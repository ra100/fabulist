import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Turn } from '../src/domain/types.ts';
import { World } from '../src/store/index-pg.ts';
import { makeStory, makeWorld, withPg } from './pg-harness.ts';
import { rollback } from '../src/loop/branch-pg.ts';
import { splitSceneAtTurn, storyLayout } from '../src/loop/history-pg.ts';
import { commitTurn } from '../src/loop/commit-pg.ts';
import { emptyDelta } from '../src/domain/types.ts';

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

    await unlocked.history.restore(checkpoint);
    assert.deepEqual(await unlocked.chronicle.getTurn(second.id), second);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('history checkpoint migration grants history tables to deployed play role', () => {
  const migration = readFileSync(new URL('../src/db/migrations-pg/006-turn-history.sql', import.meta.url), 'utf8');
  assert.match(migration, /ARRAY\['history_checkpoints', 'scene_segments'\]/);
  assert.match(migration, /ARRAY\['fabulist_play', 'fabulist_ingest'\]/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO %I/);
});

test('history checkpoint captures allocate unique positions per story inside transactions', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'history-concurrency');
    const storyId = await makeStory(db, 'history-concurrency-story', [worldId]);
    const world = await World.forStory(db, storyId);
    const first = await world.chronicle.addTurn(turnInput(1));
    const second = await world.chronicle.addTurn(turnInput(2));

    const checkpoints = await Promise.all(
      [first, second].map((turn) =>
        db.tx(async (client) => {
          const transactionalWorld = await World.forStory(client, storyId);
          return transactionalWorld.history.capture(turn.id);
        }),
      ),
    );

    assert.deepEqual(
      checkpoints.map(({ position }) => position).sort((a, b) => a - b),
      [1, 2],
    );
    assert.deepEqual(
      (await world.history.eligibleTurns()).map(({ position }) => position),
      [1, 2],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('turn rollback preserves the selected checkpoint and forks only retained history', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'turn-rollback');
    const storyId = await makeStory(db, 'turn-rollback-story', [worldId]);
    const world = await World.forStory(db, storyId);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'Player' }, 'chronicle');
    const sheet = await world.cast.getOrBlank('char:pc');
    sheet.condition.mood = 'steady';
    await world.cast.put(sheet);

    const first = await world.chronicle.addTurn(turnInput(1));
    await world.history.capture(first.id);
    await world.cast.updateCondition('char:pc', { mood: 'afraid' });
    await world.chronicle.addFact('The archive is sealed', 1);
    const second = await world.chronicle.addTurn(turnInput(2));
    await world.history.capture(second.id);
    await world.cast.updateCondition('char:pc', { mood: 'furious' });
    await world.chronicle.addFact('The archive burned', 1);
    const third = await world.chronicle.addTurn(turnInput(3));
    await world.history.capture(third.id);

    const forkResult = await rollback(db, world, { turnId: second.id });
    assert.equal(forkResult.toTurnId, second.id);
    assert.equal((await world.chronicle.turns()).length, 3, 'forking leaves the source untouched');
    const forked = await World.forStory(db, forkResult.story!.id);
    assert.deepEqual(
      (await forked.chronicle.turns()).map((turn) => turn.bookProse),
      [first.bookProse, second.bookProse],
    );
    assert.equal((await forked.history.eligibleTurns()).length, 2);

    const destructive = await rollback(db, world, { turnId: second.id, mode: 'destructive' });
    assert.equal(destructive.toTurnId, second.id);
    assert.deepEqual(
      (await world.chronicle.turns()).map(({ id }) => id),
      [first.id, second.id],
    );
    assert.equal((await world.cast.get('char:pc'))?.condition.mood, 'afraid');
    assert.ok((await world.chronicle.facts()).some((fact) => fact.text === 'The archive is sealed'));
    assert.ok(!(await world.chronicle.facts()).some((fact) => fact.text === 'The archive burned'));
    assert.equal(await world.history.checkpointForTurn(third.id), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('legacy turn rollback rejects the target without changing PostgreSQL history', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'legacy-turn-rollback');
    const storyId = await makeStory(db, 'legacy-turn-rollback-story', [worldId]);
    const world = await World.forStory(db, storyId);
    const legacy = await world.chronicle.addTurn(turnInput(1));
    const committed = await world.chronicle.addTurn(turnInput(2));
    await world.history.capture(committed.id);

    await assert.rejects(() => rollback(db, world, { turnId: legacy.id, mode: 'destructive' }), /legacy/);
    await assert.rejects(() => rollback(db, world, { turnId: 'turn:unknown', mode: 'destructive' }), /unknown/);
    await db.query(`DELETE FROM history_checkpoints WHERE story_id = $1 AND turn_id = $2`, [storyId, committed.id]);
    await assert.rejects(() => rollback(db, world, { turnId: committed.id, mode: 'destructive' }), /checkpoint/);
    assert.deepEqual(
      (await world.chronicle.turns()).map(({ id }) => id),
      [legacy.id, committed.id],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('split scene derives historical PostgreSQL grouping and rejects invalid targets', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'split-history');
    const storyId = await makeStory(db, 'split-history-story', [worldId]);
    const world = await World.forStory(db, storyId);
    const turns: Turn[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      turns.push((await commitTurn(db, world, { ...turnInput(turn), delta: emptyDelta() })).turn);
    }

    const split = await splitSceneAtTurn(world, turns[2]!.id);
    assert.equal(split.turnId, turns[2]!.id);
    assert.deepEqual(
      (await storyLayout(world)).turns.map(({ turnId, scene }) => [turnId, scene]),
      [[turns[0]!.id, 1], [turns[1]!.id, 1], [turns[2]!.id, 2], [turns[3]!.id, 2]],
    );
    const session = await world.session.get();
    assert.deepEqual({ scene: session.scene, turn: session.turn }, { scene: 2, turn: 4 });
    await assert.rejects(() => splitSceneAtTurn(world, turns[2]!.id), /already starts a scene/);
    await assert.rejects(() => splitSceneAtTurn(world, 'turn:unknown'), /unknown/);
    const legacy = await world.chronicle.addTurn(turnInput(5));
    await assert.rejects(() => splitSceneAtTurn(world, legacy.id), /legacy/);
    const missing = (await commitTurn(db, world, { ...turnInput(6), delta: emptyDelta() })).turn;
    await db.query(`DELETE FROM history_checkpoints WHERE story_id = $1 AND turn_id = $2`, [storyId, missing.id]);
    const before = {
      segments: Number((await db.one<{ n: string }>(`SELECT count(*) n FROM scene_segments WHERE story_id = $1`, [storyId]))!.n),
      session: await world.session.get(),
    };
    await assert.rejects(() => splitSceneAtTurn(world, missing.id), /checkpoint/);
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM scene_segments WHERE story_id = $1`, [storyId]))!.n),
      before.segments,
    );
    assert.deepEqual(await world.session.get(), before.session);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL split rejects initial and raw-scene boundaries', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'split-boundaries');
    const storyId = await makeStory(db, 'split-boundaries-story', [worldId]);
    const world = await World.forStory(db, storyId);
    const first = (await commitTurn(db, world, { ...turnInput(1), delta: emptyDelta() })).turn;
    await world.session.set({ scene: 2, turn: 0 });
    const second = (await commitTurn(db, world, { ...turnInput(1), delta: emptyDelta() })).turn;
    const before = Number((await db.one<{ n: string }>(
      `SELECT count(*) n FROM scene_segments WHERE story_id = $1`, [storyId],
    ))!.n);

    assert.equal(await world.history.startsScene(first.id), true);
    assert.equal(await world.history.startsScene(second.id), true);
    await assert.rejects(() => splitSceneAtTurn(world, first.id), /already starts a scene/);
    await assert.rejects(() => splitSceneAtTurn(world, second.id), /already starts a scene/);
    assert.equal(Number((await db.one<{ n: string }>(
      `SELECT count(*) n FROM scene_segments WHERE story_id = $1`, [storyId],
    ))!.n), before);
  });
  if (!ran) t.skip('no Postgres configured');
});
