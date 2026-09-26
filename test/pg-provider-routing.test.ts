import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg, type RolePools } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, sessionUser, type Who } from './signed-in.ts';
import { World, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';
import { ProviderResolver } from '../src/providers/resolver-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { statusForError } from '../src/server/http.ts';
import { proposeTurnTool, type McpToolContext } from '../src/mcp/tools-pg.ts';
import type { Db } from '../src/db/pg.ts';

async function seededStory(db: Db, who: Who): Promise<string> {
  const worldId = await makeWorld(db, `verrow-${who}`, 'Saint Verrow');
  const story = await createStory(db, { title: `${who}’s book`, worldIds: [worldId], ownerUserId: PEOPLE[who].id });
  await seedWorld(await World.forStory(db, story.id));
  return story.id;
}

function mcpFor(roles: RolePools, engine: Engine, resolver: ProviderResolver, who: Who, storyId: string): McpToolContext {
  const user = sessionUser(who);
  return {
    world: () => World.forStory(roles.play, storyId),
    db: roles.play,
    user,
    engine,
    dataRoot: 'data',
    providers: (id) => resolver.forRequest(user, id),
  };
}

test('a locked provider key surfaces as 423, the caller\'s own state', () => {
  assert.equal(statusForError(new ProviderKeyLockedError()), 423);
});

test('HTTP turns, scene close and MCP proposals run on the per-request registry and meter as server usage', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const storyId = await seededStory(db, 'alice');
    const fallback = new MockProvider();
    const shared = new MockProvider({ id: 'server-stub' });
    const boot = () => worldFor(roles.play, null);
    const engine = new Engine({ world: boot, db: roles.play, ingestDb: roles.ingest, providers: new ProviderRegistry(fallback) });
    const resolver = new ProviderResolver({ db: roles.play, server: new ProviderRegistry(shared), shareServerProvider: () => true, secretsKey: null });
    const { as, close } = await listenSignedIn(
      createApiServer({ world: boot, db: roles.play, ingestDb: roles.ingest, engine, authConfig: fakeAuth(), providerResolver: resolver }),
    );
    try {
      for (const input of ['i warm the ink and keep copying', 'i check the door']) {
        const played = await as('alice', 'POST', '/api/play', { input });
        assert.equal(played.status, 200, JSON.stringify(played.body));
      }
      assert.equal((await as('alice', 'POST', '/api/scene/close', {})).status, 200);
    } finally {
      await close();
    }
    assert.equal(fallback.calls.length, 0, 'the engine default registry was never used');
    const seen = new Set(shared.calls.map((c) => c.role));
    assert.ok(seen.has('referee') && seen.has('extract') && seen.has('summarize'), [...seen].join(','));
    const metered = await db.query<{ role: string; key_source: string; story_id: string }>(
      `SELECT DISTINCT role, key_source, story_id FROM usage_events WHERE user_id = $1`,
      [PEOPLE.alice.id],
    );
    assert.ok(metered.rows.every((r) => r.key_source === 'server' && r.story_id === storyId));
    assert.ok(metered.rows.some((r) => r.role === 'referee') && metered.rows.some((r) => r.role === 'summarize'));

    const before = shared.calls.length;
    await proposeTurnTool(mcpFor(roles, engine, resolver, 'alice', storyId), { text: 'i trim the wick' });
    assert.ok(shared.calls.length > before, 'MCP propose ran on the resolved registry');
    assert.equal(fallback.calls.length, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('upkeep follows the registry resolved for the request', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const aliceStory = await seededStory(db, 'alice');
    const adminStory = await seededStory(db, 'admin');
    const boot = () => worldFor(roles.play, null);
    const engine = new Engine({ world: boot, db: roles.play, providers: new ProviderRegistry(new MockProvider()) });
    const resolver = new ProviderResolver({
      db: roles.play,
      server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
      shareServerProvider: () => false,
      secretsKey: null,
    });
    const agent = await proposeTurnTool(mcpFor(roles, engine, resolver, 'alice', aliceStory), { text: 'i trim the wick' });
    assert.equal(agent.upkeep, 'agent', 'no own key and no sharing: the agent keeps the world');
    const server = await proposeTurnTool(mcpFor(roles, engine, resolver, 'admin', adminStory), { text: 'i trim the wick' });
    assert.equal(server.upkeep, 'server');
  });
  if (!ran) t.skip('no Postgres configured');
});
