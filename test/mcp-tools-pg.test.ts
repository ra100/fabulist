import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, withPg } from './pg-harness.ts';
import { createStory } from '../src/store/world-pg.ts';
import { World } from '../src/store/index-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { HistoryStore } from '../src/store/history-pg.ts';
import {
  rollbackTool,
  splitSceneTool,
  updateKnobsTool,
  updateSheetTool,
  updateStyleTool,
  type McpToolContext,
} from '../src/mcp/tools-pg.ts';

test('PostgreSQL MCP authoring writes serialize one same-story checkpoint each', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
    const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
    const world = await World.forStory(db, story.id);
    await seedWorld(world);
    const engine = new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider()) });
    const ctx: McpToolContext = { db, world: async () => world, engine, dataRoot: 'data' };

    await updateStyleTool(ctx, { register: 'plain' });
    assert.equal((await world.session.get()).style.register, 'plain');
    await updateSheetTool(ctx, { id: 'char:brother-anselm', condition: { mood: 'alert' } });
    assert.equal((await world.cast.get('char:brother-anselm'))?.condition.mood, 'alert');
    const firstCount = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM history_checkpoints WHERE story_id = $1`,
      [world.storyId],
    );
    assert.equal(Number(firstCount?.count), 2, 'MCP style and sheet writes match REST checkpoint behavior');

    await Promise.all([updateKnobsTool(ctx, { pacing: 0.2 }), updateKnobsTool(ctx, { danger: 0.8 })]);
    const knobs = (await world.session.get()).knobs;
    assert.equal(knobs.pacing, 0.2, 'the second mutation reads after the first transaction commits');
    assert.equal(knobs.danger, 0.8);
    const checkpoints = await db.query<{ position: number }>(
      `SELECT position FROM history_checkpoints WHERE story_id = $1 ORDER BY position`,
      [world.storyId],
    );
    assert.deepEqual(
      checkpoints.rows.map((checkpoint) => Number(checkpoint.position)),
      [1, 2, 3, 4],
      'each serialized MCP mutation has exactly one ordered checkpoint',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL MCP authoring mutation rolls back when checkpoint capture fails', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
    const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
    const world = await World.forStory(db, story.id);
    await seedWorld(world);
    const engine = new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider()) });
    const ctx: McpToolContext = { db, world: async () => world, engine, dataRoot: 'data' };
    const before = (await world.session.get()).style;
    const originalCapture = HistoryStore.prototype.capture;
    HistoryStore.prototype.capture = async function () {
      throw new Error('checkpoint persistence failed');
    };
    try {
      await assert.rejects(() => updateStyleTool(ctx, { register: 'plain' }), /checkpoint persistence failed/);
    } finally {
      HistoryStore.prototype.capture = originalCapture;
    }
    assert.deepEqual(
      (await world.session.get()).style,
      before,
      'MCP reports the capture error and leaves no unprotected edit',
    );
    const count = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM history_checkpoints WHERE story_id = $1`,
      [world.storyId],
    );
    assert.equal(Number(count?.count), 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL MCP rollback and scene split tools preserve exact target semantics', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
    const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
    const world = await World.forStory(db, story.id);
    await seedWorld(world);
    const engine = new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider()) });
    const ctx: McpToolContext = { db, world: async () => world, engine, dataRoot: 'data' };
    await engine.takeTurn('i warm the ink');
    await engine.takeTurn('i check the door');
    await engine.takeTurn('i hide the psalter');
    const turns = await world.chronicle.turns();

    const rollback = await rollbackTool(ctx, { turnId: turns[1]!.id });
    assert.equal(rollback.mode, 'fork');
    assert.equal(rollback.toTurnId, turns[1]!.id);
    assert.equal((await world.chronicle.turns()).length, 3, 'the source remains intact');
    assert.equal((await (await World.forStory(db, rollback.story!.id)).chronicle.turns()).length, 2);
    await assert.rejects(() => rollbackTool(ctx, {}), /exactly one/);
    await assert.rejects(() => rollbackTool(ctx, { scene: 1, turnId: turns[1]!.id }), /exactly one/);

    const split = await splitSceneTool(ctx, { turnId: turns[1]!.id });
    assert.equal(split.startsAtTurnId, turns[1]!.id);
    assert.equal(split.scene, 2);
    await assert.rejects(() => splitSceneTool(ctx, { turnId: turns[1]!.id }), /already starts a scene/);
    await assert.rejects(() => splitSceneTool(ctx, { turnId: 'turn:unknown' }), /unknown/);

    const legacy = await world.chronicle.addTurn({
      scene: 2,
      turn: 99,
      rawInput: 'legacy turn',
      intent: null,
      delta: null,
      bookProse: 'Legacy prose.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });
    await assert.rejects(() => splitSceneTool(ctx, { turnId: legacy.id }), /legacy/);
    await assert.rejects(() => rollbackTool(ctx, { turnId: legacy.id }), /legacy/);
  });
  if (!ran) t.skip('no Postgres configured');
});
