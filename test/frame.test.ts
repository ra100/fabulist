import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicTokenizer, tokenizerFor } from '../src/frame/tokenizer.ts';
import { assembleFrame, inputBudget, Priority } from '../src/frame/budget.ts';

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
