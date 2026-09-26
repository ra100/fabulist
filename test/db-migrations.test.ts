import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, rows } from '../src/db/db.ts';
import { applyMigrations, type Db } from '../src/db/pg.ts';

test('openDb migrates a world created before turn-history columns existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-legacy-world-'));
  try {
    const path = join(dir, 'world.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE turns (story_id TEXT NOT NULL, scene INTEGER NOT NULL, turn INTEGER NOT NULL)`);
    legacy.close();

    const db = openDb(path);
    try {
      const columns = rows<{ name: string }>(db.prepare(`SELECT name FROM pragma_table_info('turns')`).all());
      assert.ok(columns.some((column) => column.name === 'history_position'));
      const indexes = rows<{ name: string }>(db.prepare(`SELECT name FROM pragma_index_list('turns')`).all());
      assert.ok(indexes.some((index) => index.name === 'idx_turns_history_position'));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('openDb adds history_checkpoints.origin to a save created before it existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-legacy-origin-'));
  try {
    const path = join(dir, 'world.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE history_checkpoints (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL, turn_id TEXT, position INTEGER NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL)`);
    legacy.exec(`INSERT INTO history_checkpoints VALUES ('checkpoint:legacy', 'story:x', NULL, 1, '{}', '2026-01-01T00:00:00.000Z')`);
    legacy.close();

    const db = openDb(path);
    try {
      const columns = rows<{ name: string }>(db.prepare(`SELECT name FROM pragma_table_info('history_checkpoints')`).all());
      assert.ok(columns.some((column) => column.name === 'origin'));
      const legacyRow = db.prepare(`SELECT origin FROM history_checkpoints WHERE id = 'checkpoint:legacy'`).get() as {
        origin: string | null;
      };
      assert.equal(legacyRow.origin, null, 'legacy rows stay unlabelled rather than guessed');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Postgres migration failures retain rollback diagnostics without masking the migration error', async () => {
  const migrationError = new Error('duplicate column');
  const rollbackError = new Error('connection terminated');
  const queries: string[] = [];
  const fakeClient = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version FROM migrations')) return { rows: [], rowCount: 0 };
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE')) throw migrationError;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [], rowCount: 0 };
    },
  };
  const fakeDb = {
    withClient: async <T>(fn: (client: typeof fakeClient) => Promise<T>) => fn(fakeClient),
  } as unknown as Db;

  await assert.rejects(
    () => applyMigrations(fakeDb),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, migrationError);
      assert.match(error.message, /migration .* failed and its rollback also failed/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /PostgreSQL migration \d{3}-.+\.sql failed/);
      assert.equal(error.errors[1], rollbackError);
      return true;
    },
  );
  assert.ok(queries.includes('ROLLBACK'), 'the failed migration must still attempt rollback');
});
