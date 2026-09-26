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
import {
  createStoryTool,
  getGuideTool,
  getStateTool,
  proposeTurnTool,
  switchStoryTool,
  type McpToolContext,
} from '../src/mcp/tools-pg.ts';

async function seededStory(db: Db): Promise<World> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  await seedWorld(world);
  return world;
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
