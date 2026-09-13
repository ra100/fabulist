import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, rows } from '../src/db/db.ts';

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
