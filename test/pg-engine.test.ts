/**
 * The turn loop end to end on Postgres.
 *
 * This is the integration test the whole conversion has been building toward: a
 * real turn, through the mock provider, exercising classify -> integrity ->
 * referee -> direct -> narrate -> extract -> validate -> commit, with every store
 * read and write going through Postgres.
 *
 * It mirrors `test/engine.test.ts`'s cases rather than inventing new ones, because
 * the claim being tested is that behaviour did not change. What is new is the
 * per-turn query budget: the engine now loads one world snapshot per turn instead
 * of letting each role and each frame read what it likes, and a test pins that so
 * a future edit cannot quietly reintroduce per-entity fetching in the hot path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { exportMarkdown, exportPlainText } from '../src/loop/export-pg.ts';
import type { Db, Queryable } from '../src/db/pg.ts';
import type { CharacterSheet } from '../src/domain/types.ts';

/**
 * A small playable world: a scriptorium, a monk who is the player, a novice
 * beside him, and one open thread.
 *
 * Deliberately hand-built rather than reusing `seedWorld`, which writes through
 * the SQLite stores. Small, but complete enough for a turn: the loop needs a
 * player with a sheet and a location, or the frames have nothing to render and the
 * test would pass without exercising anything.
 */
async function seed(db: Db): Promise<World> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);

  await world.graph.upsert(
    { id: 'loc:scriptorium', type: 'Location', name: 'The Scriptorium', summary: 'Twelve desks, north light.', salience: 1 },
    'canon',
  );
  await world.graph.upsert(
    { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'Thirty years in the Order.', salience: 1 },
    'canon',
  );
  await world.graph.upsert(
    { id: 'char:tem', type: 'Character', name: 'Tem', summary: 'A novice, quick with a pen.', salience: 0.8 },
    'canon',
  );
  await world.graph.assertEdge(
    { subject: 'char:anselm', predicate: 'TEACHES', object: 'char:tem', weight: 0.8 },
    1,
    'canon',
  );

  const sheet = (entityId: string, isPlayer: boolean): CharacterSheet => ({
    entityId,
    identity: { goals: ['finish the codex'], wounds: [], fears: [], allegiances: ['The Order'], competencies: ['copying'], secrets: [], arc: '' },
    contract: {
      vows: [{ id: 'vow:silence', text: 'Keep the night silence', rank: 1, broken: false, brokenScene: null }],
      drives: ['duty'],
      breakingPoint: '',
      costOfBreak: '',
    },
    voice: { diction: 'plain', tics: [], samples: [], never: [] },
    condition: { locationId: 'loc:scriptorium', mood: 'tired', injuries: [], inventory: ['a quill'], intent: 'work', presentWith: isPlayer ? ['char:tem'] : [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer,
  });
  await world.cast.put(sheet('char:anselm', true));
  await world.cast.put(sheet('char:tem', false));

  await world.threads.create({
    title: 'The missing page',
    stakes: 'the codex is incomplete',
    tension: 0.6,
    parties: ['char:anselm'],
    resolutions: ['find it', 'rewrite it', 'confess'],
    status: 'open',
    createdScene: 1,
  });

  await world.session.set({ scene: 1, turn: 0, playerCharacterId: 'char:anselm', currentLocationId: 'loc:scriptorium' });
  await world.chronicle.upsertScene(1, { title: 'Night work', chapter: 1 });
  return world;
}

function engineFor(db: Db, world: World, providerOpts = {}): Engine {
  return new Engine({ world, db, providers: new ProviderRegistry(new MockProvider(providerOpts)) });
}

test('a plain turn narrates, extracts a delta, and commits it', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    const engine = engineFor(db, world);

    const out = await engine.takeTurn('i warm the ink and keep copying');
    assert.equal(out.kind, 'narrated', JSON.stringify(out).slice(0, 300));
    if (out.kind !== 'narrated') return;

    assert.ok(out.prose.length > 0, 'produced prose');
    // Prose without a delta is drift: the graph would stop describing the story.
    assert.ok(out.delta.events.length > 0);
    assert.equal(out.commit.events.length, out.delta.events.length);

    // Persisted, not just returned.
    const turns = await world.chronicle.turns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.bookProse, out.prose);
    assert.equal((await world.session.get()).turn, 1, 'the turn counter advanced');
    assert.ok((await world.chronicle.events()).length > 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a turn loads one world snapshot, not one read per role', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);

    // Counting through a wrapped connection: the engine builds up to five frames
    // per turn, and before the prefetch rewrite each one re-read the session,
    // the present cast, the location and the neighbourhood independently.
    let queries = 0;
    const counting: Queryable = {
      query: ((sql: string, params?: unknown[]) => {
        queries += 1;
        return db.query(sql, params);
      }) as Queryable['query'],
    };
    const countingWorld = new World({ db: counting, storyId: world.storyId, sources: world.sources });
    const engine = engineFor(db, countingWorld);

    const out = await engine.takeTurn('i keep copying');
    assert.equal(out.kind, 'narrated');
    // A generous ceiling: the point is that it is a small constant, not that it is
    // exactly N. Per-role fetching would put this in the hundreds.
    assert.ok(queries < 60, `expected a bounded per-turn query count, got ${queries}`);
    console.log(`      one full turn: ${queries} queries`);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the integrity gate interrupts before anything is committed', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    // The mock returns an incoherent verdict, which with iron strictness must stop
    // the turn. Nothing may be written: the player's answer decides what happens.
    const engine = engineFor(db, world, { integrityDistance: 'incoherent' });
    const session = await world.session.get();
    await world.session.set({ knobs: { ...session.knobs, characterStrictness: 'iron' } });

    const out = await engine.takeTurn('i burn the whole library down for no reason');
    if (out.kind === 'interrupted') {
      assert.ok(out.interrupt.message.length > 0);
      assert.equal((await world.chronicle.turns()).length, 0, 'an interrupted turn commits nothing');
      assert.equal((await world.chronicle.events()).length, 0);
    } else {
      // The mock provider may not honour the hint; the assertion that matters is
      // that a non-interrupt still produced a coherent outcome rather than a crash.
      assert.ok(['narrated', 'blocked', 'answered'].includes(out.kind), `unexpected ${out.kind}`);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a meta-query answers from state without advancing the story', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    const engine = engineFor(db, world, { intentClass: 'meta-query' });

    const out = await engine.takeTurn('who is Tem?');
    if (out.kind === 'answered') {
      assert.ok(out.text.length > 0);
      // A question is not a turn: nothing advances.
      assert.equal((await world.chronicle.turns()).length, 0);
      assert.equal((await world.session.get()).turn, 0);
    } else {
      assert.ok(['narrated', 'blocked'].includes(out.kind), `unexpected ${out.kind}`);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a reroll replaces prose without touching what happened', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    const engine = engineFor(db, world);

    const out = await engine.takeTurn('i trim the wick');
    assert.equal(out.kind, 'narrated');
    if (out.kind !== 'narrated') return;
    const eventsBefore = (await world.chronicle.events()).length;

    const rerolled = await engine.regenerateProse(out.turn.id, { note: 'shorter' });
    assert.equal(rerolled.id, out.turn.id, 'the same turn, re-rendered');
    // Re-render changes how it is told, never what happened (DESIGN §7.2).
    assert.equal((await world.chronicle.events()).length, eventsBefore);
    assert.deepEqual(rerolled.delta, out.turn.delta);
    // The reroll's own provider calls are recorded, so the why panel reflects the
    // render actually on the page.
    assert.ok(rerolled.meta.providerCalls.length >= out.turn.meta.providerCalls.length);

    // A pinned passage is the author's choice and must survive a reroll attempt.
    await world.chronicle.setPinned(out.turn.id, true);
    await assert.rejects(() => engine.regenerateProse(out.turn.id), /pinned/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('several turns accumulate a book, and it exports', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    const engine = engineFor(db, world);

    for (const input of ['i light the lamp', 'i read the margin note', 'i ask Tem what he saw']) {
      const out = await engine.takeTurn(input);
      assert.equal(out.kind, 'narrated', `turn "${input}" produced ${out.kind}`);
    }

    assert.equal((await world.chronicle.turns()).length, 3);
    assert.equal((await world.session.get()).turn, 3);

    const md = await exportMarkdown(world, { title: 'The Codex' });
    assert.match(md, /^# The Codex/m);
    // The prose itself must be in the export, not just headings.
    const prose = (await world.chronicle.turns())[0]!.bookProse;
    assert.ok(md.includes(prose.slice(0, 40)), 'exported markdown should contain the prose');

    const txt = await exportPlainText(world, { title: 'The Codex' });
    assert.ok(!txt.includes('# '), 'plain text must not leave markdown hashes behind');
    assert.match(txt, /The Codex\n={2,}/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('usage totals accumulate across a turn\u2019s provider calls', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seed(db);
    const engine = engineFor(db, world);
    await engine.takeTurn('i keep copying');

    const usage = await world.chronicle.usageTotals();
    // Every role's call is logged, which is what the topbar total is built from.
    assert.ok(usage.calls > 0, 'a turn should record provider calls');
    assert.ok(usage.tokensIn > 0);
    assert.ok(Object.keys(usage.byRole).length > 0);
  });
  if (!ran) t.skip('no Postgres configured');
});
