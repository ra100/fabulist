import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { coerceDelta, validateDelta } from '../src/loop/validate.ts';
import { extractJson } from '../src/providers/provider.ts';

function setup(providerOpts = {}) {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider(providerOpts);
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  return { world, mock, engine };
}

// ------------------------------------------------------------------ plumbing

test('extractJson tolerates fences, preamble and trailing commentary', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! Here you go:\n{"a":3}\nHope that helps.'), { a: 3 });
  assert.deepEqual(extractJson('{"s":"a } brace in a string"}'), { s: 'a } brace in a string' });
  assert.throws(() => extractJson('no json at all'));
});

// ----------------------------------------------------------------- the loop

test('a plain turn narrates, extracts a delta, and commits an event', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i warm the ink and keep copying');
  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;

  assert.ok(out.prose.length > 0, 'produced prose');
  assert.ok(out.delta.events.length > 0, 'prose without a delta would be drift');
  assert.equal(out.commit.events.length, out.delta.events.length);
  assert.equal(world.chronicle.events().length, 1);
  world.close();
});

test('every role that ran is logged with its token counts', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i keep copying');
  if (out.kind !== 'narrated') throw new Error('expected narration');
  const roles = out.turn.meta.providerCalls.map((c) => c.role);
  assert.ok(roles.includes('classify'));
  assert.ok(roles.includes('referee'));
  assert.ok(roles.includes('director'));
  assert.ok(roles.includes('narrate'));
  assert.ok(roles.includes('extract'));
  assert.ok(out.turn.meta.providerCalls.every((c) => c.tokensIn > 0));
  world.close();
});

test('the gm move that fired is recorded for the why panel', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i wait for the captain');
  if (out.kind !== 'narrated') throw new Error('expected narration');
  assert.ok(out.turn.meta.move, 'a move from the fixed library fired');
  assert.ok(out.turn.meta.referee, 'referee verdict retained');
  world.close();
});

// ------------------------------------------------------- the integrity gate

test('the integrity gate interrupts a vow breach instead of narrating it', async () => {
  const { world, engine } = setup();
  // Anselm has held nonviolence for thirty years; nothing here threatens him.
  const out = await engine.takeTurn('i stab the captain');
  assert.equal(out.kind, 'interrupted');
  if (out.kind !== 'interrupted') return;

  assert.equal(out.distance, 'contract-breach');
  assert.match(out.interrupt.message, /harm no living thing/i, 'names the vow it is defending');
  assert.equal(world.chronicle.events().length, 0, 'nothing was committed');
  assert.equal(world.chronicle.turns().length, 0, 'no turn was recorded');
  world.close();
});

test('the interrupt always offers a deliberate override', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i stab the captain');
  if (out.kind !== 'interrupted') throw new Error('expected interrupt');
  const effects = out.interrupt.options.map((o) => o.effect);
  assert.ok(effects.includes('override'), 'an author must be able to break their own character');
  assert.ok(effects.includes('establish-break'));
  assert.ok(effects.includes('revise'));
  world.close();
});

test('chaos-for-its-own-sake reads as incoherent, not merely a breach', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i stab the captain just because, for the lols');
  if (out.kind !== 'interrupted') throw new Error('expected interrupt');
  assert.equal(out.distance, 'incoherent');
  assert.match(out.interrupt.message, /does not read like/i);
  world.close();
});

test('override commits the break, spawns a thread, and logs a divergence', async () => {
  const { world, engine } = setup();
  const blocked = await engine.takeTurn('i stab the captain');
  assert.equal(blocked.kind, 'interrupted');

  const out = await engine.takeTurn('i stab the captain', { overrideIntegrity: true });
  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;

  assert.equal(out.commit.brokenVows.length, 1, 'the vow break was recorded');
  assert.equal(out.commit.brokenVows[0]?.vowId, 'nonviolence');

  const sheet = world.cast.get('char:brother-anselm')!;
  const vow = sheet.contract.vows.find((v) => v.id === 'nonviolence')!;
  assert.equal(vow.broken, true);
  assert.equal(vow.brokenScene, 1);

  // The break is the story, so it must become a high-tension thread.
  const threads = world.threads.all();
  const vowThread = threads.find((t) => /broke a vow/i.test(t.title));
  assert.ok(vowThread, 'a vow break spawns its own thread');
  assert.ok((vowThread?.tension ?? 0) >= 0.8, 'and it is the most pressing thing in the story');
  assert.ok(vowThread!.resolutions.length > 1);

  assert.ok(
    world.chronicle.divergences().some((d) => d.kind === 'vow-break'),
    'the ledger records the departure from who this character was',
  );
  world.close();
});

test('a non-violent action passes the gate untouched', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i talk him down and mention his sister');
  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;
  assert.equal(out.turn.meta.integrity?.distance, 'in-character');
  world.close();
});

