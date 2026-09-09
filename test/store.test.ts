import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/store/index.ts';
import { checkpoint, openDb } from '../src/db/db.ts';
import { createStory, getStory, listStoriesForUser, resolveDefaultStory, resolveOrCreateStoryForUser } from '../src/store/world.ts';

function w() {
  return World.open(':memory:');
}

test('canon stays pristine while chronicle overlays it', () => {
  const world = w();
  world.graph.upsert(
    { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'A living monk.' },
    'canon',
  );
  assert.equal(world.graph.get('char:anselm')?.summary, 'A living monk.');

  // The playthrough kills him: shadow the node, do not mutate canon.
  world.graph.upsert(
    { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'Dead since scene 12.' },
    'chronicle',
  );

  assert.equal(world.graph.get('char:anselm')?.summary, 'Dead since scene 12.');
  assert.equal(world.graph.getCanon('char:anselm')?.summary, 'A living monk.');
  world.close();
});

test('edges expire rather than being deleted, so history survives', () => {
  const world = w();
  for (const id of ['char:a', 'char:b']) {
    world.graph.upsert({ id, type: 'Character', name: id }, 'canon');
  }
  world.graph.assertEdge({ subject: 'char:a', predicate: 'ALLIED_WITH', object: 'char:b' }, 1);

  assert.equal(world.graph.edgesFrom('char:a', 5).length, 1, 'allied at scene 5');

  world.graph.retireEdge('char:a', 'ALLIED_WITH', 'char:b', 14);
  world.graph.assertEdge({ subject: 'char:a', predicate: 'BETRAYED', object: 'char:b' }, 14);

  const atFive = world.graph.edgesFrom('char:a', 5).map((e) => e.predicate);
  const atTwenty = world.graph.edgesFrom('char:a', 20).map((e) => e.predicate);

  assert.deepEqual(atFive, ['ALLIED_WITH'], 'the past is still queryable');
  assert.deepEqual(atTwenty, ['BETRAYED'], 'the present reflects the betrayal');
  assert.equal(world.graph.allEdges().length, 2, 'nothing was deleted');
  world.close();
});

test('locked sheet fields survive an AI condition update', () => {
  const world = w();
  world.graph.upsert({ id: 'char:c', type: 'Character', name: 'C' }, 'canon');
  const sheet = world.cast.getOrBlank('char:c');
  sheet.condition.mood = 'resolute';
  world.cast.put(sheet);
  world.cast.lock('char:c', 'condition.mood');

  world.cast.updateCondition('char:c', { mood: 'terrified', intent: 'flee' });

  const after = world.cast.get('char:c');
  assert.equal(after?.condition.mood, 'resolute', 'locked field is ground truth');
  assert.equal(after?.condition.intent, 'flee', 'unlocked field still updates');
  world.close();
});

test('relationships are directional and asymmetric', () => {
  const world = w();
  world.cast.adjustRelationship('char:a', 'char:b', { trust: 0.8 });
  world.cast.adjustRelationship('char:b', 'char:a', { trust: -0.6 });
  assert.equal(world.cast.relationship('char:a', 'char:b').trust, 0.8);
  assert.equal(world.cast.relationship('char:b', 'char:a').trust, -0.6);
  world.close();
});

test('relationship values clamp to [-1, 1]', () => {
  const world = w();
  world.cast.adjustRelationship('char:a', 'char:b', { trust: 5 });
  assert.equal(world.cast.relationship('char:a', 'char:b').trust, 1);
  world.cast.adjustRelationship('char:a', 'char:b', { trust: -50 });
  assert.equal(world.cast.relationship('char:a', 'char:b').trust, -1);
  world.close();
});

test('epistemic state keeps facts the player cannot know', () => {
  const world = w();
  const fact = world.chronicle.addFact('the envoy is a double agent', 3);
  world.chronicle.setKnowledge(fact.id, 'char:spymaster', 'knows', 3);
  world.chronicle.setKnowledge(fact.id, 'char:captain', 'suspects', 4);

  assert.ok(world.chronicle.knows('char:spymaster', fact.id));
  assert.ok(!world.chronicle.knows('char:captain', fact.id), 'suspicion is not knowledge');
  assert.ok(!world.chronicle.knows('char:player', fact.id));

  const unknown = world.chronicle.factsUnknownTo('char:player').map((f) => f.text);
  assert.deepEqual(unknown, ['the envoy is a double agent'], 'dramatic irony is queryable');
  world.close();
});

