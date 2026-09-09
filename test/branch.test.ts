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
import { branchSave, firstSceneOfChapter, forkStory, rollback, truncateToScene } from '../src/loop/branch.ts';
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

// -------------------------------------------------------------- forkStory

test('forkStory with no atScene creates an empty, non-overlapping story that shares canon', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const result = forkStory(world, { fromStoryId: world.storyId, title: 'a second playthrough' });
  assert.equal(result.copiedFrom, null);
  assert.equal(result.copiedUpToScene, null);
  assert.equal(result.story.forkedFrom, null, 'not a continuation, so no lineage recorded');

  const fresh = world.withStory(result.story.id);
  assert.equal(fresh.chronicle.turns().length, 0, 'nothing copied');
  assert.equal(fresh.threads.open().length, 0);
  assert.ok(fresh.graph.counts().entities > 15, 'canon is shared, not copied');
  assert.equal(fresh.session.get().scene, 1, 'a brand-new story starts at scene 1');

  // The original story is completely unaffected by the fork existing.
  assert.ok(world.chronicle.turns().length > 0);
  world.close();
});

test('forkStory with atScene copies chronicle forward with fresh, non-colliding ids', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world); // scenes 1-3, several turns/events/facts/threads

  const beforeTurns = world.chronicle.turns().length;
  const beforeFacts = world.chronicle.facts().length;
  const beforeThreads = world.threads.open(50).length;

  const result = forkStory(world, { fromStoryId: world.storyId, title: 'continued', atScene: 2 });
  assert.equal(result.copiedFrom, world.storyId);
  assert.equal(result.copiedUpToScene, 2);
  assert.equal(result.story.forkedFrom, world.storyId);
  assert.equal(result.story.forkedAtScene, 2);

  const forked = world.withStory(result.story.id);

  // Everything scoped to scene < 2 made it across.
  assert.equal(forked.chronicle.turns().length, world.chronicle.turns({ scene: undefined }).filter((t) => t.scene < 2).length);
  assert.ok(forked.chronicle.turns().length > 0);
  assert.equal(forked.session.get().scene, 2, 'the fork resumes exactly where the copy ends');

  // The original story's own rows are completely untouched: same counts,
  // same ids, no row lost to the copy and no row silently shared.
  assert.equal(world.chronicle.turns().length, beforeTurns);
  assert.equal(world.chronicle.facts().length, beforeFacts);
  assert.equal(world.threads.open(50).length, beforeThreads);

  // The defining property of the fix: every copied row's id is a *new* id,
  // not the original's — reproduced directly before the fix that copying
  // with the original id collided with the still-existing source row.
  const originalTurnIds = new Set(world.chronicle.turns().map((t) => t.id));
  const forkedTurnIds = forked.chronicle.turns().map((t) => t.id);
  assert.ok(forkedTurnIds.length > 0);
  for (const id of forkedTurnIds) assert.ok(!originalTurnIds.has(id), `forked turn id ${id} must not equal any original turn id`);

  const originalFactIds = new Set(world.chronicle.facts().map((f) => f.id));
  for (const f of forked.chronicle.facts()) assert.ok(!originalFactIds.has(f.id), 'forked fact ids are fresh too');

  world.close();
});

test('forkStory preserves fact_knowledge (epistemic state) under the remapped fact ids', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  // playHistory records a fact known specifically by novice-tem, at scene 3;
  // fork before that scene closes so the copy actually includes it.
  const fact = world.chronicle.facts().find((f) => f.text.includes('Anselm drew a knife'));
  assert.ok(fact, 'the seeded fact from playHistory exists');
  assert.ok(world.chronicle.knows('char:novice-tem', fact!.id));

  const result = forkStory(world, { fromStoryId: world.storyId, atScene: 4 });
  const forked = world.withStory(result.story.id);

  const forkedFact = forked.chronicle.facts().find((f) => f.text === fact!.text);
  assert.ok(forkedFact, 'the fact itself was copied');
  assert.notEqual(forkedFact!.id, fact!.id, 'under a fresh id');
  assert.ok(forked.chronicle.knows('char:novice-tem', forkedFact!.id), 'knowledge of it survived the id remap');
  // The original fact's own knowledge entry is untouched by the fork: still
  // exactly one knower, under the original id, not duplicated onto it.
  assert.ok(world.chronicle.knows('char:novice-tem', fact!.id), 'the original story keeps its own knowledge entry');
  assert.equal(world.chronicle.knowersOf(fact!.id).length, 1, 'not duplicated onto the original fact id');
  world.close();
});

