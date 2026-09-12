import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/store/index.ts';
import { emptyDelta, type Turn } from '../src/domain/types.ts';
import { commitDelta, commitTurn } from '../src/loop/commit.ts';
import { recordAuthoringCheckpoint, splitSceneAtTurn, storyLayout } from '../src/loop/history.ts';
import { Compactor } from '../src/loop/compact.ts';
import { exportMarkdown } from '../src/loop/export.ts';
import { buildNarratorFrame } from '../src/frame/builders.ts';
import { tokenizerFor } from '../src/frame/tokenizer.ts';
import { MockProvider } from '../src/providers/mock.ts';

function turnInput(turn: number): Omit<Turn, 'id' | 'createdAt'> {
  return {
    scene: 1,
    turn,
    rawInput: `action ${turn}`,
    intent: null,
    delta: null,
    bookProse: `Turn ${turn}.`,
    pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  };
}

test('history checkpoint restores the exact story projection', () => {
  const world = World.open(':memory:');
  world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'Player' }, 'canon');
  const sheet = world.cast.getOrBlank('char:pc');
  sheet.condition.mood = 'steady';
  world.cast.put(sheet);

  const legacy = world.chronicle.addTurn(turnInput(0));
  const first = world.chronicle.addTurn(turnInput(1));
  world.history.capture(first.id);
  world.cast.updateCondition('char:pc', { mood: 'afraid' });
  const second = world.chronicle.addTurn(turnInput(2));
  world.history.capture(second.id);

  const checkpoint = world.history.checkpointForTurn(first.id);
  assert.ok(checkpoint);
  world.history.restore(checkpoint);

  assert.equal(world.cast.get('char:pc')?.condition.mood, 'steady');
  assert.deepEqual(
    world.history.eligibleTurns().map(({ turnId }) => turnId),
    [first.id, second.id],
    'legacy turns remain ineligible and later checkpoint records remain immutable',
  );
  assert.equal(world.history.eligibleTurn(legacy.id), undefined);
  assert.equal(world.history.startsScene(first.id), true);
  world.close();
});

test('legacy turn has no eligible checkpoint', () => {
  const world = World.open(':memory:');
  const legacy = world.chronicle.addTurn(turnInput(1));
  assert.equal(world.history.checkpointForTurn(legacy.id), undefined);
  assert.equal(world.history.eligibleTurn(legacy.id), undefined);
  world.close();
});

test('committed turn checkpoint is retained when authoring checkpoints are recorded', () => {
  const world = World.open(':memory:');
  const { turn } = commitTurn(world, {
    ...turnInput(1),
    rawInput: 'take the lantern',
    delta: emptyDelta(),
    bookProse: 'The lantern is taken.',
  });

  const checkpoint = world.history.checkpointForTurn(turn.id);
  assert.ok(checkpoint);
  assert.equal(world.history.eligibleTurn(turn.id)?.position, checkpoint.position);
  assert.deepEqual(
    { scene: checkpoint.state.session.scene, turn: checkpoint.state.session.turn },
    { scene: 1, turn: 1 },
    'the checkpoint is taken after the turn cursor advances',
  );

  world.session.set({ style: { ...world.session.get().style, register: 'plain' } });
  recordAuthoringCheckpoint(world);

  assert.deepEqual(world.history.checkpointForTurn(turn.id), checkpoint);
  const count = world.db.prepare(`SELECT COUNT(*) AS count FROM history_checkpoints WHERE story_id = ?`).get(world.storyId) as {
    count: number;
  };
  assert.equal(Number(count.count), 2);
  world.close();
});

test('partial commit delta creates no turn rollback checkpoint', () => {
  const world = World.open(':memory:');
  const legacy = world.chronicle.addTurn(turnInput(1));
  commitDelta(world, emptyDelta());
  assert.equal(world.history.checkpointForTurn(legacy.id), undefined);
  world.close();
});

