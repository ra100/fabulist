import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, withPg } from './pg-harness.ts';
import type { Db } from '../src/db/pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { World } from '../src/store/index-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { agentDelta } from '../src/loop/roles-pg.ts';
import {
  commitNarrationTool,
  createStoryTool,
  getGuideTool,
  getStateTool,
  proposeTurnTool,
  switchStoryTool,
  type McpToolContext,
} from '../src/mcp/tools-pg.ts';

const AGENT_WORLD = {
  entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman', summary: 'Keeps the river crossing.' }],
  edgeAsserts: [
    { subject: 'char:ferryman-oll', predicate: 'OWES', object: 'char:brother-anselm' },
    { subject: 'char:nobody', predicate: 'KNOWS', object: 'char:brother-anselm' },
  ],
  factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'], suspectedBy: ['char:sister-oria'] }],
  threadUpdates: [{ title: 'The night ferry', stakes: 'who crosses unseen', parties: ['char:ferryman-oll'] }],
  events: [
    {
      text: 'Anselm strikes a bargain with Oll.',
      participants: ['char:brother-anselm', 'char:ferryman-oll'],
      significance: 0.9,
    },
  ],
};

async function seededStory(db: Db): Promise<World> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  await seedWorld(world);
  return world;
}

async function pgContext(db: Db, extractId = 'mock') {
  const world = await seededStory(db);
  const engine = new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider({ id: extractId })) });
  const ctx: McpToolContext = { db, world: async () => world, engine, dataRoot: 'data', selectStory: () => {} };
  return { world, engine, ctx };
}

test('PostgreSQL MCP story tools report upkeep and follow a mid-session provider swap', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seededStory(db);
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()));
    const engine = new Engine({ world: () => world, db, providers: registry });
    const ctx: McpToolContext = {
      db,
      world: async () => world,
      engine,
      dataRoot: 'data',
      selectStory: () => {},
      lintBlocklist: () => ['stock phrase'],
    };

    assert.equal((await getStateTool(ctx)).upkeep, 'agent');
    assert.equal((await createStoryTool(ctx, { title: 'Second' })).upkeep, 'agent');
    assert.equal((await switchStoryTool(ctx, { id: world.storyId })).upkeep, 'agent');
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    assert.equal(proposal.upkeep, 'agent');
    const guide = await getGuideTool(ctx);
    assert.ok(guide.upkeepChecklist?.length);
    assert.match(guide.writing.rules, /You do not invent world facts/);
    assert.deepEqual(guide.writing.blocklist, ['stock phrase']);

    registry.swap(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' })), 'stub');
    assert.equal((await getStateTool(ctx)).upkeep, 'server', 'no reconnect needed');
    assert.equal((await getGuideTool(ctx)).upkeepChecklist, undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL agentDelta validates an agent world and records the present cast on the fallback event', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seededStory(db);
    const { delta, validation } = await agentDelta(
      world,
      { edgeAsserts: [{ subject: 'char:brother-anselm', predicate: 'DISTRUSTS', object: 'char:nobody' }] },
      'Anselm waits by the door.',
    );
    assert.equal(validation.ok, true);
    assert.equal(delta.events.length, 1);
    assert.ok(delta.events[0]!.participants.includes('char:brother-anselm'));
    assert.equal(delta.events[0]!.locationId, 'loc:the-scriptorium');
    assert.equal(delta.edgeAsserts.length, 0);
    assert.ok(validation.issues.some((i) => i.repaired && /char:nobody/.test(i.message)));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL commit_narration with agent upkeep commits the world delta and reports what was dropped', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, {
      resumeToken: proposal.resumeToken,
      prose: 'Anselm strikes a bargain with the ferryman.',
      world: AGENT_WORLD,
    });
    if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
    assert.equal(out.upkeep, 'agent');
    assert.equal(out.applied.entityUpserts, 1);
    assert.equal(out.applied.edgeAsserts, 1);
    assert.ok(out.dropped.some((issue) => /char:nobody/.test(issue.message)));
    assert.equal(out.newThreads.length, 1);
    assert.equal((await world.graph.get('char:ferryman-oll'))?.name, 'Oll the Ferryman');
    assert.ok((await world.graph.neighbours('char:ferryman-oll')).some((n) => n.edge.predicate === 'OWES'));
    assert.ok(
      (await world.chronicle.knowledgeOf('char:sister-oria')).some((k) => k.level === 'suspects' && /ferry runs/.test(k.text)),
    );
    assert.ok((await world.threads.all()).some((thread) => thread.title === 'The night ferry'));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL commit_narration with server upkeep ignores world and says so', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db, 'stub-extractor');
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, {
      resumeToken: proposal.resumeToken,
      prose: 'Anselm warms the ink.',
      world: AGENT_WORLD,
    });
    if (out.status !== 'narrated') throw new Error('expected narrated');
    assert.equal(out.upkeep, 'server');
    assert.match(out.warning ?? '', /ignored world/);
    assert.equal(await world.graph.get('char:ferryman-oll'), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL commit_narration seeds consequences in its own checkpoint, like play', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'A bargain.', world: AGENT_WORLD });
    if (out.status !== 'narrated') throw new Error('expected narrated');
    assert.ok(out.consequencesSeeded > 0);
    assert.ok((await world.consequences.all()).length >= out.consequencesSeeded);
    const count = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM history_checkpoints WHERE story_id = $1`,
      [world.storyId],
    );
    assert.equal(Number(count?.count), 2);
  });
  if (!ran) t.skip('no Postgres configured');
});
