import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, withPg } from './pg-harness.ts';
import { applyMigrations, type Db } from '../src/db/pg.ts';
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
  rollbackTool,
  recordFactTool,
  openThreadTool,
  addConsequenceTool,
  replaceTurnProseTool,
  resolveInterruptTool,
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

test('PostgreSQL agentDelta leaves the dead out of the fallback event instead of blocking the turn', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seededStory(db);
    const anselm = (await world.graph.get('char:brother-anselm'))!;
    await world.graph.upsert({ ...anselm, props: { ...anselm.props, status: 'dead' } }, 'chronicle');
    const { delta, validation } = await agentDelta(world, {}, 'The candle burns down.');
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.equal(delta.events[0]!.participants.includes('char:brother-anselm'), false);
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
    assert.equal(Number(count?.count), 3, 'the baseline, the turn checkpoint, then the consequence checkpoint');
  });
  if (!ran) t.skip('no Postgres configured');
});

async function agentTurn(ctx: McpToolContext, text: string, world: Record<string, unknown>) {
  const proposal = await proposeTurnTool(ctx, { text });
  if (proposal.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${proposal.status}`);
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: `${text}, and it is written down.`, world });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  return out;
}

async function origins(db: Db, storyId: string): Promise<Array<string | null>> {
  const { rows } = await db.query<{ origin: string | null }>(
    `SELECT origin FROM history_checkpoints WHERE story_id = $1 ORDER BY position`,
    [storyId],
  );
  return rows.map((row) => row.origin);
}

test('PostgreSQL migration 009 adds history_checkpoints.origin to an existing schema', async (t) => {
  const ran = await withPg(async (db, schema) => {
    await db.query('ALTER TABLE history_checkpoints DROP COLUMN origin');
    await db.query('DELETE FROM migrations WHERE version = 9');
    await applyMigrations(db);
    const row = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'history_checkpoints' AND column_name = 'origin'`,
      [schema],
    );
    assert.equal(Number(row?.count), 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL checkpoints record their origin, and a fork keeps it', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const first = await agentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
    assert.deepEqual(await origins(db, world.storyId), ['story:start', 'turn:agent', 'tool:consequences']);

    const fork = await rollbackTool(ctx, { turnId: first.turnId });
    assert.deepEqual(await origins(db, fork.story!.id), ['story:start', 'turn:agent'], 'the fork copies the retained checkpoint with its origin');
  });
  if (!ran) return t.skip('no Postgres configured');

  // A fresh schema: pgContext seeds the verrow world, whose slug is unique.
  await withPg(async (db) => {
    const server = await pgContext(db, 'stub-extractor');
    const proposal = await proposeTurnTool(server.ctx, { text: 'i check the door' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    await commitNarrationTool(server.ctx, { resumeToken: proposal.resumeToken, prose: 'The door holds.' });
    assert.deepEqual(await origins(db, server.world.storyId), ['story:start', 'turn:server', 'tool:consequences']);
  });
});

