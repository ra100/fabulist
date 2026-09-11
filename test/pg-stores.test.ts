/**
 * The story-scoped stores on Postgres: cast, chronicle, threads, consequences,
 * directives, story state, illustrations, and the world registry.
 *
 * Mirrors the SQLite suites (`test/store.test.ts`, `test/consequence.test.ts`,
 * `test/worlds.test.ts`) so the parity claim stays checkable, and adds the cases
 * the split makes possible or newly relevant: per-world meta, cascade deletion
 * replacing a hand-maintained table list, and a world that refuses to be deleted
 * while a story still reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, withPg } from './pg-harness.ts';
import { sourcesFor } from '../src/db/overlay.ts';
import { withEncryptionRollout } from '../src/auth/encryption-rollout-pg.ts';
import { encryptStoryValue } from '../src/crypto/story-envelope.ts';
import { CastStore, emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../src/store/cast-pg.ts';
import { ChronicleStore } from '../src/store/chronicle-pg.ts';
import { GraphStore } from '../src/store/graph-pg.ts';
import { IllustrationStore } from '../src/store/illustration-pg.ts';
import { ConsequenceStore, DirectiveStore, StoryStore, ThreadStore, createStory, deleteStory, getStory, listStoriesForUser, resolveOrCreateStoryForUser } from '../src/store/world-pg.ts';
import {
  World,
  createWorld,
  deleteWorld,
  getWorldBySlug,
  listWorlds,
  renameWorld,
  setStorySources,
  slugify,
  uniqueSlug,
  worldFor,
} from '../src/store/index-pg.ts';
import type { Db } from '../src/db/pg.ts';
import { defaultKnobs, defaultStyleContract, emptyDelta, type CharacterSheet } from '../src/domain/types.ts';
import type { SessionUser } from '../src/auth/config.ts';

function testUser(id: string, email = `${id}@example.com`): SessionUser {
  return { id, email, firstName: null, lastName: null, isAdmin: false };
}

function blankSheet(entityId: string): CharacterSheet {
  return {
    entityId,
    identity: emptyIdentity(),
    contract: emptyContract(),
    voice: emptyVoice(),
    condition: emptyCondition(),
    appearance: emptyAppearance(),
    locks: [],
    isPlayer: false,
  };
}

async function encryptStoryValueForTest(
  db: Db,
  key: Buffer,
  storyId: string,
  table: string,
  recordId: string,
  field: string,
  value: unknown,
): Promise<void> {
  const envelope = encryptStoryValue(key, { storyId, table, recordId, field }, value);
  await db.query(
    `INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [storyId, table, recordId, field, envelope.version, envelope.nonce, envelope.ciphertext],
  );
}

/** A world plus a story reading it, the shape every test below starts from. */
async function setup(db: Db, slug = 'w'): Promise<{ worldId: number; storyId: string }> {
  const worldId = await makeWorld(db, slug);
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  return { worldId, storyId: story.id };
}

// ------------------------------------------------------------------- cast