/**
 * The undo of a grant, and §11's fix for the natural authoring move when the
 * extractor gets epistemics wrong. `revokeKnowledge` goes back to "never
 * told" by deleting the row outright, not to some fourth level meaning
 * "explicitly does not know" — distinct from overwriting with `'wrong'`,
 * which is a different claim.
 */
test('revoking knowledge removes the row outright, distinct from overwriting with a level', () => {
  const world = w();
  const fact = world.chronicle.addFact('the seal is forged', 2);
  world.chronicle.setKnowledge(fact.id, 'char:forger', 'knows', 2);
  assert.ok(world.chronicle.knows('char:forger', fact.id));

  world.chronicle.revokeKnowledge(fact.id, 'char:forger');
  assert.ok(!world.chronicle.knows('char:forger', fact.id));
  assert.equal(world.chronicle.knowersOf(fact.id).find((k) => k.entityId === 'char:forger'), undefined);
  assert.deepEqual(world.chronicle.knowledgeOf('char:forger'), [], 'gone, not present at some other level');
  world.close();
});

test('salience decays but bumped entities stay hot', () => {
  const world = w();
  world.graph.upsert({ id: 'char:hot', type: 'Character', name: 'Hot', salience: 0.5 }, 'canon');
  world.graph.upsert({ id: 'char:cold', type: 'Character', name: 'Cold', salience: 0.5 }, 'canon');

  world.graph.bumpSalience(['char:hot'], 0.4);
  for (let i = 0; i < 2; i++) world.graph.decaySalience(0.1);

  const hot = world.graph.get('char:hot')!.salience;
  const cold = world.graph.get('char:cold')!.salience;
  assert.ok(hot > cold, `touched entity stays hotter (${hot} > ${cold})`);
  world.close();
});

test('an entity no story has ever touched sits at its canon baseline forever, not decaying toward the floor', () => {
  // Decay used to run unconditionally over every entity, including canon's
  // shared row directly — which would have been a cross-story leak once
  // canon became shared across stories: one story's turns cooling the
  // baseline every other story reads. Decay now only touches a story's own
  // chronicle rows; an entity that story has never bumped stays exactly at
  // whatever canon (or another story's untouched view of it) says.
  const world = w();
  world.graph.upsert({ id: 'char:untouched', type: 'Character', name: 'Untouched', salience: 0.5 }, 'canon');
  for (let i = 0; i < 20; i++) world.graph.decaySalience(0.1);
  assert.equal(world.graph.get('char:untouched')!.salience, 0.5, 'no chronicle row was ever created for it, so nothing decayed');
  world.close();
});

test('vow breaking is recorded on the sheet with its scene', () => {
  const world = w();
  world.graph.upsert({ id: 'char:monk', type: 'Character', name: 'Monk' }, 'canon');
  const sheet = world.cast.getOrBlank('char:monk');
  sheet.contract.vows = [{ id: 'nonviolence', text: 'harm no living thing', rank: 1, broken: false, brokenScene: null }];
  world.cast.put(sheet);

  const broken = world.cast.breakVow('char:monk', 'nonviolence', 17);
  assert.equal(broken?.broken, true);
  assert.equal(world.cast.get('char:monk')?.contract.vows[0]?.brokenScene, 17);
  world.close();
});

test('threads rank by tension and never carry a single resolution', () => {
  const world = w();
  world.threads.create({
    title: 'The captain doubts the envoy',
    stakes: 'the alliance',
    tension: 0.3,
    parties: ['char:captain'],
    resolutions: ['exposed', 'silenced', 'turned'],
    status: 'open',
    createdScene: 1,
  });
  const hi = world.threads.create({
    title: 'Famine in the north',
    stakes: 'the village',
    tension: 0.8,
    parties: [],
    resolutions: ['relief arrives', 'they migrate'],
    status: 'open',
    createdScene: 1,
  });
  const open = world.threads.open();
  assert.equal(open[0]?.id, hi.id, 'highest tension first');
  assert.ok(open.every((t) => t.resolutions.length > 1), 'never one resolution');
  world.close();
});

