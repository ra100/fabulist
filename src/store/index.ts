/**
 * World: the single handle onto all stores for one story. Passed to roles and
 * the turn loop so nothing reaches for a raw database connection.
 *
 * Bound to one story at construction (`storyId`), not the process lifetime of
 * the file: a world file can hold many stories, and switching which one a
 * request operates on means constructing a new `World` over the same open
 * `Db`, not reopening a file. `world.session` keeps its name (not renamed to
 * `story`) even though it is now backed by `StoryStore` — every existing
 * `.get()`/`.set()` call site already expects exactly this shape, and this
 * migration changes what is underneath that property, not what callers do
 * with it.
 */
import { checkpoint, openDb, type Db } from '../db/db.ts';
import type { StoryId } from '../domain/types.ts';
import { GraphStore } from './graph.ts';
import { CastStore } from './cast.ts';
import { ChronicleStore } from './chronicle.ts';
import { IllustrationStore } from './illustration.ts';
import {
  ConsequenceStore,
  DirectiveStore,
  StoryStore,
  ThreadStore,
  getStory,
  resolveCurrentStory,
  resolveDefaultStory,
  resolveOrCreateStoryForUser,
} from './world.ts';
import { isWorldDir, pathsFor } from './worlds.ts';
import type { SessionUser } from '../auth/config.ts';

export class World {
  readonly graph: GraphStore;
  readonly cast: CastStore;
  readonly chronicle: ChronicleStore;
  readonly threads: ThreadStore;
  readonly consequences: ConsequenceStore;
  readonly directives: DirectiveStore;
  readonly session: StoryStore;
  readonly illustrations: IllustrationStore;

  readonly db: Db;
  readonly storyId: StoryId;

  constructor(db: Db, storyId: StoryId, imagesDir?: string) {
    this.db = db;
    this.storyId = storyId;
    this.graph = new GraphStore(db, storyId);
    this.cast = new CastStore(db, storyId);
    this.chronicle = new ChronicleStore(db, storyId);
    this.threads = new ThreadStore(db, storyId);
    this.consequences = new ConsequenceStore(db, storyId);
    this.directives = new DirectiveStore(db, storyId);
    this.session = new StoryStore(db, storyId);
    // Not derived from `dbPath` automatically: an in-memory database
    // (`:memory:`, what every test uses) has no directory to derive from, and
    // guessing one would mean every test that touches illustrations writes
    // real files onto the repository's disk unless it remembers to override
    // this. Explicit default instead; real callers (`cli/serve.ts`) pass the
    // directory next to their actual `dbPath`.
    this.illustrations = new IllustrationStore(db, storyId, imagesDir ?? 'data/images');
  }

  /**
   * Opens a file and binds to a story in it. `storyId` omitted means
   * auto-resolve: a fresh file gets its first story created, a file with
   * exactly one story binds to it (every call site written before this
   * migration relies on exactly this), and a file with more than one throws
   * rather than silently guessing which story was meant.
   */
  static open(path = ':memory:', storyId?: StoryId, imagesDir?: string): World {
    const db = openDb(path);
    return new World(db, storyId ?? resolveDefaultStory(db), imagesDir);
  }

  /** A second story in the same open file, without a second file handle. */
  withStory(storyId: StoryId): World {
    return new World(this.db, storyId, this.illustrations.imagesDir);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Server-level "which story is current". `Engine`/`Compactor`/`SetupService`/
 * `IllustrationService` all already accept `world: World | (() => World)` —
 * this is the thing on the other end of that getter for a real, long-lived
 * server process, so switching stories is `currentStory.switchTo(id)` rather
 * than tearing down and rebuilding the whole server. Mirrors
 * `SwappableRegistry`'s shape deliberately: same problem (a long-lived
 * server holding something that must change live), same fix.
 */
export class CurrentStory {
  private db: Db;
  private storyId: StoryId;
  private imagesDir: string | undefined;

  constructor(db: Db, storyId: StoryId, imagesDir?: string) {
    this.db = db;
    this.storyId = storyId;
    this.imagesDir = imagesDir;
  }

  /** A fresh `World` bound to whichever story is current right now. */
  world = (): World => new World(this.db, this.storyId, this.imagesDir);

  /**
   * The per-request story resolution: when `user` is a verified session
   * (`src/auth/config.ts`), resolves fresh, every call, to *that user's own*
   * story — never the shared `this.storyId` pointer, and never cached on
   * this instance, because caching per-user resolution on a single
   * process-wide object is exactly the bug this method exists to avoid (two
   * concurrent users must never be able to see or influence each other's
   * resolution). `storyIdOverride`, when given, must belong to `user` — see
   * `src/server/api.ts`'s `?storyId=` handling for why a user with more
   * than one story needs a way to pick one *other than* their most recently
   * played, without that becoming server-wide shared state the way
   * `switchTo` below is.
   *
   * `user` absent (login off, today's only mode until this existed) falls
   * straight through to `world()` — completely unchanged behavior, the
   * legacy shared-pointer model, on purpose: a local single-user server has
   * no story-ownership question to answer at all.
   */
  worldFor(user: SessionUser | null, storyIdOverride?: string): World {
    if (!user) return this.world();
    if (storyIdOverride) {
      const story = getStory(this.db, storyIdOverride);
      if (!story) throw new Error(`no story ${storyIdOverride} in this world`);
      if (story.ownerUserId !== user.id) throw new Error(`story ${storyIdOverride} does not belong to this user`);
      return new World(this.db, storyIdOverride, this.imagesDir);
    }
    const storyId = resolveOrCreateStoryForUser(this.db, user.id);
    return new World(this.db, storyId, this.imagesDir);
  }