test('a canon sheet is the baseline; play copies it forward per story', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'shared');
    const a = await createStory(db, { worldIds: [worldId] });
    const b = await createStory(db, { worldIds: [worldId] });
    const castA = new CastStore({ db, storyId: a.id, sources: await sourcesFor(db, a.id) });
    const castB = new CastStore({ db, storyId: b.id, sources: await sourcesFor(db, b.id) });

    const canon = blankSheet('char:anselm');
    canon.identity.arc = 'A living monk.';
    await castA.put(canon, 'canon');

    assert.equal((await castA.get('char:anselm'))?.identity.arc, 'A living monk.');
    assert.equal((await castB.get('char:anselm'))?.identity.arc, 'A living monk.', 'B reads the same baseline');

    // A's play mutates its own copy.
    const sheet = (await castA.get('char:anselm'))!;
    sheet.condition.mood = 'grieving';
    await castA.put(sheet);

    assert.equal((await castA.get('char:anselm'))?.condition.mood, 'grieving');
    assert.equal((await castB.get('char:anselm'))?.condition.mood, '', 'B is untouched');
    assert.equal((await castA.getCanon('char:anselm'))?.condition.mood, '', 'canon is untouched');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('locked condition fields survive an update; unlocked ones do not', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const cast = new CastStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    await cast.put(blankSheet('char:a'));
    await cast.updateCondition('char:a', { mood: 'calm', intent: 'read' });
    await cast.lock('char:a', 'condition.mood');
    // The lock is player ground truth and must survive an AI update (DESIGN §2).
    await cast.updateCondition('char:a', { mood: 'furious', intent: 'flee' });

    const s = (await cast.get('char:a'))!;
    assert.equal(s.condition.mood, 'calm', 'locked field held');
    assert.equal(s.condition.intent, 'flee', 'unlocked field changed');

    await cast.unlock('char:a', 'condition.mood');
    await cast.updateCondition('char:a', { mood: 'furious' });
    assert.equal((await cast.get('char:a'))!.condition.mood, 'furious');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('breaking a vow records it in chronicle, never in canon', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    const a = await createStory(db, { worldIds: [worldId] });
    const b = await createStory(db, { worldIds: [worldId] });
    const castA = new CastStore({ db, storyId: a.id, sources: await sourcesFor(db, a.id) });
    const castB = new CastStore({ db, storyId: b.id, sources: await sourcesFor(db, b.id) });

    const canon = blankSheet('char:a');
    canon.contract.vows = [{ id: 'vow:silence', text: 'Keep silence', rank: 1, broken: false, brokenScene: null }];
    await castA.put(canon, 'canon');

    const broken = await castA.breakVow('char:a', 'vow:silence', 7);
    assert.equal(broken?.broken, true);
    assert.equal(broken?.brokenScene, 7);
    assert.equal((await castA.get('char:a'))!.contract.vows[0]!.broken, true);
    assert.equal((await castB.get('char:a'))!.contract.vows[0]!.broken, false, 'B\u2019s vow still holds');
    assert.equal((await castA.getCanon('char:a'))!.contract.vows[0]!.broken, false, 'canon untouched');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the player is found without scanning every canon sheet', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const cast = new CastStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    // A canon sheet can never be the player: who the protagonist is belongs to a
    // playthrough, not the source material.
    await cast.put(blankSheet('char:npc'), 'canon');
    assert.equal(await cast.player(), undefined);

    const pc = blankSheet('char:me');
    pc.isPlayer = true;
    await cast.put(pc);
    assert.equal((await cast.player())?.entityId, 'char:me');
    // And the canon sheet still reports isPlayer false through the overlay.
    assert.equal((await cast.get('char:npc'))?.isPlayer, false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('relationships are directional, asymmetric and clamped', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const cast = new CastStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    await cast.adjustRelationship('char:a', 'char:b', { trust: 0.5 });
    await cast.adjustRelationship('char:b', 'char:a', { trust: -0.9 });

    assert.equal((await cast.relationship('char:a', 'char:b')).trust, 0.5);
    assert.equal((await cast.relationship('char:b', 'char:a')).trust, -0.9, 'A trusts B while B distrusts A');
    // Clamped to [-1, 1] however many times it is nudged.
    for (let i = 0; i < 10; i += 1) await cast.adjustRelationship('char:a', 'char:b', { trust: 0.5 });
    assert.equal((await cast.relationship('char:a', 'char:b')).trust, 1);

    assert.equal((await cast.relationshipsOf('char:a')).length, 1);
    assert.equal((await cast.relationshipsToward('char:a')).length, 1, 'the propagation frontier');
    // An unknown pair reads as neutral rather than undefined, so callers never branch.
    assert.equal((await cast.relationship('char:x', 'char:y')).trust, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('encrypted chronicle sheets and relationship notes round-trip without base-table prose', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const sources = await sourcesFor(db, storyId);
    const plain = new CastStore({ db, storyId, sources });
    const sheet = blankSheet('char:player');
    sheet.identity = {
      goals: ['Find the buried crown'], wounds: ['Lost a brother'], fears: ['The crypt'], allegiances: ['The city'],
      competencies: ['Lockpicking'], secrets: ['Knows the traitor'], arc: 'Learns to trust again.',
    };
    sheet.contract = {
      vows: [{ id: 'vow:mercy', text: 'Never kill a prisoner.', rank: 1, broken: false, brokenScene: null }],
      drives: ['Protect the innocent'], breakingPoint: 'The traitor threatens the city.', costOfBreak: 'Exile.',
    };
    sheet.voice = { diction: 'Careful and dry.', tics: ['counts doors'], samples: ['Nothing is free.'], never: ['begs'] };
    sheet.condition = {
      locationId: 'loc:crypt', mood: 'afraid', injuries: ['cut hand'], inventory: ['rusted key'],
      intent: 'Find the crown', presentWith: ['char:guide'],
    };
    sheet.appearance = {
      description: 'A scarred scholar.', attire: 'Dusty coat.', markers: ['silver ring'],
      referenceImagePath: null, seed: 42,
    };
    sheet.locks = ['condition.mood'];
    sheet.isPlayer = true;
    await plain.put(sheet);
    await plain.adjustRelationship('char:player', 'char:guide', {
      trust: 0.5, affection: 0.2, respect: 0.4, note: 'The guide hid the map.',
    });

    const canon = blankSheet('char:canon');
    canon.identity.arc = 'Unchanged source material.';
    await plain.put(canon, 'canon');

    const key = randomBytes(32);
    await Promise.all([
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'identity', sheet.identity),
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'contract', sheet.contract),
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'voice', sheet.voice),
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'condition', sheet.condition),
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'appearance', sheet.appearance),
      encryptStoryValueForTest(db, key, storyId, 'chron_sheets', sheet.entityId, 'locks', sheet.locks),
      encryptStoryValueForTest(
        db,
        key,
        storyId,
        'relationships',
        JSON.stringify(['char:player', 'char:guide']),
        'note',
        'The guide hid the map.',
      ),
    ]);
    await db.query(`UPDATE stories SET encryption_version = 1 WHERE id = $1`, [storyId]);
    await db.query(
      `UPDATE chron_sheets SET identity = '{}'::jsonb, contract = '{}'::jsonb, voice = '{}'::jsonb,
         condition = '{}'::jsonb, appearance = '{}'::jsonb, locks = '[]'::jsonb
       WHERE story_id = $1 AND entity_id = $2`,
      [storyId, sheet.entityId],
    );
    await db.query(`UPDATE relationships SET note = '' WHERE story_id = $1`, [storyId]);

    const crypto = { keyForStory: (id: string) => (id === storyId ? key : null) };
    const cast = (await World.forStory(db, storyId, undefined, crypto)).cast;
    assert.deepEqual(await cast.get(sheet.entityId), sheet);
    assert.deepEqual(await cast.getManyOrBlank([sheet.entityId]).then((sheets) => sheets.get(sheet.entityId)), sheet);
    assert.deepEqual(await cast.player(), sheet);
    assert.equal((await cast.getCanon(canon.entityId))?.identity.arc, 'Unchanged source material.');
    assert.equal((await cast.relationship('char:player', 'char:guide')).note, 'The guide hid the map.');

    await cast.unlock(sheet.entityId, 'condition.mood');
    await cast.updateCondition(sheet.entityId, { mood: 'resolved', inventory: ['crown'] });
    await cast.breakVow(sheet.entityId, 'vow:mercy', 3);
    const relationship = await cast.adjustRelationship('char:player', 'char:guide', { note: 'The guide returned the map.' });
    assert.equal((await cast.get(sheet.entityId))?.condition.mood, 'resolved');
    assert.equal((await cast.get(sheet.entityId))?.contract.vows[0]?.brokenScene, 3);
    assert.equal(relationship.note, 'The guide returned the map.');

    const base = await db.one<{ identity: unknown; contract: unknown; voice: unknown; condition: unknown; appearance: unknown; locks: unknown; note: string }>(
      `SELECT s.identity, s.contract, s.voice, s.condition, s.appearance, s.locks, r.note
         FROM chron_sheets s JOIN relationships r ON r.story_id = s.story_id
        WHERE s.story_id = $1 AND s.entity_id = $2`,
      [storyId, sheet.entityId],
    );
    assert.deepEqual(base, {
      identity: {}, contract: {}, voice: {}, condition: {}, appearance: {}, locks: [], note: '',
    });

    const locked = (await World.forStory(db, storyId)).cast;
    await assert.rejects(() => locked.get(sheet.entityId), /locked/);
    await assert.rejects(() => locked.relationshipsOf('char:player'), /locked/);
    await assert.rejects(() => locked.updateCondition(sheet.entityId, { mood: 'fleeing' }), /locked/);
    assert.equal((await locked.getCanon(canon.entityId))?.identity.arc, 'Unchanged source material.');

    await deleteStory(db, storyId);
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM encrypted_story_values WHERE story_id = $1`, [storyId]))!.n),
      0,
      'deleting a story cascades its encrypted cast values',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('encrypted private graph entities use opaque ids and decrypt names only in memory', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const canon = new GraphStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    await canon.upsert({ id: 'char:canon', type: 'Character', name: 'Canon Keeper' }, 'canon');
    await canon.upsert({ id: 'char:canon-peer', type: 'Character', name: 'Canon Peer' }, 'canon');
    await canon.assertEdge(
      { subject: 'char:canon', predicate: 'KNOWS', object: 'char:canon-peer', evidence: 'Canon evidence.' },
      1,
      'canon',
    );
    await canon.assertEdge(
      { subject: 'char:canon', predicate: 'TRUSTS', object: 'char:canon-peer', evidence: 'Another canon edge.' },
      1,
      'canon',
    );
    await db.query(`UPDATE stories SET encryption_version = 1 WHERE id = $1`, [storyId]);

    const key = randomBytes(32);
    const graph = (await World.forStory(db, storyId, undefined, {
      keyForStory: (id: string) => (id === storyId ? key : null),
    })).graph;
    await graph.upsert({
      id: 'char:secret', type: 'Character', name: 'Mara Vell', summary: 'The hidden archivist.',
      props: { secret: 'The crown is below the well.' }, provenance: 'authored', createdScene: 2,
    });
    await graph.upsert({ id: 'char:other', type: 'Character', name: 'Ivo Renn', summary: 'Mara’s ally.' });
    await graph.upsert({ id: 'char:canon', type: 'Character', name: 'The Keeper', summary: 'A private revision.' });
    const mara = (await graph.get('char:secret'))!;
    assert.match(mara.id, /^ent:/, 'private entity id is opaque rather than the caller’s semantic id');
    assert.equal(mara.name, 'Mara Vell');
    assert.deepEqual(mara.props, { secret: 'The crown is below the well.' });
    assert.equal((await graph.resolveName('Mara Vell'))?.id, mara.id);
    assert.deepEqual((await graph.search('archivist')).map((entity) => entity.name), ['Mara Vell']);
    assert.equal((await graph.get('char:canon'))?.name, 'The Keeper');
    assert.equal((await graph.list()).some((entity) => entity.name === 'Canon Keeper'), false);
    assert.equal((await graph.edgesFrom('char:canon'))[0]?.evidence, 'Canon evidence.');

    await graph.upsert({ ...mara, summary: 'The archivist protects the crown.' });
    await graph.assertEdge(
      { subject: 'char:secret', predicate: 'TRUSTS', object: 'char:other', evidence: 'Mara gave Ivo the key.' },
      2,
    );
    await graph.assertEdge(
      { subject: 'char:canon', predicate: 'KNOWS', object: 'char:canon-peer', evidence: 'Private evidence.' },
      2,
    );
    assert.equal((await graph.get('char:secret'))?.summary, 'The archivist protects the crown.');
    assert.equal((await graph.edgesFrom('char:secret'))[0]?.evidence, 'Mara gave Ivo the key.');
    assert.equal((await graph.edgesFrom('char:canon'))[0]?.evidence, 'Private evidence.');
    assert.equal(await graph.retireEdge('char:canon', 'TRUSTS', 'char:canon-peer', 2), true);
    assert.equal((await graph.edgesFrom('char:canon')).some((edge) => edge.predicate === 'TRUSTS'), false);
    assert.equal((await graph.getCanon('char:canon'))?.name, 'Canon Keeper');

    const base = await db.one<{ id: string; name: string; summary: string; props: unknown; evidence: string | null }>(
      `SELECT e.id, e.name, e.summary, e.props, x.evidence
         FROM chron_entities e JOIN chron_edges x ON x.story_id = e.story_id AND x.subject = e.id
        WHERE e.story_id = $1 AND e.id = $2`,
      [storyId, mara.id],
    );
    assert.match(base!.id, /^ent:/);
    assert.deepEqual(base, { id: mara.id, name: '', summary: '', props: {}, evidence: null });
    const privateEntities = await db.query<{ id: string; name: string; summary: string; props: unknown }>(
      `SELECT id, name, summary, props FROM chron_entities WHERE story_id = $1`,
      [storyId],
    );
    assert.ok(privateEntities.rows.length >= 3);
    assert.ok(privateEntities.rows.every((entity) => entity.id.startsWith('ent:')));
    assert.ok(privateEntities.rows.every((entity) => entity.name === '' && entity.summary === ''));
    assert.ok(privateEntities.rows.every((entity) => JSON.stringify(entity.props) === '{}'));
    const encrypted = await db.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM encrypted_story_values WHERE story_id = $1 AND table_name IN ('chron_entities', 'chron_edges')`,
      [storyId],
    );
    assert.ok(encrypted.rows.every((row) => !row.ciphertext.toString('utf8').includes('Mara')));

    const locked = (await World.forStory(db, storyId)).graph;
    await assert.rejects(() => locked.get('char:secret'), /locked/);
    await assert.rejects(() => locked.search('Mara'), /locked/);
    await assert.rejects(() => locked.assertEdge({ subject: 'char:secret', predicate: 'KNOWS', object: 'char:other' }, 3), /locked/);
    assert.equal((await locked.getCanon('char:canon'))?.name, 'Canon Keeper');
  });
  if (!ran) t.skip('no Postgres configured');
});

