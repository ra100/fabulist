/**
 * `World`: the single handle onto every store for one story, and the registry of
 * canon worlds above it.
 *
 * ## What a "world" is now
 *
 * Under SQLite a world was a *file* (`data/worlds/<slug>/world.db`), which is
 * why switching worlds meant closing one database handle and opening another,
 * and why `CurrentWorld` existed to choreograph that. A world is now a *row*, so
 * that whole apparatus is gone: `CurrentWorld`, `CurrentStory.rebind`,
 * `checkpoint`-before-close, the "open the new file before closing the old one so
 * a corrupt world cannot strand the server" dance. One pool serves every world,
 * and switching is choosing different `story_sources`.
 *
 * That collapse is most of the value of the migration for the request layer. The
 * SQLite design had `CurrentWorld`/`CurrentStory` as *process-level mutable
 * singletons* — "the world currently open" was a property of the server, so
 * `POST /api/worlds/:slug/switch` changed what every request saw, for everyone,
 * on the next request. Correct for "my laptop, my save file"; wrong for a shared
 * instance. Here `World.forStory` resolves per request from who is asking, and
 * two users in different worlds cannot see each other at all.
 *
 * ## Sources, not a world
 *
 * A `World` is bound to a story and that story's ordered canon sources. A plain
 * story has one; a crossover has several. Nothing in the stores special-cases
 * either, which is what makes "Harry Potter x LotR" the same code path as
 * "Saint Verrow".
 */
import type { Db, Queryable } from '../db/pg.ts';
import { sourcesFor, type OverlaySource } from '../db/overlay.ts';
import type { StoryId } from '../domain/types.ts';
import type { SessionUser } from '../auth/config.ts';
import { CastStore } from './cast-pg.ts';
import { ChronicleStore } from './chronicle-pg.ts';
import { GraphStore } from './graph-pg.ts';
import { IllustrationStore } from './illustration-pg.ts';
import {
  ConsequenceStore,
  DirectiveStore,
  StoryStore,
  ThreadStore,
  getStory,
  resolveCurrentStory,
  resolveOrCreateStoryForUser,
} from './world-pg.ts';

export interface WorldSummary {
  id: number;
  slug: string;
  title: string;
  storyCount: number;
  entityCount: number;
  edgeCount: number;
  /** Most recent `lastPlayedAt` across this world's stories, for ordering. */
  lastPlayedAt: string | null;
  lastRefreshedAt: string | null;
  /** See `world_access` in the schema for what this gates and why 'public' is the default. */
  visibility: 'public' | 'private';
  /** Which wikis this world was built from, for attribution and refresh. */
  sources: Array<{ wiki: string; baseUrl: string; pageCount: number; revisionWatermark: string }>;
}

export interface WorldOptions {
  db: Queryable;
  storyId: StoryId;
  sources: OverlaySource[];
  imagesDir?: string;
}

export class World {
  readonly graph: GraphStore;
  readonly cast: CastStore;
  readonly chronicle: ChronicleStore;
  readonly threads: ThreadStore;
  readonly consequences: ConsequenceStore;
  readonly directives: DirectiveStore;
  /**
   * Keeps its name rather than becoming `story`: every existing call site does
   * `world.session.get()`/`.set()`, and this migration changes what is
   * underneath that property, not what callers do with it.
   */
  readonly session: StoryStore;
  readonly illustrations: IllustrationStore;

  readonly db: Queryable;
  readonly storyId: StoryId;
  readonly sources: OverlaySource[];

  constructor(opts: WorldOptions) {
    const { db, storyId, sources } = opts;
    this.db = db;
    this.storyId = storyId;
    this.sources = sources;
    const worldId = sources[0]?.worldId;

    this.graph = new GraphStore({ db, storyId, sources });
    this.cast = new CastStore({ db, storyId, sources });
    this.chronicle = new ChronicleStore({ db, storyId, worldId });
    this.threads = new ThreadStore(db, storyId);
    this.consequences = new ConsequenceStore(db, storyId);
    this.directives = new DirectiveStore(db, storyId);
    this.session = new StoryStore(db, storyId);
    // Explicit rather than derived: tests must not write real files into the
    // repository just because they touched illustrations, so the default is a
    // fixed path a caller overrides on purpose.
    this.illustrations = new IllustrationStore(db, storyId, opts.imagesDir ?? 'data/images');
  }

  /**
   * Binds to a story, reading its sources.
   *
   * The replacement for `World.open(path)`: no file to open, so this is one
   * query. Throws when the story does not exist rather than creating one —
   * `resolveStoryFor` below is the "give me somewhere to land" path, and
   * conflating the two is how a typo'd id silently created a blank story.
   */
  static async forStory(db: Queryable, storyId: StoryId, imagesDir?: string): Promise<World> {
    const story = await getStory(db, storyId);
    if (!story) throw new Error(`no story ${storyId}`);
    const sources = await sourcesFor(db, storyId);
    return new World({ db, storyId, sources, imagesDir });
  }

