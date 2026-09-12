/**
 * The frame builders on Postgres, and the parity claim that matters most.
 *
 * The renderers in `builders-pg.ts` are byte-identical to the SQLite version
 * because they never touched the database — only the code feeding them did. This
 * suite asserts that literally: it builds the same world twice, once through
 * SQLite and once through Postgres, and compares the assembled frame text
 * character for character. A frame that differs is a prompt that differs, which
 * is a behaviour change no amount of green unit tests would reveal.
 *
 * It also pins the property the rewrite exists for: a bounded number of queries
 * per frame regardless of how many characters are on stage. That is invisible to
 * output-based tests and is exactly what would rot first — one reintroduced
 * per-entity `await` inside a renderer costs a round trip per character, every
 * turn, forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import {
  buildDirectorFrame,
  buildExtractFrame,
  buildIntegrityFrame,
  buildNarratorFrame,
  buildRefereeFrame,
  loadFrameData,
} from '../src/frame/builders-pg.ts';
import {
  buildDirectorFrame as sqliteDirector,
  buildExtractFrame as sqliteExtract,
  buildIntegrityFrame as sqliteIntegrity,
  buildNarratorFrame as sqliteNarrator,
  buildRefereeFrame as sqliteReferee,
} from '../src/frame/builders.ts';
import { World as SqliteWorld } from '../src/store/index.ts';
import { tokenizerFor } from '../src/frame/tokenizer.ts';
import type { Db, Queryable } from '../src/db/pg.ts';
import type { CharacterSheet } from '../src/domain/types.ts';

/**
 * One world, populated identically on both engines.
 *
 * Deliberately not a trivial fixture: it has a location with props, a player with
 * a full sheet and a vow, two present NPCs, a neighbourhood, known and hidden
 * facts, threads, directives, a ripening consequence, prior scenes, prose and a
 * style anchor — because a frame builder's job is to render all of that in a
 * fixed order and a thin fixture would exercise almost none of it.
 */
interface Seeded {
  playerId: string;
  locationId: string;
}

async function seedPg(db: Db): Promise<{ world: World; seeded: Seeded }> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  const seeded = await seedCommon({
    upsert: (e, layer) => world.graph.upsert(e as never, layer),
    edge: (a, scene, layer) => world.graph.assertEdge(a as never, scene, layer),
    sheet: (s, layer) => world.cast.put(s, layer),
    thread: (t) => world.threads.create(t as never),
    directive: (d) => world.directives.create(d as never),
    consequence: (c) => world.consequences.enqueue(c as never),
    fact: (text, scene) => world.chronicle.addFact(text, scene),
    knowledge: (factId, entityId, level, scene) => world.chronicle.setKnowledge(factId, entityId, level, scene),
    turn: (t) => world.chronicle.addTurn(t as never),
    scene: (n, patch) => world.chronicle.upsertScene(n, patch as never),
    anchor: (text) => world.chronicle.addAnchor(text),
    divergence: (scene, kind, detail) => world.chronicle.addDivergence(scene, kind, detail),
    session: (patch) => world.session.set(patch as never),
  });
  return { world, seeded };
}

function seedSqlite(): { world: SqliteWorld; seeded: Promise<Seeded> } {
  const world = SqliteWorld.open(':memory:');
  const seeded = seedCommon({
    upsert: async (e, layer) => world.graph.upsert(e as never, layer),
    edge: async (a, scene, layer) => world.graph.assertEdge(a as never, scene, layer),
    sheet: async (s, layer) => world.cast.put(s, layer),
    thread: async (t) => world.threads.create(t as never),
    directive: async (d) => world.directives.create(d as never),
    consequence: async (c) => world.consequences.enqueue(c as never),
    fact: async (text, scene) => world.chronicle.addFact(text, scene),
    knowledge: async (factId, entityId, level, scene) => world.chronicle.setKnowledge(factId, entityId, level, scene),
    turn: async (t) => world.chronicle.addTurn(t as never),
    scene: async (n, patch) => world.chronicle.upsertScene(n, patch as never),
    anchor: async (text) => world.chronicle.addAnchor(text),
    divergence: async (scene, kind, detail) => world.chronicle.addDivergence(scene, kind, detail),
    session: async (patch) => world.session.set(patch as never),
  });
  return { world, seeded };
}

/**
 * The two store APIs, reduced to the operations this fixture needs.
 *
 * Written out rather than `any` so a signature change on either side breaks this
 * file loudly: the whole point of the suite is that the two engines are
 * interchangeable, and a fixture that silently accepted a drifted API would
 * undermine the comparison it exists to make. Everything returns a promise so the
 * SQLite adapter can wrap its synchronous calls.
 */
