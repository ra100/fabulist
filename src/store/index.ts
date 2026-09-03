/**
 * World: the single handle onto all stores. Passed to roles and the turn loop
 * so nothing reaches for a raw database connection.
 */
import { openDb, type Db } from '../db/db.ts';
import { GraphStore } from './graph.ts';
import { CastStore } from './cast.ts';
import { ChronicleStore } from './chronicle.ts';
import { ConsequenceStore, DirectiveStore, SessionStore, ThreadStore } from './world.ts';

export class World {
  readonly graph: GraphStore;
  readonly cast: CastStore;
  readonly chronicle: ChronicleStore;
  readonly threads: ThreadStore;
  readonly consequences: ConsequenceStore;
  readonly directives: DirectiveStore;
  readonly session: SessionStore;

  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.graph = new GraphStore(db);
    this.cast = new CastStore(db);
    this.chronicle = new ChronicleStore(db);
    this.threads = new ThreadStore(db);
    this.consequences = new ConsequenceStore(db);
    this.directives = new DirectiveStore(db);
    this.session = new SessionStore(db);
  }

  static open(path = ':memory:'): World {
    return new World(openDb(path));
  }

  close(): void {
    this.db.close();
  }
}
