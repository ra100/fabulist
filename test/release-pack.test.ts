import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { checkIntegrity } from '../src/store/integrity.ts';
import { createReleasePack } from '../src/store/release-pack.ts';

test('createReleasePack makes a checksummed, install-ready world directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-release-pack-'));
  try {
    const source = join(dir, 'source.db');
    const world = World.open(source, undefined, join(dir, 'images'));
    seedWorld(world);
    mkdirSync(join(dir, 'images'), { recursive: true });
    writeFileSync(join(dir, 'images', 'portrait.png'), 'image');

    const result = createReleasePack(source, join(dir, 'saint-verrow'), '0.9.8-test');
    world.close();

    assert.equal(result.manifest.format, 'fabulist-world-pack');
    assert.equal(result.manifest.world.title, 'Saint Verrow');
    assert.equal(result.manifest.world.entityCount, 22);
    assert.equal(result.imageCount, 1);
    assert.ok(existsSync(join(result.dir, 'world.db')));
    assert.deepEqual(readdirSync(join(result.dir, 'images')), ['portrait.png']);
    assert.match(readFileSync(join(result.dir, 'SHA256SUMS'), 'utf8'), /world\.db/);
    assert.match(readFileSync(join(result.dir, 'SHA256SUMS'), 'utf8'), /manifest\.json/);

    const installed = World.open(result.dbPath, undefined, join(result.dir, 'images'));
    assert.ok(checkIntegrity(installed.db).ok);
    assert.equal(installed.graph.counts().entities, 22);
    installed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createReleasePack refuses to overwrite an existing release directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-release-pack-'));
  try {
    const source = join(dir, 'source.db');
    const world = World.open(source);
    seedWorld(world);
    world.close();
    const target = join(dir, 'release');
    createReleasePack(source, target, 'test');
    assert.throws(() => createReleasePack(source, target, 'test'), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
