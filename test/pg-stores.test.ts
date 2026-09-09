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
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, withPg } from './pg-harness.ts';
import { sourcesFor } from '../src/db/overlay.ts';
import { CastStore, emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../src/store/cast-pg.ts';
import { ChronicleStore } from '../src/store/chronicle-pg.ts';
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
import { defaultKnobs, defaultStyleContract, type CharacterSheet } from '../src/domain/types.ts';
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
