/**
 * Limits on what one caller can make this server spend.
 *
 * Every turn, regeneration, compaction, illustration and wizard step reaches a
 * paid model or image provider, or crawls somebody else's wiki. On a public
 * instance any signed-in account (or MCP connection) can trigger them, so three
 * things bound the bill:
 *
 *   - **Input caps.** A turn's text goes, unevicted, into every model role the
 *     turn runs. Without a cap a 1 MB request body was about 250k tokens per role.
 *   - **An ingest ceiling for non-admins.** The wizard's default (`mid`) is the
 *     most a non-admin may ask one ingest to read; `deep` is up to 3,000 model
 *     calls and stays an administrator's decision.
 *   - **A per-user budget of paid calls**, refilled over time and answered 429
 *     (REST) or a tool error (MCP) when spent. Admins and login-off local use are
 *     not metered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeWorld, withPg } from './pg-harness.ts';
import { fakeAuth, listenSignedIn, sessionUser, type AsUser, type Who } from './signed-in.ts';
import { WIKI } from './fixtures/wiki.ts';
import { World, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { fixtureFetcher } from '../src/ingest/client.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { MAX_DIRECTIVE_CHARS, MAX_TURN_INPUT_CHARS } from '../src/server/contracts.ts';
import { RateLimiter, paidCallLimitFromEnv } from '../src/server/rate-limit.ts';
import { buildMcpAuth } from '../src/mcp/auth.ts';
import { discoverWorldTool, previewIngestTool, type McpToolContext } from '../src/mcp/tools-pg.ts';
import type { Db } from '../src/db/pg.ts';

const WIKI_URL = 'https://vale.fandom.com';
const MCP_DEV_TOKEN = 'cost-limits-mcp-secret';

// ------------------------------------------------------------ the budget itself

test('a paid-call budget allows a burst, then one call per refill interval, per key', () => {
  let now = 0;
  const limiter = new RateLimiter(2, 60, () => now);
  assert.equal(limiter.take('alice'), null);
  assert.equal(limiter.take('alice'), null);
  assert.equal(limiter.take('alice'), 1, 'the third call is told to wait one second');
  assert.equal(limiter.take('bob'), null, 'budgets are per caller');
  now += 1_000;
  assert.equal(limiter.take('alice'), null, 'a second later one call has refilled');
  assert.equal(limiter.take('alice'), 1, 'and only one');
  now += 60_000;
  assert.equal(limiter.take('alice'), null);
  assert.equal(limiter.take('alice'), null);
  assert.equal(limiter.take('alice'), 1, 'an idle minute refills up to the burst, not beyond it');
});

test('the paid-call budget can be tuned or turned off from the environment', () => {
  assert.equal(paidCallLimitFromEnv({}), undefined, 'unset means the server default');
  assert.deepEqual(paidCallLimitFromEnv({ FABULIST_PAID_CALLS_PER_MINUTE: '6', FABULIST_PAID_CALLS_BURST: '3' }), {
    perMinute: 6,
    burst: 3,
  });
  assert.equal(paidCallLimitFromEnv({ FABULIST_PAID_CALLS_PER_MINUTE: '0' }), null, '0 turns metering off');
  assert.throws(
    () => paidCallLimitFromEnv({ FABULIST_PAID_CALLS_PER_MINUTE: 'lots' }),
    /FABULIST_PAID_CALLS_PER_MINUTE/,
  );
  assert.throws(() => paidCallLimitFromEnv({ FABULIST_PAID_CALLS_BURST: '-1' }), /FABULIST_PAID_CALLS_BURST/);
});

// ------------------------------------------------------------------ servers

interface CostServerOptions {
  signedIn?: boolean;
  paidCallLimit?: { burst: number; perMinute: number } | null;
  mcp?: boolean;
}

/** A seeded instance whose model and wiki are doubles that record every call. */
async function withCostServer(
  db: Db,
  fn: (ctx: { as: AsUser; base: string; model: MockProvider; fetches: () => number }) => Promise<void>,
  opts: CostServerOptions = {},
): Promise<void> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  await seedWorld(world);

  const model = new MockProvider();
  const providers = new ProviderRegistry(model);
  let fetched = 0;
  const fixture = fixtureFetcher(WIKI);
  const setup = new SetupService({
    world: () => world,
    db,
    providers,
    wikiFetcher: (url) => {
      fetched += 1;
      return fixture(url);
    },
  });
  const mcpAuth = opts.mcp ? buildMcpAuth({ MCP_DEV_TOKEN }) : undefined;
  const { as, base, close } = await listenSignedIn(
    createApiServer({
      world: () => world,
      db,
      engine: new Engine({ world: () => world, db, providers }),
      setup,
      ...(opts.signedIn ? { authConfig: fakeAuth() } : {}),
      ...(opts.paidCallLimit !== undefined ? { paidCallLimit: opts.paidCallLimit } : {}),
      ...(mcpAuth ? { mcpAuth, mcpResourceUrl: 'http://127.0.0.1/mcp' } : {}),
    }),
  );
  try {
    await fn({ as, base, model, fetches: () => fetched });
  } finally {
    await close();
  }
}

