import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { createStory, resolveDefaultStory } from '../src/store/world.ts';

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

function emptyStoryIdentity() {
  return { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' };
}

function blankMeta() {
  return { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] };
}
