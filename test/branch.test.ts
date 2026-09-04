import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { branchSave, truncateToScene } from '../src/loop/branch.ts';
import { seedConsequences } from '../src/consequence/propagate.ts';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'story-branch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Plays a few scenes so there is a real history to branch away from. */
async function playHistory(world: World) {
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()), autoCompact: false });

  await engine.takeTurn('i warm the ink');
  world.session.set({ scene: 2, turn: 0 });

  const out = await engine.takeTurn('i hide the psalter under the loose flag');
  if (out.kind === 'narrated') seedConsequences(world, out.delta, out.commit.events);

  // Scene 3: the vow break, plus a relation that ends.
  world.session.set({ scene: 3, turn: 0 });
  world.graph.assertEdge({ subject: 'char:brother-anselm', predicate: 'CONFIDES_IN', object: 'char:novice-tem' }, 3);
  world.graph.retireEdge('char:brother-anselm', 'TRUSTS', 'char:sister-oria', 3);
  await engine.takeTurn('i stab the captain', { overrideIntegrity: true });
  const fact = world.chronicle.addFact('Anselm drew a knife in the yard', 3);
  world.chronicle.setKnowledge(fact.id, 'char:novice-tem', 'knows', 3);
}

test('truncating to a scene discards that scene and everything after it', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  assert.equal(world.chronicle.turns().length, 3);
  const removed = truncateToScene(world, 3);

  assert.equal(removed.turns, 1, 'only scene 3 was discarded');
  assert.equal(world.chronicle.turns().length, 2, 'scenes 1 and 2 survive');
  assert.ok(world.chronicle.turns().every((t) => t.scene < 3));
  assert.equal(world.session.get().scene, 3, 'play resumes at the branch point');
  assert.equal(world.session.get().turn, 0);
  world.close();
});

test('canon survives a branch untouched', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const canonBefore = world.graph.counts().canon;
  await playHistory(world);

  truncateToScene(world, 2);
  assert.equal(world.graph.counts().canon, canonBefore, 'a branch is a different playthrough, not a different universe');
  assert.ok(world.graph.getCanon('char:brother-anselm'), 'the source material is intact');
  world.close();
});

test('a vow broken in the discarded future is unbroken again', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const broken = world.cast.get('char:brother-anselm')!.contract.vows.find((v) => v.id === 'nonviolence')!;
  assert.equal(broken.broken, true, 'it was broken in scene 3');

  truncateToScene(world, 3);

  const after = world.cast.get('char:brother-anselm')!.contract.vows.find((v) => v.id === 'nonviolence')!;
  assert.equal(after.broken, false, 'the break was an event, and that event is gone');
  assert.equal(after.brokenScene, null);
  world.close();
});

test('a vow broken before the branch point stays broken', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  // The break happened in scene 3, so branching at 4 must preserve it.
  truncateToScene(world, 4);
  const vow = world.cast.get('char:brother-anselm')!.contract.vows.find((v) => v.id === 'nonviolence')!;
  assert.equal(vow.broken, true);
  assert.equal(vow.brokenScene, 3);
  world.close();
});

test('an edge retired in the discarded future is restored', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const liveBefore = world.graph.edgesFrom('char:brother-anselm').map((e) => e.predicate);
  assert.ok(!liveBefore.includes('TRUSTS'), 'the relation ended in scene 3');

  truncateToScene(world, 3);

  const liveAfter = world.graph.edgesFrom('char:brother-anselm').map((e) => e.predicate);
  assert.ok(
    liveAfter.includes('TRUSTS'),
    'it was live at the branch point, so the branch must not inherit an ending that never happened',
  );
  world.close();
});

test('an edge asserted in the discarded future is removed', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  assert.ok(world.graph.edgesFrom('char:brother-anselm').some((e) => e.predicate === 'CONFIDES_IN'));

  truncateToScene(world, 3);
  assert.ok(!world.graph.edgesFrom('char:brother-anselm').some((e) => e.predicate === 'CONFIDES_IN'));
  world.close();
});

test('facts and the knowledge of them are discarded together', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const late = world.chronicle.facts().find((f) => /drew a knife/.test(f.text));
  assert.ok(late, 'the fact existed');
  truncateToScene(world, 3);

  assert.ok(!world.chronicle.facts().some((f) => /drew a knife/.test(f.text)), 'the fact is gone');
  assert.ok(
    !world.chronicle.knowledgeOf('char:novice-tem').some((k) => /drew a knife/.test(k.text)),
    'and nobody remembers learning it',
  );
  // Seed-time facts are untouched.
  assert.ok(world.chronicle.facts().some((f) => /over the pass/.test(f.text)));
  world.close();
});

