import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';

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
  for (let i = 0; i < 5; i++) world.graph.decaySalience(0.1);

  const hot = world.graph.get('char:hot')!.salience;
  const cold = world.graph.get('char:cold')!.salience;
  assert.ok(hot > cold, `touched entity stays hotter (${hot} > ${cold})`);
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