test('permissive strictness disables the gate entirely', async () => {
  const { world, engine } = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, characterStrictness: 'permissive' } });
  const out = await engine.takeTurn('i stab the captain');
  assert.equal(out.kind, 'narrated', 'permissive narrates anything');
  world.close();
});

test('coaching strictness never interrupts even on a breach', async () => {
  const { world, engine } = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, characterStrictness: 'coaching' } });
  const out = await engine.takeTurn('i stab the captain');
  assert.equal(out.kind, 'narrated', 'coaching relies on in-fiction resistance instead');
  world.close();
});

test('a character with no vows is never gated', async () => {
  const world = World.open(':memory:');
  seedWorld(world, { playerCharacterId: 'char:sister-oria' });
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const out = await engine.takeTurn('i stab the sergeant');
  assert.equal(out.kind, 'narrated', 'no contract means nothing to defend');
  world.close();
});

// ---------------------------------------------------------------- referee

test('referencing a place that does not exist canonises it rather than refusing', async () => {
  const { world, engine } = setup();
  const before = world.graph.counts().entities;
  const out = await engine.takeTurn('i go down to the tavern by the gate');
  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;

  assert.equal(out.turn.meta.referee?.ruling, 'allow', 'default is permissive');
  assert.ok(world.graph.counts().entities > before, 'the place now exists');
  const spawned = world.graph.search('tavern', 5);
  assert.ok(spawned.length > 0);
  assert.match(spawned[0]!.provenance, /^emergent:/, 'marked as emergent, not canon');
  world.close();
});

test('the impossible gets in-fiction friction, not a refusal', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('i teleport to the mountain pass');
  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;
  assert.equal(out.turn.meta.referee?.ruling, 'friction');
  assert.ok(out.turn.meta.referee?.cost, 'the world supplies a reason it failed');
  world.close();
});

// ------------------------------------------------------------- meta queries

test('a world question is answered from state without advancing the story', async () => {
  const { world, engine } = setup();
  const out = await engine.takeTurn('who is captain sered?');
  assert.equal(out.kind, 'answered');
  if (out.kind !== 'answered') return;
  assert.match(out.text, /Sered/);
  assert.equal(world.chronicle.turns().length, 0, 'no turn consumed');
  world.close();
});

// ---------------------------------------------------------------- validation

test('coerceDelta flags a narrated turn that recorded no events', () => {
  const { delta, issues } = coerceDelta({ events: [], sceneAdvance: false });
  assert.equal(delta.events.length, 0);
  const blocking = issues.filter((i) => !i.repaired);
  assert.equal(blocking.length, 1, 'prose with no delta is exactly the drift to catch');
  assert.match(blocking[0]!.message, /no events/);
});

test('coerceDelta survives entirely malformed input', () => {
  for (const bad of [null, 'text', 42, []]) {
    const { delta } = coerceDelta(bad);
    assert.equal(delta.events.length, 0, 'never throws, always returns a delta');
  }
});

test('unknown entity references are resolved by name where possible', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta } = coerceDelta({
    events: [{ text: 'they spoke', participants: ['Brother Anselm'], significance: 0.5 }],
    sceneAdvance: false,
  });
  const res = validateDelta(world, delta);
  assert.deepEqual(delta.events[0]?.participants, ['char:brother-anselm'], 'prose name mapped to id');
  assert.ok(res.issues.some((i) => i.tier === 'referential' && i.repaired));
  world.close();
});

test('unresolvable entity references are dropped rather than left dangling', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta } = coerceDelta({
    events: [{ text: 'x', participants: ['char:nobody-at-all'], significance: 0.5 }],
    edgeAsserts: [{ subject: 'char:nobody-at-all', predicate: 'KNOWS', object: 'char:brother-anselm' }],
    sceneAdvance: false,
  });
  validateDelta(world, delta);
  assert.equal(delta.events[0]?.participants.length, 0, 'a dangling edge makes the referee confidently wrong later');
  assert.equal(delta.edgeAsserts.length, 0);
  world.close();
});

test('retiring an edge that was never asserted is a semantic issue', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta } = coerceDelta({
    events: [{ text: 'x', participants: [], significance: 0.5 }],
    edgeRetires: [{ subject: 'char:brother-anselm', predicate: 'MARRIED_TO', object: 'char:sister-oria' }],
    sceneAdvance: false,
  });
  const res = validateDelta(world, delta);
  assert.ok(res.issues.some((i) => i.tier === 'semantic' && /no live edge/.test(i.message)));
  assert.equal(delta.edgeRetires.length, 0);
  world.close();
});

