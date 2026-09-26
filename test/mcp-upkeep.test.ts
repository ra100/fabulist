import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { defaultKnobs, defaultStyleContract } from '../src/domain/types.ts';
import { buildGuide, upkeepFor } from '../src/mcp/upkeep.ts';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { Engine } from '../src/loop/engine.ts';
import { coerceAgentDelta } from '../src/loop/validate.ts';
import { agentDelta } from '../src/loop/roles.ts';
import {
  commitNarrationTool,
  createStoryTool,
  getGuideTool,
  getStateTool,
  proposeTurnTool,
  rollbackTool,
  recordFactTool,
  openThreadTool,
  addConsequenceTool,
  type McpToolContext,
} from '../src/mcp/tools.ts';

test('upkeepFor is "agent" exactly when the extract role resolves to the mock', () => {
  assert.equal(upkeepFor(new ProviderRegistry(new MockProvider())), 'agent');
  assert.equal(upkeepFor(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' }))), 'server');
  assert.equal(
    upkeepFor(new ProviderRegistry(new MockProvider({ id: 'narrator' }), { extract: new MockProvider() })),
    'agent',
    'a real narrator does not help if extraction is still the mock',
  );
  assert.equal(
    upkeepFor(new ProviderRegistry(new MockProvider(), { extract: new MockProvider({ id: 'bedrock' }) })),
    'server',
  );
});

test('buildGuide carries the loop, the writing contract and validation, and the checklist only for agent upkeep', () => {
  const input = {
    writingRules: 'You do not invent world facts.',
    style: defaultStyleContract(),
    knobs: defaultKnobs(),
    anchors: [{ text: 'The ink was cold.', note: 'plain' }],
    blocklist: ['breath she did not know'],
  };
  const agent = buildGuide({ ...input, upkeep: 'agent' });
  assert.equal(agent.upkeep, 'agent');
  assert.match(agent.loop, /propose_turn/);
  assert.match(agent.loop, /commit_narration/);
  assert.match(agent.loop, /NOTHING IS SAVED UNTIL THIS CALL/);
  assert.equal(agent.writing.rules, 'You do not invent world facts.');
  assert.deepEqual(agent.writing.blocklist, ['breath she did not know']);
  assert.deepEqual(agent.writing.anchors, [{ text: 'The ink was cold.', note: 'plain' }]);
  assert.match(agent.validation, /dropped/);
  assert.match(agent.validation, /blocked/);
  const checklist = agent.upkeepChecklist?.join('\n') ?? '';
  for (const field of [
    'entityUpserts',
    'update_sheet',
    'edgeAsserts',
    'edgeRetires',
    'relationshipUpdates',
    'factsLearned',
    'suspectedBy',
    'threadUpdates',
    'conditionUpdates',
    'vowBreaks',
    'add_consequence',
  ]) {
    assert.match(checklist, new RegExp(field), `checklist mentions ${field}`);
  }

  const server = buildGuide({ ...input, upkeep: 'server' });
  assert.equal(server.upkeep, 'server');
  assert.equal(server.upkeepChecklist, undefined);
});

test('SQLite MCP story tools report upkeep and follow a mid-session provider swap', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()));
  const engine = new Engine({ world, providers: registry });
  const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data', lintBlocklist: () => ['stock phrase'] };

  assert.equal(getStateTool(ctx).upkeep, 'agent');
  assert.equal(createStoryTool(ctx, { title: 'Second' }).upkeep, 'agent');
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  assert.equal(proposal.upkeep, 'agent');
  const guide = getGuideTool(ctx);
  assert.ok(guide.upkeepChecklist?.length);
  assert.match(guide.writing.rules, /You do not invent world facts/);
  assert.deepEqual(guide.writing.blocklist, ['stock phrase']);

  registry.swap(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' })), 'stub');
  assert.equal(getStateTool(ctx).upkeep, 'server', 'no reconnect needed');
  assert.equal(getGuideTool(ctx).upkeepChecklist, undefined);
  world.close();
});

test('coerceAgentDelta falls back to one prose event when every supplied event is blank', () => {
  const { delta, issues } = coerceAgentDelta(
    { events: [{ text: '   ' }, 'junk'], factsLearned: [{ text: 'The bell is cracked.', knownBy: ['char:a'] }] },
    'Rain  on the\nroof.',
    ['char:a', 'char:b'],
    'loc:roof',
  );
  assert.equal(delta.events.length, 1);
  assert.deepEqual(delta.events[0], {
    text: 'Rain on the roof.',
    participants: ['char:a', 'char:b'],
    locationId: 'loc:roof',
    significance: 0.5,
  });
  assert.equal(delta.factsLearned.length, 1, 'the other fields are kept');
  assert.equal(issues.filter((i) => !i.repaired).length, 0, 'a missing event list never blocks an agent turn');
});

