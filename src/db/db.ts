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
  migrate(db);
  return db;
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