test('a vow break naming a vow the character does not hold is rejected', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta } = coerceDelta({
    events: [{ text: 'x', participants: [], significance: 0.5 }],
    vowBreaks: [{ entityId: 'char:brother-anselm', vowId: 'celibacy' }],
    sceneAdvance: false,
  });
  const res = validateDelta(world, delta);
  assert.equal(delta.vowBreaks.length, 0);
  assert.ok(res.issues.some((i) => i.tier === 'semantic' && /holds no vow/.test(i.message)));
  world.close();
});

test('acting on a dead character is surfaced as blocking, not repaired', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  world.graph.upsert(
    { id: 'char:sergeant-doff', type: 'Character', name: 'Sergeant Doff', props: { status: 'dead' } },
    'chronicle',
  );
  const { delta } = coerceDelta({
    events: [{ text: 'Doff argues', participants: ['char:sergeant-doff'], significance: 0.5 }],
    sceneAdvance: false,
  });
  const res = validateDelta(world, delta);
  assert.equal(res.ok, false, 'the loop must not quietly commit this');
  assert.ok(res.issues.some((i) => i.tier === 'semantic' && /recorded dead/.test(i.message)));
  world.close();
});

// ------------------------------------------------------------ provider tiers

test('a provider with no schema support still yields a committable delta', async () => {
  const { world, engine } = setup({ capabilities: { structuredOutput: 'none', systemRole: false } });
  const out = await engine.takeTurn('i keep copying and say nothing');
  assert.equal(out.kind, 'narrated', 'the degradation path holds');
  world.close();
});

test('a small context window still produces a turn', async () => {
  const { world, engine } = setup({ capabilities: { contextWindow: 8_000 } });
  const out = await engine.takeTurn('i keep copying');
  assert.equal(out.kind, 'narrated');
  world.close();
});

test('the 64k floor leaves the narrator frame inside budget', async () => {
  const { world, engine, mock } = setup({ capabilities: { contextWindow: 64_000 } });
  await engine.takeTurn('i keep copying');
  const narrateCall = mock.calls.find((c) => c.role === 'narrate')!;
  // 64k window, ~2k reserved for output, 4 chars/token: comfortably inside.
  assert.ok(narrateCall.chars / 4 < 60_000, `narrator frame fits: ~${Math.round(narrateCall.chars / 4)} tokens`);
  world.close();
});

// ------------------------------------------------------------------ registers

test('shorthand input is kept verbatim while the book gets worked prose', async () => {
  const { world, engine } = setup();
  const raw = 'i try to talk him down, mention his sister, dont draw';
  const out = await engine.takeTurn(raw);
  if (out.kind !== 'narrated') throw new Error('expected narration');
  assert.equal(out.turn.rawInput, raw, 'the record of intent survives exactly');
  assert.notEqual(out.turn.bookProse, raw, 'the book reads differently from the note');
  assert.ok(out.turn.intent, 'the parsed intent is retained too');
  world.close();
});

test('polished prose is flagged verbatim so it survives into the book', async () => {
  const { world, engine } = setup();
  const polished =
    'He set the quire down, squared it against the edge of the desk, and considered how much of the truth would fit in one sentence.';
  const out = await engine.takeTurn(polished);
  if (out.kind !== 'narrated') throw new Error('expected narration');
  assert.equal(out.turn.intent?.verbatim, true, 'finished prose is not paraphrased away');
  world.close();
});

// ------------------------------------------------------------------- salience

test('entities touched this turn end hotter than untouched ones', async () => {
  const { world, engine } = setup();
  const coldBefore = world.graph.get('char:hela-vask')!.salience;
  await engine.takeTurn('i speak with novice tem about the psalter');
  const player = world.graph.get('char:brother-anselm')!.salience;
  const cold = world.graph.get('char:hela-vask')!.salience;
  assert.ok(player > cold, 'the frame will not fill with people who left');
  assert.ok(cold <= coldBefore, 'untouched entities cool');
  world.close();
});

// --------------------------------------------------------------- consistency

test('a twenty-turn session stays consistent and records every turn', async () => {
  const { world, engine } = setup();
  const inputs = [
    'i warm the ink', 'i check the door', 'i tell tem to fetch water',
    'i hide the psalter under the loose flag', 'i go down to the lower cells',
    'i listen at the stair', 'i return to the desk', 'i keep copying',
    'i greet the captain politely', 'i offer him the ledger instead',
    'i ask about his sister', 'i mention the winter stores',
    'i walk him to the yard', 'i speak with oria about the herbs',
    'i send tem away for the afternoon', 'i meet hela at the mill',
    'i pay her in silver', 'i come back before vespers',
    'i write nothing down', 'i sleep badly',
  ];
  for (const input of inputs) {
    const out = await engine.takeTurn(input);
    assert.equal(out.kind, 'narrated', `turn failed: ${input}`);
  }
  assert.equal(world.chronicle.turns().length, 20);
  assert.equal(world.session.get().turn, 20);
  assert.ok(world.chronicle.events().length >= 20);
  world.close();
});