test('coerceAgentDelta keeps agent events when at least one has text', () => {
  const { delta } = coerceAgentDelta(
    { events: [{ text: 'Anselm bars the door.', participants: ['char:a'], significance: 0.8 }] },
    'prose',
    ['char:z'],
    null,
  );
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0]!.text, 'Anselm bars the door.');
  assert.deepEqual(delta.events[0]!.participants, ['char:a']);
});

test('SQLite agentDelta validates an agent world and records the present cast on the fallback event', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta, validation } = agentDelta(
    world,
    { edgeAsserts: [{ subject: 'char:brother-anselm', predicate: 'DISTRUSTS', object: 'char:nobody' }] },
    'Anselm waits by the door.',
  );
  assert.equal(validation.ok, true);
  assert.equal(delta.events.length, 1);
  assert.ok(delta.events[0]!.participants.includes('char:brother-anselm'));
  assert.equal(delta.events[0]!.locationId, 'loc:the-scriptorium');
  assert.equal(delta.edgeAsserts.length, 0, 'an edge to an unknown id is dropped');
  assert.ok(validation.issues.some((i) => i.repaired && /char:nobody/.test(i.message)));
  world.close();
});

function sqliteContext(extractId = 'mock') {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider({ id: extractId })) });
  const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data' };
  return { world, engine, ctx };
}

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

test('SQLite commit_narration with agent upkeep commits the world delta and reports what was dropped', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, {
    resumeToken: proposal.resumeToken,
    prose: 'Anselm strikes a bargain with the ferryman.',
    world: AGENT_WORLD,
  });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  assert.equal(out.upkeep, 'agent');
  assert.equal(out.warning, undefined);
  assert.equal(out.applied.entityUpserts, 1);
  assert.equal(out.applied.edgeAsserts, 1, 'the edge to an unknown id is not applied');
  assert.equal(out.applied.factsLearned, 1);
  assert.ok(out.dropped.some((issue) => /char:nobody/.test(issue.message)));
  assert.equal(out.newThreads.length, 1, 'a title without an id opens a thread');
  assert.equal(world.graph.get('char:ferryman-oll')?.name, 'Oll the Ferryman');
  assert.ok(world.graph.neighbours('char:ferryman-oll').some((n) => n.edge.predicate === 'OWES'));
  assert.ok(world.chronicle.knowledgeOf('char:sister-oria').some((k) => k.level === 'suspects' && /ferry runs/.test(k.text)));
  assert.ok(world.threads.all().some((thread) => thread.title === 'The night ferry'));
  world.close();
});

test('SQLite commit_narration warns when agent upkeep omits world', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'Anselm warms the ink.' });
  if (out.status !== 'narrated') throw new Error('expected narrated');
  assert.match(out.warning ?? '', /no world was given/);
  world.close();
});

test('SQLite commit_narration with server upkeep ignores world and says so', async () => {
  const { world, ctx } = sqliteContext('stub-extractor');
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
  assert.equal(world.graph.get('char:ferryman-oll'), undefined);
  assert.deepEqual(out.dropped, []);
  world.close();
});

test('SQLite commit_narration seeds consequences in its own checkpoint, like play', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'A bargain.', world: AGENT_WORLD });
  if (out.status !== 'narrated') throw new Error('expected narrated');
  assert.ok(out.consequencesSeeded > 0, 'a significant event touching a well-connected character ripples');
  assert.ok(world.consequences.all().length >= out.consequencesSeeded);
  const checkpoints = world.db
    .prepare('SELECT count(*) AS n FROM history_checkpoints WHERE story_id = ?')
    .get(world.storyId) as { n: number };
  assert.equal(Number(checkpoints.n), 2, 'the turn checkpoint, then the consequence checkpoint');
  world.close();
});

function sqliteOrigins(world: World): Array<string | null> {
  return (
    world.db.prepare('SELECT origin FROM history_checkpoints WHERE story_id = ? ORDER BY position').all(world.storyId) as Array<{
      origin: string | null;
    }>
  ).map((row) => row.origin);
}

