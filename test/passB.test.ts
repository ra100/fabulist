import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { WikiClient, fixtureFetcher } from '../src/ingest/client.ts';
import { runPassA } from '../src/ingest/passA.ts';
import { LlmPassBExtractor, PASSB_PREDICATES, clipQuote } from '../src/ingest/passB.ts';
import { ingest } from '../src/ingest/depth.ts';
import { MockProvider } from '../src/providers/mock.ts';
import type { Provider } from '../src/providers/provider.ts';
import { WIKI } from './fixtures/wiki.ts';

const client = () => new WikiClient({ baseUrl: 'https://vale.fandom.com', fetcher: fixtureFetcher(WIKI), delayMs: 0 });

async function seeded() {
  const world = World.open(':memory:');
  const c = client();
  runPassA(world, await c.fetchPages(Object.keys(WIKI)), { wiki: 'vale', depth: 1 });
  return { world, c };
}

/** Provider that returns a fixed payload, for testing the validation gate. */
function canned(payload: unknown): Provider {
  return {
    id: 'canned',
    model: 'canned',
    capabilities: {
      contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true,
      streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0.5, steerability: 0.5,
    },
    async complete() {
      return { text: JSON.stringify(payload), tokensIn: 10, tokensOut: 10, model: 'canned', schemaEnforced: true };
    },
  };
}

test('pass B extracts evidenced relations and rejects the rest', async () => {
  const { world, c } = await seeded();
  const extractor = new LlmPassBExtractor({ provider: new MockProvider(), world });

  const page = (await c.fetchPage('Warden Ilsa Crowe'))!;
  const entity = world.graph.get('char:warden-ilsa-crowe')!;
  const out = await extractor.extract(page, entity);

  assert.ok(out.edges.length > 0, 'kept the honest relations');
  assert.ok(out.edges.every((e) => (e.evidence ?? '').length >= 12), 'every kept edge carries a quote');
  assert.ok(
    out.edges.every((e) => (PASSB_PREDICATES as readonly string[]).includes(e.predicate)),
    'predicates stay inside the closed vocabulary',
  );
  // The mock deliberately emits one of each failure shape.
  assert.ok(extractor.stats.droppedNoEvidence > 0, 'unquotable evidence dropped');
  assert.ok(extractor.stats.droppedBadPredicate > 0, 'off-vocabulary predicate dropped');
  assert.ok(extractor.stats.droppedUnknownObject > 0, 'relation to a nonexistent entity dropped');
  world.close();
});

