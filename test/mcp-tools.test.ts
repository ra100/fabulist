/**
 * MCP tool functions in isolation, no MCP protocol involved — the transport
 * (`src/mcp/server.ts`) is a thin wrapper over these, so this is where the
 * actual behaviour is worth testing (see `src/mcp/tools.ts`'s own header
 * comment for why the split is drawn this way).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, CurrentWorld } from '../src/store/index.ts';
import { createWorldFile } from '../src/store/worlds.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import {
  commitNarrationTool,
  getBookTool,
  getCastTool,
  getEntityTool,
  getFactsTool,
  getStateTool,
  getThreadsTool,
  listStoriesTool,
  listWorldsTool,
  proposeTurnTool,
  resolveInterruptTool,
  searchEntitiesTool,
  searchTool,
  fetchTool,
  type McpToolContext,
} from '../src/mcp/tools.ts';

function setup() {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data' };
  return { world, engine, ctx };
}

// -------------------------------------------------------------- read tools

test('getStateTool mirrors GET /api/state\u2019s shape', () => {
  const { world, ctx } = setup();
  const state = getStateTool(ctx);
  assert.equal(state.session.scene, world.session.get().scene);
  assert.ok(state.counts.entities > 0, 'the seed world has entities');
  assert.equal(state.usage.calls, 0, 'nothing has been narrated yet');
  world.close();
});

test('getCastTool with no name lists the whole cast', () => {
  const { world, ctx } = setup();
  const out = getCastTool(ctx, {});
  assert.ok(out.cast!.length > 0);
  assert.ok(out.cast!.some((c) => c.entity?.id === 'char:brother-anselm'));
  world.close();
});

test('getCastTool with a name resolves one character by name, not just id', () => {
  const { world, ctx } = setup();
  const out = getCastTool(ctx, { name: 'Brother Anselm' });
  assert.equal(out.entity?.id, 'char:brother-anselm');
  assert.ok(out.sheet?.contract.vows.some((v) => v.id === 'nonviolence'));
  world.close();
});

test('getCastTool with an unresolvable name returns nulls, not a throw', () => {
  const { world, ctx } = setup();
  const out = getCastTool(ctx, { name: 'Someone Who Does Not Exist' });
  assert.equal(out.entity, null);
  assert.equal(out.sheet, null);
  world.close();
});

test('getEntityTool resolves by id and includes live neighbours', () => {
  const { world, ctx } = setup();
  const out = getEntityTool(ctx, { id: 'char:brother-anselm' });
  assert.equal(out.entity?.id, 'char:brother-anselm');
  assert.ok(Array.isArray(out.neighbours));
  world.close();
});

test('searchEntitiesTool finds the seed cast by a partial query', () => {
  const { world, ctx } = setup();
  const out = searchEntitiesTool(ctx, { query: 'anselm' });
  assert.ok(out.entities.some((e) => e.id === 'char:brother-anselm'));
  world.close();
});

test('getThreadsTool reports the seed world\u2019s own authored threads', () => {
  const { world, ctx } = setup();
  // Saint Verrow's seed canon ships with starting tensions already in play
  // (see src/seed/verrow.ts) — the tool's job is reporting them faithfully,
  // not that a fresh world starts empty.
  const threads = getThreadsTool(ctx).threads;
  assert.ok(threads.length > 0, 'the seed world ships with authored threads');
  assert.ok(threads.every((t) => typeof t.id === 'string' && typeof t.tension === 'number'));
  world.close();
});

test('getFactsTool reports the seed world\u2019s own authored facts', () => {
  const { world, ctx } = setup();
  // Wrong the first time: assumed a fresh seed has no facts. Saint Verrow's
  // canon authors several as backstory (see src/seed/verrow.ts) — checked
  // directly against the actual seed rather than assumed a second time.
  const facts = getFactsTool(ctx, {}).facts;
  assert.ok(facts.length > 0, 'the seed world ships with authored facts');
  assert.ok(facts.every((f) => typeof f.id === 'string' && typeof f.text === 'string'));
  world.close();
});

test('getBookTool returns turns in order, most recent last', async () => {
  const { world, ctx, engine } = setup();
  await engine.takeTurn('i warm the ink and keep copying');
  const out = getBookTool(ctx, {});
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0]?.turn, 1);
  world.close();
});

test('listWorldsTool and listStoriesTool report the currently open one', () => {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-tools-'));
  try {
    createWorldFile('Test World', root);
    const cw = CurrentWorld.open('test-world', root);
    const mock = new MockProvider();
    const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = {
      world: () => cw.world(),
      engine,
      currentStory: cw.stories(),
      currentWorld: cw,
      dataRoot: root,
    };

    const worlds = listWorldsTool(ctx);
    assert.equal(worlds.worlds.length, 1);
    assert.equal(worlds.worlds[0]?.current, true, 'the only world is the open one');

    const stories = listStoriesTool(ctx);
    assert.equal(stories.stories.length, 1);
    assert.equal(stories.stories[0]?.current, true);

    cw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- the turn tools

test('proposeTurnTool returns awaiting-narration with the exact narrator prompt material', async () => {
  const { world, ctx } = setup();
  const out = await proposeTurnTool(ctx, { text: 'i warm the ink and keep copying' });
  assert.equal(out.status, 'awaiting-narration');
  if (out.status !== 'awaiting-narration') return;
  assert.ok(out.resumeToken.length > 0);
  assert.match(out.narratorSystemPrompt, /narrator/i);
  assert.ok(out.sceneFrame.length > 0);
  world.close();
});

test('proposeTurnTool surfaces an integrity interrupt with the original text for resolve_interrupt', async () => {
  const { world, ctx } = setup();
  const out = await proposeTurnTool(ctx, { text: 'i stab the captain' });
  assert.equal(out.status, 'interrupted');
  if (out.status !== 'interrupted') return;
  assert.equal(out.originalText, 'i stab the captain');
  assert.ok(out.options.some((o) => o.effect === 'override'));
  world.close();
});

test('commitNarrationTool finishes the turn end to end', async () => {
  const { world, ctx } = setup();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink and keep copying' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');

  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'Anselm keeps to his letters.' });
  assert.equal(out.status, 'narrated');
  if (out.status !== 'narrated') return;
  assert.equal(out.prose, 'Anselm keeps to his letters.');
  assert.ok(out.eventsRecorded > 0);
  world.close();
});

test('resolveInterruptTool with revise or switch-character writes nothing and never calls the engine', async () => {
  const { world, ctx } = setup();
  const revise = await resolveInterruptTool(ctx, { originalText: 'i stab the captain', effect: 'revise' });
  assert.equal(revise.status, 'nothing-written');
  const switchChar = await resolveInterruptTool(ctx, { originalText: 'i stab the captain', effect: 'switch-character' });
  assert.equal(switchChar.status, 'nothing-written');
  assert.equal(world.chronicle.turns().length, 0);
  world.close();
});

test('resolveInterruptTool with override proceeds to awaiting-narration and records the break on commit', async () => {
  const { world, ctx } = setup();
  const resolved = await resolveInterruptTool(ctx, { originalText: 'i stab the captain', effect: 'override' });
  assert.equal(resolved.status, 'awaiting-narration');
  if (resolved.status !== 'awaiting-narration') return;

  const committed = await commitNarrationTool(ctx, {
    resumeToken: resolved.resumeToken,
    prose: 'Anselm drives the blade home, and something in him breaks with it.',
  });
  assert.equal(committed.status, 'narrated');
  if (committed.status !== 'narrated') return;
  assert.equal(committed.brokenVows.length, 1);
  world.close();
});

// ---------------------------------- ChatGPT search/fetch compatibility pair

test('search finds entities by name and returns ids fetch can resolve', () => {
  const { ctx } = setup();
  const { results } = searchTool(ctx, { query: 'Anselm' });

  assert.ok(results.length > 0, 'the seeded cast includes Brother Anselm');
  const hit = results.find((r) => r.title.includes('Anselm'));
  assert.ok(hit, 'Anselm is among the results');
  // Ids come back verbatim/native — entities carry their own type prefix.
  assert.match(hit.id, /^char:/, 'entity ids keep their native type prefix');
  assert.equal(hit.url, `fabulist://${hit.id}`);

  // The round trip is the actual contract ChatGPT relies on: every id from
  // search must resolve through fetch.
  const doc = fetchTool(ctx, { id: hit.id });
  assert.ok(doc.text.includes('Anselm'));
  assert.equal(doc.id, hit.id);
});

test('search returns an empty result list rather than throwing on no match', () => {
  const { ctx } = setup();
  const { results } = searchTool(ctx, { query: 'zzzz-nothing-matches-this-zzzz' });
  assert.deepEqual(results, []);
});

test('search treats a blank query as no results, not as match-everything', () => {
  const { ctx } = setup();
  assert.deepEqual(searchTool(ctx, { query: '   ' }).results, []);
});

test('every search result id round-trips through fetch', () => {
  const { world, ctx } = setup();
  // Give facts and threads something searchable in common with each other, so
  // this covers the fact:/thread: branches and not just entities.
  world.chronicle.addFact('The garrison keeps a ledger of the cloister.', 0);
  const { results } = searchTool(ctx, { query: 'garrison' });
  assert.ok(results.length > 0);

  for (const r of results) {
    const doc = fetchTool(ctx, { id: r.id });
    assert.equal(doc.id, r.id, `fetch echoes the id it was given (${r.id})`);
    assert.equal(typeof doc.text, 'string');
    assert.ok(doc.text.length > 0, `fetch returns real text for ${r.id}`);
    assert.equal(typeof doc.title, 'string');
    assert.ok(doc.metadata, `fetch returns metadata for ${r.id}`);
  }
});

test('fetch accepts a bare entity id, since a model may pass one through from another tool', () => {
  const { world, ctx } = setup();
  const anselm = world.graph.resolveName('Brother Anselm');
  assert.ok(anselm, 'seeded');
  const doc = fetchTool(ctx, { id: anselm.id });
  assert.ok(doc.text.includes('Anselm'));
});

test('fetch accepts a bare turn id and returns that turn’s prose', async () => {
  const { world, ctx, engine } = setup();
  await engine.takeTurn('i look around the cloister');
  const turn = world.chronicle.recentTurns(1)[0];
  assert.ok(turn, 'a turn was committed');

  const doc = fetchTool(ctx, { id: turn.id });
  assert.equal(doc.text, turn.bookProse);
  assert.equal(doc.metadata.scene, turn.scene);
});

test('fetch fails loudly on an unrecognized id rather than returning an empty document', () => {
  const { ctx } = setup();
  assert.throws(() => fetchTool(ctx, { id: 'nonsense:does-not-exist' }), /unrecognized id|no /);
});
