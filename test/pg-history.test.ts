import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Turn } from '../src/domain/types.ts';
import { World } from '../src/store/index-pg.ts';
import { makeStory, makeWorld, withPg } from './pg-harness.ts';

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

test('history checkpoint restores the exact story projection', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'history');
    const storyId = await makeStory(db, 'history-story', [worldId]);
    const world = await World.forStory(db, storyId);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'Player' }, 'chronicle');
    const sheet = await world.cast.getOrBlank('char:pc');
    sheet.condition.mood = 'steady';
    await world.cast.put(sheet);

    const legacy = await world.chronicle.addTurn(turnInput(0));
    const first = await world.chronicle.addTurn(turnInput(1));
    await world.history.capture(first.id);
    await world.cast.updateCondition('char:pc', { mood: 'afraid' });
    const second = await world.chronicle.addTurn(turnInput(2));
    await world.history.capture(second.id);

    const checkpoint = await world.history.checkpointForTurn(first.id);
    assert.ok(checkpoint);
    await world.history.restore(checkpoint);
    assert.equal((await world.cast.get('char:pc'))?.condition.mood, 'steady');
    assert.deepEqual(
      (await world.history.eligibleTurns()).map(({ turnId }) => turnId),
      [first.id, second.id],
    );
    assert.equal(await world.history.eligibleTurn(legacy.id), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('private history checkpoints never fall back to plaintext', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'private-history');
    const storyId = await makeStory(db, 'private-history-story', [worldId]);
    await db.query(`UPDATE stories SET encryption_version = 1 WHERE id = $1`, [storyId]);
    const key = randomBytes(32);
    const unlocked = await World.forStory(db, storyId, undefined, { keyForStory: () => key });
    const turn = await unlocked.chronicle.addTurn(turnInput(1));
    const checkpoint = await unlocked.history.capture(turn.id);
    const stored = await db.one<{ state: unknown }>(`SELECT state FROM history_checkpoints WHERE id = $1`, [
      checkpoint.id,
    ]);
    assert.deepEqual(stored?.state, {});

    const locked = await World.forStory(db, storyId);
    await assert.rejects(() => locked.history.checkpointForTurn(turn.id), /locked/);
    const second = await unlocked.chronicle.addTurn(turnInput(2));
    await assert.rejects(() => locked.history.capture(second.id), /locked/);
    const count = await db.one<{ n: string }>(`SELECT count(*) n FROM history_checkpoints WHERE story_id = $1`, [
      storyId,
    ]);
    assert.equal(Number(count?.n), 1);
  });
  if (!ran) t.skip('no Postgres configured');
});
