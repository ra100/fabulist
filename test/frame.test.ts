import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicTokenizer, tokenizerFor } from '../src/frame/tokenizer.ts';
import { assembleFrame, inputBudget, Priority } from '../src/frame/budget.ts';
import { renderProps, renderSheet, thumbnail } from '../src/frame/builders.ts';
import type { CharacterSheet, Entity } from '../src/domain/types.ts';

const tk = new HeuristicTokenizer({ charsPerToken: 4 });

test('tokenizer over-estimates rather than under', () => {
  const prose = 'A plain sentence of ordinary English words, nothing unusual about it.';
  const naive = Math.ceil(prose.length / 4);
  assert.ok(tk.count(prose) >= naive, 'never under-counts vs the naive ratio');
});

test('symbol-dense JSON counts worse than flowing prose of equal length', () => {
  const json = '{"a":1,"b":[2,3],"c":{"d":"e"},"f":true,"g":null,"h":9.87}';
  const prose = 'x'.repeat(json.length);
  assert.ok(tk.count(json) > tk.count(prose), 'punctuation penalty applies');
});

test('truncate respects the budget and prefers a sentence boundary', () => {
  const text = 'First sentence here. Second sentence follows. Third one trails off after that.';
  const cut = tk.truncate(text, 8);
  assert.ok(tk.count(cut) <= 8, `fits budget, got ${tk.count(cut)}`);
  assert.ok(cut.length < text.length, 'actually truncated');
});

test('truncate is a no-op when the text already fits', () => {
  const text = 'short';
  assert.equal(tk.truncate(text, 1000), text);
});

test('frame under budget keeps every slot', () => {
  const frame = assembleFrame(
    [
      { name: 'a', priority: Priority.styleContract, content: 'style rules' },
      { name: 'b', priority: Priority.vectorFlavour, content: 'flavour text' },
    ],
    { budget: 1000, tokenizer: tk },
  );
  assert.equal(frame.log.evicted.length, 0);
  assert.equal(frame.slots.length, 2);
  assert.match(frame.text, /<a>/);
});

test('vector flavour is evicted before anything else', () => {
  const big = 'word '.repeat(400);
  const frame = assembleFrame(
    [
      { name: 'style-contract', priority: Priority.styleContract, content: big, evictable: false, compressible: false },
      { name: 'present-cast', priority: Priority.presentCast, content: big, evictable: false, compressible: false },
      { name: 'vector-flavour', priority: Priority.vectorFlavour, content: big, compressible: false },
    ],
    { budget: 300, tokenizer: tk },
  );
  assert.ok(frame.log.evicted.includes('vector-flavour'), 'garnish goes first');
  assert.ok(!frame.log.evicted.includes('style-contract'), 'style is protected');
  assert.ok(!frame.log.evicted.includes('present-cast'), 'present cast is protected');
});

test('compression is attempted before eviction', () => {
  const big = 'sentence here. '.repeat(200);
  const frame = assembleFrame(
    [
      { name: 'protected', priority: Priority.agreedBeat, content: 'beat', evictable: false },
      { name: 'summaries', priority: Priority.sceneSummaries, content: big, compressible: true },
    ],
    { budget: 200, tokenizer: tk },
  );
  assert.ok(frame.log.compressed.includes('summaries'), 'compressed rather than dropped');
  assert.ok(frame.slots.some((s) => s.name === 'summaries'), 'slot survives in reduced form');
});

test('protected slots survive even when that overruns the budget', () => {
  // Better to overrun visibly than to silently drop the agreed beat.
  const huge = 'x'.repeat(20_000);
  const frame = assembleFrame(
    [{ name: 'agreed-beat', priority: Priority.agreedBeat, content: huge, evictable: false, compressible: false }],
    { budget: 100, tokenizer: tk },
  );
  assert.equal(frame.log.evicted.length, 0);
  assert.ok(frame.log.used > 100, 'overrun is recorded in the log, not hidden');
});

test('per-slot cap applies regardless of remaining budget', () => {
  const frame = assembleFrame(
    [{ name: 'capped', priority: Priority.recentProse, content: 'word '.repeat(1000), maxTokens: 50 }],
    { budget: 100_000, tokenizer: tk },
  );
  assert.ok((frame.slots[0]?.tokens ?? 0) <= 50, 'hard cap honoured');
});