test('session round-trips style and knobs with defaults filled', () => {
  const world = w();
  world.session.set({ scene: 4, playerCharacterId: 'char:me' });
  const s = world.session.get();
  assert.equal(s.scene, 4);
  assert.equal(s.playerCharacterId, 'char:me');
  assert.equal(s.style.pov, 'third-limited', 'default style survives');
  assert.equal(s.knobs.characterStrictness, 'strict', 'strict is the default gate');
  world.close();
});

test('turn keeps all four registers', () => {
  const world = w();
  const t = world.chronicle.addTurn({
    scene: 1,
    turn: 1,
    rawInput: 'i try to talk him down, mention his sister, dont draw',
    intent: {
      class: 'action',
      actorId: 'char:me',
      action: 'de-escalate',
      targetIds: ['char:him'],
      manner: 'calm',
      dialogueGist: 'mention the sister',
      verbatim: false,
    },
    delta: null,
    bookProse: 'He kept his hands open and spoke of her name.',
    pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  const back = world.chronicle.getTurn(t.id)!;
  assert.match(back.rawInput, /dont draw/, 'raw intent is kept verbatim');
  assert.equal(back.intent?.action, 'de-escalate');
  assert.match(back.bookProse, /hands open/);
  world.close();
});

test('pinned prose is never overwritten by a re-render', () => {
  const world = w();
  const t = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null,
    bookProse: 'The sentence I loved.', pinned: true,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  world.chronicle.setProse(t.id, 'A worse sentence.');
  assert.equal(world.chronicle.getTurn(t.id)?.bookProse, 'The sentence I loved.');
  world.close();
});

test('a reroll appends its provider calls and replaces the lint result', () => {
  const world = w();
  const t = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null,
    bookProse: 'first draft', pinned: false,
    meta: {
      integrity: null, referee: null, move: null, frameLog: null,
      lint: { profile: 'fiction', score: 9, tripped: true, findings: [] },
      providerCalls: [{ role: 'narrate', provider: 'mock', model: 'mock-1', tokensIn: 10, tokensOut: 20 }],
    },
  });
  world.chronicle.appendRerollMeta(t.id, {
    providerCalls: [{ role: 'narrate', provider: 'mock', model: 'mock-1', tokensIn: 5, tokensOut: 8 }],
    lint: { profile: 'fiction', score: 0, tripped: false, findings: [] },
  });
  const after = world.chronicle.getTurn(t.id)!;
  assert.equal(after.meta.providerCalls.length, 2, 'the original call is kept, not replaced');
  assert.equal(after.meta.lint?.score, 0, 'lint reflects the reroll, not the original draft');
  world.close();
});

test('a reroll never touches a pinned turn\'s meta either', () => {
  const world = w();
  const t = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null,
    bookProse: 'kept forever', pinned: true,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  world.chronicle.appendRerollMeta(t.id, {
    providerCalls: [{ role: 'narrate', provider: 'mock', model: 'mock-1', tokensIn: 5, tokensOut: 8 }],
    lint: { profile: 'fiction', score: 3, tripped: true, findings: [] },
  });
  assert.equal(world.chronicle.getTurn(t.id)?.meta.providerCalls.length, 0);
  world.close();
});

test('usage totals sum provider calls across every turn and by role', () => {
  const world = w();
  world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null, bookProse: '', pinned: false,
    meta: {
      integrity: null, referee: null, move: null, frameLog: null, lint: null,
      providerCalls: [
        { role: 'narrate', provider: 'mock', model: 'mock', tokensIn: 100, tokensOut: 40 },
        { role: 'referee', provider: 'mock', model: 'mock', tokensIn: 30, tokensOut: 10 },
      ],
    },
  });
  world.chronicle.addTurn({
    scene: 1, turn: 2, rawInput: 'y', intent: null, delta: null, bookProse: '', pinned: false,
    meta: {
      integrity: null, referee: null, move: null, frameLog: null, lint: null,
      providerCalls: [{ role: 'narrate', provider: 'mock', model: 'mock', tokensIn: 50, tokensOut: 20 }],
    },
  });

  const usage = world.chronicle.usageTotals();
  assert.equal(usage.calls, 3);
  assert.equal(usage.tokensIn, 180);
  assert.equal(usage.tokensOut, 70);
  assert.equal(usage.byRole.narrate?.calls, 2);
  assert.equal(usage.byRole.narrate?.tokensIn, 150);
  assert.equal(usage.byRole.referee?.calls, 1);
  world.close();
});