  /** A different story, same connection. Cheap: no file I/O, just new sources. */
  async withStory(storyId: StoryId): Promise<World> {
    return World.forStory(this.db, storyId, this.illustrations.imagesDir);
  }

  /** The primary canon world's id, for a canon write or a refresh. */
  get worldId(): number | undefined {
    return this.sources[0]?.worldId;
  }
}

/**
 * Per-request story resolution.
 *
 * This is the function that replaces the `CurrentStory`/`CurrentWorld` singleton
 * pair, and it is deliberately a function rather than an object with state: a
 * process-wide "current story" pointer is exactly the bug that made the SQLite
 * server unsafe for more than one user, because one request's switch changed
 * every other request's view. Resolving fresh per request, from the session user,
 * makes that class of bug unrepresentable.
 *
 * - `user` present: that user's own story, created on first visit if needed.
 * - `user` absent (login off, a local single-user run): the most recently played
 *   story, or a fresh one. No ownership question to answer.
 * - `storyIdOverride`: a specific story, but only if it belongs to `user`.
 */
export async function resolveStoryFor(
  db: Queryable,
  user: SessionUser | null,
  opts: { storyIdOverride?: string; worldIds?: number[] } = {},
): Promise<StoryId> {
  if (opts.storyIdOverride) {
    const story = await getStory(db, opts.storyIdOverride);
    if (!story) throw new Error(`no story ${opts.storyIdOverride}`);
    if (user && story.ownerUserId && story.ownerUserId !== user.id) {
      throw new Error(`story ${opts.storyIdOverride} does not belong to this user`);
    }
    return story.id;
  }
  if (user) return resolveOrCreateStoryForUser(db, user.id, opts.worldIds ?? [], user.encryptNewStories ? 1 : 0);
  return resolveCurrentStory(db, opts.worldIds ?? []);
}

/** The world a request should act on, resolved from the session. */
export async function worldFor(
  db: Queryable,
  user: SessionUser | null,
  opts: { storyIdOverride?: string; worldIds?: number[]; imagesDir?: string } = {},
): Promise<World> {
  const storyId = await resolveStoryFor(db, user, opts);
  return World.forStory(db, storyId, opts.imagesDir);
}

// ---------------------------------------------------------- world registry

/**
 * Every canon world, most recently played first.
 *
 * One query with lateral subselects rather than the SQLite version's "open every
 * world file and run three aggregates in each". That loop was the one thing in
 * the old registry with a real cost — bounded, but it opened and closed a
 * database handle per world on every list call, and `readWorldSummary` had to
 * swallow errors so one corrupt file could not take out the whole picker. Neither
 * concern exists now.
 */
export async function listWorlds(db: Queryable): Promise<WorldSummary[]> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string;
    story_count: string;
    entity_count: string;
    edge_count: string;
    last_played_at: Date | null;
    last_refreshed_at: Date | null;
    visibility: 'public' | 'private';
  }>(
    `SELECT w.id, w.slug, w.title, w.last_refreshed_at, w.visibility,
       (SELECT count(*) FROM story_sources ss WHERE ss.world_id = w.id) story_count,
       (SELECT count(*) FROM canon_entities c WHERE c.world_id = w.id AND c.retired_at_revision IS NULL) entity_count,
       (SELECT count(*) FROM canon_edges e WHERE e.world_id = w.id) edge_count,
       (SELECT max(s.last_played_at) FROM stories s
          JOIN story_sources ss2 ON ss2.story_id = s.id WHERE ss2.world_id = w.id) last_played_at
     FROM worlds w
     ORDER BY last_played_at DESC NULLS LAST, w.slug`,
  );

  const { rows: srcRows } = await db.query<{
    world_id: string;
    wiki: string;
    base_url: string;
    page_count: number;
    revision_watermark: string;
  }>(`SELECT world_id, wiki, base_url, page_count, revision_watermark FROM world_sources ORDER BY wiki`);

  const byWorld = new Map<string, WorldSummary['sources']>();
  for (const s of srcRows) {
    const list = byWorld.get(s.world_id) ?? [];
    list.push({
      wiki: s.wiki,
      baseUrl: s.base_url,
      pageCount: s.page_count,
      revisionWatermark: s.revision_watermark,
    });
    byWorld.set(s.world_id, list);
  }

  return rows.map((r) => ({
    id: Number(r.id),
    slug: r.slug,
    title: r.title,
    storyCount: Number(r.story_count),
    entityCount: Number(r.entity_count),
    edgeCount: Number(r.edge_count),
    lastPlayedAt: r.last_played_at ? r.last_played_at.toISOString() : null,
    lastRefreshedAt: r.last_refreshed_at ? r.last_refreshed_at.toISOString() : null,
    visibility: r.visibility,
    sources: byWorld.get(r.id) ?? [],
  }));
}

