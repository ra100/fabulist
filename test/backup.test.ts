import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { backupSave, imagesDirFor, timestamp, vacuumInto } from '../src/store/backup.ts';
import { checkIntegrity } from '../src/store/integrity.ts';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'story-backup-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The reason this module exists rather than a documented `cp`. With a live
 * connection open, the main database file can be almost empty while everything
 * committed sits in the `-wal` sidecar — so a filesystem copy of the `.db`
 * alone can yield a database with no tables at all, not merely a stale one.
 */
test('a plain file copy of an open save loses data that backupSave keeps', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src);
    seedWorld(world);

    // Deliberately copied while the connection is open — the realistic mistake:
    // a server is running and the operator copies the file from another shell.
    const byCp = join(dir, 'by-cp.db');
    copyFileSync(src, byCp);
    const result = backupSave(src, join(dir, 'by-backup'));
    world.close();

    const tablesIn = (path: string) => {
      const db = new DatabaseSync(path);
      const n = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'`).get() as { n: number };
      db.close();
      return n.n;
    };
    assert.equal(tablesIn(byCp), 0, 'the cp copy is empty: the schema itself was still in the WAL');
    assert.ok(tablesIn(result.dbPath) > 15, 'the backup has the real schema');

    const db = new DatabaseSync(result.dbPath);
    const entities = db.prepare('SELECT COUNT(*) n FROM entities').get() as { n: number };
    assert.equal(entities.n, 22, 'and every seeded entity');
    db.close();
  } finally {
    cleanup();
  }
});

test('the backup is a single self-contained file with no sidecars', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src);
    seedWorld(world);
    const result = backupSave(src, join(dir, 'out'));
    world.close();

    assert.ok(existsSync(result.dbPath));
    assert.ok(!existsSync(`${result.dbPath}-wal`), 'no -wal beside the backup');
    assert.ok(!existsSync(`${result.dbPath}-shm`), 'no -shm beside the backup');
    assert.ok(result.bytes > 0);

    const db = new DatabaseSync(result.dbPath);
    const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(check.integrity_check, 'ok');
    db.close();
  } finally {
    cleanup();
  }
});

test('a restored backup is playable and referentially intact', async () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const source = World.open(src);
    seedWorld(source);
    const result = backupSave(src, join(dir, 'out'));
    source.close();

    // Open the backup as a save in its own right, not merely as a file.
    const restored = World.open(result.dbPath);
    assert.ok(checkIntegrity(restored.db).ok, 'no dangling references survived the copy');
    assert.equal(restored.graph.counts().entities, 22);
    assert.equal(restored.chronicle.getMeta('worldTitle'), 'Saint Verrow');

    const { Engine } = await import('../src/loop/engine.ts');
    const { MockProvider } = await import('../src/providers/mock.ts');
    const { ProviderRegistry } = await import('../src/providers/provider.ts');
    const engine = new Engine({ world: restored, providers: new ProviderRegistry(new MockProvider()) });
    const out = await engine.takeTurn('i listen at the door');
    assert.equal(out.kind, 'narrated', 'a backup is a save, not just bytes');
    restored.close();
  } finally {
    cleanup();
  }
});

test('images travel with the database, since the rows point at files outside it', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src, undefined, imagesDirFor(src));
    seedWorld(world);
    mkdirSync(imagesDirFor(src), { recursive: true });
    writeFileSync(join(imagesDirFor(src), 'a.png'), 'not-really-a-png');
    writeFileSync(join(imagesDirFor(src), 'b.png'), 'nor-this');

    const result = backupSave(src, join(dir, 'out'));
    world.close();

    assert.equal(result.imageCount, 2);
    assert.ok(result.imagesPath);
    assert.deepEqual(readdirSync(result.imagesPath!).sort(), ['a.png', 'b.png']);
    assert.equal(statSync(join(result.imagesPath!, 'a.png')).size, 'not-really-a-png'.length);
  } finally {
    cleanup();
  }
});

test('a save with no images backs up cleanly rather than failing', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src);
    seedWorld(world);
    const result = backupSave(src, join(dir, 'out'));
    world.close();
    assert.equal(result.imagesPath, null);
    assert.equal(result.imageCount, 0);
  } finally {
    cleanup();
  }
});

test('backup refuses to overwrite, and refuses a source that is not there', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src);
    seedWorld(world);
    backupSave(src, join(dir, 'out'));
    // Overwriting a backup silently is how the previous good copy is lost.
    assert.throws(() => backupSave(src, join(dir, 'out')), /already exists/);
    world.close();

    assert.throws(() => backupSave(join(dir, 'nope.db'), join(dir, 'x')), /no save at/);
  } finally {
    cleanup();
  }
});

test('a path containing a quote cannot break out of the VACUUM INTO literal', () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'live.db');
    const world = World.open(src);
    seedWorld(world);
    // VACUUM INTO takes a literal, not a bound parameter, so the escaping is
    // this module's responsibility.
    const odd = join(dir, "o'brien.db");
    const bytes = vacuumInto(world.db, odd);
    world.close();
    assert.ok(bytes > 0);
    assert.ok(existsSync(odd), 'the file landed at the literal path, quote included');
  } finally {
    cleanup();
  }
});

test('timestamp is sortable and filename-safe', () => {
  const stamp = timestamp(new Date(2026, 8, 5, 23, 3, 7));
  assert.equal(stamp, '20260905-230307');
  assert.doesNotMatch(stamp, /[^0-9-]/, 'nothing a filesystem or shell would object to');
  assert.ok(timestamp(new Date(2026, 0, 2)) < timestamp(new Date(2026, 0, 10)), 'lexical order is chronological');
});