async function sqliteAgentTurn(ctx: McpToolContext, text: string, world: Record<string, unknown>) {
  const proposal = await proposeTurnTool(ctx, { text });
  if (proposal.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${proposal.status}`);
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: `${text}, and it is written down.`, world });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  return out;
}

test('SQLite checkpoints record their origin, and a fork keeps it', async () => {
  const { world, ctx } = sqliteContext();
  const first = await sqliteAgentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
  assert.deepEqual(sqliteOrigins(world), ['turn:agent', 'tool:consequences']);
  const fork = rollbackTool(ctx, { turnId: first.turnId });
  assert.deepEqual(sqliteOrigins(world.withStory(fork.forkedStory!.id)), ['turn:agent']);
  world.close();

  const server = sqliteContext('stub-extractor');
  const proposal = await proposeTurnTool(server.ctx, { text: 'i check the door' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  await commitNarrationTool(server.ctx, { resumeToken: proposal.resumeToken, prose: 'The door holds.' });
  assert.deepEqual(sqliteOrigins(server.world), ['turn:server', 'tool:consequences']);
  server.world.close();
});

test('SQLite get_state lists recent checkpoints newest first with their origin', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const state = getStateTool(ctx);
  assert.deepEqual(
    state.recentHistory.map(({ origin, turnId }) => [origin, turnId]),
    [['tool:consequences', null], ['turn:agent', turn.turnId]],
  );
  world.close();
});

test('SQLite granular tools write one checkpoint each, labelled by tool', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const recorded = recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['Brother Anselm'], suspectedBy: ['char:sister-oria'] });
  assert.deepEqual(recorded.knownBy, ['char:brother-anselm'], 'names resolve like the other authoring tools');
  assert.ok(world.chronicle.knowledgeOf('char:sister-oria').some((k) => k.level === 'suspects' && /takes coin/.test(k.text)));
  const thread = openThreadTool(ctx, { title: 'The garrison purse', parties: ['char:captain-sered'], tension: 2 });
  assert.equal(thread.tension, 1, 'tension is clamped to 0..1');
  assert.deepEqual(thread.resolutions, ['unresolved', 'escalates', 'fades']);
  const event = world.chronicle.events({ limit: 1 })[0]!;
  const consequence = addConsequenceTool(ctx, {
    causeEventId: event.id,
    actorId: 'char:captain-sered',
    action: 'Sered audits the ferry tolls.',
    trigger: { kind: 'after-scenes', scenes: 1 },
    visibility: 'offscreen-discoverable',
  });
  assert.equal(consequence.maturity, 'pending');
  assert.throws(
    () => addConsequenceTool(ctx, { causeEventId: 'ev:missing', actorId: 'char:captain-sered', action: 'x', trigger: { kind: 'immediate' }, visibility: 'onscreen' }),
    /no event "ev:missing"/,
  );
  assert.throws(() => recordFactTool(ctx, { text: 'x', knownBy: ['char:nobody'] }), /no entity/);
  assert.deepEqual(sqliteOrigins(world), ['turn:agent', 'tool:consequences', 'tool:record_fact', 'tool:open_thread', 'tool:add_consequence']);
  assert.ok(turn.turnId);
  world.close();
});

test('SQLite rollback and fork across an agent turn and a record_fact write restore exactly', async () => {
  const { world, ctx } = sqliteContext();
  const first = await sqliteAgentTurn(ctx, 'i warm the ink', {
    entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman' }],
    factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'] }],
  });
  recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['char:brother-anselm'] });
  await sqliteAgentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'loc:far-bank', type: 'Location', name: 'The Far Bank' }] });

  const fork = rollbackTool(ctx, { turnId: first.turnId });
  const forked = world.withStory(fork.forkedStory!.id);
  assert.ok(forked.graph.get('char:ferryman-oll'));
  assert.ok(forked.chronicle.facts().some((f) => f.text === 'The ferry runs at night.'));
  assert.ok(!forked.chronicle.facts().some((f) => f.text.startsWith('Oll takes coin')), 'the later tool write is not in the fork');
  assert.equal(forked.graph.get('loc:far-bank'), undefined);

  rollbackTool(ctx, { turnId: first.turnId, mode: 'destructive' });
  assert.ok(world.graph.get('char:ferryman-oll'));
  assert.ok(!world.chronicle.facts().some((f) => f.text.startsWith('Oll takes coin')));
  assert.equal(world.graph.get('loc:far-bank'), undefined);
  assert.deepEqual(sqliteOrigins(world), ['turn:agent']);
  world.close();
});