test('a forked story plays forward independently with the engine, no dangling references', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const result = forkStory(world, { fromStoryId: world.storyId, atScene: 2 });
  const forked = world.withStory(result.story.id);
  const engine = new Engine({ world: forked, providers: new ProviderRegistry(new MockProvider()) });

  const out = await engine.takeTurn('i go to the tavern by the gate');
  assert.equal(out.kind, 'narrated');
  assert.equal(forked.chronicle.turns().length, 2, "scene 1's copied turn plus the new one");

  // The original story's turn count is exactly what it was before the fork
  // and the fork's own subsequent play — nothing leaked backward.
  const originalTurns = world.chronicle.turns().length;
  await engine.takeTurn('i wait quietly');
  assert.equal(world.chronicle.turns().length, originalTurns, 'playing the fork never touches the original');
  world.close();
});

test('forkStory refuses a scene below 1 and an unknown source story', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  assert.throws(() => forkStory(world, { fromStoryId: world.storyId, atScene: 0 }), /scene must be 1/);
  assert.throws(() => forkStory(world, { fromStoryId: 'story:does-not-exist' }), /no story/);
  world.close();
});

// --------------------------------------------------------------- rollback

test('rollback defaults to fork mode: the original story is left completely untouched', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world); // scenes 1-3
  world.session.set({ scene: 3, turn: 1 });

  const beforeTurns = world.chronicle.turns().length;
  const result = rollback(world, { scene: 2 });
  assert.equal(result.mode, 'fork');
  assert.equal(result.toScene, 2);
  assert.ok(result.forkedStory, 'a fork mode result names the new story');
  assert.equal(result.removed, undefined, 'fork mode reports no deletion counts — nothing was deleted');

  // The original story: same turn count, still sitting at scene 3, exactly
  // as if rollback had never been called.
  assert.equal(world.chronicle.turns().length, beforeTurns);
  assert.equal(world.session.get().scene, 3);

  // The fork: stops at the rollback point, same as any atScene fork.
  const forked = world.withStory(result.forkedStory!.id);
  assert.equal(forked.session.get().scene, 2);
  assert.ok(forked.chronicle.turns().length < beforeTurns, 'the tail is not in the fork');
  world.close();
});

test('rollback in destructive mode truncates the current story in place, with no sibling', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.session.set({ scene: 3, turn: 1 });
  const storiesBefore = world.db.prepare(`SELECT COUNT(*) n FROM stories`).get() as { n: number };

  const result = rollback(world, { scene: 2, mode: 'destructive' });
  assert.equal(result.mode, 'destructive');
  assert.equal(result.toScene, 2);
  assert.ok(result.removed && result.removed.turns >= 1, 'destructive mode reports what it deleted');
  assert.equal(result.forkedStory, undefined, 'destructive mode names no fork');

  assert.equal(world.session.get().scene, 2, 'the current story itself moved back');
  const storiesAfter = world.db.prepare(`SELECT COUNT(*) n FROM stories`).get() as { n: number };
  assert.equal(storiesAfter.n, storiesBefore.n, 'no sibling story was created');
  world.close();
});

test('rollback by chapter resolves to the first scene recorded in that chapter', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.chronicle.upsertScene(1, { chapter: 1 });
  world.chronicle.upsertScene(2, { chapter: 1 });
  world.chronicle.upsertScene(3, { chapter: 2 });
  world.session.set({ scene: 3, turn: 1 });

  assert.equal(firstSceneOfChapter(world, 1), 1);
  assert.equal(firstSceneOfChapter(world, 2), 3);
  assert.equal(firstSceneOfChapter(world, 3), undefined, 'a chapter with no recorded scenes has nothing to roll back to');

  const result = rollback(world, { chapter: 2, mode: 'destructive' });
  assert.equal(result.toScene, 3, 'chapter 2 started at scene 3');
  world.close();
});

test('rollback refuses ambiguous input (both or neither of scene/chapter)', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  assert.throws(() => rollback(world, {}), /exactly one/);
  assert.throws(() => rollback(world, { scene: 1, chapter: 1 }), /exactly one/);
  world.close();
});

test('rollback refuses a scene that has not happened yet, and a scene below 1', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.session.set({ scene: 2, turn: 0 });
  assert.throws(() => rollback(world, { scene: 5 }), /has not happened yet/);
  assert.throws(() => rollback(world, { scene: 0 }), /scene must be 1/);
  world.close();
});

test('rollback by chapter refuses a chapter with no recorded scenes', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  assert.throws(() => rollback(world, { chapter: 9 }), /no recorded scenes/);
  world.close();
});