// ------------------------------------------------------------- multi-story

test('two stories in the same world file share canon but never see each other\'s chronicle', () => {
  const world = w();
  world.chronicle.setMeta('worldTitle', 'The Shared World');
  world.graph.upsert({ id: 'char:hero', type: 'Character', name: 'Hero', summary: 'canon summary' }, 'canon');
  world.cast.put({
    entityId: 'char:hero',
    identity: emptyStoryIdentity(),
    contract: { vows: [{ id: 'v1', text: 'never lie', rank: 1, broken: false, brokenScene: null }], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: '', tics: [], samples: [], never: [] },
    condition: { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: false,
  }, 'canon');

  const storyA = world.storyId;
  const storyB = createStory(world.db, { title: 'Story B' }).id;
  const b = world.withStory(storyB);

  // Both stories start out seeing the exact same canon.
  assert.equal(world.graph.get('char:hero')?.summary, 'canon summary');
  assert.equal(b.graph.get('char:hero')?.summary, 'canon summary');
  assert.equal(world.cast.get('char:hero')?.contract.vows[0]?.text, 'never lie');
  assert.equal(b.cast.get('char:hero')?.contract.vows[0]?.text, 'never lie');

  // Story A diverges: overwrites the summary and breaks the vow.
  world.graph.upsert({ id: 'char:hero', type: 'Character', name: 'Hero', summary: 'A says something happened' }, 'chronicle');
  world.cast.breakVow('char:hero', 'v1', 3);

  // Story A sees its own divergence.
  assert.equal(world.graph.get('char:hero')?.summary, 'A says something happened');
  assert.equal(world.cast.get('char:hero')?.contract.vows[0]?.broken, true);

  // Story B is completely unaffected — same canon, no leak.
  assert.equal(b.graph.get('char:hero')?.summary, 'canon summary');
  assert.equal(b.cast.get('char:hero')?.contract.vows[0]?.broken, false);

  // Canon itself, read directly, was never touched.
  assert.equal(world.graph.getCanon('char:hero')?.summary, 'canon summary');
  assert.equal(storyA !== storyB, true, 'the two stories really are different ids');
  world.close();
});

test('two stories can each retire the same canon edge independently', () => {
  const world = w();
  world.graph.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
  world.graph.upsert({ id: 'char:b', type: 'Character', name: 'B' }, 'canon');
  world.graph.assertEdge({ subject: 'char:a', predicate: 'TRUSTS', object: 'char:b' }, 0, 'canon');

  const b = world.withStory(createStory(world.db, { title: 'B' }).id);

  assert.ok(world.graph.edgesFrom('char:a').some((e) => e.predicate === 'TRUSTS'));
  assert.ok(b.graph.edgesFrom('char:a').some((e) => e.predicate === 'TRUSTS'));

  world.graph.retireEdge('char:a', 'TRUSTS', 'char:b', 5);

  assert.ok(!world.graph.edgesFrom('char:a').some((e) => e.predicate === 'TRUSTS'), 'story A retired it');
  assert.ok(b.graph.edgesFrom('char:a').some((e) => e.predicate === 'TRUSTS'), 'story B never touched it, still sees canon live');
  world.close();
});

test('threads, turns, and facts never cross between two stories in the same file', () => {
  const world = w();
  const b = world.withStory(createStory(world.db, { title: 'B' }).id);

  world.threads.create({ title: 'A thread', stakes: '', tension: 0.5, parties: [], resolutions: ['x', 'y'], status: 'open', createdScene: 1 });
  world.chronicle.addTurn({ scene: 1, turn: 1, rawInput: 'a input', intent: null, delta: null, bookProse: 'a prose', pinned: false, meta: blankMeta() });
  const fact = world.chronicle.addFact('a fact', 1);
  world.chronicle.setKnowledge(fact.id, 'char:a', 'knows', 1);

  assert.equal(world.threads.open().length, 1);
  assert.equal(b.threads.open().length, 0);

  assert.equal(world.chronicle.turns().length, 1);
  assert.equal(b.chronicle.turns().length, 0);

  assert.equal(world.chronicle.facts().length, 1);
  assert.equal(b.chronicle.facts().length, 0);
  world.close();
});

test('a story with no chronicle salience yet reads canon\'s baseline; another story\'s bump does not leak into it', () => {
  const world = w();
  world.graph.upsert({ id: 'char:x', type: 'Character', name: 'X', salience: 0.3 }, 'canon');
  const b = world.withStory(createStory(world.db, { title: 'B' }).id);

  world.graph.bumpSalience(['char:x'], 0.5);
  assert.equal(world.graph.get('char:x')?.salience, 0.8);
  assert.equal(b.graph.get('char:x')?.salience, 0.3, 'story B never touched it, unaffected by story A\'s bump');
  world.close();
});

test('World.open on a multi-story file without an explicit storyId refuses rather than guessing', () => {
  const world = w();
  createStory(world.db, { title: 'second' });
  const path = world.db;
  assert.throws(() => resolveDefaultStory(path), /2 stories/);
  world.close();
});

test('createStory records lineage when forked, and leaves it null for a fresh story', () => {
  const world = w();
  const fresh = createStory(world.db, { title: 'fresh' });
  assert.equal(fresh.forkedFrom, null);
  assert.equal(fresh.forkedAtScene, null);

  const forked = createStory(world.db, { title: 'forked', forkedFrom: world.storyId, forkedAtScene: 4 });
  assert.equal(forked.forkedFrom, world.storyId);
  assert.equal(forked.forkedAtScene, 4);
  world.close();
});

test('createStory leaves ownerUserId null unless a user is given', () => {
  const world = w();
  const noOwner = createStory(world.db, { title: 'no owner' });
  assert.equal(noOwner.ownerUserId, null);

  const owned = createStory(world.db, { title: 'owned', ownerUserId: 'user_abc' });
  assert.equal(owned.ownerUserId, 'user_abc');
  world.close();
});

test('listStoriesForUser only ever returns that user\u2019s own stories, never another\u2019s or an unowned one', () => {
  const world = w();
  // world.storyId's own auto-created story is unowned (created by w()'s setup, no user) — it must not leak into either user's list.
  createStory(world.db, { title: 'alice 1', ownerUserId: 'user_alice' });
  createStory(world.db, { title: 'alice 2', ownerUserId: 'user_alice' });
  createStory(world.db, { title: 'bob 1', ownerUserId: 'user_bob' });

  const aliceStories = listStoriesForUser(world.db, 'user_alice');
  assert.equal(aliceStories.length, 2);
  assert.ok(aliceStories.every((s) => s.ownerUserId === 'user_alice'));

  const bobStories = listStoriesForUser(world.db, 'user_bob');
  assert.equal(bobStories.length, 1);
  assert.equal(bobStories[0]?.title, 'bob 1');

  assert.deepEqual(listStoriesForUser(world.db, 'user_nobody'), []);
  world.close();
});

test('listStoriesForUser orders most recently played first, same as listStories', async () => {
  const world = w();
  const first = createStory(world.db, { title: 'first', ownerUserId: 'user_carol' });
  const second = createStory(world.db, { title: 'second', ownerUserId: 'user_carol' });
  // A real sleep, not just op-sequencing: `last_played_at`/`created_at` are
  // millisecond-resolution `toISOString()` (checked directly — two
  // createStory/session.set calls in quick succession land the same
  // millisecond often enough that this test flaked on ordering alone before
  // this existed), so without a genuine time gap the DESC ordering has no
  // deterministic tiebreaker to rely on.
  await new Promise((r) => setTimeout(r, 5));
  // Touch the first one's last_played_at so it sorts after the second despite being created earlier.
  world.withStory(first.id).session.set({ turn: 1 });

  const stories = listStoriesForUser(world.db, 'user_carol');
  assert.equal(stories[0]?.id, first.id, 'the one just played sorts first');
  assert.equal(stories[1]?.id, second.id);
  world.close();
});

test('resolveOrCreateStoryForUser creates on first call and returns the same story on repeat calls', () => {
  const world = w();
  const first = resolveOrCreateStoryForUser(world.db, 'user_dave');
  const second = resolveOrCreateStoryForUser(world.db, 'user_dave');
  assert.equal(first, second, 'no duplicate story created for a user who already has one');
  assert.equal(listStoriesForUser(world.db, 'user_dave').length, 1);
  world.close();
});

test('resolveOrCreateStoryForUser picks the most recently played when a user has several, rather than erroring', async () => {
  const world = w();
  const first = createStory(world.db, { title: 'first', ownerUserId: 'user_erin' });
  const second = createStory(world.db, { title: 'second', ownerUserId: 'user_erin' });
  // Explicit touch, not creation order — and a real sleep first, not just
  // op-sequencing: two createStory calls in quick succession can land the
  // same millisecond timestamp (checked directly — `new Date().toISOString()`
  // is millisecond-resolution and ties often enough in practice), so this
  // proves the *most recently played* rule specifically, the same way the
  // listStoriesForUser ordering test above does.
  await new Promise((r) => setTimeout(r, 5));
  world.withStory(first.id).session.set({ turn: 1 });

  // Unlike resolveDefaultStory (file-wide, throws on >1), this must not
  // throw: "a user has multiple stories" is the ordinary case here.
  const resolved = resolveOrCreateStoryForUser(world.db, 'user_erin');
  assert.equal(resolved, first.id, 'the one just played, even though it was created first');
  assert.notEqual(resolved, second.id);
  world.close();
});

test('resolveOrCreateStoryForUser never returns another user\u2019s story or an unowned one', () => {
  const world = w();
  createStory(world.db, { title: 'unowned' }); // no ownerUserId — must be invisible
  createStory(world.db, { title: 'frank\u2019s', ownerUserId: 'user_frank' });

  const resolved = resolveOrCreateStoryForUser(world.db, 'user_grace');
  const graceStory = getStory(world.db, resolved);
  assert.equal(graceStory?.ownerUserId, 'user_grace', 'a fresh story was created for grace, not borrowed from frank or the unowned one');
  world.close();
});

/**
 * Regression: `witnessedEvents` used `participants LIKE '%id%'`, a substring
 * match against the serialised JSON array, so any id the target was a prefix
 * of matched too. Ids are name-derived slugs, so related characters routinely
 * share stems and this fires in normal play rather than only in theory.
 */
test('witnessedEvents matches participants exactly, not as a substring', () => {
  const world = w();
  world.chronicle.addEvent({
    scene: 1,
    turn: 1,
    text: 'the elder speaks alone',
    participants: ['char:tem-the-elder'],
    locationId: null,
    significance: 0.5,
    visibility: 'onscreen',
    fromConsequenceId: null,
  });

  assert.equal(
    world.chronicle.witnessedEvents('char:tem').length,
    0,
    'char:tem did not witness an event whose only participant was char:tem-the-elder',
  );
  assert.equal(world.chronicle.witnessedEvents('char:tem-the-elder').length, 1, 'the actual participant still matches');
  world.close();
});

test('witnessedEvents finds a participant anywhere in the array, and respects visibility', () => {
  const world = w();
  const base = { locationId: null, significance: 0.5, fromConsequenceId: null } as const;
  world.chronicle.addEvent({
    ...base,
    scene: 1,
    turn: 1,
    text: 'three in the room',
    participants: ['char:a', 'char:tem', 'char:c'],
    visibility: 'onscreen',
  });
  world.chronicle.addEvent({
    ...base,
    scene: 2,
    turn: 1,
    text: 'plotted where nobody could see',
    participants: ['char:tem'],
    visibility: 'offscreen-hidden',
  });

  const seen = world.chronicle.witnessedEvents('char:tem');
  assert.equal(seen.length, 1, 'the hidden event is not witnessed');
  assert.equal(seen[0]?.text, 'three in the room', 'found mid-array, not only at the head');
  world.close();
});

/**
 * The WAL grows by appended page images per commit, so a long session rewrites
 * the same hot pages thousands of times and the sidecar can end up larger than
 * the database it fronts. `journal_size_limit` is what lets the space come back
 * after a checkpoint; the default of -1 reuses the file in place forever.
 */
test('the WAL stays bounded across many commits and truncates on checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-wal-'));
  const path = join(dir, 'w.db');
  try {
    const db = openDb(path);
    const limit = db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number };
    assert.equal(limit.journal_size_limit, 4194304, 'a limit is set, not left at -1');

    db.exec('CREATE TABLE wal_probe (x TEXT)');
    const insert = db.prepare('INSERT INTO wal_probe VALUES (?)');
    // Each run is its own implicit transaction, which is the shape that grows
    // the WAL fastest — one page image appended per commit.
    for (let i = 0; i < 3000; i++) insert.run('x'.repeat(400));

    const walSize = () => {
      try {
        return statSync(`${path}-wal`).size;
      } catch {
        return 0;
      }
    };
    assert.ok(
      walSize() <= 6 * 1024 * 1024,
      `wal should stay near the 4MB autocheckpoint threshold, was ${walSize()}`,
    );

    checkpoint(db);
    assert.equal(walSize(), 0, 'checkpoint(TRUNCATE) gives the space back');

    // The data survived the checkpoint — it was folded in, not discarded.
    const n = db.prepare('SELECT COUNT(*) n FROM wal_probe').get() as { n: number };
    assert.equal(n.n, 3000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint is a no-op rather than a throw on an in-memory database', () => {
  const world = w();
  assert.doesNotThrow(() => checkpoint(world.db), 'never in WAL mode, must not throw');
  world.close();
});