  id(): StoryId {
    return this.storyId;
  }

  /** Switches which story every subsequent `world()` call resolves to. Throws if the story does not exist in this file. */
  switchTo(storyId: StoryId): void {
    if (!getStory(this.db, storyId)) throw new Error(`no story ${storyId} in this world`);
    this.storyId = storyId;
  }

  /**
   * Rebinds to a different open database — the story half of a *world* switch.
   *
   * Exists so `CurrentWorld` can swap the file without anything downstream
   * holding a stale handle. Deliberately takes an already-open `Db` and an
   * already-resolved story id rather than a path: opening files and deciding
   * which story to land on is `CurrentWorld`'s job, and duplicating that here
   * would give two places the power to open a database.
   */
  rebind(db: Db, storyId: StoryId, imagesDir?: string): void {
    if (!getStory(db, storyId)) throw new Error(`no story ${storyId} in that world`);
    this.db = db;
    this.storyId = storyId;
    this.imagesDir = imagesDir;
  }
}

/**
 * Server-level "which world file is current" — `CurrentStory` one level up.
 *
 * `CurrentStory` solved switching *within* a file, which needs no I/O: the
 * database handle stays put and only a `story_id` changes. A world switch is a
 * genuinely different operation, because a world *is* the file. There is no
 * cross-file query, so the old handle must be closed and a new one opened, and
 * everything holding the old one has to notice.
 *
 * Which is why this owns a `CurrentStory` rather than sitting beside one. Every
 * long-lived consumer — `Engine`, `SetupService`, `IllustrationService`, and
 * every plain route in `api.ts` — already resolves `world` through a getter for
 * story switching. Pointing that single getter at a `CurrentStory` this class
 * rebinds means a world switch reuses the seam that already exists and is
 * already tested, instead of adding a parallel one that each consumer would
 * have to opt into (and that new code would forget).
 *
 * `dbPath` in config stays unpatchable, and is now only the *boot* choice; it
 * is no longer the answer to "which world am I in".
 */
export class CurrentWorld {
  private dataRoot: string;
  private slugValue: string;
  private db: Db;
  private story: CurrentStory;

  private constructor(dataRoot: string, slug: string, db: Db, story: CurrentStory) {
    this.dataRoot = dataRoot;
    this.slugValue = slug;
    this.db = db;
    this.story = story;
  }

  /** Opens a world by slug and binds to its default story. */
  static open(slug: string, dataRoot = 'data'): CurrentWorld {
    const paths = pathsFor(slug, dataRoot);
    if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);
    const db = openDb(paths.dbPath);
    const story = new CurrentStory(db, resolveCurrentStory(db), paths.imagesDir);
    return new CurrentWorld(dataRoot, slug, db, story);
  }

  /** The story pointer to hand to `createApiServer`, `Engine`, and friends. */
  stories(): CurrentStory {
    return this.story;
  }

  /** The getter every consumer holds. Survives both story and world switches. */
  world = (): World => this.story.world();

  slug(): string {
    return this.slugValue;
  }

  /**
   * Closes the current file and opens another, rebinding the shared
   * `CurrentStory` so existing consumers follow along.
   *
   * Order matters and is the whole point of this method. The new database is
   * opened and its default story resolved *before* anything is closed, so a
   * switch to a missing or corrupt world throws with the old world still open
   * and fully usable — the alternative (close, then fail to open) leaves the
   * server holding a closed handle and every subsequent request failing, which
   * is unrecoverable without a restart.
   *
   * A checkpoint precedes the close so the world being left behind is a single
   * tidy file rather than one carrying a multi-megabyte `-wal` (see `db.ts`),
   * which matters now that leaving a world is a routine click rather than a
   * process exit.
   */
  switchTo(slug: string): void {
    if (slug === this.slugValue) return;
    const paths = pathsFor(slug, this.dataRoot);
    if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);

    const nextDb = openDb(paths.dbPath);
    let nextStoryId: StoryId;
    try {
      nextStoryId = resolveCurrentStory(nextDb);
    } catch (err) {
      // Leave the old world untouched if resolution fails for any reason (a
      // corrupt or unreadable file, say): losing the player's open session is
      // a worse outcome than refusing the switch. Several stories is no
      // longer one of those reasons — `resolveCurrentStory` picks the most
      // recently played rather than throwing, since per-user stories made
      // multi-story worlds ordinary.
      nextDb.close();
      throw err;
    }

    const previous = this.db;
    this.db = nextDb;
    this.slugValue = slug;
    this.story.rebind(nextDb, nextStoryId, paths.imagesDir);

    checkpoint(previous);
    previous.close();
  }

  /**
   * Re-resolves the current world in place — used after an operation replaced
   * the story rows underneath (`SetupService.reset`) or renamed the directory.
   */
  reopen(slug = this.slugValue): void {
    const paths = pathsFor(slug, this.dataRoot);
    if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);
    const nextDb = openDb(paths.dbPath);
    const nextStoryId = resolveCurrentStory(nextDb);
    const previous = this.db;
    this.db = nextDb;
    this.slugValue = slug;
    this.story.rebind(nextDb, nextStoryId, paths.imagesDir);
    checkpoint(previous);
    previous.close();
  }

  close(): void {
    checkpoint(this.db);
    this.db.close();
  }
}

