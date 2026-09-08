import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/** Rows come back with a null prototype; normalise so spread and `in` behave. */
export function row<T>(r: unknown): T | undefined {
  return r == null ? undefined : ({ ...(r as object) } as T);
}

export function rows<T>(rs: unknown[]): T[] {
  return rs.map((r) => ({ ...(r as object) }) as T);
}

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  configure(db);
  migrate(db);
  return db;
}

/**
 * Connection-scoped pragmas. `schema.sql` sets `journal_mode`/`foreign_keys`
 * because they belong with the schema; these belong with the connection.
 *
 * `journal_size_limit` is the one that matters. WAL grows by appended page
 * images per commit, not by logical data size, so a long play session rewrites
 * the same hot pages thousands of times: a 320 KB world file was observed with
 * a 4.6 MB sidecar. That is not a leak — it is exactly `wal_autocheckpoint`'s
 * 1000-page default (1000 × 4096 = 4.1 MB), confirmed by pragma rather than
 * guessed — but the default limit of -1 means the file is reused in place and
 * never shrinks, so the high-water mark is permanent. A limit tells SQLite to
 * truncate back down after each checkpoint.
 *
 * Left alone deliberately: `synchronous`. The default (FULL) is what makes a
 * save survive a power cut, and this is somebody's novel.
 */
function configure(db: Db): void {
  // 4 MB, matching the autocheckpoint threshold: the WAL is allowed to reach
  // its natural checkpoint size, then gives the space back.
  db.exec('PRAGMA journal_size_limit = 4194304');
}

/**
 * Folds the WAL back into the main database and truncates the sidecar.
 *
 * Call at a natural pause — scene close — rather than per turn: a checkpoint
 * is real I/O, and mid-scene is exactly when the player is waiting on prose.
 * Also the right thing to call before handing a world file to anyone, since a
 * WAL-mode database is really three files while open (`-wal`, `-shm`) and only
 * the main file is meaningful once checkpointed.
 *
 * A checkpoint can legitimately fail to complete when another connection holds
 * a read lock, and that is not an error worth propagating into a scene
 * transition — the next one will catch up. `TRUNCATE` is the aggressive mode
 * (block for writers, then zero the file) precisely because the caller has
 * chosen a moment where blocking is acceptable.
 */
export function checkpoint(db: Db): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Busy, or not in WAL mode (`:memory:` never is). Nothing to recover from.
  }
}

/**
 * Additive column migrations for databases created before a field existed.
 *
 * `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op against an existing
 * save, so a column added to a domain type after a save was created needs an
 * explicit `ALTER TABLE`. This SQLite build has no `ADD COLUMN IF NOT EXISTS`
 * (confirmed directly: it is a syntax error, not merely undocumented), so
 * idempotency is checked by hand against `pragma_table_info` before altering.
 * Keep this list append-only — one line per column, forever — the same
 * discipline `schema.sql` already applies to tables.
 */
function migrate(db: Db): void {
  addColumnIfMissing(db, 'sheets', 'appearance', `TEXT NOT NULL DEFAULT '{}'`);
  addColumnIfMissing(db, 'ingest_pages', 'passb_status', `TEXT NOT NULL DEFAULT ''`);
  // Created here, not in `schema.sql`: on an existing save the column above
  // did not exist until the line just ran, and `schema.sql` executes as one
  // `exec()` before `migrate()` — an index built there against a column added
  // here would be building against nothing on every pre-existing save.
  db.exec('CREATE INDEX IF NOT EXISTS idx_ingest_pages_wiki_status ON ingest_pages(wiki, passb_status)');

  // NULL, not a default: NULL means "no owner" (every story created before
  // this column existed, and every story created while login is off — see
  // src/auth/config.ts). A story a logged-in user creates gets their WorkOS
  // user id written explicitly by createStory; nothing here claims an
  // existing NULL row on anyone's behalf, since silently attributing a
  // stranger's old local save to whoever logs in first would be a real
  // privacy bug, not a convenience.
  addColumnIfMissing(db, 'stories', 'owner_user_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stories_owner ON stories(owner_user_id)');
}

function addColumnIfMissing(db: Db, table: string, column: string, ddl: string): void {
  const existing = rows<{ name: string }>(db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table));
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function jsonGet<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