async function withMcpClient<T>(base: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: ['Bearer', MCP_DEV_TOKEN].join(' ') } },
  });
  const client = new Client({ name: 'fabulist-cost-limits-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
}

// --------------------------------------------------------------- input caps

test('a turn longer than the cap is refused before any model call, over REST and MCP', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ as, base, model }) => {
        const tooLong = await as('alice', 'POST', '/api/play', { input: 'a'.repeat(MAX_TURN_INPUT_CHARS + 1) });
        assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
        assert.match(String(tooLong.body.error), new RegExp(`at most ${MAX_TURN_INPUT_CHARS}`));
        assert.equal(model.calls.length, 0, 'no model was called for the refused turn');

        await withMcpClient(base, async (client) => {
          const proposed = await client.callTool({
            name: 'propose_turn',
            arguments: { text: 'a'.repeat(MAX_TURN_INPUT_CHARS + 1) },
          });
          assert.equal(proposed.isError, true, toolText(proposed));
          assert.equal(model.calls.length, 0, 'nor for the refused MCP turn');
        });

        const atCap = await as('alice', 'POST', '/api/play', {
          input: 'I look around the scriptorium. '.repeat(200).slice(0, MAX_TURN_INPUT_CHARS),
        });
        assert.equal(atCap.status, 200, JSON.stringify(atCap.body));
      },
      { mcp: true },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a directive longer than the cap is refused, over REST and MCP', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ as, base }) => {
        const tooLong = await as('alice', 'POST', '/api/directive', { text: 'd'.repeat(MAX_DIRECTIVE_CHARS + 1) });
        assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
        const ok = await as('alice', 'POST', '/api/directive', { text: 'Keep the bells ringing.' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));

        await withMcpClient(base, async (client) => {
          const added = await client.callTool({
            name: 'add_directive',
            arguments: { text: 'd'.repeat(MAX_DIRECTIVE_CHARS + 1) },
          });
          assert.equal(added.isError, true, toolText(added));
        });
      },
      { mcp: true },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a custom-world description longer than the cap is refused before any model call', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(db, async ({ as, model }) => {
      const tooLong = await as('alice', 'POST', '/api/setup/custom', { description: 'w'.repeat(10_001) });
      assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
      assert.equal(model.calls.length, 0);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('every MCP tool argument that reaches a model or a wiki is capped', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ base, model, fetches }) => {
        const cases: Array<[tool: string, args: Record<string, unknown>, limit: number]> = [
          ['play', { input: 'a'.repeat(MAX_TURN_INPUT_CHARS + 1) }, MAX_TURN_INPUT_CHARS],
          ['propose_turn', { text: 'a'.repeat(MAX_TURN_INPUT_CHARS + 1) }, MAX_TURN_INPUT_CHARS],
          ['resolve_interrupt', { originalText: 'a'.repeat(MAX_TURN_INPUT_CHARS + 1) }, MAX_TURN_INPUT_CHARS],
          ['add_directive', { text: 'd'.repeat(MAX_DIRECTIVE_CHARS + 1) }, MAX_DIRECTIVE_CHARS],
          ['resolve_wiki', { query: 'q'.repeat(501) }, 500],
          ['plan_world', { wish: 'w'.repeat(10_001) }, 10_000],
          ['create_custom_world', { description: 'w'.repeat(10_001) }, 10_000],
        ];
        await withMcpClient(base, async (client) => {
          for (const [tool, args, limit] of cases) {
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, true, `${tool}: ${toolText(result)}`);
            assert.match(toolText(result), new RegExp(String(limit)), `${tool} is refused for its length`);
          }
        });
        assert.equal(model.calls.length, 0, 'no refused call reached a model');
        assert.equal(fetches(), 0, 'or a wiki');
      },
      { mcp: true },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------- the ingest ceiling