export async function getWorldBySlug(db: Queryable, slug: string): Promise<WorldSummary | undefined> {
  const all = await listWorlds(db);
  return all.find((w) => w.slug === slug);
}

/**
 * Filesystem-safe, human-readable slug.
 *
 * Kept even though a world is no longer a directory: the slug is still the
 * stable public identifier in URLs (`/api/worlds/:slug/...`) and the thing an
 * operator types. Accents are folded rather than stripped so "Zaklínač" yields
 * `zaklinac` instead of `zakl-na` — the app is explicitly meant to be usable for
 * Czech and Slovak worlds, and a mangled name looks like data loss even when it
 * is only cosmetic.
 */
export function slugify(title: string): string {
  const folded = title
    .normalize('NFD')
    // Strip combining marks: this is what turns "í" (i + U+0301) into "i".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    // A trailing hyphen can reappear after the length clamp cuts mid-word.
    .replace(/-+$/g, '');
  // Every fallback path leads here: a title of only punctuation, only non-Latin
  // script (Cyrillic, CJK — folding leaves nothing ASCII), or the empty string.
  return slug || 'world';
}

/**
 * `mass-effect`, then `mass-effect-2`, … — never silently reuses a slug.
 *
 * A unique index on `worlds.slug` makes a collision an error rather than silent
 * corruption, so this only has to find the next free name.
 */
export async function uniqueSlug(db: Queryable, title: string): Promise<string> {
  const base = slugify(title);
  const { rows } = await db.query<{ slug: string }>(`SELECT slug FROM worlds WHERE slug LIKE $1`, [`${base}%`]);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error(`cannot find an unused slug for "${title}"`);
}

/** Creates an empty canon world. Needs the ingest role: a world is system data. */
export async function createWorld(db: Queryable, title: string): Promise<WorldSummary> {
  const slug = await uniqueSlug(db, title);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO worlds (slug, title) VALUES ($1,$2) RETURNING id`,
    [slug, title.trim()],
  );
  const id = Number(rows[0]!.id);
  return {
    id,
    slug,
    title: title.trim(),
    storyCount: 0,
    entityCount: 0,
    edgeCount: 0,
    lastPlayedAt: null,
    lastRefreshedAt: null,
    // A new world is public by default: see `world_access` in the schema for why
    // hiding ingested canon by default would make a shared instance unusable.
    visibility: 'public',
    sources: [],
  };
}

/**
 * Deletes a canon world and its rows.
 *
 * Refuses while any story still reads it. `story_sources.world_id` is
 * `ON DELETE RESTRICT` precisely so the database enforces this rather than
 * trusting a check here — deleting a world out from under a playthrough would
 * leave every canon reference in it dangling, and no foreign key can span the
 * overlay to catch that afterwards. The pre-check exists only to turn the raw
 * constraint violation into a sentence an operator can act on.
 */
export async function deleteWorld(db: Queryable, slug: string): Promise<void> {
  const world = await getWorldBySlug(db, slug);
  if (!world) throw new Error(`no world "${slug}"`);
  if (world.storyCount > 0) {
    throw new Error(
      `cannot delete "${slug}": ${world.storyCount} story/ies still read it. Delete those stories first, or keep the world.`,
    );
  }
  await db.query(`DELETE FROM worlds WHERE id = $1`, [world.id]);
}

/** Renames a world's title, and its slug when the derived one is free. */
export async function renameWorld(db: Queryable, slug: string, title: string): Promise<WorldSummary> {
  const world = await getWorldBySlug(db, slug);
  if (!world) throw new Error(`no world "${slug}"`);
  const desired = slugify(title);
  // Only when free, and never a silent overwrite: the unique index would reject
  // it anyway, and a rename that quietly kept the old slug is less confusing
  // than one that fails.
  const nextSlug = desired === slug ? slug : ((await getWorldBySlug(db, desired)) ? slug : desired);
  await db.query(`UPDATE worlds SET title = $1, slug = $2 WHERE id = $3`, [title.trim(), nextSlug, world.id]);
  return (await getWorldBySlug(db, nextSlug))!;
}

/** Points a story at a set of canon worlds, in precedence order. The crossover write. */
export async function setStorySources(db: Db, storyId: StoryId, worldIds: number[]): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(`DELETE FROM story_sources WHERE story_id = $1`, [storyId]);
    for (const [i, worldId] of worldIds.entries()) {
      await tx.query(`INSERT INTO story_sources (story_id, world_id, ordinal) VALUES ($1,$2,$3)`, [
        storyId,
        worldId,
        i + 1,
      ]);
    }
  });
}