// -------------------------------------------------------------- chronicle

test('witnessed events are POV-masked without prefix collisions', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const chron = new ChronicleStore({ db, storyId });
    await chron.addEvent({
      scene: 1, turn: 1, text: 'Tem the Elder speaks', participants: ['char:tem-the-elder'],
      locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
    });
    await chron.addEvent({
      scene: 1, turn: 2, text: 'Tem listens', participants: ['char:tem'],
      locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
    });
    await chron.addEvent({
      scene: 1, turn: 3, text: 'Offscreen plotting', participants: ['char:tem'],
      locationId: null, significance: 0.5, visibility: 'offscreen-hidden', fromConsequenceId: null,
    });

    // The bug this guards: `LIKE '%char:tem%'` matched `char:tem-the-elder`,
    // handing the Narrator events the player never saw. Reproduced directly
    // against node:sqlite before the SQLite fix; asserted here so the Postgres
    // containment test cannot regress it.
    const seen = await chron.witnessedEvents('char:tem');
    assert.deepEqual(seen.map((e) => e.text), ['Tem listens'], 'no prefix collision, no offscreen leak');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('turns round-trip jsonb meta, pinning and prose', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const chron = new ChronicleStore({ db, storyId });
    const turn = await chron.addTurn({
      scene: 1, turn: 1, rawInput: 'look', intent: null, delta: null, bookProse: 'First draft.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [{ role: 'narrator', provider: 'mock', model: 'm', tokensIn: 10, tokensOut: 20 }] },
    });

    const got = await chron.getTurn(turn.id);
    assert.equal(got?.bookProse, 'First draft.');
    assert.equal(got?.meta.providerCalls.length, 1);
    assert.equal(typeof got?.createdAt, 'string', 'callers expect an ISO string, not a Date');

    // Re-render changes how it is told, never what happened.
    await chron.setProse(turn.id, 'Second draft.');
    assert.equal((await chron.getTurn(turn.id))?.bookProse, 'Second draft.');

    // A pinned turn is the passage the author chose to keep.
    await chron.setPinned(turn.id, true);
    await chron.setProse(turn.id, 'Third draft.');
    assert.equal((await chron.getTurn(turn.id))?.bookProse, 'Second draft.', 'pinned prose is protected');

    await chron.appendRerollMeta(turn.id, { providerCalls: [{ role: 'narrator', provider: 'mock', model: 'm', tokensIn: 1, tokensOut: 2 }], lint: null });
    assert.equal((await chron.getTurn(turn.id))?.meta.providerCalls.length, 1, 'pinned meta is protected too');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('encrypted chronicles keep personal prose and turn JSON out of base tables', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    await db.query(`UPDATE stories SET encryption_version = 1 WHERE id = $1`, [storyId]);
    const key = randomBytes(32);
    const crypto = { keyForStory: (id: string) => (id === storyId ? key : null) };
    const chron = (await World.forStory(db, storyId, undefined, crypto)).chronicle;
    const meta = {
      integrity: null,
      referee: null,
      move: null,
      frameLog: null,
      lint: null,
      providerCalls: [{ role: 'narrator' as const, provider: 'private-provider', model: 'private-model', tokensIn: 3, tokensOut: 5 }],
    };

    const event = await chron.addEvent({
      scene: 1, turn: 1, text: 'The hidden bell rings.', participants: ['char:a'],
      locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
    });
    const turn = await chron.addTurn({
      scene: 1, turn: 1, rawInput: 'Open the hidden door.',
      intent: { class: 'action', actorId: 'char:a', action: 'open', targetIds: ['door'], manner: '', dialogueGist: null, verbatim: false },
      delta: emptyDelta(),
      bookProse: 'A concealed passage opens.', pinned: false, meta,
    });
    await chron.upsertScene(1, { title: 'Hidden Hall', summary: 'The bell reveals a door.' });
    await chron.upsertChapter(1, { title: 'Secrets', summary: 'Nothing stays buried.' });
    const fact = await chron.addFact('The bell is a key.', 1);
    await chron.addDivergence(1, 'choice', 'The player opened the hidden door.', 'The door stays closed.');
    await chron.addAnchor('Use short, tense sentences.', 'Preferred voice', 1);

    const base = await db.one<{
      event_text: string; raw_input: string; intent: unknown; delta: unknown; book_prose: string; meta: unknown; fact_text: string;
    }>(
      `SELECT e.text event_text, t.raw_input, t.intent, t.delta, t.book_prose, t.meta, f.text fact_text
         FROM events e JOIN turns t ON t.story_id = e.story_id JOIN facts f ON f.story_id = e.story_id
        WHERE e.id = $1 AND t.id = $2 AND f.id = $3`,
      [event.id, turn.id, fact.id],
    );
    assert.deepEqual(base, {
      event_text: '', raw_input: '', intent: null, delta: null, book_prose: '', meta: {}, fact_text: '',
    });
    const values = await db.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM encrypted_story_values WHERE story_id = $1`,
      [storyId],
    );
    assert.equal(values.rows.length, 15);
    assert.ok(values.rows.every((row) => !row.ciphertext.toString('utf8').includes('hidden')));

    assert.equal((await chron.events())[0]?.text, 'The hidden bell rings.');
    const restoredTurn = await chron.getTurn(turn.id);
    assert.equal(restoredTurn?.rawInput, 'Open the hidden door.');
    assert.deepEqual(restoredTurn?.intent, turn.intent);
    assert.deepEqual(restoredTurn?.delta, turn.delta);
    assert.deepEqual(restoredTurn?.meta, meta);
    assert.equal((await chron.facts())[0]?.text, 'The bell is a key.');
    assert.deepEqual(await chron.scenes(), [{ scene: 1, title: 'Hidden Hall', summary: 'The bell reveals a door.', locationId: null, chapter: 1 }]);
    assert.deepEqual(await chron.chapter(1), { chapter: 1, title: 'Secrets', summary: 'Nothing stays buried.' });
    assert.deepEqual((await chron.divergences()).map(({ kind, detail, canon }) => ({ kind, detail, canon })), [
      { kind: 'choice', detail: 'The player opened the hidden door.', canon: 'The door stays closed.' },
    ]);
    assert.deepEqual((await chron.anchors()).map(({ text, note }) => ({ text, note })), [
      { text: 'Use short, tense sentences.', note: 'Preferred voice' },
    ]);

    const locked = new ChronicleStore({ db, storyId });
    await assert.rejects(() => locked.getTurn(turn.id), /locked/);
    const wrongKey = new ChronicleStore({ db, storyId, crypto: { keyForStory: () => randomBytes(32) } });
    await assert.rejects(() => wrongKey.getTurn(turn.id), /cannot be decrypted/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('encrypted story-owned stores envelope personal fields and fail closed when locked', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const plainStory = new StoryStore(db, storyId);
    await plainStory.rename('Private book');
    const plainSession = await plainStory.set({
      playerCharacterId: 'char:player',
      currentLocationId: 'loc:cellar',
      style: { ...(await plainStory.get()).style, pov: 'first' },
      knobs: { ...(await plainStory.get()).knobs, pacing: 0.7 },
    });
    const plainThreads = new ThreadStore(db, storyId);
    const thread = await plainThreads.create({
      title: 'Find the traitor', stakes: 'The city may fall.', tension: 0.8,
      parties: ['char:player', 'char:spymaster'], resolutions: ['expose them', 'join them'],
      status: 'open', createdScene: 2,
    });
    const plainConsequences = new ConsequenceStore(db, storyId);
    const consequence = await plainConsequences.enqueue({
      causeEventId: 'ev:secret', trigger: { kind: 'on-learn', entityId: 'char:player', factId: 'fact:secret' },
      actorId: 'char:spymaster', action: 'Send the assassins.', visibility: 'offscreen-hidden',
      maturity: 'pending', depth: 1, significance: 0.9, createdScene: 2,
    });
    const plainDirectives = new DirectiveStore(db, storyId);
    const directive = await plainDirectives.create({
      text: 'Keep the traitor unnamed.', scope: 'scene', strength: 'mandate',
      lifetimeScenes: 2, status: 'active', createdScene: 2,
    });

    const key = randomBytes(32);
    await Promise.all([
      encryptStoryValueForTest(db, key, storyId, 'stories', storyId, 'title', 'Private book'),
      encryptStoryValueForTest(db, key, storyId, 'stories', storyId, 'player_character_id', plainSession.playerCharacterId),
      encryptStoryValueForTest(db, key, storyId, 'stories', storyId, 'current_location_id', plainSession.currentLocationId),
      encryptStoryValueForTest(db, key, storyId, 'stories', storyId, 'style', plainSession.style),
      encryptStoryValueForTest(db, key, storyId, 'stories', storyId, 'knobs', plainSession.knobs),
      encryptStoryValueForTest(db, key, storyId, 'threads', thread.id, 'title', thread.title),
      encryptStoryValueForTest(db, key, storyId, 'threads', thread.id, 'stakes', thread.stakes),
      encryptStoryValueForTest(db, key, storyId, 'threads', thread.id, 'parties', thread.parties),
      encryptStoryValueForTest(db, key, storyId, 'threads', thread.id, 'resolutions', thread.resolutions),
      encryptStoryValueForTest(db, key, storyId, 'consequences', consequence.id, 'trigger', consequence.trigger),
      encryptStoryValueForTest(db, key, storyId, 'consequences', consequence.id, 'action', consequence.action),
      encryptStoryValueForTest(db, key, storyId, 'directives', directive.id, 'text', directive.text),
    ]);
    await db.query(
      `UPDATE stories SET encryption_version = 1, title = '', player_character_id = '', current_location_id = NULL,
         style = '{}'::jsonb, knobs = '{}'::jsonb WHERE id = $1`,
      [storyId],
    );
    await db.query(`UPDATE threads SET title = '', stakes = '', parties = '[]'::jsonb, resolutions = '[]'::jsonb WHERE id = $1`, [
      thread.id,
    ]);
    await db.query(`UPDATE consequences SET trigger = '{}'::jsonb, action = '' WHERE id = $1`, [consequence.id]);
    await db.query(`UPDATE directives SET text = '' WHERE id = $1`, [directive.id]);

    const crypto = { keyForStory: (id: string) => (id === storyId ? key : null) };
    const world = await World.forStory(db, storyId, undefined, crypto);
    assert.equal((await world.session.info()).title, 'Private book');
    assert.deepEqual(await world.session.get(), plainSession);
    assert.deepEqual(await world.threads.get(thread.id), thread);
    assert.deepEqual(await world.consequences.get(consequence.id), consequence);
    assert.deepEqual(await world.directives.active(), [directive]);

    await world.session.rename('Retitled private book');
    await world.session.set({ currentLocationId: 'loc:roof' });
    await world.threads.update(thread.id, { stakes: 'The city will burn.', resolutions: ['flee'] });
    await world.consequences.retime(consequence.id, { kind: 'after-scenes', scenes: 3 });
    await world.directives.setStatus(directive.id, 'retired');

    assert.equal((await world.session.info()).title, 'Retitled private book');
    assert.equal((await world.session.get()).currentLocationId, 'loc:roof');
    assert.equal((await world.threads.get(thread.id))?.stakes, 'The city will burn.');
    assert.deepEqual((await world.threads.get(thread.id))?.resolutions, ['flee']);
    assert.deepEqual((await world.consequences.get(consequence.id))?.trigger, { kind: 'after-scenes', scenes: 3 });
    assert.deepEqual(await world.directives.active(), []);

    const base = await db.one<{
      title: string; player_character_id: string; current_location_id: string | null; style: unknown; knobs: unknown;
      thread_title: string; stakes: string; parties: unknown; resolutions: unknown; trigger: unknown; action: string; directive_text: string;
    }>(
      `SELECT s.title, s.player_character_id, s.current_location_id, s.style, s.knobs,
              t.title thread_title, t.stakes, t.parties, t.resolutions, c.trigger, c.action, d.text directive_text
         FROM stories s JOIN threads t ON t.story_id = s.id JOIN consequences c ON c.story_id = s.id
              JOIN directives d ON d.story_id = s.id
        WHERE s.id = $1`,
      [storyId],
    );
    assert.deepEqual(base, {
      title: '', player_character_id: '', current_location_id: null, style: {}, knobs: {},
      thread_title: '', stakes: '', parties: [], resolutions: [], trigger: {}, action: '', directive_text: '',
    });
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM encrypted_story_values WHERE story_id = $1`, [storyId]))!.n),
      12,
    );

    const locked = await World.forStory(db, storyId);
    await assert.rejects(() => locked.session.get(), /locked/);
    await assert.rejects(() => locked.threads.open(), /locked/);
    await assert.rejects(() => locked.consequences.setMaturity(consequence.id, 'fired', 3), /locked/);
    await assert.rejects(() => locked.directives.setStatus(directive.id, 'active'), /locked/);

    await deleteStory(db, storyId);
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM encrypted_story_values WHERE story_id = $1`, [storyId]))!.n),
      0,
      'story deletion cascades its encrypted values',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('usage totals accumulate across turns and split by role', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const chron = new ChronicleStore({ db, storyId });
    const meta = (calls: Array<{ role: string; provider: string; model: string; tokensIn: number; tokensOut: number }>) => ({
      integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: calls,
    });
    await chron.addTurn({ scene: 1, turn: 1, rawInput: 'a', intent: null, delta: null, bookProse: '', pinned: false, meta: meta([{ role: 'narrator', provider: 'mock', model: 'm', tokensIn: 100, tokensOut: 50 }]) });
    await chron.addTurn({ scene: 1, turn: 2, rawInput: 'b', intent: null, delta: null, bookProse: '', pinned: false, meta: meta([{ role: 'narrator', provider: 'mock', model: 'm', tokensIn: 10, tokensOut: 5 }, { role: 'referee', provider: 'mock', model: 'm', tokensIn: 7, tokensOut: 3 }]) });

    const totals = await chron.usageTotals();
    assert.equal(totals.tokensIn, 117);
    assert.equal(totals.tokensOut, 58);
    assert.equal(totals.calls, 3);
    assert.deepEqual(totals.byRole.narrator, { tokensIn: 110, tokensOut: 55, calls: 2 });
    assert.deepEqual(totals.byRole.referee, { tokensIn: 7, tokensOut: 3, calls: 1 });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('scene and chapter upserts do not erase what another writer set', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const chron = new ChronicleStore({ db, storyId });
    // The wizard writes a title; the compactor later writes only a summary.
    await chron.upsertScene(1, { title: 'The Scriptorium', chapter: 1 });
    await chron.upsertScene(1, { summary: 'Anselm sets down his quill.', chapter: 1 });
    const scene = (await chron.scenes())[0]!;
    assert.equal(scene.title, 'The Scriptorium', 'a blank patch must not erase the title');
    assert.equal(scene.summary, 'Anselm sets down his quill.');

    await chron.upsertChapter(1, { title: 'Winter' });
    await chron.upsertChapter(1, { summary: 'The cold sets in.' });
    assert.deepEqual(await chron.chapter(1), { chapter: 1, title: 'Winter', summary: 'The cold sets in.' });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('epistemics: knowledge is per-entity, distortion only improves, revoking forgets', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const chron = new ChronicleStore({ db, storyId });
    const fact = await chron.addFact('The abbot is dead', 3);

    await chron.setKnowledge(fact.id, 'char:a', 'knows', 3, 0);
    await chron.setKnowledge(fact.id, 'char:b', 'suspects', 4, 0.6);

    assert.equal(await chron.knows('char:a', fact.id), true);
    assert.equal(await chron.knows('char:b', fact.id), false, 'suspecting is not knowing');
    assert.equal((await chron.knowersOf(fact.id)).length, 2);
    assert.equal((await chron.knowledgeOf('char:a'))[0]?.text, 'The abbot is dead');

    // Hearing it first-hand after a rumour corrects the rumour; it must not
    // re-muddy what is already known clearly.
    await chron.setKnowledge(fact.id, 'char:b', 'knows', 5, 0.1);
    assert.equal((await chron.knowledgeOf('char:b'))[0]?.distortion, 0.1);
    await chron.setKnowledge(fact.id, 'char:b', 'knows', 6, 0.9);
    assert.equal((await chron.knowledgeOf('char:b'))[0]?.distortion, 0.1, 'distortion only decreases');

    // Dramatic irony: what the player does not know.
    assert.deepEqual((await chron.factsUnknownTo('char:c')).map((f) => f.id), [fact.id]);
    assert.deepEqual(await chron.factsUnknownTo('char:a'), []);

    // Revoking returns to "never told", not a fourth level meaning "knows it is false".
    await chron.revokeKnowledge(fact.id, 'char:a');
    assert.equal(await chron.knows('char:a', fact.id), false);
    assert.deepEqual((await chron.factsUnknownTo('char:a')).map((f) => f.id), [fact.id]);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('world meta is per world, and refuses to guess which one', async (t) => {
  const ran = await withPg(async (db) => {
    const w1 = await makeWorld(db, 'one');
    const w2 = await makeWorld(db, 'two');
    const s = await createStory(db, { worldIds: [w1] });

    const c1 = new ChronicleStore({ db, storyId: s.id, worldId: w1 });
    const c2 = new ChronicleStore({ db, storyId: s.id, worldId: w2 });
    await c1.setMeta('palette', 'chronicle');
    await c2.setMeta('palette', 'starfield');
    // The SQLite version's global `meta` key is why star-trek-alpha-beta still
    // carries the title "Saint Verrow": one world's write clobbered another's.
    assert.equal(await c1.getMeta('palette'), 'chronicle');
    assert.equal(await c2.getMeta('palette'), 'starfield');
    assert.equal(await c1.getMeta('missing', 'fallback'), 'fallback');

    const noWorld = new ChronicleStore({ db, storyId: s.id });
    await assert.rejects(() => noWorld.setMeta('palette', 'x'), /needs a target world/);
    assert.equal(await noWorld.getMeta('palette', 'fallback'), 'fallback', 'reads degrade rather than throw');
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------- threads, consequences, directives

test('threads rank by tension and clamp it', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const threads = new ThreadStore(db, storyId);
    const hot = await threads.create({ title: 'Hot', stakes: '', tension: 0.9, parties: ['char:a'], resolutions: [], status: 'open', createdScene: 1 });
    await threads.create({ title: 'Cold', stakes: '', tension: 0.1, parties: [], resolutions: [], status: 'open', createdScene: 1 });
    await threads.create({ title: 'Done', stakes: '', tension: 0.99, parties: [], resolutions: [], status: 'resolved', createdScene: 1 });

    assert.deepEqual((await threads.open()).map((x) => x.title), ['Hot', 'Cold'], 'the Director\u2019s menu, closed threads excluded');
    assert.deepEqual((await threads.get(hot.id))?.parties, ['char:a'], 'jsonb array round-trips');
    await threads.adjustTension(hot.id, 0.5);
    assert.equal((await threads.get(hot.id))?.tension, 1, 'clamped');
    await threads.adjustTension(hot.id, -5);
    assert.equal((await threads.get(hot.id))?.tension, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('consequences mature through the queue and count hidden fires', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const cons = new ConsequenceStore(db, storyId);
    const c = await cons.enqueue({
      causeEventId: 'ev:1', trigger: { kind: 'immediate' }, actorId: 'char:a', action: 'retaliate',
      visibility: 'offscreen-hidden', maturity: 'pending', depth: 1, significance: 0.7, createdScene: 1,
    });
    assert.equal((await cons.pending()).length, 1);
    assert.deepEqual((await cons.byCause('ev:1')).map((x) => x.id), [c.id]);

    await cons.setMaturity(c.id, 'fired', 4);
    assert.equal((await cons.get(c.id))?.firedScene, 4);
    assert.equal((await cons.pending()).length, 0);
    // Drives the ignorance budget (DESIGN §6.5): matured, but the player did not see it.
    assert.equal(await cons.hiddenFiredCount(), 1);

    await cons.retime(c.id, { kind: 'after-scenes', scenes: 3 });
    assert.deepEqual((await cons.get(c.id))?.trigger, { kind: 'after-scenes', scenes: 3 });
    await cons.supersede(c.id, 'cons:other');
    assert.equal((await cons.get(c.id))?.maturity, 'superseded');
    assert.equal(await cons.hiddenFiredCount(), 0, 'superseded is no longer a hidden fire');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('directives expire when their lifetime runs out', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const dirs = new DirectiveStore(db, storyId);
    const short = await dirs.create({ text: 'Be terse', scope: 'scene', strength: 'hint', lifetimeScenes: 2, status: 'active', createdScene: 1 });
    const forever = await dirs.create({ text: 'Stay in period', scope: 'campaign', strength: 'mandate', lifetimeScenes: null, status: 'active', createdScene: 1 });

    assert.equal((await dirs.active()).length, 2);
    assert.deepEqual(await dirs.expire(2), [], 'not yet: created 1 + lifetime 2 = 3');
    assert.deepEqual(await dirs.expire(3), [short.id]);
    assert.deepEqual((await dirs.active()).map((d) => d.id), [forever.id], 'a null lifetime never expires');
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------- stories and worlds

test('story state round-trips and touches last_played_at', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    const store = new StoryStore(db, storyId);
    const before = (await store.info()).lastPlayedAt;
    await new Promise((r) => setTimeout(r, 10));

    const next = await store.set({ scene: 4, turn: 12, playerCharacterId: 'char:me' });
    assert.equal(next.scene, 4);
    assert.equal((await store.get()).playerCharacterId, 'char:me');
    // Defaults are filled in from the domain type, so a story written before a
    // knob or style field existed still reads as complete rather than partial.
    const state = await store.get();
    assert.equal(state.knobs.pacing, defaultKnobs().pacing);
    assert.equal(state.knobs.canonFidelity, defaultKnobs().canonFidelity);
    assert.equal(state.style.pov, defaultStyleContract().pov);
    assert.notEqual((await store.info()).lastPlayedAt, before, 'playing updates the sort key');

    await store.rename('The Long Winter');
    assert.equal((await store.info()).title, 'The Long Winter');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('deleting a story cascades every scoped table, with no hand-maintained list', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, storyId } = await setup(db);
    const other = await createStory(db, { worldIds: [worldId] });

    // One row in each story-scoped table, so a missed cascade shows up as a leak.
    const chron = new ChronicleStore({ db, storyId });
    const turn = await chron.addTurn({ scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null, bookProse: '', pinned: false, meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] } });
    await chron.addEvent({ scene: 1, turn: 1, text: 'e', participants: [], locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null });
    const fact = await chron.addFact('f', 1);
    await chron.setKnowledge(fact.id, 'char:a', 'knows', 1);
    await chron.addDivergence(1, 'kind', 'detail');
    await chron.addAnchor('anchor');
    await chron.upsertScene(2, { title: 's' });
    await chron.upsertChapter(1, { title: 'c' });
    await new ThreadStore(db, storyId).create({ title: 't', stakes: '', tension: 0.5, parties: [], resolutions: [], status: 'open', createdScene: 1 });
    await new ConsequenceStore(db, storyId).enqueue({ causeEventId: 'ev:1', trigger: { kind: 'immediate' }, actorId: 'char:a', action: 'a', visibility: 'onscreen', maturity: 'pending', depth: 1, significance: 0.5, createdScene: 1 });
    await new DirectiveStore(db, storyId).create({ text: 'd', scope: 'scene', strength: 'hint', lifetimeScenes: null, status: 'active', createdScene: 1 });
    const cast = new CastStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    await cast.put(blankSheet('char:a'));
    await cast.adjustRelationship('char:a', 'char:b', { trust: 0.2 });
    await new GraphStoreShim(db, storyId).addChronEntity();
    const illus = new IllustrationStore(db, storyId, mkdtempSync(join(tmpdir(), 'illus-')));
    await illus.reserve({ subject: { kind: 'scene', turnId: turn.id, locationId: null }, visualStyle: 'drawing', prompt: 'p', negativePrompt: '', seed: 1, provider: 'mock', createdScene: 1 });

    await deleteStory(db, storyId);

    // Asserted by sweeping every story-scoped table rather than spot-checking:
    // this is the exact failure SetupService.reset() had twice, where a table
    // added later was missing from a hand-written list.
    const tables = ['turns', 'events', 'facts', 'threads', 'consequences', 'directives', 'divergences', 'style_anchors', 'scenes', 'chapters', 'relationships', 'chron_entities', 'chron_sheets', 'illustrations', 'story_sources'];
    for (const table of tables) {
      const { rows } = await db.query<{ n: string }>(`SELECT count(*) n FROM ${table} WHERE story_id = $1`, [storyId]);
      assert.equal(Number(rows[0]!.n), 0, `${table} should have cascaded`);
    }
    // fact_knowledge cascades through facts rather than carrying story_id.
    assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM fact_knowledge`))!.n), 0);
    // The other story is untouched, and so is canon.
    assert.ok(await getStory(db, other.id));
    assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM worlds`))!.n), 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

/** Minimal helper: one chronicle entity, without pulling in the whole GraphStore. */
class GraphStoreShim {
  private db: Db;
  private storyId: string;

  constructor(db: Db, storyId: string) {
    this.db = db;
    this.storyId = storyId;
  }
  async addChronEntity(): Promise<void> {
    await this.db.query(
      `INSERT INTO chron_entities (story_id, id, type, name) VALUES ($1,'char:a','Character','A')`,
      [this.storyId],
    );
  }
}

test('per-user story resolution never returns another user\u2019s or an unowned story', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    // An unowned story: created before login existed, or during a login-off run.
    await createStory(db, { title: 'legacy', worldIds: [worldId] });

    const alice = await resolveOrCreateStoryForUser(db, 'user_alice', [worldId]);
    const bob = await resolveOrCreateStoryForUser(db, 'user_bob', [worldId]);
    assert.notEqual(alice, bob);
    // Stable across calls: a second visit returns the same story, not a new one.
    assert.equal(await resolveOrCreateStoryForUser(db, 'user_alice', [worldId]), alice);

    assert.deepEqual((await listStoriesForUser(db, 'user_alice')).map((s) => s.id), [alice]);
    // null owner means unowned, never "owned by everyone" — attributing a
    // stranger's old save to whoever logs in first would be a privacy bug.
    assert.equal((await listStoriesForUser(db, 'user_alice')).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('worldFor resolves per request, so two users never share a pointer', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    const alice = testUser('user_alice');
    const bob = testUser('user_bob');

    const wa = await worldFor(db, alice, { worldIds: [worldId] });
    const wb = await worldFor(db, bob, { worldIds: [worldId] });
    assert.notEqual(wa.storyId, wb.storyId);

    // The SQLite server held "the open story" as process state, so one request's
    // switch changed every other request's view. Resolving per request makes that
    // unrepresentable: Alice's write is invisible to Bob.
    await wa.graph.upsert({ id: 'char:secret', type: 'Character', name: 'Alice only' }, 'chronicle');
    assert.ok(await wa.graph.has('char:secret'));
    assert.equal(await wb.graph.has('char:secret'), false);

    // An override is honoured only for one's own story.
    const again = await worldFor(db, alice, { storyIdOverride: wa.storyId });
    assert.equal(again.storyId, wa.storyId);
    await assert.rejects(() => worldFor(db, bob, { storyIdOverride: wa.storyId }), /does not belong/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('slugify folds accents rather than stripping them', () => {
  // The app is meant to be usable for Czech and Slovak worlds, so a title with
  // diacritics must not become a mangled name — "zakl-n-a" looks like corruption.
  assert.equal(slugify('Zakl\u00ednač'), 'zaklinac');
  assert.equal(slugify('\u0160umava'), 'sumava');
  assert.equal(slugify('Mass Effect'), 'mass-effect');
  assert.equal(slugify('!!!'), 'world', 'never empty');
  assert.equal(slugify(''), 'world');
});

test('the world registry lists, renames, and refuses unsafe deletes', async (t) => {
  const ran = await withPg(async (db) => {
    const created = await createWorld(db, 'Mass Effect');
    assert.equal(created.slug, 'mass-effect');
    // A second world with the same title gets its own slug, never a silent reuse.
    assert.equal(await uniqueSlug(db, 'Mass Effect'), 'mass-effect-2');

    const worldId = created.id;
    await db.query(`INSERT INTO canon_entities (world_id, id, type, name) VALUES ($1,'char:a','Character','A')`, [worldId]);
    await db.query(`INSERT INTO canon_edges (world_id, subject, predicate, object) VALUES ($1,'char:a','KNOWS','char:b')`, [worldId]);

    let listed = (await listWorlds(db)).find((w) => w.slug === 'mass-effect')!;
    assert.equal(listed.entityCount, 1);
    assert.equal(listed.edgeCount, 1);
    assert.equal(listed.storyCount, 0);
    assert.equal(listed.lastPlayedAt, null, 'an unplayed world has no timestamp, not a fake one');

    // A world with a story reading it must not be deletable: story_sources is
    // ON DELETE RESTRICT precisely because no foreign key can span the overlay to
    // catch the dangling references afterwards.
    const story = await createStory(db, { worldIds: [worldId] });
    listed = (await getWorldBySlug(db, 'mass-effect'))!;
    assert.equal(listed.storyCount, 1);
    await assert.rejects(() => deleteWorld(db, 'mass-effect'), /still read it/);

    await deleteStory(db, story.id);
    const renamed = await renameWorld(db, 'mass-effect', 'Mass Effect Legendary');
    assert.equal(renamed.title, 'Mass Effect Legendary');
    assert.equal(renamed.slug, 'mass-effect-legendary');
    await deleteWorld(db, renamed.slug);
    assert.equal(await getWorldBySlug(db, renamed.slug), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('setStorySources rewrites a story\u2019s crossover in order', async (t) => {
  const ran = await withPg(async (db) => {
    const a = await makeWorld(db, 'a');
    const b = await makeWorld(db, 'b');
    const c = await makeWorld(db, 'c');
    const story = await createStory(db, { worldIds: [a] });

    await setStorySources(db, story.id, [b, c, a]);
    const sources = await sourcesFor(db, story.id);
    assert.deepEqual(sources.map((s) => [s.worldId, s.ordinal]), [[b, 1], [c, 2], [a, 3]]);

    const world = await World.forStory(db, story.id);
    assert.equal(world.worldId, b, 'the primary source is ordinal 1');
    assert.equal(world.sources.length, 3);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('illustrations keep bytes on disk and delete them with the row', async (t) => {
  const ran = await withPg(async (db) => {
    const dir = mkdtempSync(join(tmpdir(), 'fabulist-illus-'));
    try {
      const { storyId } = await setup(db);
      const store = new IllustrationStore(db, storyId, dir);
      const reserved = await store.reserve({
        subject: { kind: 'portrait', entityId: 'char:a' },
        visualStyle: 'drawing', prompt: 'a monk', negativePrompt: '', seed: 42, provider: 'mock', createdScene: 1,
      });
      assert.equal(reserved.status, 'pending', 'a reload during generation shows pending, not nothing');

      const done = await store.complete(reserved.id, new Uint8Array([1, 2, 3]), 'image/png', 42);
      assert.equal(done?.status, 'done');
      assert.equal(done?.seed, 42, 'BIGINT must come back as a number or a re-seed silently differs');
      const abs = store.absolutePath(done!)!;
      assert.ok(existsSync(abs));

      assert.equal((await store.latestPortrait('char:a'))?.id, reserved.id);
      assert.equal((await store.forEntity('char:a')).length, 1);

      // A failed generation must not be offered as the reference image.
      const bad = await store.reserve({
        subject: { kind: 'portrait', entityId: 'char:a' },
        visualStyle: 'drawing', prompt: 'x', negativePrompt: '', seed: null, provider: 'mock', createdScene: 2,
      });
      await store.fail(bad.id, 'provider exploded');
      assert.equal((await store.latestPortrait('char:a'))?.id, reserved.id, 'still the completed one');

      await store.delete(reserved.id);
      assert.equal(await store.get(reserved.id), undefined);
      assert.equal(existsSync(abs), false, 'bytes go with the row, or a retry leaks files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('encrypted illustrations protect prompts and image bytes at rest', async (t) => {
  const dir = join('data', '.test-encrypted-illustrations');
  rmSync(dir, { recursive: true, force: true });
  let ran = false;
  try {
    ran = await withPg(async (db) => {
    const { storyId } = await setup(db);
    await db.query(`UPDATE stories SET encryption_version = 1 WHERE id = $1`, [storyId]);
    const key = randomBytes(32);
    const world = await World.forStory(db, storyId, dir, {
      keyForStory: (id: string) => (id === storyId ? key : null),
    });
    const secretPrompt = 'Mara Vell guards the moonlit archive.';
    const secretBytes = Buffer.from('private illustration bytes: moonlit archive');
    const reserved = await world.illustrations.reserve({
      subject: { kind: 'portrait', entityId: 'char:mara' },
      visualStyle: 'drawing',
      prompt: secretPrompt,
      negativePrompt: 'no daylight',
      seed: 42,
      provider: 'mock',
      createdScene: 1,
    });
    const done = (await world.illustrations.complete(reserved.id, secretBytes, 'image/png', 42))!;
    assert.equal((await world.illustrations.get(done.id))?.prompt, secretPrompt);
    assert.deepEqual(await world.illustrations.readBytes(done), secretBytes);
    assert.deepEqual(await world.illustrations.referenceInput(done), { path: null, bytes: secretBytes });

    const raw = readFileSync(world.illustrations.absolutePath(done)!);
    assert.equal(raw.includes(secretBytes), false, 'the private image is never stored as plaintext');
    const row = await db.one<{ prompt: string; negative_prompt: string }>(
      `SELECT prompt, negative_prompt FROM illustrations WHERE id = $1`,
      [done.id],
    );
    assert.deepEqual(row, { prompt: '', negative_prompt: '' });
    assert.equal(
      Number((await db.one<{ n: string }>(
        `SELECT count(*) n FROM encrypted_story_values
          WHERE story_id = $1 AND table_name = 'illustrations' AND record_id = $2`,
        [storyId, done.id],
      ))!.n),
      2,
    );

    const locked = (await World.forStory(db, storyId, dir)).illustrations;
    await assert.rejects(() => locked.get(done.id), /locked/);
    await assert.rejects(() => locked.readBytes(done), /locked/);
    await assert.rejects(() => locked.reserve({
      subject: { kind: 'portrait', entityId: 'char:mara' },
      visualStyle: 'drawing', prompt: 'must not write', negativePrompt: '', seed: null, provider: 'mock', createdScene: 1,
    }), /locked/);
    await assert.rejects(() => locked.complete(done.id, Buffer.from('must not write'), 'image/png', null), /locked/);
    await assert.rejects(() => locked.delete(done.id), /locked/);

    const path = world.illustrations.absolutePath(done)!;
    await world.illustrations.delete(done.id);
    assert.equal(existsSync(path), false);
    assert.equal(
      Number((await db.one<{ n: string }>(
        `SELECT count(*) n FROM encrypted_story_values
          WHERE story_id = $1 AND table_name = 'illustrations' AND record_id = $2`,
        [storyId, done.id],
      ))!.n),
      0,
    );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!ran) t.skip('no Postgres configured');
});

/**
 * An empty story must not outrank a book with writing in it.
 *
 * `last_played_at` is `NOT NULL DEFAULT now()`, so "most recently played" is really "most
 * recently created" until someone plays. Every one of the failed boots during the
 * Postgres migration created a blank story — `resolveOrCreateStoryForUser` makes one when
 * the user owns none, and the imported books were unowned at the time — so those blanks
 * were newer than the real book and won the default. The session landed on a blank story
 * that sourced no world, which is why the setup wizard appeared and the cast was empty on
 * an instance holding a played book and 33,000 canon entities.
 *
 * Fixed by preferring a story that has actually been written in. Turn count is the honest
 * signal: it cannot be faked by a timestamp default, and a book with turns is a book.
 */
test('resolution prefers a book with writing over a newer empty one', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'ordering', 'Ordering');
    const owner = 'user-order';

    const real = await createStory(db, { title: 'Real book', ownerUserId: owner, worldIds: [worldId] });
    await db.query(`UPDATE stories SET turn = 12, scene = 3 WHERE id = $1`, [real.id]);
    // Created afterwards, so a plain `last_played_at DESC` puts it first.
    const blank = await createStory(db, { title: '', ownerUserId: owner, worldIds: [] });

    assert.equal(
      await resolveOrCreateStoryForUser(db, owner),
      real.id,
      'a session must land on the book with turns, not the newer blank one',
    );

    // The blank story still exists — this is about which one is *default*, not about
    // deleting anything.
    const mine = await listStoriesForUser(db, owner);
    assert.equal(mine.length, 2);
    assert.ok(
      mine.some((st) => st.id === blank.id),
      'the empty story is still listed, just not preferred',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('withEncryptionRollout binds bootstrap email to user id and keeps it stable', async (t) => {
  const ran = await withPg(async (db) => {
    const user = testUser('user_fabulist', 'fabulist@rast.io');
    const enriched = await withEncryptionRollout(db, user);
    assert.equal(enriched?.encryptionPilot, true);
    assert.equal(enriched?.encryptNewStories, true);

    const row = await db.one<{ user_id: string; bootstrap_email: string }>(
      `SELECT user_id, bootstrap_email FROM encryption_rollout WHERE bootstrap_email = 'fabulist@rast.io'`,
    );
    assert.equal(row?.user_id, 'user_fabulist');

    // Once bound, email changes do not drop rollout eligibility.
    const renamed = await withEncryptionRollout(db, { ...user, email: 'new-address@example.com' });
    assert.equal(renamed?.encryptionPilot, true);
    assert.equal(renamed?.encryptNewStories, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a rollout-enabled user auto-creates an encryption v1 story on first visit', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'enc-default', 'Encryption default');
    await db.query(
      `INSERT INTO encryption_rollout (bootstrap_email, enabled, encrypt_new_stories, updated_at)
       VALUES ($1, true, true, now())
       ON CONFLICT (bootstrap_email)
       DO UPDATE SET enabled = EXCLUDED.enabled, encrypt_new_stories = EXCLUDED.encrypt_new_stories, updated_at = now()`,
      ['pilot@example.com'],
    );
    const user = await withEncryptionRollout(db, testUser('user_pilot', 'pilot@example.com'));
    const world = await worldFor(db, user, { worldIds: [worldId] });
    const created = await getStory(db, world.storyId);
    assert.equal(created?.ownerUserId, 'user_pilot');
    assert.equal(created?.encryptionVersion, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});
