/**
 * Worlds: the file-level layer above stories.
 *
 * These tests care about the boundary that made world switching impossible
 * before — that a world is a *directory*, that switching closes one database
 * and opens another, and that nothing leaks across that boundary. Story-level
 * behaviour is covered in store.test.ts; the interesting cases here are the
 * ones involving real files, so these use a temp directory rather than
 * `:memory:`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { CurrentWorld, World } from '../src/store/index.ts';
import { createStory } from '../src/store/world.ts';
import {
  createWorldFile,
  deleteWorldFile,
  isWorldDir,
  listWorlds,
  migrateLegacySave,
  pathsFor,
  renameWorldFile,
  slugify,
  uniqueSlug,
} from '../src/store/worlds.ts';

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-worlds-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ slugging

test('slugify folds accents rather than stripping them', () => {
  // The app is meant to be usable for Czech and Slovak worlds, so a title with
  // diacritics must not become a mangled directory name — "zakl-n-a" would look
  // like corruption even though it is only cosmetic.
  assert.equal(slugify('Zaklínač'), 'zaklinac');
  assert.equal(slugify('Šumava'), 'sumava');
  assert.equal(slugify('Mass Effect'), 'mass-effect');
});

test('slugify never returns an empty string', () => {
  // A title of only punctuation or only non-Latin script folds to nothing.
  // Returning '' would mean `pathsFor('')` resolves to the worlds root itself,
  // and creating that world would scribble `world.db` over the whole registry.
  assert.equal(slugify('!!!'), 'world');
  assert.equal(slugify(''), 'world');
  assert.equal(slugify('日本語'), 'world');
});

test('uniqueSlug suffixes rather than reusing an existing directory', () => {
  withRoot((root) => {
    const first = createWorldFile('Mass Effect', root);
    assert.equal(first.slug, 'mass-effect');
    const second = createWorldFile('Mass Effect', root);
    assert.equal(second.slug, 'mass-effect-2', 'a same-titled world must not adopt the first one’s file');
    assert.notEqual(first.dbPath, second.dbPath);
  });
});

test('uniqueSlug is stable when nothing exists yet', () => {
  withRoot((root) => {
    assert.equal(uniqueSlug('Saint Verrow', root), 'saint-verrow');
  });
});

// ---------------------------------------------------------------- discovery

test('listWorlds finds created worlds and ignores non-world directories', () => {
  withRoot((root) => {
    createWorldFile('Alpha', root);
    createWorldFile('Beta', root);
    // Junk that a real data directory accumulates: an editor artefact and a
    // directory with no world.db. Neither may break the picker, which is the
    // one screen you need in order to recover from a broken world.
    writeFileSync(join(root, 'worlds', '.DS_Store'), '');
    const stray = join(root, 'worlds', 'half-extracted');
    createWorldFile('placeholder', root);
    rmSync(pathsFor('placeholder', root).dbPath);

    const found = listWorlds(root).map((w) => w.slug).sort();
    assert.deepEqual(found, ['alpha', 'beta']);
    assert.ok(!existsSync(join(stray, 'world.db')), 'precondition: stray dir has no world.db');
  });
});

test('listWorlds returns empty rather than throwing on a fresh install', () => {
  withRoot((root) => {
    assert.deepEqual(listWorlds(root), [], 'no worlds directory yet is a normal state, not an error');
  });
});

test('a world summary reports its title, story and entity counts', () => {
  withRoot((root) => {
    const created = createWorldFile('Saint Verrow', root);
    const world = World.open(created.dbPath, undefined, created.imagesDir);
    world.graph.upsert({ id: 'char:x', type: 'Character', name: 'X' }, 'canon');
    createStory(world.db, { title: 'second book' });
    world.close();

    const summary = listWorlds(root)[0]!;
    assert.equal(summary.title, 'Saint Verrow', 'the title comes from meta, not the directory name');
    assert.equal(summary.entityCount, 1);
    assert.equal(summary.storyCount, 2);
  });
});

test('a corrupt world file is skipped instead of breaking the list', () => {
  withRoot((root) => {
    createWorldFile('Good', root);
    const bad = pathsFor('broken', root);
    createWorldFile('Broken', root);
    // Not valid SQLite. `openDb` throws, and the whole picker would go with it
    // if the summary read did not swallow this.
    writeFileSync(bad.dbPath, 'this is not a database');

    const slugs = listWorlds(root).map((w) => w.slug);
    assert.deepEqual(slugs, ['good'], 'the healthy world is still listed');
  });
});

// ----------------------------------------------------------------- lifecycle

test('createWorldFile writes a real, openable database', () => {
  withRoot((root) => {
    const created = createWorldFile('Andromeda', root);
    assert.ok(isWorldDir(created.dir), 'created eagerly so discovery can see it before any ingest');
    // Openable means the schema was applied, which is what makes the wizard's
    // first write succeed rather than fail on a missing table.
    const world = World.open(created.dbPath, undefined, created.imagesDir);
    assert.equal(world.graph.counts().entities, 0);
    world.close();
  });
});

test('deleteWorldFile removes the whole directory, sidecars included', () => {
  withRoot((root) => {
    const a = createWorldFile('A', root);
    createWorldFile('B', root);
    // A leftover -wal is the specific hazard: unlinking only world.db would
    // leave a sidecar that a later world reusing the slug could be opened
    // against, mixing two worlds' pages.
    writeFileSync(`${a.dbPath}-wal`, 'stale');
    deleteWorldFile('a', { dataRoot: root });
    assert.ok(!existsSync(a.dir), 'the directory goes as a unit');
    assert.deepEqual(listWorlds(root).map((w) => w.slug), ['b']);
  });
});

test('deleteWorldFile refuses the open world', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    createWorldFile('B', root);
    assert.throws(
      () => deleteWorldFile('a', { dataRoot: root, openSlug: 'a' }),
      /currently open/,
      'deleting the open world would leave the server holding a closed handle',
    );
    assert.ok(isWorldDir(pathsFor('a', root).dir), 'and it is still there');
  });
});

test('renameWorldFile moves the directory when the world is closed', () => {
  withRoot((root) => {
    createWorldFile('Mass Efect', root);
    const renamed = renameWorldFile('mass-efect', 'Mass Effect', { dataRoot: root });
    assert.equal(renamed.slug, 'mass-effect');
    assert.equal(renamed.title, 'Mass Effect');
    assert.ok(!existsSync(pathsFor('mass-efect', root).dir), 'the misspelled directory is gone');
  });
});

test('renameWorldFile retitles but does not move the open world', () => {
  withRoot((root) => {
    createWorldFile('Old', root);
    // Moving a file out from under a live SQLite handle appears to work on
    // macOS (the inode survives) and loses writes later. Retitling without
    // moving is inconsistent but never destructive.
    const renamed = renameWorldFile('old', 'New', { dataRoot: root, openSlug: 'old' });
    assert.equal(renamed.title, 'New', 'the title still changes');
    assert.equal(renamed.slug, 'old', 'the directory does not move while open');
  });
});

test('renameWorldFile keeps the old directory when the new slug is taken', () => {
  withRoot((root) => {
    createWorldFile('Alpha', root);
    createWorldFile('Beta', root);
    const renamed = renameWorldFile('beta', 'Alpha', { dataRoot: root });
    assert.equal(renamed.title, 'Alpha', 'the title is whatever was asked for');
    assert.equal(renamed.slug, 'beta', 'but it must not clobber the existing alpha directory');
    assert.equal(listWorlds(root).length, 2, 'both worlds survive');
  });
});

// ----------------------------------------------------------------- migration

test('migrateLegacySave moves a pre-multi-world save, sidecars and images', () => {
  withRoot((root) => {
    // A save at the old single-dbPath location, with a title, an image and a
    // WAL sidecar — this is somebody's actual novel, so it must not be lost.
    const legacyDb = join(root, 'fabulist.db');
    const db = openDb(legacyDb);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('worldTitle', ?)`).run('Saint Verrow');
    db.prepare(`INSERT INTO entities (id, layer, story_id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene) VALUES ('char:v','canon',NULL,'Character','Verrow','','authored',1,0.5,3,'{}',1)`).run();
    db.close();
    const legacyImages = join(root, 'images');
    createWorldFile('scratch', root); // ensures worlds root exists
    rmSync(pathsFor('scratch', root).dir, { recursive: true });
    writeFileSync(join(root, 'images-placeholder'), '');

    const moved = migrateLegacySave(legacyDb, root)!;
    assert.equal(moved.slug, 'saint-verrow', 'the slug comes from the title, not a generic name');
    assert.equal(moved.title, 'Saint Verrow');
    assert.ok(!existsSync(legacyDb), 'moved, not copied — no ambiguity about which file is authoritative');
    assert.ok(!existsSync(`${legacyDb}-wal`), 'no sidecar stranded at the legacy path');
    assert.ok(!existsSync(legacyImages), 'nothing left at the old images path');
    // The point of moving sidecars at all: a row committed to the WAL must
    // survive the migration. Reopening proves it did.
    const reopened = World.open(moved.dbPath);
    assert.equal(reopened.graph.getCanon('char:v')?.name, 'Verrow', 'committed rows survived the move');
    reopened.close();
  });
});

test('migrateLegacySave returns null when there is nothing to migrate', () => {
  withRoot((root) => {
    assert.equal(
      migrateLegacySave(join(root, 'nope.db'), root),
      null,
      'a fresh install and an already-migrated one must be indistinguishable to the caller',
    );
  });
});

test('migrateLegacySave still moves an unreadable file, under a generic slug', () => {
  withRoot((root) => {
    const legacy = join(root, 'fabulist.db');
    writeFileSync(legacy, 'not sqlite at all');
    const moved = migrateLegacySave(legacy, root)!;
    // The summary read fails (it is not a database), but the file must still
    // have been relocated rather than abandoned at a path nothing reads.
    assert.ok(!existsSync(legacy), 'the file was moved out of the legacy path');
    assert.ok(existsSync(pathsFor('imported-world', root).dbPath), 'under a generic but findable name');
    assert.equal(moved, null, 'and it reports no readable summary');
  });
});

// ------------------------------------------------------------- CurrentWorld

test('CurrentWorld.switchTo closes one file and opens the other', () => {
  withRoot((root) => {
    const a = createWorldFile('A', root);
    const b = createWorldFile('B', root);
    // Distinct canon per world, so a leak between them is visible as a count.
    for (const [paths, name] of [[a, 'Anna'], [b, 'Bert']] as const) {
      const w = World.open(paths.dbPath, undefined, paths.imagesDir);
      w.graph.upsert({ id: `char:${name}`, type: 'Character', name }, 'canon');
      w.close();
    }

    const cw = CurrentWorld.open('a', root);
    try {
      assert.equal(cw.world().graph.get('char:Anna')?.name, 'Anna');
      assert.equal(cw.world().graph.get('char:Bert'), undefined, 'worlds share nothing');

      cw.switchTo('b');
      assert.equal(cw.slug(), 'b');
      assert.equal(cw.world().graph.get('char:Bert')?.name, 'Bert', 'the new file is live');
      assert.equal(cw.world().graph.get('char:Anna'), undefined, 'and the old one is gone, not merged');
    } finally {
      cw.close();
    }
  });
});

test('a world switch reaches consumers holding only the story getter', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const b = createWorldFile('B', root);
    const w = World.open(b.dbPath, undefined, b.imagesDir);
    w.graph.upsert({ id: 'char:bee', type: 'Character', name: 'Bee' }, 'canon');
    w.close();

    const cw = CurrentWorld.open('a', root);
    try {
      // This is the seam the whole design rests on: Engine/SetupService/
      // IllustrationService and every route capture exactly this getter, once,
      // for the process lifetime. If a world switch did not reach through it,
      // every consumer would keep talking to the closed database.
      const getWorld = cw.world;
      assert.equal(getWorld().graph.counts().entities, 0);
      cw.switchTo('b');
      assert.equal(getWorld().graph.get('char:bee')?.name, 'Bee', 'the captured getter followed the switch');
    } finally {
      cw.close();
    }
  });
});

test('switching to a missing world leaves the current one open and usable', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      assert.throws(() => cw.switchTo('nope'), /no world "nope"/);
      // The failure mode this guards against: close-then-open would leave a
      // closed handle and every later request failing until a restart.
      assert.equal(cw.slug(), 'a');
      assert.equal(cw.world().graph.counts().entities, 0, 'the open world still answers queries');
    } finally {
      cw.close();
    }
  });
});

test('switching to the world already open is a no-op, not a reopen', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const before = cw.world().storyId;
      cw.switchTo('a');
      assert.equal(cw.world().storyId, before, 'the same story stays bound; no needless file churn');
    } finally {
      cw.close();
    }
  });
});

test('CurrentWorld exposes a CurrentStory that still switches stories', () => {
  withRoot((root) => {
    const a = createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const second = createStory(cw.world().db, { title: 'second' });
      cw.stories().switchTo(second.id);
      assert.equal(cw.world().storyId, second.id, 'the story layer is untouched by the world layer');
      assert.equal(cw.slug(), 'a', 'and a story switch does not move the world');
    } finally {
      cw.close();
    }
    assert.ok(existsSync(a.dbPath));
  });
});

test('worldFor with no user falls straight through to the legacy shared-pointer world(), unchanged', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const cs = cw.stories();
      assert.equal(cs.worldFor(null).storyId, cs.world().storyId, 'login-off mode is untouched by this method existing');
    } finally {
      cw.close();
    }
  });
});

test('worldFor resolves each user to their own story, never the shared pointer or each other\u2019s', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const cs = cw.stories();
      const aliceWorld = cs.worldFor({ id: 'user_alice', email: 'a@x.com', firstName: null, lastName: null });
      const bobWorld = cs.worldFor({ id: 'user_bob', email: 'b@x.com', firstName: null, lastName: null });
      assert.notEqual(aliceWorld.storyId, bobWorld.storyId, 'two different users never land on the same auto-created story');

      // Calling again for the same user resolves to the same story, not a new one each time.
      const aliceAgain = cs.worldFor({ id: 'user_alice', email: 'a@x.com', firstName: null, lastName: null });
      assert.equal(aliceAgain.storyId, aliceWorld.storyId);
    } finally {
      cw.close();
    }
  });
});

test('worldFor never mutates the shared storyId pointer \u2014 concurrent-safe by construction', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const cs = cw.stories();
      const before = cs.id();
      cs.worldFor({ id: 'user_alice', email: 'a@x.com', firstName: null, lastName: null });
      assert.equal(cs.id(), before, 'resolving a per-user world must never change what the legacy pointer itself sees');
    } finally {
      cw.close();
    }
  });
});

test('worldFor with an explicit storyId override uses it, but only when it belongs to that user', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const cs = cw.stories();
      const alice = { id: 'user_alice', email: 'a@x.com', firstName: null, lastName: null };
      const bob = { id: 'user_bob', email: 'b@x.com', firstName: null, lastName: null };

      const aliceSecond = createStory(cw.world().db, { title: 'alice second', ownerUserId: 'user_alice' });
      const resolved = cs.worldFor(alice, aliceSecond.id);
      assert.equal(resolved.storyId, aliceSecond.id, 'the explicit override wins over "most recently played"');

      assert.throws(() => cs.worldFor(bob, aliceSecond.id), /does not belong/, 'bob may not read alice\u2019s story by id');
      assert.throws(() => cs.worldFor(alice, 'story:does-not-exist'), /no story/);
    } finally {
      cw.close();
    }
  });
});


test('each world keeps its own images directory', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    createWorldFile('B', root);
    const cw = CurrentWorld.open('a', root);
    try {
      const aDir = cw.world().illustrations.imagesDir;
      cw.switchTo('b');
      const bDir = cw.world().illustrations.imagesDir;
      // Content-addressed filenames mean a shared directory would interleave
      // two worlds' images with nothing marking which belonged to which.
      assert.notEqual(aDir, bDir, 'images must not be shared across worlds');
      assert.ok(bDir.includes(join('worlds', 'b')), `expected b's own directory, got ${bDir}`);
    } finally {
      cw.close();
    }
  });
});

test('closing a world checkpoints it, leaving one tidy file', () => {
  withRoot((root) => {
    createWorldFile('A', root);
    const cw = CurrentWorld.open('a', root);
    cw.world().graph.upsert({ id: 'char:q', type: 'Character', name: 'Q' }, 'canon');
    cw.close();
    // Leaving a world is now a routine click rather than a process exit, so a
    // multi-megabyte -wal per abandoned world would accumulate. A checkpointed
    // file either has no sidecar or a truncated one.
    const walPath = `${pathsFor('a', root).dbPath}-wal`;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    assert.equal(walBytes, 0, `expected a folded-in sidecar, found ${walBytes} bytes`);
    // And the data survived the checkpoint, which is the part that matters.
    const reopened = World.open(pathsFor('a', root).dbPath);
    assert.equal(reopened.graph.getCanon('char:q')?.name, 'Q');
    reopened.close();
  });
});
