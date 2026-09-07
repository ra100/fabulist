/**
 * Pass B concurrency tests.
 *
 * The point of the pool is wall-clock, but the thing worth testing is the
 * *invariant that makes it safe*: extractions overlap, while every graph write
 * stays serial and in candidate order, so a concurrent run commits exactly what
 * a sequential one would. These tests pin that rather than the speedup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { WikiClient, fixtureFetcher, type WikiPage } from '../src/ingest/client.ts';
import { runPassA } from '../src/ingest/passA.ts';
import { crawl, prune } from '../src/ingest/scope.ts';
import {
  runPassB,
  ingest,
  MODES,
  DEFAULT_PASSB_CONCURRENCY,
  type PassBExtractor,
  type PassBOutput,
} from '../src/ingest/depth.ts';
import type { Entity } from '../src/domain/types.ts';
import { WIKI } from './fixtures/wiki.ts';

const client = () => new WikiClient({ baseUrl: 'https://vale.fandom.com', fetcher: fixtureFetcher(WIKI), delayMs: 0 });

async function scopedWorld() {
  const world = World.open(':memory:');
  const c = client();
  runPassA(world, await c.fetchPages(Object.keys(WIKI)), { wiki: 'vale', depth: 1 });
  const crawled = await crawl({ client: c, seeds: ['Warden Ilsa Crowe', 'Duskhollow'], hops: 2, maxPages: 600 });
  const scoped = prune(crawled, { maxPages: 600 });
  return { world, scoped };
}

/**
 * Records the true overlap of in-flight extractions, and the order in which
 * results were handed back, so both halves of the invariant are observable.
 */
class TrackingExtractor implements PassBExtractor {
  inFlight = 0;
  peakInFlight = 0;
  readonly startOrder: string[] = [];
  readonly completionOrder: string[] = [];
  private delayFor: (title: string) => number;

  // Written out rather than a parameter property: Node's strip-only TypeScript
  // mode (which is how `pnpm test` runs) rejects `constructor(private x)`.
  constructor(delayFor: (title: string) => number = () => 0) {
    this.delayFor = delayFor;
  }

  async extract(page: WikiPage, entity: Entity): Promise<PassBOutput> {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.startOrder.push(page.title);
    await new Promise((r) => setTimeout(r, this.delayFor(page.title)));
    this.inFlight--;
    this.completionOrder.push(page.title);
    // One event per page: `applyPassB` mints ids from a running counter, so
    // interleaved commits would collide. The id assertions below depend on this.
    return {
      edges: [],
      events: [{ text: `something happened at ${page.title}` }],
      contradictions: [],
    };
  }
}

// ------------------------------------------------------------------ the pool

test('extractions actually overlap up to the configured concurrency', async () => {
  const { world, scoped } = await scopedWorld();
  const ex = new TrackingExtractor(() => 5);
  await runPassB(world, scoped, ex, MODES.mid, { concurrency: 4 });

  assert.ok(ex.peakInFlight > 1, `calls overlapped (peak ${ex.peakInFlight})`);
  assert.ok(ex.peakInFlight <= 4, `never exceeded the limit (peak ${ex.peakInFlight})`);
  world.close();
});

test('concurrency: 1 keeps exactly one call in flight, matching the old behaviour', async () => {
  const { world, scoped } = await scopedWorld();
  const ex = new TrackingExtractor(() => 2);
  await runPassB(world, scoped, ex, MODES.mid, { concurrency: 1 });

  assert.equal(ex.peakInFlight, 1, 'strictly sequential when asked');
  world.close();
});

test('a concurrency below 1 is clamped rather than deadlocking the pass', async () => {
  const { world, scoped } = await scopedWorld();
  const ex = new TrackingExtractor();
  const out = await runPassB(world, scoped, ex, MODES.mid, { concurrency: 0 });

  assert.ok(out.pages > 0, 'the pass still ran');
  assert.equal(ex.peakInFlight, 1);
  world.close();
});

// ------------------------------------------------------- the ordering invariant

test('results commit in candidate order even when they finish out of order', async () => {
  const { world, scoped } = await scopedWorld();
  const targets = scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));

  // Make the first page by far the slowest, so it finishes last but must still
  // commit first. This is the case a naive `Promise.all` + push would get wrong.
  const slowest = targets[0]!.title;
  const ex = new TrackingExtractor((title) => (title === slowest ? 40 : 1));
  await runPassB(world, scoped, ex, MODES.mid, { concurrency: 4 });

  assert.notEqual(ex.completionOrder[0], slowest, 'the slow page really did finish late');

  // Event ids encode the commit sequence (`event:<entityId>:<n>`), so reading
  // them back proves the order writes were applied in.
  const events = world.graph.list({ limit: 500 }).filter((e) => e.type === 'Event');
  const bySeq = new Map<number, string>();
  for (const e of events) {
    const seq = Number(e.id.split(':').pop());
    bySeq.set(seq, e.summary);
  }
  assert.ok(bySeq.get(0)?.includes(slowest), `the first candidate committed first (got "${bySeq.get(0)}")`);
  world.close();
});

