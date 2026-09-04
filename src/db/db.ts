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
  return db;
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
