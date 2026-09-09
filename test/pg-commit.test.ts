/**
 * The commit path on Postgres: delta commit, validation, and consequence
 * propagation.
 *
 * Three things here are worth more than the rest:
 *
 *   - **Atomicity is real.** `commitDelta` builds a second `World` over the
 *     transaction client, because a store built on the pool would run its writes
 *     on other connections — outside the transaction — and a rollback would leave
 *     half the delta applied. A test forces a mid-commit failure and asserts
 *     nothing survives.
 *   - **`transmitRumours` no longer re-queries inside its innermost loop**, which
 *     was O(knowers x neighbours) queries per fact. The test counts queries and
 *     also pins the correctness bug that pattern hid: two knowers reaching the
 *     same recipient in one tick could both transmit.
 *   - **Validation still repairs and drops exactly as before.** The batching
 *     rewrote the control flow, so the issue messages and repair semantics are
 *     asserted rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { commitDelta } from '../src/loop/commit-pg.ts';
import { validateDelta } from '../src/loop/validate-pg.ts';
import {
  applyDirectiveRecalc,
  seedConsequences,
  tickConsequences,
  transmitRumours,
  worldTick,
} from '../src/consequence/propagate-pg.ts';
import { emptyDelta } from '../src/domain/types.ts';
import type { Db, Queryable } from '../src/db/pg.ts';
import type { CharacterSheet, Delta } from '../src/domain/types.ts';

async function setup(db: Db): Promise<{ world: World; worldId: number }> {
  const worldId = await makeWorld(db, 'w');
  const story = await createStory(db, { worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  await world.session.set({ scene: 1, turn: 1, playerCharacterId: 'char:pc', currentLocationId: 'loc:hall' });
  return { world, worldId };
}

function sheet(entityId: string, over: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    entityId,
    identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
    contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: '', tics: [], samples: [], never: [] },
    condition: { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: false,
    ...over,
  };
}

// ----------------------------------------------------------------- commit

test('a delta commits atomically: entities, events, edges, facts, threads', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'PC' }, 'canon');
    await world.graph.upsert({ id: 'char:npc', type: 'Character', name: 'NPC' }, 'canon');

    const delta: Delta = {
      ...emptyDelta(),
      entityUpserts: [{ id: 'item:lantern', type: 'Item', name: 'A lantern', summary: 'Tin, dented.' }],
      events: [{ text: 'The lantern is lit.', participants: ['char:pc'], locationId: 'loc:hall', significance: 0.7 }],
      edgeAsserts: [{ subject: 'char:pc', predicate: 'CARRIES', object: 'item:lantern', weight: 0.8 }],
      factsLearned: [{ text: 'The hall is watched', knownBy: ['char:pc'], suspectedBy: ['char:npc'] }],
      threadUpdates: [{ title: 'Who is watching', tensionDelta: 0.3 }],
    };

    const result = await commitDelta(db, world, delta);

    assert.equal(result.events.length, 1);
    assert.equal(result.factIds.length, 1);
    assert.equal(result.newThreadIds.length, 1);
    assert.ok(result.touchedIds.includes('char:pc'));
    assert.ok(result.touchedIds.includes('item:lantern'));

    assert.equal((await world.graph.get('item:lantern'))?.name, 'A lantern');
    assert.equal((await world.graph.edgesFrom('char:pc')).length, 1);
    assert.equal((await world.chronicle.events()).length, 1);
    assert.equal(await world.chronicle.knows('char:pc', result.factIds[0]!), true);
    assert.equal(await world.chronicle.knows('char:npc', result.factIds[0]!), false, 'suspecting is not knowing');
    assert.equal((await world.threads.all()).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a failure mid-commit rolls back everything, not just the failing write', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'PC' }, 'canon');

    // A thread update naming a thread that exists, plus an event, plus a
    // deliberately impossible fact knowledge write (an entity id far longer than
    // any column allows would not fail, so the failure is forced by a bad
    // knowledge level, which the CHECK constraint rejects).
    const delta: Delta = {
      ...emptyDelta(),
      events: [{ text: 'Something happens.', participants: ['char:pc'], locationId: null, significance: 0.5 }],
      entityUpserts: [{ id: 'item:x', type: 'Item', name: 'X', summary: '' }],
      factsLearned: [{ text: 'a fact', knownBy: ['char:pc'], suspectedBy: [] }],
    };
    // Corrupt the delta so the knowledge insert violates the CHECK on `level`.
    (delta.factsLearned[0] as unknown as { knownBy: string[] }).knownBy = ['char:pc'];
    const bad = { ...delta, threadUpdates: [{ id: 'thread:nope', title: undefined }] } as Delta;
    void bad;

    // Force a failure by making the *second* event's participants column reject:
    // simplest reliable trigger is a null text, which the NOT NULL column refuses.
    const failing: Delta = {
      ...delta,
      events: [
        { text: 'Something happens.', participants: ['char:pc'], locationId: null, significance: 0.5 },
        { text: null as unknown as string, participants: [], locationId: null, significance: 0.5 },
      ],
    };

    await assert.rejects(() => commitDelta(db, world, failing));

    // The first event and the entity upsert both preceded the failure, and both
    // must be gone. This is the property the transaction exists for, and the one
    // that silently breaks if a store runs on the pool instead of the client.
    assert.equal((await world.chronicle.events()).length, 0, 'the successful event must roll back too');
    assert.equal(await world.graph.get('item:x'), undefined, 'the entity upsert must roll back');
    assert.equal((await world.chronicle.facts()).length, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a broken vow spawns a thread and a divergence in the same transaction', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'Brother Anselm' }, 'canon');
    await world.cast.put(
      sheet('char:pc', {
        contract: {
          vows: [{ id: 'vow:silence', text: 'Keep silence', rank: 1, broken: false, brokenScene: null }],
          drives: [],
          breakingPoint: '',
          costOfBreak: '',
        },
      }),
      'canon',
    );

    const result = await commitDelta(db, world, {
      ...emptyDelta(),
      vowBreaks: [{ entityId: 'char:pc', vowId: 'vow:silence' }],
    });

    assert.equal(result.brokenVows.length, 1);
    assert.equal(result.newThreadIds.length, 1, 'the fallout is the story, so it becomes a thread');
    const threads = await world.threads.all();
    assert.match(threads[0]!.title, /Brother Anselm broke a vow/);
    assert.equal((await world.chronicle.divergences()).length, 1);
    // Canon still says the vow holds: the break is this story's.
    assert.equal((await world.cast.getCanon('char:pc'))!.contract.vows[0]!.broken, false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('sceneAdvance moves the session and opens the next scene', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await commitDelta(db, world, { ...emptyDelta(), sceneAdvance: true });
    assert.equal((await world.session.get()).scene, 2);
    assert.equal((await world.session.get()).turn, 0);
    assert.ok((await world.chronicle.scenes()).some((s) => s.scene === 2));
  });
  if (!ran) t.skip('no Postgres configured');
});

// -------------------------------------------------------------- validation

test('validation resolves names, drops unknowns, and reports each repair', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:anselm', type: 'Character', name: 'Brother Anselm' }, 'canon');

    const delta: Delta = {
      ...emptyDelta(),
      events: [
        {
          text: 'x',
          // One resolvable by name, one unresolvable.
          participants: ['Brother Anselm', 'char:nobody'],
          locationId: null,
          significance: 0.5,
        },
      ],
      edgeAsserts: [{ subject: 'char:anselm', predicate: 'KNOWS', object: 'char:ghost', weight: 0.5 }],
    };

    const res = await validateDelta(world, delta);
    assert.deepEqual(res.delta.events[0]!.participants, ['char:anselm'], 'named reference repaired, unknown dropped');
    assert.equal(res.delta.edgeAsserts.length, 0, 'an edge with a dangling endpoint is dropped entirely');
    const messages = res.issues.map((i) => i.message);
    assert.ok(messages.some((m) => /resolved "Brother Anselm" to char:anselm/.test(m)));
    assert.ok(messages.some((m) => /unknown entity "char:nobody"/.test(m)));
    // All repairs, so the delta is still committable.
    assert.equal(res.ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('validation refuses to retire an edge that was never live', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    await world.graph.upsert({ id: 'char:b', type: 'Character', name: 'B' }, 'canon');
    await world.graph.assertEdge({ subject: 'char:a', predicate: 'ALLIED_WITH', object: 'char:b' }, 1, 'canon');

    const res = await validateDelta(world, {
      ...emptyDelta(),
      edgeRetires: [
        { subject: 'char:a', predicate: 'ALLIED_WITH', object: 'char:b' },
        // Never asserted: the model believes a relation the graph never had.
        { subject: 'char:a', predicate: 'BETRAYED', object: 'char:b' },
      ],
    });

    assert.equal(res.delta.edgeRetires.length, 1);
    assert.equal(res.delta.edgeRetires[0]!.predicate, 'ALLIED_WITH');
    assert.ok(
      res.issues.some((i) => i.message.includes('no live edge char:a -[BETRAYED]-> char:b')),
      `expected a no-live-edge issue, got ${JSON.stringify(res.issues.map((i) => i.message))}`,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('validation blocks a delta that acts on the dead, and drops phantom vows', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert(
      { id: 'char:dead', type: 'Character', name: 'Dead', props: { status: 'dead' } },
      'canon',
    );
    await world.graph.upsert({ id: 'char:live', type: 'Character', name: 'Live' }, 'canon');
    await world.cast.put(sheet('char:live'), 'canon');

    const res = await validateDelta(world, {
      ...emptyDelta(),
      events: [{ text: 'x', participants: ['char:dead'], locationId: null, significance: 0.5 }],
      vowBreaks: [
        { entityId: 'char:live', vowId: 'vow:nonexistent' },
        { entityId: 'char:nosheet', vowId: 'vow:x' },
      ],
    });

    // Semantic and unrepaired: this one must never auto-commit.
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.tier === 'semantic' && !i.repaired && /recorded dead/.test(i.message)));
    assert.equal(res.delta.vowBreaks.length, 0);
    assert.ok(res.issues.some((i) => /holds no vow/.test(i.message)));
    assert.ok(res.issues.some((i) => /no sheet for char:nosheet/.test(i.message)));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an entity the delta creates is a legitimate reference within it', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'PC' }, 'canon');
    const res = await validateDelta(world, {
      ...emptyDelta(),
      entityUpserts: [{ id: 'item:new', type: 'Item', name: 'New thing', summary: '' }],
      edgeAsserts: [{ subject: 'char:pc', predicate: 'CARRIES', object: 'item:new', weight: 0.5 }],
    });
    // Would be dropped as dangling if upserts were not applied before resolution.
    assert.equal(res.delta.edgeAsserts.length, 1);
    assert.equal(res.ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------- propagation

test('consequences seed from relationships, typed edges and factions', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    for (const id of ['char:pc', 'char:kin', 'char:enemy', 'char:comrade', 'fac:order']) {
      await world.graph.upsert({ id, type: id.startsWith('fac') ? 'Faction' : 'Character', name: id }, 'canon');
    }
    // A hostile relationship, a kinship edge, and a shared faction: the three
    // routes findReactors walks.
    await world.cast.adjustRelationship('char:enemy', 'char:pc', { trust: -0.8, affection: -0.6 });
    await world.graph.assertEdge({ subject: 'char:kin', predicate: 'SIBLING_OF', object: 'char:pc', weight: 0.9 }, 1, 'canon');
    await world.graph.assertEdge({ subject: 'char:pc', predicate: 'MEMBER_OF', object: 'fac:order', weight: 0.9 }, 1, 'canon');
    await world.graph.assertEdge({ subject: 'char:comrade', predicate: 'MEMBER_OF', object: 'fac:order', weight: 0.9 }, 1, 'canon');

    const events = [
      { id: 'ev:1', scene: 1, turn: 1, text: 'The player is struck.', participants: ['char:pc'], locationId: null, significance: 0.9, visibility: 'onscreen' as const, fromConsequenceId: null },
    ];
    const seeded = await seedConsequences(world, emptyDelta(), events);

    assert.ok(seeded.length >= 2, `expected several reactors, got ${seeded.length}`);
    const actors = seeded.map((c) => c.actorId);
    assert.ok(!actors.includes('char:pc'), 'the player is never a reactor \u2014 that would take their agency');
    assert.ok(actors.includes('char:enemy') || actors.includes('char:kin'));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the tick ripens, then fires, then chains, then expires', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:actor', type: 'Character', name: 'The Actor' }, 'canon');
    const c = await world.consequences.enqueue({
      causeEventId: 'ev:1', trigger: { kind: 'immediate' }, actorId: 'char:actor', action: 'moves against them',
      visibility: 'offscreen-hidden', maturity: 'pending', depth: 1, significance: 0.8, createdScene: 1,
    });

    const first = await tickConsequences(world);
    assert.deepEqual(first.ripened, [c.id], 'pending becomes ripening, not fired, on the first tick');

    const second = await tickConsequences(world);
    assert.equal(second.fired.length, 1);
    assert.match(second.fired[0]!.event.text, /The Actor moves against them\./);
    assert.equal((await world.consequences.get(c.id))?.maturity, 'fired');
    // Offscreen and hidden, so it counts against the ignorance budget.
    assert.equal(await world.consequences.hiddenFiredCount(), 1);

    // Old and unimportant: expires rather than firing forever.
    const stale = await world.consequences.enqueue({
      causeEventId: 'ev:2', trigger: { kind: 'after-scenes', scenes: 1 }, actorId: 'char:actor', action: 'shrugs',
      visibility: 'offscreen-hidden', maturity: 'pending', depth: 1, significance: 0.2, createdScene: 1,
    });
    await world.session.set({ scene: 20 });
    const third = await tickConsequences(world);
    assert.ok(third.expired.includes(stale.id));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an on-learn trigger waits until the actor actually knows', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:actor', type: 'Character', name: 'Actor' }, 'canon');
    const fact = await world.chronicle.addFact('The abbot is dead', 1);
    const c = await world.consequences.enqueue({
      causeEventId: 'ev:1', trigger: { kind: 'on-learn', entityId: 'char:actor', factId: fact.id },
      actorId: 'char:actor', action: 'demands recompense', visibility: 'offscreen-discoverable',
      maturity: 'ripening', depth: 1, significance: 0.7, createdScene: 1,
    });

    // Gating on knowledge is what makes offscreen chains feel real rather than
    // magical: nobody reacts to what they have not learned.
    assert.equal((await tickConsequences(world)).fired.length, 0);
    await world.chronicle.setKnowledge(fact.id, 'char:actor', 'knows', 1);
    assert.equal((await tickConsequences(world)).fired.length, 1);
    assert.equal((await world.consequences.get(c.id))?.maturity, 'fired');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('rumours transmit once per recipient per tick, with a bounded query count', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    // Two knowers who share a neighbour. The SQLite version re-queried the knower
    // set per neighbour, so both knowers could transmit to the shared recipient
    // within one tick before the re-query caught up.
    for (const id of ['char:k1', 'char:k2', 'char:shared']) {
      await world.graph.upsert({ id, type: 'Character', name: id }, 'canon');
    }
    await world.graph.assertEdge({ subject: 'char:k1', predicate: 'ALLIED_WITH', object: 'char:shared', weight: 1 }, 1, 'canon');
    await world.graph.assertEdge({ subject: 'char:k2', predicate: 'ALLIED_WITH', object: 'char:shared', weight: 1 }, 1, 'canon');
    const fact = await world.chronicle.addFact('a secret', 1);
    await world.chronicle.setKnowledge(fact.id, 'char:k1', 'knows', 1);
    await world.chronicle.setKnowledge(fact.id, 'char:k2', 'knows', 1);

    let queries = 0;
    const counting: Queryable = {
      query: ((sql: string, params?: unknown[]) => {
        queries += 1;
        return db.query(sql, params);
      }) as Queryable['query'],
    };
    const countingWorld = new World({ db: counting, storyId: world.storyId, sources: world.sources });

    const moved = await transmitRumours(countingWorld, 4);
    const toShared = moved.filter((m) => m.toId === 'char:shared');
    assert.equal(toShared.length, 1, 'a recipient learns a fact once per tick, not once per knower');
    // The old shape was O(knowers x neighbours) queries per fact; this pins that it
    // is now a small constant.
    assert.ok(queries <= 15, `expected a bounded query count, got ${queries}`);
    // Distortion rises with transmission: the recipient believes a vaguer version.
    assert.ok(toShared[0]!.distortion > 0);
    assert.equal(await world.chronicle.knows('char:shared', fact.id), false, 'second-hand news is suspicion, not knowledge');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('worldTick drifts thread tension, and respects npcAgency', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    const hot = await world.threads.create({ title: 'Hot', stakes: '', tension: 0.8, parties: [], resolutions: [], status: 'open', createdScene: 1 });
    const cold = await world.threads.create({ title: 'Cold', stakes: '', tension: 0.2, parties: [], resolutions: [], status: 'open', createdScene: 1 });

    const notes = await worldTick(world);
    assert.equal(notes.length, 2);
    assert.ok((await world.threads.get(hot.id))!.tension > 0.8, 'high tension drifts up on its own');
    assert.ok((await world.threads.get(cold.id))!.tension < 0.2, 'low tension cools');

    // Agency off means the world does not move without the player.
    const session = await world.session.get();
    await world.session.set({ knobs: { ...session.knobs, npcAgency: 0.1 } });
    assert.deepEqual(await worldTick(world), []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a directive steers the future without touching committed chronicle', async (t) => {
  const ran = await withPg(async (db) => {
    const { world } = await setup(db);
    await world.graph.upsert({ id: 'char:sered', type: 'Character', name: 'Captain Sered' }, 'canon');
    const aligned = await world.threads.create({ title: 'The garrison searches the scriptorium', stakes: 'soldiers', tension: 0.5, parties: [], resolutions: ['negotiate'], status: 'open', createdScene: 1 });
    const unrelated = await world.threads.create({ title: 'The missing page', stakes: 'codex', tension: 0.8, parties: [], resolutions: [], status: 'open', createdScene: 1 });
    const alignedCons = await world.consequences.enqueue({ causeEventId: 'ev:1', trigger: { kind: 'after-scenes', scenes: 6 }, actorId: 'char:sered', action: 'searches the scriptorium', visibility: 'offscreen-discoverable', maturity: 'pending', depth: 1, significance: 0.7, createdScene: 1 });
    const trivial = await world.consequences.enqueue({ causeEventId: 'ev:2', trigger: { kind: 'after-scenes', scenes: 9 }, actorId: 'char:sered', action: 'polishes a boot', visibility: 'offscreen-hidden', maturity: 'pending', depth: 1, significance: 0.1, createdScene: 1 });
    const event = await world.chronicle.addEvent({ scene: 1, turn: 1, text: 'Committed history.', participants: [], locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null });

    const res = await applyDirectiveRecalc(world, 'dir:1', 'the garrison searches the scriptorium tonight');

    assert.ok(res.raisedThreads.includes(aligned.id));
    assert.ok(res.loweredThreads.includes(unrelated.id));
    assert.ok(res.retimedConsequences.includes(alignedCons.id));
    assert.ok(res.supersededConsequences.includes(trivial.id));
    assert.deepEqual((await world.consequences.get(alignedCons.id))?.trigger, { kind: 'after-scenes', scenes: 1 });
    // A directive steers the future only (DESIGN §7.3): committed history stands.
    assert.equal((await world.chronicle.events()).length, 1);
    assert.equal((await world.chronicle.events())[0]!.id, event.id);
  });
  if (!ran) t.skip('no Postgres configured');
});