interface SeedAdapter {
  upsert(e: Record<string, unknown>, layer: 'canon' | 'chronicle'): Promise<void>;
  edge(a: Record<string, unknown>, scene: number, layer?: 'canon' | 'chronicle'): Promise<void>;
  sheet(s: CharacterSheet, layer: 'canon' | 'chronicle'): Promise<void>;
  thread(t: Record<string, unknown>): Promise<unknown>;
  directive(d: Record<string, unknown>): Promise<unknown>;
  consequence(c: Record<string, unknown>): Promise<unknown>;
  fact(text: string, scene: number): Promise<{ id: string }>;
  knowledge(factId: string, entityId: string, level: 'knows' | 'suspects' | 'wrong', scene: number): Promise<void>;
  turn(t: Record<string, unknown>): Promise<unknown>;
  scene(n: number, patch: Record<string, unknown>): Promise<void>;
  anchor(text: string): Promise<void>;
  divergence(scene: number, kind: string, detail: string): Promise<void>;
  session(patch: Record<string, unknown>): Promise<unknown>;
}

/** The engine-agnostic seed, so both sides are populated by exactly one code path. */
async function seedCommon(w: SeedAdapter): Promise<Seeded> {
  const playerId = 'char:anselm';
  const locationId = 'loc:scriptorium';

  await w.upsert(
    {
      id: locationId,
      type: 'Location',
      name: 'The Scriptorium',
      summary: 'Long room, north light, twelve desks.',
      salience: 1,
      props: { region: 'the north cloister', terrain: 'stone', population: '19' },
    },
    'canon',
  );
  await w.upsert(
    { id: playerId, type: 'Character', name: 'Brother Anselm', summary: 'Thirty years in the Order.', salience: 1, props: { status: 'alive', born: '412 AV', species: 'human' } },
    'canon',
  );
  await w.upsert({ id: 'char:tem', type: 'Character', name: 'Tem', summary: 'A novice.', salience: 0.8 }, 'canon');
  await w.upsert({ id: 'char:sered', type: 'Character', name: 'Captain Sered', summary: 'The garrison.', salience: 0.4, props: { affiliation: 'the garrison' } }, 'canon');
  await w.upsert({ id: 'fac:order', type: 'Faction', name: 'The Order', salience: 0.3 }, 'canon');

  await w.edge({ subject: playerId, predicate: 'MEMBER_OF', object: 'fac:order', weight: 0.9 }, 1, 'canon');
  await w.edge({ subject: playerId, predicate: 'TEACHES', object: 'char:tem', weight: 0.7 }, 1, 'canon');
  await w.edge({ subject: locationId, predicate: 'PART_OF', object: 'fac:order', weight: 0.5 }, 1, 'canon');

  await w.sheet(
    {
      entityId: playerId,
      identity: { goals: ['finish the codex'], wounds: ['a dead brother'], fears: ['fire'], allegiances: ['The Order'], competencies: ['copying'], secrets: [], arc: 'A quiet man' },
      contract: { vows: [{ id: 'vow:silence', text: 'Keep the night silence', rank: 1, broken: false, brokenScene: null }], drives: ['duty'], breakingPoint: 'the boy in danger', costOfBreak: 'expulsion' },
      voice: { diction: 'plain, unhurried', tics: ['trails off'], samples: ['It will keep until morning.'], never: ['profanity'] },
      condition: { locationId, mood: 'tired', injuries: [], inventory: ['a knife'], intent: 'work', presentWith: ['char:tem'] },
      appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
      locks: ['condition.mood'],
      isPlayer: true,
    },
    'chronicle',
  );
  await w.sheet(
    {
      entityId: 'char:tem',
      identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
      contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
      voice: { diction: 'quick', tics: [], samples: [], never: [] },
      condition: { locationId, mood: 'eager', injuries: [], inventory: [], intent: 'learn', presentWith: [] },
      appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
      locks: [],
      isPlayer: false,
    },
    'chronicle',
  );

  await w.thread({ title: 'The missing page', stakes: 'the codex is incomplete', tension: 0.8, parties: [playerId], resolutions: ['find it', 'rewrite it'], status: 'open', createdScene: 1 });
  await w.thread({ title: 'The garrison arrives', stakes: 'soldiers in the cloister', tension: 0.4, parties: ['char:sered'], resolutions: ['negotiate'], status: 'open', createdScene: 1 });
  await w.directive({ text: 'Keep the pace slow', scope: 'scene', strength: 'hint', lifetimeScenes: null, status: 'active', createdScene: 1 });
  await w.consequence({ causeEventId: 'ev:1', trigger: { kind: 'immediate' }, actorId: 'char:sered', action: 'demand entry', visibility: 'offscreen-discoverable', maturity: 'ripening', depth: 1, significance: 0.6, createdScene: 1 });

  const known = await w.fact('The codex is missing a page', 1);
  await w.knowledge(known.id, playerId, 'knows', 1);
  await w.fact('Sered has orders to search the scriptorium', 1);

  await w.scene(1, { title: 'Night work', summary: 'Anselm works late.', locationId, chapter: 1 });
  await w.scene(2, { title: 'Morning', locationId, chapter: 1 });
  await w.turn({ scene: 2, turn: 1, rawInput: 'look around', intent: null, delta: null, bookProse: 'He set the quill down across the inkwell.', pinned: false, meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] } });
  await w.turn({ scene: 2, turn: 2, rawInput: 'listen', intent: null, delta: null, bookProse: 'Bootsteps in the passage, more than one pair.', pinned: false, meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] } });
  await w.anchor('The cold came up through the flagstones like water.');
  await w.divergence(2, 'canon-departure', 'Tem is present although canon has him at the mill');

  await w.session({ scene: 2, turn: 2, playerCharacterId: playerId, currentLocationId: locationId });
  return { playerId, locationId };
}