test('a signed-in non-admin cannot preview or discover more than the wizard’s default ingest', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ as, fetches }) => {
        const scope = { baseUrl: WIKI_URL, seeds: ['Duskhollow'] };
        for (const [label, body] of [
          ['a deep ingest', { ...scope, mode: 'deep' }],
          ['a deep ingest, even a small one', { ...scope, mode: 'deep', maxPages: 100, hops: 1 }],
          ['more pages than mid reads', { ...scope, mode: 'mid', maxPages: 601 }],
          ['more hops than mid follows', { ...scope, mode: 'mid', hops: 3 }],
        ] as const) {
          const preview = await as('alice', 'POST', '/api/setup/preview', body);
          assert.equal(preview.status, 403, `${label}: ${JSON.stringify(preview.body)}`);
          assert.match(String(preview.body.error), /administrator/);
        }
        const discover = await as('alice', 'POST', '/api/setup/discover', { ...scope, mode: 'deep' });
        assert.equal(discover.status, 403, JSON.stringify(discover.body));
        assert.equal(fetches(), 0, 'nothing was crawled for a refused scope');

        const mid = await as('alice', 'POST', '/api/setup/preview', { ...scope, mode: 'mid' });
        assert.equal(mid.status, 200, JSON.stringify(mid.body));

        const deepForAdmin = await as('admin', 'POST', '/api/setup/preview', { ...scope, mode: 'deep' });
        assert.equal(deepForAdmin.status, 200, JSON.stringify(deepForAdmin.body));
      },
      { signedIn: true },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('MCP previews and ingests are held to the same ceiling for a non-admin', async (t) => {
  const ran = await withPg(async (db) => {
    const setup = new SetupService({
      world: () => worldFor(db, null),
      db,
      providers: new ProviderRegistry(new MockProvider()),
      wikiFetcher: fixtureFetcher(WIKI),
    });
    const ctxFor = (who: Who): McpToolContext => {
      const user = sessionUser(who);
      return {
        db,
        user,
        world: () => worldFor(db, user),
        engine: new Engine({
          world: () => worldFor(db, user),
          db,
          providers: new ProviderRegistry(new MockProvider()),
        }),
        setup,
        dataRoot: 'data',
      };
    };
    const scope = { baseUrl: WIKI_URL, seeds: ['Duskhollow'] };

    await assert.rejects(() => previewIngestTool(ctxFor('alice'), { ...scope, mode: 'deep' }), /administrator/);
    await assert.rejects(() => discoverWorldTool(ctxFor('alice'), { ...scope, maxPages: 601 }), /administrator/);

    // A preview is cached under a key anyone can reconstruct, so the ceiling is
    // checked again when an ingest starts, not only when a preview is made.
    const deep = await previewIngestTool(ctxFor('admin'), { ...scope, mode: 'deep' });
    const alice = sessionUser('alice');
    const aliceWorld = await World.forStory(db, (await createStory(db, { title: '', ownerUserId: alice.id })).id);
    assert.throws(
      () =>
        setup.startIngest(
          deep.previewKey,
          { character: { existing: null, name: '', role: '', goals: [], vows: [] }, style: {}, opening: '' },
          { world: aliceWorld, user: alice },
        ),
      /administrator/,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------ the per-user budget

test('paid REST calls beyond a user’s budget are answered 429, without reaching the model', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ as, model }) => {
        for (let i = 0; i < 2; i += 1) {
          const played = await as('alice', 'POST', '/api/play', { input: 'I light the lamp.' });
          assert.equal(played.status, 200, JSON.stringify(played.body));
        }
        const callsBefore = model.calls.length;
        const refused = await as('alice', 'POST', '/api/play', { input: 'I light another lamp.' });
        assert.equal(refused.status, 429, JSON.stringify(refused.body));
        assert.ok(Number(refused.headers.get('retry-after')) >= 1, 'the refusal says when to retry');
        assert.equal(model.calls.length, callsBefore, 'the refused turn reached no model');

        assert.equal((await as('alice', 'GET', '/api/state')).status, 200, 'reads are not metered');
        assert.equal((await as('bob', 'POST', '/api/play', { input: 'I wait.' })).status, 200, 'budgets are per user');
        for (let i = 0; i < 3; i += 1) {
          const played = await as('admin', 'POST', '/api/play', { input: 'I keep watch.' });
          assert.equal(played.status, 200, `admins are not metered: ${JSON.stringify(played.body)}`);
        }
      },
      { signedIn: true, paidCallLimit: { burst: 2, perMinute: 1 } },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('paid MCP tool calls beyond a user’s budget come back as a tool error', async (t) => {
  const ran = await withPg(async (db) => {
    await withCostServer(
      db,
      async ({ base, model }) => {
        await withMcpClient(base, async (client) => {
          const first = await client.callTool({ name: 'propose_turn', arguments: { text: 'I light the lamp.' } });
          assert.notEqual(first.isError, true, toolText(first));
          const callsBefore = model.calls.length;
          const second = await client.callTool({ name: 'propose_turn', arguments: { text: 'I light another.' } });
          assert.equal(second.isError, true, toolText(second));
          assert.match(toolText(second), /too many|rate/i);
          assert.equal(model.calls.length, callsBefore, 'the refused call reached no model');

          const state = await client.callTool({ name: 'get_state', arguments: {} });
          assert.notEqual(state.isError, true, `reads are not metered: ${toolText(state)}`);
        });
      },
      { signedIn: true, mcp: true, paidCallLimit: { burst: 1, perMinute: 1 } },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
