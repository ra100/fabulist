import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/store/index.ts';
import { emptyDelta, type Turn } from '../src/domain/types.ts';
import { commitDelta, commitTurn } from '../src/loop/commit.ts';
import { recordAuthoringCheckpoint } from '../src/loop/history.ts';

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