test('empty slots are dropped without appearing as evicted', () => {
  const frame = assembleFrame(
    [
      { name: 'has', priority: 50, content: 'content' },
      { name: 'empty', priority: 50, content: '   ' },
    ],
    { budget: 1000, tokenizer: tk },
  );
  assert.equal(frame.slots.length, 1);
  assert.equal(frame.log.evicted.length, 0);
});

test('frame log records every slot size for diagnosis', () => {
  const frame = assembleFrame(
    [
      { name: 'a', priority: 50, content: 'some content here' },
      { name: 'b', priority: 40, content: 'more content there' },
    ],
    { budget: 1000, tokenizer: tk },
  );
  assert.equal(frame.log.slots.length, 2);
  assert.ok(frame.log.slots.every((s) => s.tokens > 0));
  assert.equal(frame.log.used, frame.log.slots.reduce((n, s) => n + s.tokens, 0));
});

test('slots render highest priority first', () => {
  const frame = assembleFrame(
    [
      { name: 'low', priority: 10, content: 'low' },
      { name: 'high', priority: 120, content: 'high' },
    ],
    { budget: 1000, tokenizer: tk },
  );
  assert.ok(frame.text.indexOf('<high>') < frame.text.indexOf('<low>'));
});

test('input budget reserves room for output', () => {
  const b = inputBudget(64_000, 2_000, 0.9);
  assert.ok(b < 64_000 - 2_000, 'margin applied on top of the reservation');
  assert.ok(b > 40_000, `still usable at 64k, got ${b}`);
});

test('a full 64k narrator budget stays inside the window', () => {
  const budget = inputBudget(64_000, 2_048);
  const t = tokenizerFor(4);
  const frame = assembleFrame(
    [
      { name: 'style-contract', priority: Priority.styleContract, content: 'pov: first\n'.repeat(20), evictable: false },
      { name: 'present-cast', priority: Priority.presentCast, content: 'sheet line\n'.repeat(2000), evictable: false, maxTokens: 2600 },
      { name: 'recent-prose', priority: Priority.recentProse, content: 'prose. '.repeat(5000), maxTokens: 2200 },
      { name: 'cast-thumbnails', priority: Priority.castThumbnails, content: 'thumb\n'.repeat(3000), maxTokens: 500 },
    ],
    { budget, tokenizer: t },
  );
  assert.ok(frame.log.used <= budget, `${frame.log.used} <= ${budget}`);
});

// ------------------------------------------------------------- props rendering
// Pass A writes every infobox field onto `entity.props`, but nothing in
// `src/frame/` read it: species, status, affiliation and the rest were
// extracted, stored, and never shown to the model. These assert both that the
// whitelist reaches a frame and that it stays a whitelist.

function entity(props: Record<string, unknown>): Entity {
  return {
    id: 'char:ilsa',
    type: 'Character',
    layer: 'canon',
    name: 'Ilsa Crowe',
    summary: 'Warden of Duskhollow.',
    provenance: 'wiki:Warden_Ilsa_Crowe',
    confidence: 1,
    salience: 0.8,
    depthLevel: 2,
    props,
    createdScene: 0,
  };
}

test('renderProps surfaces whitelisted infobox fields in a stable order', () => {
  // Deliberately out of whitelist order in the source object: render order must
  // follow the whitelist, not insertion, or the frame reshuffles between turns.
  const out = renderProps(entity({ affiliation: 'Wardens of the Vale', species: 'Human', status: 'Alive' }));
  assert.equal(out, 'species: Human | status: Alive | affiliation: Wardens of the Vale');
});

test('renderProps drops keys that are noise rather than world fact', () => {
  const out = renderProps(
    entity({
      species: 'Human',
      image: 'Ilsa_Crowe_portrait.png',
      appearances: '47',
      voice: 'Some Actor',
      first: 'Episode 1',
      categories: ['Characters', 'Wardens'],
      infoboxTemplate: 'Infobox character',
    }),
  );
  assert.equal(out, 'species: Human', 'only the whitelisted key survives');
  assert.doesNotMatch(out, /png|Actor|Episode|Infobox/, 'no production trivia leaks in as in-world fact');
});