/**
 * Replaces generated ids with a stable placeholder, so a frame comparison tests
 * rendering rather than UUID equality.
 *
 * Deliberately narrow: only the `<prefix>:<uuid>` shape used by thread,
 * consequence, turn, fact and directive ids. Canon entity ids are deterministic
 * slugs (`char:anselm`) and are compared literally, because those *should* match
 * across engines and a bug that changed them must fail this test.
 */
function normaliseIds(text: string): string {
  return text.replace(/\b([a-z]+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '$1:<id>');
}

const TOKENIZER = tokenizerFor(4);
const BUDGET = 12_000;

test('every frame renders byte-identically to the SQLite builders', async (t) => {
  const ran = await withPg(async (db) => {
    const { world: pgWorld, seeded } = await seedPg(db);
    const { world: sqWorld, seeded: sqSeeded } = seedSqlite();
    await sqSeeded;

    try {
      const pgSession = await pgWorld.session.get();
      const sqSession = sqWorld.session.get();
      const data = await loadFrameData(pgWorld, pgSession);

      const pgCtx = { world: pgWorld, session: pgSession, tokenizer: TOKENIZER, budget: BUDGET, rawInput: 'I open the door.', agreedBeat: 'Sered enters.' };
      const sqCtx = { world: sqWorld, session: sqSession, tokenizer: TOKENIZER, budget: BUDGET, rawInput: 'I open the door.', agreedBeat: 'Sered enters.' };

      // The comparison that makes the whole port trustworthy: identical prompt
      // text, slot for slot, from two completely different storage layers.
      const cases: Array<[string, string, string]> = [
        ['referee', buildRefereeFrame(pgCtx, data).text, sqliteReferee(sqCtx).text],
        ['director', buildDirectorFrame(pgCtx, data).text, sqliteDirector(sqCtx).text],
        ['narrator', buildNarratorFrame(pgCtx, data).text, sqliteNarrator(sqCtx).text],
        ['integrity', buildIntegrityFrame(pgCtx, data, seeded.playerId).text, sqliteIntegrity(sqCtx, seeded.playerId).text],
        ['extract', buildExtractFrame(pgCtx, data, 'He opened the door.').text, sqliteExtract(sqCtx, 'He opened the door.').text],
      ];

      for (const [name, pg, sq] of cases) {
        assert.ok(pg.length > 200, `${name} frame should have real content, got ${pg.length} chars`);
        // UUIDs are minted per row, so the two databases cannot agree on them and
        // never could. Normalising them is the difference between comparing the
        // *rendering* — which is what a prompt is made of, and what must not drift
        // — and comparing two random-number generators. Everything else,
        // including slot order, ordering within slots, whitespace and eviction
        // decisions, is compared exactly.
        assert.equal(
          normaliseIds(pg),
          normaliseIds(sq),
          `${name} frame text diverged between SQLite and Postgres`,
        );
      }
    } finally {
      sqWorld.close();
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a frame is built with a bounded number of queries, not one per character', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await seedPg(db);
    const session = await world.session.get();

    // Count the queries `loadFrameData` issues by wrapping the connection. This is
    // the property that would rot first: one `await` reintroduced inside a
    // renderer costs a round trip per character on every turn, and no
    // output-based test would notice.
    let queries = 0;
    const counting: Queryable = {
      query: ((sql: string, params?: unknown[]) => {
        queries += 1;
        return db.query(sql, params);
      }) as Queryable['query'],
    };
    const countingWorld = new World({ db: counting, storyId: world.storyId, sources: world.sources });

    await loadFrameData(countingWorld, session);
    const withThreeOnStage = queries;

    // Add ten more characters to the location, so a per-entity implementation
    // would need at least ten more round trips.
    for (let i = 0; i < 10; i += 1) {
      await world.graph.upsert({ id: `char:extra${i}`, type: 'Character', name: `Extra ${i}` }, 'canon');
      await world.cast.put({
        entityId: `char:extra${i}`,
        identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
        contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
        voice: { diction: '', tics: [], samples: [], never: [] },
        condition: { locationId: 'loc:scriptorium', mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
        appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
        locks: [],
        isPlayer: false,
      });
    }

    queries = 0;
    const data = await loadFrameData(countingWorld, session);
    const withThirteenOnStage = queries;

    // 12: the player, the one NPC their `presentWith` names, and the ten extras
    // whose condition places them in this location. Captain Sered is canon-only
    // with no chronicle sheet in the room, so he is correctly not on stage — the
    // count is asserted rather than assumed because it is what makes the
    // query-count comparison below meaningful.
    assert.equal(data.presentIds.length, 12, `expected the extra cast on stage, got ${data.presentIds.length}`);
    assert.ok(
      withThirteenOnStage <= withThreeOnStage,
      `query count must not grow with cast size (${withThreeOnStage} -> ${withThirteenOnStage})`,
    );
    // A small, stated ceiling rather than an exact number, so adding a slot is
    // allowed but a fan-out is not.
    assert.ok(withThirteenOnStage <= 20, `expected a bounded query count, got ${withThirteenOnStage}`);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a crossover frame draws present cast and neighbours from both worlds', async (t) => {
  const ran = await withPg(async (db) => {
    const hp = await makeWorld(db, 'potter');
    const lotr = await makeWorld(db, 'middle-earth');
    const story = await createStory(db, { worldIds: [hp, lotr] });
    const world = await World.forStory(db, story.id);

    const hpGraph = new World({ db, storyId: story.id, sources: world.sources }).graph;
    await hpGraph.upsert({ id: 'char:harry', type: 'Character', name: 'Harry', salience: 1 }, 'canon');
    await hpGraph.upsert({ id: 'loc:hogwarts', type: 'Location', name: 'Hogwarts', salience: 1 }, 'canon');
    // Written to the second world explicitly, since a canon write needs a target.
    const lotrWorld = new World({ db, storyId: story.id, sources: world.sources });
    const lotrGraph = lotrWorld.graph;
    Object.assign(lotrGraph as unknown as { canonWorldId: number }, { canonWorldId: lotr });
    await lotrGraph.upsert({ id: 'char:frodo', type: 'Character', name: 'Frodo', salience: 1 }, 'canon');

    await world.cast.put({
      entityId: 'char:harry',
      identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
      contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
      voice: { diction: '', tics: [], samples: [], never: [] },
      condition: { locationId: 'loc:hogwarts', mood: '', injuries: [], inventory: [], intent: '', presentWith: ['char:frodo'] },
      appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
      locks: [],
      isPlayer: true,
    });
    await world.session.set({ scene: 1, turn: 1, playerCharacterId: 'char:harry', currentLocationId: 'loc:hogwarts' });
    // The bridge between worlds is chronicle, which is what a crossover frame has
    // to be able to show.
    await world.graph.assertEdge({ subject: 'char:harry', predicate: 'ALLIED_WITH', object: 'char:frodo' }, 1);

    const session = await world.session.get();
    const data = await loadFrameData(world, session);
    const frame = buildNarratorFrame({ world, session, tokenizer: TOKENIZER, budget: BUDGET }, data);

    assert.match(frame.text, /Harry/);
    assert.match(frame.text, /Frodo/, 'the second world\u2019s character must reach the frame');
    assert.match(frame.text, /Hogwarts/);
  });
  if (!ran) t.skip('no Postgres configured');
});