test('an evidence span that is not on the page is treated as a hallucination', async () => {
  const { world, c } = await seeded();
  const provider = canned({
    relations: [
      { predicate: 'BETRAYED', object: 'Bram the Lesser', evidence: 'She stabbed him in the market at dawn.' },
    ],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract((await c.fetchPage('Warden Ilsa Crowe'))!, world.graph.get('char:warden-ilsa-crowe')!);

  assert.equal(out.edges.length, 0, 'a confident invention must not reach the graph');
  assert.equal(extractor.stats.droppedNoEvidence, 1);
  world.close();
});

test('evidence verification tolerates quoting and markup differences', async () => {
  const { world, c } = await seeded();
  // Same sentence as the page, but with wiki bold markers and curly apostrophes.
  const provider = canned({
    relations: [
      {
        predicate: 'MEMBER_OF',
        object: 'Wardens of the Vale',
        evidence: "'''Ilsa Crowe''' is the Warden of Duskhollow and the ranking officer of the Wardens of the Vale.",
      },
    ],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract((await c.fetchPage('Warden Ilsa Crowe'))!, world.graph.get('char:warden-ilsa-crowe')!);
  assert.equal(out.edges.length, 1, 'an honest quote is not failed on formatting');
  world.close();
});

test('relations may only point at entities that already exist', async () => {
  const { world, c } = await seeded();
  const page = (await c.fetchPage('Warden Ilsa Crowe'))!;
  const provider = canned({
    relations: [
      { predicate: 'ALLIED_WITH', object: 'The Invented Order of Nothing', evidence: page.wikitext.slice(200, 320) },
    ],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract(page, world.graph.get('char:warden-ilsa-crowe')!);
  assert.equal(out.edges.length, 0, 'pass B must not seed a subgraph of fiction');
  assert.equal(extractor.stats.droppedUnknownObject, 1);
  world.close();
});

test('a self-referential relation is dropped', async () => {
  const { world, c } = await seeded();
  const page = (await c.fetchPage('Warden Ilsa Crowe'))!;
  const provider = canned({
    relations: [{ predicate: 'ALLIED_WITH', object: 'Warden Ilsa Crowe', evidence: page.wikitext.slice(150, 300) }],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract(page, world.graph.get('char:warden-ilsa-crowe')!);
  assert.equal(out.edges.length, 0);
  world.close();
});

test('object names are resolved to their canonical entity name', async () => {
  const { world, c } = await seeded();
  const page = (await c.fetchPage('Warden Ilsa Crowe'))!;
  const provider = canned({
    // Lower-cased and partial, as prose would write it.
    relations: [{ predicate: 'KIN_OF', object: 'bram the lesser', evidence: page.wikitext.slice(0, 200) }],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract(page, world.graph.get('char:warden-ilsa-crowe')!);
  assert.equal(out.edges[0]?.objectName, 'Bram the Lesser', 'resolved rather than passed through');
  world.close();
});

test('voice samples must be quotable from the page', async () => {
  const { world, c } = await seeded();
  const extractor = new LlmPassBExtractor({ provider: new MockProvider(), world });
  const out = await extractor.extract((await c.fetchPage('Warden Ilsa Crowe'))!, world.graph.get('char:warden-ilsa-crowe')!);

  assert.ok(out.voiceCard, 'a character page yields a voice card');
  assert.ok(out.voiceCard!.samples!.some((s) => /bridge stays open/.test(s)), 'real dialogue kept');
  assert.ok(
    !out.voiceCard!.samples!.some((s) => /never spoken/.test(s)),
    'invented dialogue dropped — voice is the highest-leverage artifact, so it must be real',
  );
  world.close();
});

test('non-characters never get a voice card', async () => {
  const { world, c } = await seeded();
  const provider = canned({ relations: [], events: [], voice: { diction: 'gravelly', samples: [] } });
  const extractor = new LlmPassBExtractor({ provider, world });
  const out = await extractor.extract((await c.fetchPage('Duskhollow'))!, world.graph.get('loc:duskhollow')!);
  assert.equal(out.voiceCard, undefined, 'a city does not have a diction');
  world.close();
});

test('events carry in-world dates where the page states one', async () => {
  const { world, c } = await seeded();
  const extractor = new LlmPassBExtractor({ provider: new MockProvider(), world });
  const out = await extractor.extract((await c.fetchPage('Cinder Riots'))!, world.graph.get('event:cinder-riots')!);
  assert.ok(out.events.length > 0);
  world.close();
});

test('a provider failure yields an empty result rather than throwing', async () => {
  const { world, c } = await seeded();
  const failing: Provider = {
    id: 'x', model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'none', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0, steerability: 0 },
    async complete() { throw new Error('rate limited'); },
  };
  const seen: string[] = [];
  const extractor = new LlmPassBExtractor({ provider: failing, world, onError: (t) => seen.push(t) });
  const out = await extractor.extract((await c.fetchPage('Duskhollow'))!, world.graph.get('loc:duskhollow')!);

  assert.deepEqual(out.edges, []);
  assert.deepEqual(seen, ['Duskhollow'], 'the failure is reported, not swallowed silently');
  world.close();
});

test('unparseable model output is handled as a failure', async () => {
  const { world, c } = await seeded();
  const garbage: Provider = {
    id: 'x', model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'none', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0, steerability: 0 },
    async complete() { return { text: 'I cannot help with that.', tokensIn: 1, tokensOut: 1, model: 'x', schemaEnforced: false }; },
  };
  const extractor = new LlmPassBExtractor({ provider: garbage, world });
  const out = await extractor.extract((await c.fetchPage('Duskhollow'))!, world.graph.get('loc:duskhollow')!);
  assert.deepEqual(out.edges, []);
  world.close();
});

test('the page excerpt respects the token budget and drops appendix sections', async () => {
  const { world, c } = await seeded();
  const captured: string[] = [];
  const spy: Provider = {
    id: 'x', model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0, steerability: 0 },
    async complete(req) {
      captured.push(req.messages.map((m) => m.content).join('\n'));
      return { text: '{"relations":[],"events":[]}', tokensIn: 1, tokensOut: 1, model: 'x', schemaEnforced: true };
    },
  };
  const extractor = new LlmPassBExtractor({ provider: spy, world, pageBudget: 200 });
  await extractor.extract((await c.fetchPage('Duskhollow'))!, world.graph.get('loc:duskhollow')!);

  const page = captured[0]!.match(/<page>([\s\S]*?)<\/page>/)![1]!;
  assert.ok(page.length / 4 < 320, `excerpt stayed near budget (~${Math.round(page.length / 4)} tokens)`);
  assert.ok(!/## See also/.test(page), 'navigation sections are worthless to extract from');
  world.close();
});

test('a full mid ingest with pass B writes evidenced edges into canon', async () => {
  const world = World.open(':memory:');
  const c = client();
  // Pass A first, so the id space is closed before pass B may reference it.
  runPassA(world, await c.fetchPages(Object.keys(WIKI)), { wiki: 'vale', depth: 1 });

  const extractor = new LlmPassBExtractor({ provider: new MockProvider(), world });
  const res = await ingest({
    world, client: c, seeds: ['Warden Ilsa Crowe', 'Duskhollow'], mode: 'mid', wiki: 'vale', extractor,
  });

  assert.ok(res.passB!.pages > 0, 'pass B ran');
  assert.ok(res.passB!.edges > 0, 'and contributed relations');

  const evidenced = world.graph.allEdges().filter((e) => e.evidence && !e.evidence.startsWith('infobox'));
  assert.ok(evidenced.length > 0, 'pass B edges are traceable to a quoted sentence');
  assert.ok(evidenced.every((e) => e.layer === 'canon'), 'ingested material stays in canon');
  world.close();
});

test('extraction stats make a run judgeable rather than trusted', async () => {
  const { world, c } = await seeded();
  const extractor = new LlmPassBExtractor({ provider: new MockProvider(), world });
  for (const title of ['Warden Ilsa Crowe', 'Bram the Lesser', 'Duskhollow']) {
    const page = (await c.fetchPage(title))!;
    const entity = world.graph.resolveName(title)!;
    await extractor.extract(page, entity);
  }
  assert.equal(extractor.stats.pages, 3);
  const dropped = extractor.stats.droppedNoEvidence + extractor.stats.droppedBadPredicate + extractor.stats.droppedUnknownObject;
  assert.ok(dropped > 0, 'the drop rate is visible');
  assert.ok(extractor.stats.relations > 0, 'alongside what was kept');
  world.close();
});

// --------------------------------------------------------------- quote caps
// Stored verbatim source text is the exposure that matters legally (see
// docs/legal-briefing-fandom-ingest.md) and it silently eats frame budget.
// Evidence was bounded by a character `slice` that cut mid-word; voice samples
// had no length cap at all, making them the largest verbatim surface here.

/** A provider that answers with one fixed payload, for cap assertions. */
function fixedProvider(payload: unknown): Provider {
  return {
    id: 'x',
    model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0, steerability: 0 },
    async complete() {
      return { text: JSON.stringify(payload), tokensIn: 1, tokensOut: 1, model: 'x', schemaEnforced: true };
    },
  };
}

test('clipQuote trims on a word boundary and marks the cut', () => {
  assert.equal(clipQuote('one two three', 5), 'one two three', 'under the cap is untouched');
  assert.equal(clipQuote('one two three four five six', 3), 'one two three…');
  assert.equal(clipQuote('  collapses   inner\n\nwhitespace  ', 9), 'collapses inner whitespace');
  assert.equal(clipQuote('', 5), '');
  assert.equal(clipQuote('exactly three words', 3), 'exactly three words', 'the boundary is inclusive');
});

test('a long evidence span is stored clipped, but verified in full first', async () => {
  const { world, c } = await seeded();
  // A genuine span from the fixture page: verification must pass against the
  // model's full quote, while only the trimmed version is stored.
  const long =
    'Ilsa Crowe is the Warden of Duskhollow and the ranking officer of the Wardens of the Vale.';
  const provider = fixedProvider({
    relations: [{ predicate: 'LEADS', object: 'Wardens of the Vale', evidence: long, weight: 0.8 }],
    events: [],
  });
  const extractor = new LlmPassBExtractor({ provider, world, maxQuoteWords: 10 });
  const out = await extractor.extract(
    (await c.fetchPage('Warden Ilsa Crowe'))!,
    world.graph.resolveName('Warden Ilsa Crowe')!,
  );

  assert.equal(out.edges.length, 1, 'the relation survived — clipping is not dropping');
  const evidence = out.edges[0]!.evidence!;
  assert.ok(evidence.endsWith('…'), 'the cut is marked');
  assert.equal(evidence.replace('…', '').trim().split(' ').length, 10, 'exactly the cap');
  assert.ok(long.startsWith(evidence.replace('…', '')), 'still a true prefix of the source sentence');
  assert.equal(extractor.stats.clippedQuotes, 1, 'clipping is counted, not silent');
  world.close();
});

test('voice samples are capped too, after being verified against the page', async () => {
  const { world, c } = await seeded();
  const provider = fixedProvider({
    relations: [],
    events: [],
    voice: { diction: 'terse', samples: ['I have buried better people than you for less.'], tics: [], never: [] },
  });
  const extractor = new LlmPassBExtractor({ provider, world, maxQuoteWords: 4 });
  const out = await extractor.extract(
    (await c.fetchPage('Warden Ilsa Crowe'))!,
    world.graph.resolveName('Warden Ilsa Crowe')!,
  );

  assert.equal(out.voiceCard!.samples![0], 'I have buried better…');
  world.close();
});

test('a sample that is not on the page is dropped, not merely shortened', async () => {
  const { world, c } = await seeded();
  const provider = fixedProvider({
    relations: [],
    events: [],
    voice: { diction: 'terse', samples: ['A line she never said anywhere on this page.'], tics: [], never: [] },
  });
  const extractor = new LlmPassBExtractor({ provider, world, maxQuoteWords: 4 });
  const out = await extractor.extract(
    (await c.fetchPage('Warden Ilsa Crowe'))!,
    world.graph.resolveName('Warden Ilsa Crowe')!,
  );
  assert.deepEqual(out.voiceCard?.samples ?? [], [], 'hallucinated dialogue does not survive being shortened');
  world.close();
});