function emptyStoryIdentity() {
  return { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' };
}

function blankMeta() {
  return { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] };
}

// -------------------------------------------------- name resolution rigour

test('resolveName allows case, articles and disambiguators — and nothing else', () => {
  const world = w();
  world.graph.upsert({ id: 'loc:citadel', type: 'Location', name: 'The Citadel', summary: 'A station.' }, 'canon');
  world.graph.upsert({ id: 'char:shepard', type: 'Character', name: 'Shepard (Commander)' }, 'canon');

  assert.equal(world.graph.resolveName('The Citadel')?.id, 'loc:citadel', 'exact');
  assert.equal(world.graph.resolveName('the citadel')?.id, 'loc:citadel', 'case');
  assert.equal(world.graph.resolveName('Citadel')?.id, 'loc:citadel', 'a leading article is not a different referent');
  assert.equal(world.graph.resolveName('Shepard')?.id, 'char:shepard', 'nor is a wiki disambiguator');
  assert.equal(world.graph.resolveName('  Citadel  ')?.id, 'loc:citadel');

  // Anything looser must fail rather than pick the nearest-looking row: a
  // wrong edge is invisible, a missing one gets counted and reported.
  assert.equal(world.graph.resolveName('Citadel Council'), undefined, 'not a superstring');
  assert.equal(world.graph.resolveName('Cita'), undefined, 'not a prefix');
  assert.equal(world.graph.resolveName('A station.'), undefined, 'and never by summary text');
  assert.equal(world.graph.resolveName(''), undefined);
  world.close();
});

