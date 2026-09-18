import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, rows } from '../src/db/db.ts';
import { applySchemaAndMigrations, type Db } from '../src/db/pg.ts';

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

test('Postgres fresh-install schema creation is inside the migration lock', async () => {
  const queries: string[] = [];
  const fakeClient = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes(`to_regclass('turns')`)) return { rows: [{ has_turns: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const fakeDb = {
    query: fakeClient.query,
    withClient: async <T>(fn: (client: typeof fakeClient) => Promise<T>) => fn(fakeClient),
  } as unknown as Db;

  await applySchemaAndMigrations(fakeDb);

  const lock = queries.findIndex((query) => query.includes('pg_advisory_lock'));
  const schema = queries.findIndex((query) => query.includes('CREATE TABLE IF NOT EXISTS migrations'));
  assert.ok(lock >= 0);
  assert.ok(schema > lock, 'fresh-install schema must not run before the advisory lock');
});

test('failed ingest_pages rebuild rolls back the staging table and preserves the legacy table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-legacy-ingest-pages-'));
  try {
    const path = join(dir, 'world.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE ingest_pages (
        page_id TEXT PRIMARY KEY,
        wiki TEXT,
        title TEXT NOT NULL,
        revision TEXT NOT NULL DEFAULT '',
        depth INTEGER NOT NULL DEFAULT 0,
        hops INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL DEFAULT '',
        passb_status TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO ingest_pages (page_id, wiki, title) VALUES ('1', NULL, 'Duskhollow');
    `);
    legacy.close();

    assert.throws(
      () => openDb(path),
      /NOT NULL constraint failed/,
      'the invalid legacy row should fail the rebuild',
    );

    const db = new DatabaseSync(path);
    try {
      const table = rows<{ name: string; pk: number }>(db.prepare(`SELECT name, pk FROM pragma_table_info('ingest_pages')`).all());
      assert.deepEqual(
        table.filter((column) => column.pk > 0).map((column) => column.name),
        ['page_id'],
        'the legacy primary key remains after rollback',
      );
      assert.deepEqual(
        rows<{ page_id: string; wiki: string | null; title: string }>(
          db.prepare(`SELECT page_id, wiki, title FROM ingest_pages`).all(),
        ),
        [{ page_id: '1', wiki: null, title: 'Duskhollow' }],
        'the legacy row remains intact after rollback',
      );
      assert.equal(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ingest_pages_new'`).get(),
        undefined,
        'the staging table is rolled back',
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
