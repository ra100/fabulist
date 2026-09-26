import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { defaultKnobs, defaultStyleContract } from '../src/domain/types.ts';
import { buildGuide, peopleInput, triggerInput, upkeepFor, worldDeltaInput } from '../src/mcp/upkeep.ts';
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
  replaceTurnProseTool,
  resolveInterruptTool,
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

test('SQLite agentDelta leaves the dead out of the fallback event instead of blocking the turn', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const anselm = world.graph.get('char:brother-anselm')!;
  world.graph.upsert({ ...anselm, props: { ...anselm.props, status: 'dead' } }, 'chronicle');
  const { delta, validation } = agentDelta(world, {}, 'The candle burns down.');
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal(delta.events[0]!.participants.includes('char:brother-anselm'), false);
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
  assert.equal(Number(checkpoints.n), 3, 'the baseline, the turn checkpoint, then the consequence checkpoint');
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
  assert.deepEqual(sqliteOrigins(world), ['story:start', 'turn:agent', 'tool:consequences']);
  const fork = rollbackTool(ctx, { turnId: first.turnId });
  assert.deepEqual(sqliteOrigins(world.withStory(fork.forkedStory!.id)), ['story:start', 'turn:agent']);
  world.close();

  const server = sqliteContext('stub-extractor');
  const proposal = await proposeTurnTool(server.ctx, { text: 'i check the door' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  await commitNarrationTool(server.ctx, { resumeToken: proposal.resumeToken, prose: 'The door holds.' });
  assert.deepEqual(sqliteOrigins(server.world), ['story:start', 'turn:server', 'tool:consequences']);
  server.world.close();
});

test('SQLite get_state lists recent checkpoints newest first with their origin', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const state = getStateTool(ctx);
  assert.deepEqual(
    state.recentHistory.map(({ origin, turnId }) => [origin, turnId]),
    [['tool:consequences', null], ['turn:agent', turn.turnId], ['story:start', null]],
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
  const base = { causeEventId: event.id, actorId: 'char:captain-sered', action: 'x', visibility: 'onscreen' as const };
  assert.throws(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-enter', locationId: 'The Far Bank' } }), /no entity "The Far Bank"/);
  assert.throws(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-enter', locationId: 'char:captain-sered' } }), /not a Location/);
  assert.throws(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'Brother Anselm', factId: 'fact:missing' } }), /no fact "fact:missing"/);
  assert.throws(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'char:nobody', factId: recorded.fact.id } }), /no entity "char:nobody"/);
  const onLearn = addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'Brother Anselm', factId: recorded.fact.id } });
  assert.deepEqual(onLearn.trigger, { kind: 'on-learn', entityId: 'char:brother-anselm', factId: recorded.fact.id }, 'trigger names resolve to ids');
  assert.throws(() => recordFactTool(ctx, { text: 'x', knownBy: ['char:nobody'] }), /no entity/);
  assert.deepEqual(sqliteOrigins(world), ['story:start', 'turn:agent', 'tool:consequences', 'tool:record_fact', 'tool:open_thread', 'tool:add_consequence', 'tool:add_consequence']);
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
  assert.deepEqual(sqliteOrigins(world), ['story:start', 'turn:agent']);
  world.close();
});

test('SQLite replace_turn_prose with world re-applies the latest turn from the checkpoint before it', async () => {
  const { world, ctx } = sqliteContext();
  await sqliteAgentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
  const second = await sqliteAgentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'item:brass-key', type: 'Item', name: 'A Brass Key' }] });
  const out = await replaceTurnProseTool(ctx, {
    id: second.turnId,
    prose: 'Anselm checks the door and finds a lantern.',
    world: { entityUpserts: [{ id: 'item:lantern', type: 'Item', name: 'A Hooded Lantern' }] },
  });
  if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
  assert.equal(out.stateMode, 'reapplied');
  assert.equal(out.replacedTurnId, second.turnId);
  assert.equal(world.graph.get('item:brass-key'), undefined, 'the old delta is gone');
  assert.ok(world.graph.get('item:lantern'));
  assert.ok(world.graph.get('char:ferryman-oll'), 'the earlier turn stands');
  const turns = world.chronicle.turns();
  assert.equal(turns.length, 2);
  assert.equal(turns.at(-1)!.bookProse, 'Anselm checks the door and finds a lantern.');
  assert.deepEqual(sqliteOrigins(world), ['story:start', 'turn:agent', 'tool:consequences', 'turn:agent', 'tool:consequences'], 'the re-commit seeds consequences in its own checkpoint');
  world.close();
});

test('SQLite replace_turn_prose with world refuses when a later edit exists, and changes nothing', async () => {
  const { world, ctx } = sqliteContext();
  await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const second = await sqliteAgentTurn(ctx, 'i check the door', {});
  recordFactTool(ctx, { text: 'The latch sticks.' });
  const before = sqliteOrigins(world);
  await assert.rejects(
    () => replaceTurnProseTool(ctx, { id: second.turnId, prose: 'Other prose.', world: {} }),
    /later turns or edits/,
  );
  assert.deepEqual(sqliteOrigins(world), before);
  assert.notEqual(world.chronicle.getTurn(second.turnId)?.bookProse, 'Other prose.');
  world.close();
});