test('a synthetic event node can never be resolved as a referent by its sentence text', () => {
  const world = w();
  world.graph.upsert({ id: 'loc:mars', type: 'Location', name: 'Mars', salience: 0.2 }, 'canon');
  // Exactly what Pass B mints: name = first 70 chars of the event sentence,
  // summary = the whole sentence, and a salience high enough to have won the
  // old fuzzy top-hit contest against the real article.
  world.graph.upsert(
    {
      id: 'event:char:x:1',
      type: 'Event',
      name: 'Humans discovered a Prothean data cache on Mars in 2148',
      summary: 'Humans discovered a Prothean data cache on Mars in 2148',
      salience: 0.9,
    },
    'canon',
  );

  assert.equal(world.graph.resolveName('Mars')?.id, 'loc:mars', 'the place, not the sentence that mentions it');
  assert.equal(
    world.graph.resolveName('Prothean data cache'),
    undefined,
    'and a phrase out of an event sentence resolves to nothing at all',
  );

  // A real, page-derived event still works, because it has a real title.
  world.graph.upsert({ id: 'event:battle-of-the-citadel', type: 'Event', name: 'Battle of the Citadel' }, 'canon');
  assert.equal(world.graph.resolveName('Battle of the Citadel')?.id, 'event:battle-of-the-citadel');
  world.close();
});