test('renderProps ignores non-scalar values instead of stringifying them', () => {
  // `props.categories` is an array and other wikis nest objects; both would
  // render as "[object Object]" or a comma soup if passed through blindly.
  assert.equal(renderProps(entity({ status: { alive: true }, species: ['Human'], rank: 'Warden' })), 'rank: Warden');
});

test('renderProps clips a long value and bounds the key count', () => {
  const long = renderProps(entity({ relatives: 'Bram the Lesser (brother); '.repeat(20) }));
  assert.ok(long.length < 160, `one runaway field cannot eat the slot, got ${long.length}`);
  assert.ok(long.endsWith('…'), 'the cut is marked');

  const many = renderProps(
    entity({
      species: 'Human', gender: 'Female', age: '34', born: '412 AV', status: 'Alive',
      occupation: 'Warden', title: 'Warden of Duskhollow', rank: 'Captain',
      affiliation: 'Wardens', leader: 'herself', region: 'The Vale',
    }),
    3,
  );
  assert.equal(many.split(' | ').length, 3, 'maxKeys is honoured');
});

test('thumbnail carries a two-key slice, so an offstage name is still legible', () => {
  const t = thumbnail(entity({ species: 'Human', status: 'Alive', affiliation: 'Wardens of the Vale' }));
  assert.match(t, /^id=char:ilsa name=Ilsa Crowe \(Character\)/, 'the existing shape is unchanged');
  assert.match(t, /\[species: Human \| status: Alive\]$/, 'plus a bounded props slice');
  assert.doesNotMatch(t, /affiliation/, 'a thumbnail stays a thumbnail');
});

test('thumbnail is unchanged when an entity has no whitelisted props', () => {
  const t = thumbnail(entity({}));
  assert.equal(t, 'id=char:ilsa name=Ilsa Crowe (Character) — Warden of Duskhollow.', 'no empty brackets');
});

test('renderSheet places canon attributes above the authored sheet', () => {
  const sheet: CharacterSheet = {
    entityId: 'char:ilsa',
    identity: { goals: ['keep the bridge open'], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
    contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: 'terse', tics: [], samples: [], never: [] },
    condition: { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: false,
  };
  const lines = renderSheet(entity({ species: 'Human', status: 'Alive' }), sheet).split('\n');
  assert.equal(lines[0], 'id=char:ilsa name=Ilsa Crowe');
  assert.equal(lines[1], 'summary: Warden of Duskhollow.');
  assert.equal(lines[2], 'species: Human | status: Alive', 'canon fact before authored goals');
  assert.equal(lines[3], 'goals: keep the bridge open');
});

test('renderSheet does not repeat props that pass A already mirrored onto the sheet', () => {
  // Pass A copies infobox `affiliation` into identity.allegiances and
  // `occupation` into competencies, so rendering both prints each fact twice.
  const sheet: CharacterSheet = {
    entityId: 'char:ilsa',
    identity: { goals: [], wounds: [], fears: [], allegiances: ['Wardens of the Vale'], competencies: ['Warden'], secrets: [], arc: '' },
    contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: '', tics: [], samples: [], never: [] },
    condition: { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: false,
  };
  const out = renderSheet(entity({ species: 'Human', affiliation: 'Wardens of the Vale', occupation: 'Warden' }), sheet);

  // Assert on the rendered lines rather than raw substring counts: "Warden" is
  // a substring of "Wardens of the Vale", so counting occurrences measures the
  // regex more than the behaviour.
  const lines = out.split('\n');
  assert.deepEqual(lines, [
    'id=char:ilsa name=Ilsa Crowe',
    'summary: Warden of Duskhollow.',
    'species: Human',
    'allegiances: Wardens of the Vale',
    'competencies: Warden',
  ]);
  assert.ok(!lines.some((l) => l.startsWith('species: Human | affiliation')), 'no props line repeating the sheet');

  // But a thumbnail has no sheet beside it, so there affiliation must survive.
  assert.match(thumbnail(entity({ affiliation: 'Wardens of the Vale' })), /affiliation/);
});