test('split scene derives historical grouping and keeps continuation in the new segment', async () => {
  const world = World.open(':memory:');
  const turns = [1, 2, 3, 4].map((turn) =>
    commitTurn(world, { ...turnInput(turn), delta: emptyDelta(), bookProse: `Prose ${turn}.` }).turn,
  );
  world.chronicle.upsertScene(1, { title: 'Stale scene', summary: 'All four turns.' });
  world.chronicle.upsertChapter(1, { title: 'Stale chapter', summary: 'Stale rollup.' });

  const split = splitSceneAtTurn(world, turns[2]!.id);
  assert.equal(split.turnId, turns[2]!.id);
  assert.equal(split.position, world.history.eligibleTurn(turns[2]!.id)?.position);
  assert.deepEqual(
    storyLayout(world).turns.map(({ turnId, scene }) => [turnId, scene]),
    [[turns[0]!.id, 1], [turns[1]!.id, 1], [turns[2]!.id, 2], [turns[3]!.id, 2]],
  );
  assert.equal(world.history.startsScene(turns[2]!.id), true);
  assert.throws(() => splitSceneAtTurn(world, turns[2]!.id), /already starts a scene/);
  assert.deepEqual(
    { scene: world.session.get().scene, turn: world.session.get().turn },
    { scene: 2, turn: 4 },
  );
  assert.equal(world.chronicle.scenes()[0]?.summary, '');
  assert.equal(world.chronicle.chapter(1)?.summary, '');

  const compactor = new Compactor({ world, provider: new MockProvider(), minTurns: 1 });
  assert.ok(await compactor.summariseScene(1));
  const markdown = exportMarkdown(world);
  assert.ok(markdown.indexOf('### Scene 1') < markdown.indexOf('Prose 1.'));
  assert.ok(markdown.indexOf('### Scene 2') < markdown.indexOf('Prose 3.'));
  const frame = buildNarratorFrame({
    world, session: world.session.get(), tokenizer: tokenizerFor(4), budget: 20_000, rawInput: 'continue',
  });
  assert.match(frame.text, /scene 1:/);

  const continuation = commitTurn(world, { ...turnInput(5), delta: emptyDelta(), bookProse: 'Prose 5.' }).turn;
  const last = storyLayout(world).turns.at(-1)!;
  assert.equal(last.turnId, continuation.id);
  assert.equal(last.scene, 2);
  assert.equal(last.source.scene, 1);
  world.close();
});

test('invalid split targets leave history unchanged', () => {
  const world = World.open(':memory:');
  const legacy = world.chronicle.addTurn(turnInput(1));
  const committed = commitTurn(world, { ...turnInput(2), delta: emptyDelta() }).turn;
  assert.throws(() => splitSceneAtTurn(world, 'turn:unknown'), /unknown/);
  assert.throws(() => splitSceneAtTurn(world, legacy.id), /legacy/);
  world.db.prepare(`DELETE FROM history_checkpoints WHERE story_id = ? AND turn_id = ?`).run(world.storyId, committed.id);
  const before = {
    layout: storyLayout(world).turns.map((turn) => [turn.turnId, turn.scene]),
    segments: Number((world.db.prepare(`SELECT COUNT(*) AS n FROM scene_segments`).get() as { n: number }).n),
    session: world.session.get(),
  };
  assert.throws(() => splitSceneAtTurn(world, committed.id), /checkpoint/);
  assert.deepEqual(storyLayout(world).turns.map((turn) => [turn.turnId, turn.scene]), before.layout);
  assert.equal(Number((world.db.prepare(`SELECT COUNT(*) AS n FROM scene_segments`).get() as { n: number }).n), before.segments);
  assert.deepEqual(world.session.get(), before.session);
  world.close();
});

test('initial and normal raw-scene boundaries cannot be split', () => {
  const world = World.open(':memory:');
  const first = commitTurn(world, { ...turnInput(1), delta: emptyDelta() }).turn;
  world.session.set({ scene: 2, turn: 0 });
  const second = commitTurn(world, { ...turnInput(1), delta: emptyDelta() }).turn;
  const before = Number((world.db.prepare(`SELECT COUNT(*) AS n FROM scene_segments`).get() as { n: number }).n);

  assert.equal(world.history.startsScene(first.id), true);
  assert.equal(world.history.startsScene(second.id), true);
  assert.throws(() => splitSceneAtTurn(world, first.id), /already starts a scene/);
  assert.throws(() => splitSceneAtTurn(world, second.id), /already starts a scene/);
  assert.equal(Number((world.db.prepare(`SELECT COUNT(*) AS n FROM scene_segments`).get() as { n: number }).n), before);
  world.close();
});

test('restoring retained split history reconciles the continuation cursor', () => {
  const world = World.open(':memory:');
  const turns = Array.from({ length: 4 }, (_, index) =>
    commitTurn(world, { ...turnInput(index + 1), delta: emptyDelta() }).turn,
  );
  splitSceneAtTurn(world, turns[2]!.id);
  world.history.restoreTurn(turns[3]!.id);

  const session = world.session.get();
  assert.deepEqual({ scene: session.scene, turn: session.turn }, { scene: 2, turn: 4 });
  assert.ok(world.history.activeSegmentAt(4));
  world.close();
});
