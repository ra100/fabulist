/**
 * MCP tool functions in isolation, no MCP protocol involved — the transport
 * (`src/mcp/server.ts`) is a thin wrapper over these, so this is where the
 * actual behaviour is worth testing (see `src/mcp/tools.ts`'s own header
 * comment for why the split is drawn this way).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, CurrentStory, CurrentWorld } from '../src/store/index.ts';
import { createWorldFile } from '../src/store/worlds.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { MockImageProvider } from '../src/providers/mockImage.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { SetupService } from '../src/setup/service.ts';
import { IllustrationService } from '../src/illustration/service.ts';
import { directoryFixture } from '../src/setup/directory.ts';
import { fixtureFetcher } from '../src/ingest/client.ts';
import { WIKI } from './fixtures/wiki.ts';
import {
  addAnchorTool,
  addDirectiveTool,
  branchStoryToFileTool,
  cancelSetupJobTool,
  closeSceneTool,
  commitIngestTool,
  commitNarrationTool,
  compactTool,
  createCustomWorldTool,
  createStoryTool,
  deleteDirectiveTool,
  deleteIllustrationTool,
  discoverWorldTool,
  forkStoryTool,
  generatePortraitTool,
  generateSceneIllustrationTool,
  getBookTool,
  getCastTool,
  getEntityTool,
  getFactsTool,
  getSetupJobTool,
  getStateTool,
  getThreadsTool,
  lockSheetFieldTool,
  listCharactersTool,
  listStoriesTool,
  listWorldsTool,
  pinTurnTool,
  planWorldTool,
  playTool,
  previewIngestTool,
  proposeTurnTool,
  regenerateTurnTool,
  resetWorldTool,
  resolveInterruptTool,
  resolveWikiTool,
  searchEntitiesTool,
  searchTool,
  fetchTool,
  startStoryTool,
  switchStoryTool,
  switchWorldTool,
  tickTool,
  updateKnobsTool,
  updateSheetTool,
  updateStyleTool,
  updateThreadTool,
  useSampleWorldTool,
  listWorldPacksTool,
  useWorldPackTool,
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

/** A setup() with SetupService and an illustration service (mock image provider) also wired in. */
function fullSetup() {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  const svc = new SetupService({ world, providers: new ProviderRegistry(mock) });
  const imageProvider = new MockImageProvider();
  const illustrations = new IllustrationService({ world, providers: { get: () => imageProvider } });
  const ctx: McpToolContext = { world: () => world, engine, setup: svc, illustrations, dataRoot: 'data' };
  return { world, engine, svc, illustrations, ctx };
}