test('PostgreSQL get_state lists recent checkpoints newest first with their origin', async (t) => {
  const ran = await withPg(async (db) => {
    const { ctx } = await pgContext(db);
    const turn = await agentTurn(ctx, 'i warm the ink', {});
    const state = await getStateTool(ctx);
    assert.deepEqual(
      state.recentHistory.map(({ origin, turnId }) => [origin, turnId]),
      [['tool:consequences', null], ['turn:agent', turn.turnId], ['story:start', null]],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL granular tools write one checkpoint each, labelled by tool', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', {});
    const recorded = await recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['Brother Anselm'], suspectedBy: ['char:sister-oria'] });
    assert.deepEqual(recorded.knownBy, ['char:brother-anselm']);
    const thread = await openThreadTool(ctx, { title: 'The garrison purse', parties: ['char:captain-sered'], tension: 2 });
    assert.equal(thread.tension, 1);
    const event = (await world.chronicle.events({ limit: 1 }))[0]!;
    const consequence = await addConsequenceTool(ctx, {
      causeEventId: event.id,
      actorId: 'char:captain-sered',
      action: 'Sered audits the ferry tolls.',
      trigger: { kind: 'after-scenes', scenes: 1 },
      visibility: 'offscreen-discoverable',
    });
    assert.equal(consequence.maturity, 'pending');
    await assert.rejects(
      () => addConsequenceTool(ctx, { causeEventId: 'ev:missing', actorId: 'char:captain-sered', action: 'x', trigger: { kind: 'immediate' }, visibility: 'onscreen' }),
      /no event "ev:missing"/,
    );
    const base = { causeEventId: event.id, actorId: 'char:captain-sered', action: 'x', visibility: 'onscreen' as const };
    await assert.rejects(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-enter', locationId: 'The Far Bank' } }), /no entity "The Far Bank"/);
    await assert.rejects(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-enter', locationId: 'char:captain-sered' } }), /not a Location/);
    await assert.rejects(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'Brother Anselm', factId: 'fact:missing' } }), /no fact "fact:missing"/);
    await assert.rejects(() => addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'char:nobody', factId: recorded.fact.id } }), /no entity "char:nobody"/);
    const onLearn = await addConsequenceTool(ctx, { ...base, trigger: { kind: 'on-learn', entityId: 'Brother Anselm', factId: recorded.fact.id } });
    assert.deepEqual(onLearn.trigger, { kind: 'on-learn', entityId: 'char:brother-anselm', factId: recorded.fact.id });
    assert.deepEqual(await origins(db, world.storyId), ['story:start', 'turn:agent', 'tool:consequences', 'tool:record_fact', 'tool:open_thread', 'tool:add_consequence', 'tool:add_consequence']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL rollback and fork across an agent turn and a record_fact write restore exactly', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const first = await agentTurn(ctx, 'i warm the ink', {
      entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman' }],
      factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'] }],
    });
    await recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['char:brother-anselm'] });
    await agentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'loc:far-bank', type: 'Location', name: 'The Far Bank' }] });

    const fork = await rollbackTool(ctx, { turnId: first.turnId });
    const forked = await World.forStory(db, fork.story!.id);
    assert.ok(await forked.graph.get('char:ferryman-oll'));
    assert.ok((await forked.chronicle.facts()).some((f) => f.text === 'The ferry runs at night.'));
    assert.ok(!(await forked.chronicle.facts()).some((f) => f.text.startsWith('Oll takes coin')));
    assert.equal(await forked.graph.get('loc:far-bank'), undefined);

    await rollbackTool(ctx, { turnId: first.turnId, mode: 'destructive' });
    assert.ok(await world.graph.get('char:ferryman-oll'));
    assert.ok(!(await world.chronicle.facts()).some((f) => f.text.startsWith('Oll takes coin')));
    assert.equal(await world.graph.get('loc:far-bank'), undefined);
    assert.deepEqual(await origins(db, world.storyId), ['story:start', 'turn:agent']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world re-applies the latest turn from the checkpoint before it', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
    const second = await agentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'item:brass-key', type: 'Item', name: 'A Brass Key' }] });
    const out = await replaceTurnProseTool(ctx, {
      id: second.turnId,
      prose: 'Anselm checks the door and finds a lantern.',
      world: { entityUpserts: [{ id: 'item:lantern', type: 'Item', name: 'A Hooded Lantern' }] },
    });
    if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
    assert.equal(await world.graph.get('item:brass-key'), undefined);
    assert.ok(await world.graph.get('item:lantern'));
    assert.ok(await world.graph.get('char:ferryman-oll'));
    const turns = await world.chronicle.turns();
    assert.equal(turns.length, 2);
    assert.equal(turns.at(-1)!.bookProse, 'Anselm checks the door and finds a lantern.');
    assert.deepEqual(await origins(db, world.storyId), ['story:start', 'turn:agent', 'tool:consequences', 'turn:agent', 'tool:consequences'], 'the re-commit seeds consequences in its own checkpoint');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world refuses when a later edit exists, and changes nothing', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', {});
    const second = await agentTurn(ctx, 'i check the door', {});
    await recordFactTool(ctx, { text: 'The latch sticks.' });
    const before = await origins(db, world.storyId);
    await assert.rejects(
      () => replaceTurnProseTool(ctx, { id: second.turnId, prose: 'Other prose.', world: {} }),
      /later turns or edits/,
    );
    assert.deepEqual(await origins(db, world.storyId), before);
    assert.notEqual((await world.chronicle.getTurn(second.turnId))?.bookProse, 'Other prose.');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL eligible turns carry their checkpoint origin', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const turn = await agentTurn(ctx, 'i warm the ink', {});
    assert.deepEqual(
      (await world.history.eligibleTurns()).map(({ turnId, origin }) => [turnId, origin]),
      [[turn.turnId, 'turn:agent']],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world re-applies the first turn, re-seeds its consequences and returns citable event ids', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const first = await agentTurn(ctx, 'i warm the ink', AGENT_WORLD);
    assert.ok(first.events[0]?.id.startsWith('ev:'), 'commit_narration returns event ids');
    const consequences = (await world.consequences.all()).length;
    const directed = (await world.chronicle.getTurn(first.turnId))!.meta.threadId;
    assert.ok(directed, 'the director steered this turn toward a thread');
    const tension = (await world.threads.all()).find((thread) => thread.id === directed)!.tension;

    const out = await replaceTurnProseTool(ctx, { id: first.turnId, prose: 'Anselm strikes a bargain with Oll.', world: AGENT_WORLD });
    if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
    assert.equal((await world.chronicle.turns()).length, 1);
    assert.ok(out.consequencesSeeded > 0);
    assert.equal((await world.consequences.all()).length, consequences, 'the old seeds are replaced, not lost');
    assert.equal((await world.threads.all()).find((thread) => thread.id === directed)!.tension, tension, 'the director bump is re-applied');
    const consequence = await addConsequenceTool(ctx, {
      causeEventId: out.events[0]!.id,
      actorId: 'char:captain-sered',
      action: 'Sered hears of the bargain.',
      trigger: { kind: 'immediate' },
      visibility: 'offscreen-discoverable',
    });
    assert.equal(consequence.causeEventId, out.events[0]!.id);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world keeps a vow break the player chose at an interrupt', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const vow = async () => (await world.cast.get('char:brother-anselm'))!.contract.vows.find((v) => v.id === 'nonviolence')!;
    const proposal = await proposeTurnTool(ctx, { text: 'i stab the captain' });
    assert.equal(proposal.status, 'interrupted');
    const resolved = await resolveInterruptTool(ctx, { originalText: 'i stab the captain', effect: 'establish-break' });
    if (resolved.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${resolved.status}`);
    const committed = await commitNarrationTool(ctx, { resumeToken: resolved.resumeToken, prose: 'Anselm stabs the captain.', world: {} });
    if (committed.status !== 'narrated') throw new Error(`expected narrated, got ${committed.status}`);
    assert.equal((await vow()).broken, true);

    const out = await replaceTurnProseTool(ctx, { id: committed.turnId, prose: 'The blade goes in.', world: {} });
    if (out.status !== 'replaced' || out.stateMode !== 'reapplied') throw new Error(`expected reapplied, got ${out.status}`);
    assert.equal((await vow()).broken, true, 'the prose fix does not un-break the vow');
    assert.ok(out.brokenVows.some((v) => v.vowId === 'nonviolence'));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL commit_narration decides upkeep and extracts on one provider resolution', async (t) => {
  const ran = await withPg(async (db) => {
    const { ctx } = await pgContext(db);
    const server = new MockProvider({ id: 'stub-extractor' });
    const answers: ProviderRegistry[] = [];
    // Each resolution may see a different key state (a lock, a delete, a toggle); these answers differ per call.
    ctx.providers = async () => answers.shift() ?? new ProviderRegistry(new MockProvider());
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    answers.push(new ProviderRegistry(server), new ProviderRegistry(new MockProvider()));
    const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'Anselm waits by the door.' });
    if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
    assert.equal(out.upkeep, 'server');
    assert.ok(server.calls.some((c) => c.role === 'extract'), 'the registry that decided upkeep is the one that extracted');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world re-summarises the scene a recommitted turn closes', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', {});
    const closing = await agentTurn(ctx, 'i leave the scriptorium', { sceneAdvance: true });
    const summaryOf = async (scene: number) => (await world.chronicle.scenes()).find((s) => s.scene === scene)?.summary;
    const scene = (await world.chronicle.getTurn(closing.turnId))!.scene;
    assert.ok(await summaryOf(scene), 'the first commit compacted the closed scene');
    const out = await replaceTurnProseTool(ctx, { id: closing.turnId, prose: 'Anselm leaves at dusk.', world: { sceneAdvance: true } });
    if (out.status !== 'replaced') throw new Error(`expected replaced, got ${out.status}`);
    assert.ok(await summaryOf(scene), 'the recommit compacts it again');
  });
  if (!ran) t.skip('no Postgres configured');
});