test('SQLite replace_turn_prose without world keeps the delta and warns under agent upkeep', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const out = await replaceTurnProseTool(ctx, { id: turn.turnId, prose: 'New prose.' });
  assert.equal(out.stateMode, 'preserve');
  assert.equal(out.upkeep, 'agent');
  assert.match(out.warning ?? '', /may no longer match/);
  world.close();
});

test('SQLite replace_turn_prose with world re-applies the first turn, re-seeds its consequences and returns citable event ids', async () => {
  const { world, ctx } = sqliteContext();
  const first = await sqliteAgentTurn(ctx, 'i warm the ink', AGENT_WORLD);
  assert.ok(first.events[0]?.id.startsWith('ev:'), 'commit_narration returns event ids');
  const consequences = world.consequences.all().length;
  const directed = world.chronicle.getTurn(first.turnId)!.meta.threadId;
  assert.ok(directed, 'the director steered this turn toward a thread');
  const tension = world.threads.all().find((thread) => thread.id === directed)!.tension;

  const out = await replaceTurnProseTool(ctx, { id: first.turnId, prose: 'Anselm strikes a bargain with Oll.', world: AGENT_WORLD });
  if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
  assert.equal(world.chronicle.turns().length, 1);
  assert.ok(out.consequencesSeeded > 0);
  assert.equal(world.consequences.all().length, consequences, 'the old seeds are replaced, not lost');
  assert.equal(world.threads.all().find((thread) => thread.id === directed)!.tension, tension, 'the director bump is re-applied');
  const consequence = addConsequenceTool(ctx, {
    causeEventId: out.events[0]!.id,
    actorId: 'char:captain-sered',
    action: 'Sered hears of the bargain.',
    trigger: { kind: 'immediate' },
    visibility: 'offscreen-discoverable',
  });
  assert.equal(consequence.causeEventId, out.events[0]!.id);
  world.close();
});

test('SQLite replace_turn_prose with world keeps a vow break the player chose at an interrupt', async () => {
  const { world, ctx } = sqliteContext();
  const vow = () => world.cast.get('char:brother-anselm')!.contract.vows.find((v) => v.id === 'nonviolence')!;
  const proposal = await proposeTurnTool(ctx, { text: 'i stab the captain' });
  assert.equal(proposal.status, 'interrupted');
  const resolved = await resolveInterruptTool(ctx, { originalText: 'i stab the captain', effect: 'establish-break' });
  if (resolved.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${resolved.status}`);
  const committed = await commitNarrationTool(ctx, { resumeToken: resolved.resumeToken, prose: 'Anselm stabs the captain.', world: {} });
  if (committed.status !== 'narrated') throw new Error(`expected narrated, got ${committed.status}`);
  assert.equal(vow().broken, true);

  const out = await replaceTurnProseTool(ctx, { id: committed.turnId, prose: 'The blade goes in.', world: {} });
  if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
  assert.equal(vow().broken, true, 'the prose fix does not un-break the vow');
  assert.ok(out.brokenVows.some((v) => v.vowId === 'nonviolence'));
  world.close();
});

test('agent world deltas and between-turn tool inputs are size-capped', () => {
  const event = { text: 'The lamp gutters.', participants: ['character:iris'] };
  assert.equal(worldDeltaInput.safeParse({ events: [event], entityUpserts: [{ id: 'item:lamp', type: 'Item', name: 'Lamp', props: { lit: false } }] }).success, true);
  assert.equal(worldDeltaInput.safeParse({ events: Array(51).fill(event) }).success, false, 'too many events');
  assert.equal(worldDeltaInput.safeParse({ events: [{ text: 'x'.repeat(10_001) }] }).success, false, 'event text');
  assert.equal(worldDeltaInput.safeParse({ events: [{ text: 'x', participants: Array(21).fill('a') }] }).success, false, 'participants');
  assert.equal(
    worldDeltaInput.safeParse({ entityUpserts: [{ id: 'x'.repeat(201), type: 'Item', name: 'Lamp' }] }).success,
    false,
    'id length',
  );
  assert.equal(
    worldDeltaInput.safeParse({ conditionUpdates: [{ entityId: 'item:lamp', patch: { blob: 'x'.repeat(10_001) } }] }).success,
    false,
    'patch size',
  );
  assert.equal(peopleInput.safeParse(Array(20).fill('character:iris')).success, true);
  assert.equal(peopleInput.safeParse(Array(21).fill('character:iris')).success, false);
  assert.equal(triggerInput.safeParse({ kind: 'after-scenes', scenes: 3 }).success, true);
  assert.equal(triggerInput.safeParse({ kind: 'after-scenes', scenes: 51 }).success, false);
});

test('SQLite replace_turn_prose with world re-summarises the scene a recommitted turn closes', async () => {
  const { world, ctx } = sqliteContext();
  await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const closing = await sqliteAgentTurn(ctx, 'i leave the scriptorium', { sceneAdvance: true });
  const summaryOf = (scene: number) => world.chronicle.scenes().find((s) => s.scene === scene)?.summary;
  const scene = world.chronicle.getTurn(closing.turnId)!.scene;
  assert.ok(summaryOf(scene), 'the first commit compacted the closed scene');
  const out = await replaceTurnProseTool(ctx, { id: closing.turnId, prose: 'Anselm leaves at dusk.', world: { sceneAdvance: true } });
  if (out.status !== 'replaced') throw new Error(`expected replaced, got ${out.status}`);
  assert.ok(summaryOf(scene), 'the recommit compacts it again');
  world.close();
});