test('consequences seeded in the discarded future are discarded', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  assert.ok(world.consequences.all().length > 0);

  truncateToScene(world, 2);
  assert.equal(world.consequences.all().length, 0, 'nothing is left in motion from a future that did not happen');
  world.close();
});

test('emergent entities created in the discarded future are removed', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()), autoCompact: false });
  world.session.set({ scene: 5, turn: 0 });
  await engine.takeTurn('i go to the tavern by the gate');

  assert.ok(world.graph.search('tavern', 3).length > 0, 'the tavern was canonised');
  truncateToScene(world, 5);
  assert.equal(world.graph.search('tavern', 3).length, 0, 'and un-canonised by the branch');
  world.close();
});

test('branching a save on disk leaves the original completely untouched', async () => {
  const { dir, cleanup } = tmp();
  try {
    const originalPath = join(dir, 'main.db');
    const original = World.open(originalPath);
    seedWorld(original);
    await playHistory(original);
    const turnsBefore = original.chronicle.turns().length;
    const vowBefore = original.cast.get('char:brother-anselm')!.contract.vows[0]!.broken;
    original.close();

    const branchPath = join(dir, 'what-if.db');
    const res = branchSave({ fromPath: originalPath, toPath: branchPath, atScene: 3 });

    assert.equal(res.atScene, 3);
    assert.ok(existsSync(branchPath));

    const reopened = World.open(originalPath);
    assert.equal(reopened.chronicle.turns().length, turnsBefore, 'the source playthrough is intact');
    assert.equal(reopened.cast.get('char:brother-anselm')!.contract.vows[0]!.broken, vowBefore);
    reopened.close();

    const branch = World.open(branchPath);
    assert.ok(branch.chronicle.turns().length < turnsBefore, 'the branch has less history');
    assert.equal(branch.cast.get('char:brother-anselm')!.contract.vows[0]!.broken, false, 'and no vow break');
    assert.ok(branch.graph.getCanon('char:brother-anselm'), 'but the same canon');
    branch.close();
  } finally {
    cleanup();
  }
});

test('a branch is immediately playable and diverges independently', async () => {
  const { dir, cleanup } = tmp();
  try {
    const originalPath = join(dir, 'main.db');
    const original = World.open(originalPath);
    seedWorld(original);
    await playHistory(original);
    original.close();

    const branchPath = join(dir, 'branch.db');
    branchSave({ fromPath: originalPath, toPath: branchPath, atScene: 3 });

    const branch = World.open(branchPath);
    const engine = new Engine({ world: branch, providers: new ProviderRegistry(new MockProvider()), autoCompact: false });

    const out = await engine.takeTurn('i speak to him quietly instead');
    assert.equal(out.kind, 'narrated', 'the branch plays on from the fork point');
    assert.equal(branch.session.get().scene, 3);

    // The stronger property: because the vow was restored, the integrity gate is
    // live again on the branch even though it had already been broken upstream.
    const gated = await engine.takeTurn('i stab the captain');
    assert.equal(gated.kind, 'interrupted', 'the branch defends a vow the original had already lost');
    branch.close();

    // And the original still has its own future.
    const reopened = World.open(originalPath);
    assert.ok(reopened.chronicle.turns().some((t) => t.scene === 3), 'the original kept scene 3');
    reopened.close();
  } finally {
    cleanup();
  }
});

test('branching refuses to clobber an existing save unless told to', async () => {
  const { dir, cleanup } = tmp();
  try {
    const a = join(dir, 'a.db');
    const w = World.open(a);
    seedWorld(w);
    w.close();
    const b = join(dir, 'b.db');
    branchSave({ fromPath: a, toPath: b, atScene: 1 });
    assert.throws(() => branchSave({ fromPath: a, toPath: b, atScene: 1 }), /already exists/);
    branchSave({ fromPath: a, toPath: b, atScene: 1, overwrite: true });
  } finally {
    cleanup();
  }
});

test('branching a missing save fails clearly', () => {
  assert.throws(() => branchSave({ fromPath: '/nonexistent/x.db', toPath: '/tmp/y.db', atScene: 1 }), /no save at/);
});

test('branching before scene 1 is rejected', () => {
  const { dir, cleanup } = tmp();
  try {
    const a = join(dir, 'a.db');
    const w = World.open(a);
    seedWorld(w);
    w.close();
    assert.throws(() => branchSave({ fromPath: a, toPath: join(dir, 'b.db'), atScene: 0 }), /scene must be 1/);
  } finally {
    cleanup();
  }
});

test('the removal report accounts for what the branch discarded', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  const removed = truncateToScene(world, 2);
  assert.ok(removed.turns >= 2);
  assert.ok(removed.events > 0);
  assert.ok(removed.consequences > 0);
  assert.ok(removed.retiredEdgesRestored > 0, 'restored relations are reported too');
  world.close();
});
