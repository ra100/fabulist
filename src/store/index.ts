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
import { openDb, type Db } from '../db/db.ts';
import type { StoryId } from '../domain/types.ts';
import { GraphStore } from './graph.ts';
import { CastStore } from './cast.ts';
import { ChronicleStore } from './chronicle.ts';
import {
  ConsequenceStore,
  DirectiveStore,
  StoryStore,
  ThreadStore,
  resolveDefaultStory,
} from './world.ts';

export class World {
  readonly graph: GraphStore;
  readonly cast: CastStore;
  readonly chronicle: ChronicleStore;
  readonly threads: ThreadStore;
  readonly consequences: ConsequenceStore;
  readonly directives: DirectiveStore;
  readonly session: StoryStore;

  readonly db: Db;
  readonly storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
    this.graph = new GraphStore(db, storyId);
    this.cast = new CastStore(db, storyId);
    this.chronicle = new ChronicleStore(db, storyId);
    this.threads = new ThreadStore(db, storyId);
    this.consequences = new ConsequenceStore(db, storyId);
    this.directives = new DirectiveStore(db, storyId);
    this.session = new StoryStore(db, storyId);
  }

  /**
   * Opens a file and binds to a story in it. `storyId` omitted means
   * auto-resolve: a fresh file gets its first story created, a file with
   * exactly one story binds to it (every call site written before this
   * migration relies on exactly this), and a file with more than one throws
   * rather than silently guessing which story was meant.
   */
  static open(path = ':memory:', storyId?: StoryId): World {
    const db = openDb(path);
    return new World(db, storyId ?? resolveDefaultStory(db));
  }

  /** A second story in the same open file, without a second file handle. */
  withStory(storyId: StoryId): World {
    return new World(this.db, storyId);
  }

  close(): void {
    this.db.close();
  }
}