async function settleJob(svc: SetupService, id: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (svc.jobs.get(id)?.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
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

test('switchWorldTool actually switches, so the next call\u2019s tools follow', () => {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-tools-'));
  try {
    createWorldFile('First World', root);
    createWorldFile('Second World', root);
    const cw = CurrentWorld.open('first-world', root);
    const mock = new MockProvider();
    // A getter over `cw`, exactly like `serve.ts`'s own `getWorld` \u2014 the
    // point being tested is that this getter (and therefore `engine`,
    // `get_state`, etc.) follows the switch without anything here being
    // reconstructed.
    const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = {
      world: () => cw.world(),
      engine,
      currentStory: cw.stories(),
      currentWorld: cw,
      dataRoot: root,
    };

    assert.equal(cw.slug(), 'first-world');
    const out = switchWorldTool(ctx, { slug: 'second-world' });
    assert.equal(out.current, 'second-world');
    assert.equal(cw.slug(), 'second-world', 'the shared CurrentWorld actually moved');

    const worlds = listWorldsTool(ctx);
    assert.equal(worlds.worlds.find((w) => w.slug === 'second-world')?.current, true);
    assert.equal(worlds.worlds.find((w) => w.slug === 'first-world')?.current, false);

    cw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('switchWorldTool reports a clear error for an unknown slug, without disturbing the open world', () => {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-tools-'));
  try {
    createWorldFile('Only World', root);
    const cw = CurrentWorld.open('only-world', root);
    const mock = new MockProvider();
    const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = { world: () => cw.world(), engine, currentStory: cw.stories(), currentWorld: cw, dataRoot: root };

    assert.throws(() => switchWorldTool(ctx, { slug: 'nope' }), /no world "nope"/);
    assert.equal(cw.slug(), 'only-world', 'a failed switch leaves the original world open');

    cw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('switchWorldTool throws a clear, actionable message when this server has no CurrentWorld at all', () => {
  const { world, ctx } = setup(); // setup() never sets currentWorld \u2014 a fixed-world deployment
  assert.throws(() => switchWorldTool(ctx, { slug: 'anything' }), /no switchable world/);
  world.close();
});

// ------------------------------------------------------------ story tools

test('createStoryTool starts a fresh story without switching to it', () => {
  const { world, ctx } = setup();
  const before = listStoriesTool(ctx).stories;
  assert.equal(before.length, 1, 'sanity: seedWorld makes exactly one story');

  const { story } = createStoryTool(ctx, { title: 'A parallel telling' });
  assert.equal(story.title, 'A parallel telling');
  assert.notEqual(story.id, world.storyId, 'a new id, not the existing story');

  const after = listStoriesTool(ctx).stories;
  assert.equal(after.length, 2);
  assert.equal(after.find((s) => s.id === world.storyId)?.current, true, 'still on the original story \u2014 create does not switch');
  assert.equal(after.find((s) => s.id === story.id)?.current, false);
  world.close();
});

test('forkStoryTool with no atScene shares canon only; with atScene it copies the chronicle up to that point', () => {
  const { world, ctx } = setup();
  const freshFork = forkStoryTool(ctx, { title: 'What if' });
  assert.equal(freshFork.copiedFrom, null);
  assert.equal(freshFork.copiedUpToScene, null);

  // seedWorld's own story already has at least one turn recorded (scene 1) \u2014
  // fork at scene 2 so "up to but not including" has something to copy.
  const branch = forkStoryTool(ctx, { atScene: 2 });
  assert.equal(branch.copiedUpToScene, 2);
  world.close();
});

test('forkStoryTool defaults fromStoryId to whichever story is current', () => {
  const { world, ctx } = setup();
  const result = forkStoryTool(ctx, {});
  assert.equal(result.story.forkedFrom, null); // no atScene given \u2014 a fresh copy, not attributed to a source
  world.close();
});

test('switchStoryTool actually switches, so the next call\u2019s tools follow', () => {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-tools-'));
  try {
    createWorldFile('Story World', root);
    const cw = CurrentWorld.open('story-world', root);
    const mock = new MockProvider();
    const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = { world: () => cw.world(), engine, currentStory: cw.stories(), currentWorld: cw, dataRoot: root };

    const originalId = cw.world().storyId;
    const { story } = createStoryTool(ctx, { title: 'Second story' });

    const out = switchStoryTool(ctx, { id: story.id });
    assert.equal(out.current, story.id);
    assert.equal(ctx.world().storyId, story.id, 'the shared CurrentStory actually moved');
    assert.notEqual(ctx.world().storyId, originalId);

    cw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('switchStoryTool throws a clear, actionable message when this server has no CurrentStory at all', () => {
  const { world, ctx } = setup(); // setup() never sets currentStory \u2014 a fixed-world deployment
  assert.throws(() => switchStoryTool(ctx, { id: 'anything' }), /no story management/);
  world.close();
});

test('listCharactersTool lists the seed cast, ranked by connectedness', () => {
  const { world, ctx } = setup();
  const { characters } = listCharactersTool(ctx);
  assert.ok(characters.length > 0);
  assert.ok(characters.some((c) => c.id === 'char:brother-anselm'));
  // Every entry has the shape start_story's `existing` argument needs.
  for (const c of characters) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.connections, 'number');
  }
  world.close();
});

test('startStoryTool adopts an existing character and proposes an opening', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  const svc = new SetupService({ world, providers: new ProviderRegistry(mock) });
  const ctx: McpToolContext = { world: () => world, engine, setup: svc, dataRoot: 'data' };

  const out = startStoryTool(ctx, { existing: 'Sister Oria' });
  assert.equal(out.playerCharacterId, 'char:sister-oria');
  assert.equal(out.created, false);
  assert.ok(out.opening.length > 0, 'an opening line is proposed');
  assert.equal(world.cast.player()?.entityId, 'char:sister-oria');
  world.close();
});

test('startStoryTool places an original character when existing is omitted', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  const svc = new SetupService({ world, providers: new ProviderRegistry(mock) });
  const ctx: McpToolContext = { world: () => world, engine, setup: svc, dataRoot: 'data' };

  const out = startStoryTool(ctx, { name: 'A Newcomer', role: 'A traveler passing through' });
  assert.equal(out.created, true);
  assert.equal(world.graph.get(out.playerCharacterId)?.provenance, 'emergent:0', 'an invented protagonist, not source material');
  world.close();
});

test('startStoryTool throws a clear, actionable message when this server has no setup service enabled', () => {
  const { world, ctx } = setup(); // setup() never sets ctx.setup
  assert.throws(() => startStoryTool(ctx, { existing: 'Brother Anselm' }), /no setup service enabled/);
  world.close();
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

// ------------------------------------------ other turn/session write tools

test('playTool narrates a turn end to end using this server\u2019s own configured provider', async () => {
  const { world, ctx } = setup();
  const out = await playTool(ctx, { input: 'i warm the ink and keep copying' });
  assert.equal(out.outcome.kind, 'narrated');
  if (out.outcome.kind !== 'narrated') return;
  assert.ok(out.outcome.prose.length > 0);
  world.close();
});

test('playTool with overrideIntegrity bypasses the gate, same as resolve_interrupt', async () => {
  const { world, ctx } = setup();
  const out = await playTool(ctx, { input: 'i stab the captain', overrideIntegrity: true });
  assert.equal(out.outcome.kind, 'narrated');
  world.close();
});

test('pinTurnTool pins and unpins a turn', async () => {
  const { world, ctx } = setup();
  const played = await proposeTurnTool(ctx, { text: 'i warm the ink and keep copying' });
  assert.equal(played.status, 'awaiting-narration');
  if (played.status !== 'awaiting-narration') return;
  const committed = await commitNarrationTool(ctx, { resumeToken: played.resumeToken, prose: 'He warms the ink.' });
  assert.equal(committed.status, 'narrated');
  if (committed.status !== 'narrated') return;

  const pinned = pinTurnTool(ctx, { id: committed.turnId });
  assert.equal(pinned?.pinned, true);
  const unpinned = pinTurnTool(ctx, { id: committed.turnId, pinned: false });
  assert.equal(unpinned?.pinned, false);
  world.close();
});

test('regenerateTurnTool re-renders a turn\u2019s prose, and refuses a pinned one', async () => {
  const { world, ctx } = setup();
  const played = await proposeTurnTool(ctx, { text: 'i warm the ink and keep copying' });
  assert.equal(played.status, 'awaiting-narration');
  if (played.status !== 'awaiting-narration') return;
  const committed = await commitNarrationTool(ctx, { resumeToken: played.resumeToken, prose: 'He warms the ink.' });
  assert.equal(committed.status, 'narrated');
  if (committed.status !== 'narrated') return;

  const regenerated = await regenerateTurnTool(ctx, { id: committed.turnId });
  assert.equal(regenerated.id, committed.turnId);

  pinTurnTool(ctx, { id: committed.turnId });
  await assert.rejects(() => regenerateTurnTool(ctx, { id: committed.turnId }), /pinned/);
  world.close();
});

test('updateSheetTool edits identity/voice/condition without touching appearance\u2019s reference image fields', () => {
  const { world, ctx } = setup();
  const before = world.cast.get('char:brother-anselm')!;
  const out = updateSheetTool(ctx, {
    id: 'char:brother-anselm',
    voice: { ...before.voice, diction: 'terse, clipped' },
    appearance: { description: 'A new description' },
  });
  assert.equal(out?.voice.diction, 'terse, clipped');
  assert.equal(out?.appearance.description, 'A new description');
  assert.equal(out?.appearance.referenceImagePath, before.appearance.referenceImagePath, 'never touched through this editor');
  world.close();
});

test('updateSheetTool throws a clear error for an unknown sheet', () => {
  const { world, ctx } = setup();
  assert.throws(() => updateSheetTool(ctx, { id: 'char:nobody' }), /no sheet/);
  world.close();
});

test('lockSheetFieldTool locks and unlocks a field path', () => {
  const { world, ctx } = setup();
  const locked = lockSheetFieldTool(ctx, { id: 'char:brother-anselm', path: 'identity.arc' });
  assert.ok(locked?.locks.includes('identity.arc'));
  const unlocked = lockSheetFieldTool(ctx, { id: 'char:brother-anselm', path: 'identity.arc', locked: false });
  assert.ok(!unlocked?.locks.includes('identity.arc'));
  world.close();
});

test('updateThreadTool edits tension, status, title, and stakes', () => {
  const { world, ctx } = setup();
  const thread = getThreadsTool(ctx).threads[0]!;
  const out = updateThreadTool(ctx, { id: thread.id, tension: 0.95, status: 'resolved' });
  assert.equal(out?.tension, 0.95);
  assert.equal(out?.status, 'resolved');
  world.close();
});

test('addDirectiveTool creates a directive and reports its recalculation diff', () => {
  const { world, ctx } = setup();
  const out = addDirectiveTool(ctx, { text: 'the captain grows suspicious of the scriptorium' });
  assert.equal(out.directive.text, 'the captain grows suspicious of the scriptorium');
  assert.equal(out.directive.status, 'active');
  assert.ok(Array.isArray(out.diff.raisedThreadTitles));
  world.close();
});

test('deleteDirectiveTool retires rather than hard-deletes', () => {
  const { world, ctx } = setup();
  const { directive } = addDirectiveTool(ctx, { text: 'a directive to retire' });
  deleteDirectiveTool(ctx, { id: directive.id });
  assert.ok(!world.directives.active().some((d) => d.id === directive.id));
  world.close();
});

test('updateStyleTool merges a partial patch, leaving untouched fields alone', () => {
  const { world, ctx } = setup();
  const before = world.session.get().style;
  const out = updateStyleTool(ctx, { register: 'ornate' });
  assert.equal(out.register, 'ornate');
  assert.equal(out.pov, before.pov, 'fields not in the patch are unchanged');
  world.close();
});

test('updateKnobsTool merges a partial patch, leaving untouched fields alone', () => {
  const { world, ctx } = setup();
  const before = world.session.get().knobs;
  const out = updateKnobsTool(ctx, { danger: 0.9 });
  assert.equal(out.danger, 0.9);
  assert.equal(out.pacing, before.pacing);
  world.close();
});

test('addAnchorTool records a style anchor', () => {
  const { world, ctx } = setup();
  addAnchorTool(ctx, { text: 'The bridge stays open to whoever needs crossing.', note: 'a good line' });
  const anchors = world.chronicle.anchors(20);
  assert.ok(anchors.some((a) => a.text.includes('bridge stays open')));
  world.close();
});

test('generatePortraitTool generates a portrait and sets the reference image path', async () => {
  const { world, ctx } = fullSetup();
  const out = await generatePortraitTool(ctx, { entityId: 'char:brother-anselm' });
  assert.equal(out.status, 'done');
  const sheet = world.cast.get('char:brother-anselm');
  assert.ok(sheet?.appearance.referenceImagePath);
  world.close();
});

test('generatePortraitTool throws a clear, actionable message when no image provider is configured', async () => {
  const { world, ctx } = setup(); // setup() never sets ctx.illustrations
  await assert.rejects(() => generatePortraitTool(ctx, { entityId: 'char:brother-anselm' }), /no image provider configured/);
  world.close();
});

test('generateSceneIllustrationTool illustrates an already-committed turn', async () => {
  const { world, ctx, engine } = fullSetup();
  const outcome = await engine.takeTurn('i warm the ink and keep copying');
  assert.equal(outcome.kind, 'narrated');
  if (outcome.kind !== 'narrated') return;
  const out = await generateSceneIllustrationTool(ctx, { turnId: outcome.turn.id });
  assert.equal(out.status, 'done');
  world.close();
});

test('generateSceneIllustrationTool throws on an unknown turn', async () => {
  const { world, ctx } = fullSetup();
  await assert.rejects(() => generateSceneIllustrationTool(ctx, { turnId: 'turn:nope' }), /no turn/);
  world.close();
});

test('deleteIllustrationTool removes a generated illustration', async () => {
  const { world, ctx } = fullSetup();
  const illus = await generatePortraitTool(ctx, { entityId: 'char:brother-anselm' });
  deleteIllustrationTool(ctx, { id: illus.id });
  assert.equal(world.illustrations.get(illus.id), undefined);
  world.close();
});

test('tickTool advances the world clock', () => {
  const { world, ctx } = setup();
  const out = tickTool(ctx);
  assert.ok('tick' in out && 'notes' in out);
  world.close();
});

test('compactTool summarises a specific scene when given one', async () => {
  const { world, ctx } = setup();
  const out = await compactTool(ctx, { scene: 1, force: true });
  assert.ok('scene' in out);
  if ('scene' in out) assert.equal(out.scene, 1);
  world.close();
});

test('compactTool backfills every unsummarised closed scene when scene is omitted', async () => {
  const { world, ctx } = setup();
  const out = await compactTool(ctx, {});
  assert.ok('scenesSummarised' in out);
  world.close();
});

test('closeSceneTool advances the scene counter and resets the turn counter', async () => {
  const { world, ctx } = setup();
  const before = world.session.get();
  const out = await closeSceneTool(ctx);
  assert.equal(out.closedScene, before.scene);
  assert.equal(out.nowScene, before.scene + 1);
  assert.equal(world.session.get().scene, before.scene + 1);
  assert.equal(world.session.get().turn, 0);
  world.close();
});

test('branchStoryToFileTool forks the save file at a scene into a different path on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-mcp-branch-'));
  try {
    const dbPath = join(dir, 'source.db');
    const world = World.open(dbPath);
    seedWorld(world);
    const mock = new MockProvider();
    const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data' };

    const toPath = join(dir, 'branch.db');
    const out = branchStoryToFileTool(ctx, { atScene: 1, toPath });
    assert.equal(out.path, toPath);
    assert.ok(existsSync(toPath));
    world.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branchStoryToFileTool refuses an in-memory save', () => {
  const { world, ctx } = setup();
  assert.throws(() => branchStoryToFileTool(ctx, { atScene: 1, toPath: '/tmp/nope.db' }), /in-memory/);
  world.close();
});

// -------------------------------------------------------- setup wizard tools

const FIXTURE = {
  wikis: { 'https://vale.fandom.com': { sitename: 'The Ashen Vale Wiki', articles: 4200 } },
  directory: { 'the ashen vale': [{ name: 'The Ashen Vale Wiki', url: 'https://vale.fandom.com' }] },
  categories: { 'https://vale.fandom.com': [{ category: 'Characters', size: 120 }] },
  search: { 'ashgrove arc': ['Ashgrove Arc'], duskhollow: ['Duskhollow'] },
};

function setupWizardCtx() {
  const world = World.open(':memory:');
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  const svc = new SetupService({
    world,
    providers: new ProviderRegistry(mock),
    directoryOptions: { fetcher: directoryFixture(FIXTURE), delayMs: 0 },
    wikiFetcher: fixtureFetcher(WIKI),
  });
  const ctx: McpToolContext = { world: () => world, engine, setup: svc, dataRoot: 'data' };
  return { world, svc, ctx };
}

test('resolveWikiTool finds candidates for free text', async () => {
  const { world, ctx } = setupWizardCtx();
  const out = await resolveWikiTool(ctx, { query: 'the ashen vale' });
  assert.ok(out.candidates.some((c) => c.baseUrl === 'https://vale.fandom.com'));
  world.close();
});

test('resolveWikiTool throws a clear message when no setup service is enabled', async () => {
  const { world, ctx } = setup();
  await assert.rejects(() => resolveWikiTool(ctx, { query: 'anything' }), /no setup service enabled/);
  world.close();
});

test('planWorldTool turns free text plus a wiki into an editable plan', async () => {
  const { world, ctx } = setupWizardCtx();
  const { candidates } = await resolveWikiTool(ctx, { query: 'the ashen vale' });
  const plan = await planWorldTool(ctx, { wish: 'a quiet story about the scriptorium', wiki: candidates[0]! });
  assert.ok(Array.isArray(plan.seeds));
  world.close();
});

test('previewIngestTool reports scope and cost without writing anything', async () => {
  const { world, ctx } = setupWizardCtx();
  const out = await previewIngestTool(ctx, { baseUrl: 'https://vale.fandom.com', seeds: ['Duskhollow'], mode: 'mid' });
  assert.ok(out.previewKey.length > 0);
  assert.equal(world.graph.counts().entities, 0, 'nothing committed yet');
  world.close();
});

test('discoverWorldTool runs the same crawl as a pollable job', async () => {
  const { world, svc, ctx } = setupWizardCtx();
  const job = discoverWorldTool(ctx, { baseUrl: 'https://vale.fandom.com', seeds: ['Duskhollow'], mode: 'mid' });
  await settleJob(svc, job.id);
  const settled = getSetupJobTool(ctx, { id: job.id }) as { status: string; result: { previewKey: string } | null };
  assert.equal(settled.status, 'done');
  assert.ok(settled.result?.previewKey);
  world.close();
});

test('commitIngestTool commits a previewed scope and actually writes canon', async () => {
  const { world, svc, ctx } = setupWizardCtx();
  const preview = await previewIngestTool(ctx, { baseUrl: 'https://vale.fandom.com', seeds: ['Duskhollow'], mode: 'mid' });
  const job = commitIngestTool(ctx, { previewKey: preview.previewKey });
  await settleJob(svc, job.id);
  const settled = getSetupJobTool(ctx, { id: job.id });
  assert.equal(settled.status, 'done');
  assert.ok(world.graph.counts().entities > 0, 'canon was actually written');
  world.close();
});

test('commitIngestTool throws for a previewKey that was never previewed', () => {
  const { world, ctx } = setupWizardCtx();
  assert.throws(() => commitIngestTool(ctx, { previewKey: 'never-previewed' }), /no preview/);
  world.close();
});

test('createCustomWorldTool builds an authored world from a description', async () => {
  const { world, svc, ctx } = setupWizardCtx();
  const job = createCustomWorldTool(ctx, { description: 'A lighthouse keeper and the smugglers who need her looking away.' });
  await settleJob(svc, job.id);
  const settled = getSetupJobTool(ctx, { id: job.id });
  assert.equal(settled.status, 'done');
  assert.ok(world.graph.counts().entities > 0);
  world.close();
});

test('useSampleWorldTool loads the built-in example', () => {
  const { world, ctx } = setupWizardCtx();
  const out = useSampleWorldTool(ctx);
  assert.ok(out.playerCharacterId.length > 0);
  assert.ok(out.opening.length > 0);
  world.close();
});

test('listWorldPacksTool lists the shipped worlds and their scenarios', () => {
  const { world, ctx } = setupWizardCtx();
  const out = listWorldPacksTool(ctx);
  assert.ok(out.packs.length >= 1);
  for (const pack of out.packs) {
    assert.ok(pack.id.length > 0);
    assert.ok(pack.scenarios.length >= 1);
    // The summary has to be usable by a caller that cannot see the pack file, so
    // it names the player rather than exposing an entity id.
    for (const s of pack.scenarios) assert.ok(!s.playerName.includes(':'));
  }
  world.close();
});

test('useWorldPackTool installs a pack and rebinds the current story', () => {
  // The rebind is the part worth testing: a pack creates one story per scenario,
  // so a caller left pointing at the story the file opened with would install a
  // world and then go on playing a different one.
  const world = World.open(':memory:');
  const mock = new MockProvider();
  const currentStory = new CurrentStory(world.db, world.storyId);
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(mock) });
  const svc = new SetupService({ world: () => currentStory.world(), providers: new ProviderRegistry(mock) });
  const ctx: McpToolContext = {
    world: () => currentStory.world(),
    engine,
    setup: svc,
    currentStory,
    dataRoot: 'data',
  };

  const pack = listWorldPacksTool(ctx).packs[0];
  assert.ok(pack);
  const wanted = pack.scenarios[pack.scenarios.length - 1];
  assert.ok(wanted);

  const out = useWorldPackTool(ctx, { packId: pack.id, scenarioId: wanted.id });
  assert.equal(out.scenarioId, wanted.id);
  assert.deepEqual(out.warnings, []);
  assert.equal(currentStory.world().storyId, out.storyId, 'current story was not rebound');
  assert.equal(currentStory.world().session.get().playerCharacterId, out.playerCharacterId);

  assert.throws(() => useWorldPackTool(ctx, { packId: 'nope' }), /no such world pack/);
  world.close();
});

test('getSetupJobTool throws for an unknown job id', () => {
  const { world, ctx } = setupWizardCtx();
  assert.throws(() => getSetupJobTool(ctx, { id: 'job:nope' }), /no such job/);
  world.close();
});

test('cancelSetupJobTool cooperatively cancels a running job', async () => {
  const { world, svc, ctx } = setupWizardCtx();
  const job = discoverWorldTool(ctx, { baseUrl: 'https://vale.fandom.com', seeds: ['Duskhollow'], mode: 'mid' });
  const out = cancelSetupJobTool(ctx, { id: job.id });
  assert.equal(typeof out.cancelled, 'boolean');
  await settleJob(svc, job.id);
  world.close();
});

test('resetWorldTool wipes the world and rebinds currentStory to the new blank story', () => {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-tools-'));
  try {
    createWorldFile('Reset Me', root);
    const cw = CurrentWorld.open('reset-me', root);
    seedWorld(cw.world());
    const mock = new MockProvider();
    const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const svc = new SetupService({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
    const ctx: McpToolContext = { world: () => cw.world(), engine, currentStory: cw.stories(), setup: svc, dataRoot: root };

    assert.ok(cw.world().graph.counts().entities > 0, 'sanity: something was there before reset');
    const out = resetWorldTool(ctx);
    assert.equal(out.ok, true);
    assert.equal(cw.world().storyId, out.storyId, 'currentStory rebinds to the new story');
    assert.equal(cw.world().graph.counts().entities, 0);
    cw.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resetWorldTool throws a clear message when no setup service is enabled', () => {
  const { world, ctx } = setup();
  assert.throws(() => resetWorldTool(ctx), /no setup service enabled/);
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