test('a concurrent run commits byte-identically to a sequential one', async () => {
  const snapshot = async (concurrency: number) => {
    const { world, scoped } = await scopedWorld();
    await runPassB(world, scoped, new TrackingExtractor((t) => t.length % 7), MODES.mid, { concurrency });
    const events = world.graph
      .list({ limit: 500 })
      .filter((e) => e.type === 'Event')
      .map((e) => `${e.id}|${e.summary}|${e.provenance}`)
      .sort();
    const edges = world.graph
      .allEdges()
      .map((e) => `${e.subject}|${e.predicate}|${e.object}`)
      .sort();
    world.close();
    return { events, edges };
  };

  const sequential = await snapshot(1);
  const parallel = await snapshot(6);

  assert.deepEqual(parallel.events, sequential.events, 'identical events, identical ids');
  assert.deepEqual(parallel.edges, sequential.edges, 'identical edges');
  assert.ok(sequential.events.length > 0, 'the comparison was not vacuous');
});

test('event ids stay unique under concurrency — no counter collisions', async () => {
  const { world, scoped } = await scopedWorld();
  await runPassB(world, scoped, new TrackingExtractor((t) => t.length % 5), MODES.mid, { concurrency: 8 });

  const ids = world.graph.list({ limit: 500 }).filter((e) => e.type === 'Event').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'every event got its own id');
  assert.ok(ids.length > 1, 'several events were written');
  world.close();
});

// ----------------------------------------------------------------- resilience

test('one failing extraction does not abort the pass or shift the others', async () => {
  const { world, scoped } = await scopedWorld();
  const targets = scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));
  const doomed = targets[1]!.title;

  const flaky: PassBExtractor = {
    async extract(page) {
      if (page.title === doomed) throw new Error('extraction exploded');
      return { edges: [], events: [{ text: `ok ${page.title}` }], contradictions: [] };
    },
  };

  const out = await runPassB(world, scoped, flaky, MODES.mid, { concurrency: 4 });
  assert.ok(out.pages > 0, 'the pass survived');
  assert.equal(out.pages, targets.length - 1, 'exactly the doomed page was skipped');

  // Match on this pass's own marker, not on the title: Pass A already created
  // `event:sundering-of-marrow`, whose summary happens to contain "Duskhollow",
  // so a bare title search cannot tell a pass-B write from pre-existing canon.
  const written = world.graph
    .list({ limit: 500 })
    .filter((e) => e.type === 'Event' && e.summary.startsWith('ok '))
    .map((e) => e.summary.slice(3));

  assert.ok(!written.includes(doomed), 'the failed page contributed no event of its own');
  assert.equal(written.length, targets.length - 1, 'every other page still committed');
  world.close();
});

// ------------------------------------------------------------------- progress

test('progress is reported once per page, ending at the total', async () => {
  const { world, scoped } = await scopedWorld();
  const seen: Array<{ done: number; total: number }> = [];
  const out = await runPassB(world, scoped, new TrackingExtractor(), MODES.mid, {
    concurrency: 4,
    onProgress: (done, total) => seen.push({ done, total }),
  });

  assert.equal(seen.length, out.pages, 'one callback per extracted page');
  assert.equal(seen.at(-1)?.done, seen.at(-1)?.total, 'the last callback reports completion');
  // Monotonic, because `settled` only ever increments.
  const dones = seen.map((s) => s.done);
  assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'progress never goes backwards');
  world.close();
});

// --------------------------------------------------------------- the defaults

test('the default concurrency is a real bound, and ingest threads it through', async () => {
  assert.ok(DEFAULT_PASSB_CONCURRENCY >= 1 && DEFAULT_PASSB_CONCURRENCY <= 8, 'a conservative default');

  const world = World.open(':memory:');
  const c = client();
  runPassA(world, await c.fetchPages(Object.keys(WIKI)), { wiki: 'vale', depth: 1 });
  const ex = new TrackingExtractor(() => 3);
  const res = await ingest({
    world,
    client: c,
    seeds: ['Warden Ilsa Crowe', 'Duskhollow'],
    mode: 'mid',
    wiki: 'vale',
    extractor: ex,
    passBConcurrency: 3,
  });

  assert.ok(res.passB!.pages > 0, 'pass B ran through ingest()');
  assert.ok(ex.peakInFlight > 1 && ex.peakInFlight <= 3, `ingest honoured the limit (peak ${ex.peakInFlight})`);
  world.close();
});

test('ingest forwards progress callbacks to the pass', async () => {
  const world = World.open(':memory:');
  const c = client();
  runPassA(world, await c.fetchPages(Object.keys(WIKI)), { wiki: 'vale', depth: 1 });
  let calls = 0;
  await ingest({
    world,
    client: c,
    seeds: ['Warden Ilsa Crowe'],
    mode: 'mid',
    wiki: 'vale',
    extractor: new TrackingExtractor(),
    onPassBProgress: () => calls++,
  });
  assert.ok(calls > 0, 'the CLI can show progress on a long run');
  world.close();
});
