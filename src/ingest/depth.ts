/**
 * Depth-mode orchestration. See DESIGN.md §3.1.
 *
 * The amendment that matters more than the modes themselves: depth is a property
 * of each subgraph, not one global setting. You play in a small corner of a
 * universe, so paying deep-extraction cost on the whole wiki is waste, and
 * skimming the region you actually inhabit is what makes the GM feel thin.
 *
 * Deep is a superset of mid is a superset of skim, so upgrading is a diff over
 * nodes below the target level. Nothing is ever re-extracted.
 */
import type { DepthLevelValue, Entity, EntityId } from '../domain/types.ts';
import type { World } from '../store/index.ts';
import type { PageSource, WikiPage } from './client.ts';
import { runPassA, type PassAResult } from './passA.ts';
import { crawl, discover, prune, type CrawlResult, type DiscoveryPreview } from './scope.ts';

export type DepthMode = 'skim' | 'mid' | 'deep';

export interface DepthSpec {
  level: DepthLevelValue;
  hops: number;
  maxPages: number;
  passB: 'none' | 'core' | 'all';
  voiceCards: 'none' | 'main' | 'all';
  embeddings: 'leads' | 'sections-in-scope' | 'sections-all';
  reconcileContradictions: boolean;
}

/** The table from DESIGN.md §3.1, made executable. */
export const MODES: Record<DepthMode, DepthSpec> = {
  skim: { level: 1, hops: 1, maxPages: 150, passB: 'none', voiceCards: 'none', embeddings: 'leads', reconcileContradictions: false },
  mid: { level: 2, hops: 2, maxPages: 600, passB: 'core', voiceCards: 'main', embeddings: 'sections-in-scope', reconcileContradictions: false },
  deep: { level: 3, hops: 3, maxPages: 3000, passB: 'all', voiceCards: 'all', embeddings: 'sections-all', reconcileContradictions: true },
};

/**
 * Pass B is the LLM half: typed relations with evidence spans, timeline events,
 * and voice cards mined from prose. Defining the seam here means depth
 * orchestration is complete and testable now, and a real extractor drops in
 * without touching this file.
 */
export interface PassBExtractor {
  extract(page: WikiPage, entity: Entity): Promise<PassBOutput>;
}

export interface PassBOutput {
  edges: Array<{ predicate: string; objectName: string; weight?: number; evidence?: string }>;
  events: Array<{ text: string; inWorldDate?: string; participants?: string[] }>;
  voiceCard?: { diction?: string; tics?: string[]; samples?: string[]; never?: string[] };
  /** Statements the page makes that contradict what is already in the graph. */
  contradictions?: Array<{ claim: string; conflictsWith: string }>;
  /**
   * True when this result is a swallowed failure (a provider error, an
   * expired credential, unparseable output) rather than a genuine "the page
   * said nothing extractable". `LlmPassBExtractor.extract` never throws
   * across a page — one bad call must not abort the pass — but that used to
   * mean a failure and an honestly empty page were the identical shape, so a
   * token that expired mid-run and killed every remaining call left no trace
   * to resume against: the page looked exactly as "done" as one the model had
   * actually read. A caller that cares about resuming checks this; one that
   * doesn't (the existing tests, the null extractor) is unaffected, since the
   * field is optional and absent means "not a failure".
   */
  failed?: boolean;
}

/** Does nothing, on purpose. Keeps depth.ts complete before the LLM pass exists. */
export class NullPassBExtractor implements PassBExtractor {
  async extract(): Promise<PassBOutput> {
    return { edges: [], events: [], contradictions: [] };
  }
}

export interface IngestOptions {
  client: PageSource;
  seeds: string[];
  mode: DepthMode;
  wiki?: string;
  exclude?: string[];
  extractor?: PassBExtractor;
  /** Stop after the preview rather than committing. */
  previewOnly?: boolean;
  /** Pass B extractions in flight at once. See `runPassB`. */
  passBConcurrency?: number;
  /** Progress for the long pass, forwarded to `runPassB`'s `onProgress`. */
  onPassBProgress?: (done: number, total: number, title: string) => void;
}

export interface IngestResult {
  preview: DiscoveryPreview;
  passA: PassAResult | null;
  passB: { pages: number; edges: number; events: number; voiceCards: number } | null;
  mode: DepthMode;
}

/**
 * Full ingest for a mode: crawl, preview, commit Pass A, then Pass B if the mode
 * calls for it.
 */
export async function ingest(opts: IngestOptions & { world?: World }): Promise<IngestResult> {
  const spec = MODES[opts.mode];
  const crawled = await crawl({
    client: opts.client,
    seeds: opts.seeds,
    hops: spec.hops,
    maxPages: spec.maxPages,
    exclude: opts.exclude,
  });

  const scoped = prune(crawled, { maxPages: spec.maxPages });
  const preview = discover(scoped, { maxPages: spec.maxPages });

  if (opts.previewOnly || !opts.world) {
    return { preview, passA: null, passB: null, mode: opts.mode };
  }

  const pages = [...scoped.pages.values()];
  const passA = runPassA(opts.world, pages, {
    depth: spec.level,
    wiki: opts.wiki ?? 'wiki',
    voiceCards: spec.voiceCards !== 'none',
  });

  let passB: IngestResult['passB'] = null;
  if (spec.passB !== 'none' && opts.extractor) {
    passB = await runPassB(opts.world, scoped, opts.extractor, spec, {
      ...(opts.passBConcurrency !== undefined ? { concurrency: opts.passBConcurrency } : {}),
      ...(opts.onPassBProgress ? { onProgress: opts.onPassBProgress } : {}),
      wiki: opts.wiki ?? 'wiki',
    });
  }

  return { preview, passA, passB, mode: opts.mode };
}

/**
 * Default Pass B concurrency.
 *
 * 4 rather than "as many as possible": every extraction is one ~7k-token
 * prompt, and against a local single-GPU server the calls contend for the same
 * weights, so past a handful the wall-clock stops improving and only the
 * per-request latency (and the chance of a timeout) grows. Against a cloud
 * provider the binding limit is the account's rate limit, which is also well
 * under "unbounded". 4 is a safe default in both worlds; callers who know their
 * backend can raise it.
 */
export const DEFAULT_PASSB_CONCURRENCY = 4;

export interface RunPassBOptions {
  /** Extractions in flight at once. Clamped to at least 1. */
  concurrency?: number;
  /** Called after each page settles, for progress reporting on a long run. */
  onProgress?: (done: number, total: number, title: string) => void;
  /** Matches the `wiki` column in `ingest_pages`, for status bookkeeping. */
  wiki?: string;
}

/**
 * Runs Pass B over the pages the mode selects: core entities only for mid, all
 * of the scope for deep. Core means the highest-scoring pages, which is where
 * relation quality actually pays off.
 *
 * **Concurrency.** The extractions run in a bounded pool, because this pass is
 * the single longest operation in the app — 150 sequential ~7k-token calls for
 * `mid` and 3000 for `deep`, which against a local model is the difference
 * between a coffee break and an overnight run.
 *
 * What is parallel and what is not, deliberately:
 *
 * - **The model calls are parallel.** They are genuinely independent: each
 *   reads one page and returns a candidate delta.
 * - **Every graph write stays serial, and in the original candidate order.**
 *   This is the part worth being careful about. `world.graph`/`world.cast` sit
 *   on one synchronous SQLite connection, and two of the writes below are
 *   order-dependent in ways that are invisible until they corrupt something:
 *   event ids are minted from a running counter (`event:<id>:<n>`), so
 *   interleaved writers would collide on an id and silently overwrite each
 *   other's events; and `assertEdge`/`resolveName` read graph state that
 *   earlier pages in the same pass have written. Collecting results and
 *   applying them in `targets` order keeps the committed graph *byte-identical
 *   to a sequential run*, which is also what makes the existing tests a valid
 *   check on this change.
 *
 * The cost of that choice is that a slow page delays the commit of pages behind
 * it, not that it delays their extraction — the pool keeps working. Peak memory
 * is bounded by the pool size, not the page count, because each result is
 * applied and released as its turn comes up rather than all being held to the
 * end.
 */
export async function runPassB(
  world: World,
  scoped: CrawlResult,
  extractor: PassBExtractor,
  spec: DepthSpec,
  opts: RunPassBOptions = {},
): Promise<{ pages: number; edges: number; events: number; voiceCards: number }> {
  const targets =
    spec.passB === 'all'
      ? scoped.candidates
      : scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));

  const out = { pages: 0, edges: 0, events: 0, voiceCards: 0 };

  // Resolve the work up front so the pool has nothing to decide. Entities are
  // resolved here rather than in the worker because `resolveName` is a
  // synchronous DB read, and doing it once keeps the async section purely
  // network-bound.
  //
  // Pages already marked `done` are skipped here, not filtered by the caller:
  // this is what makes a resumed ingest — the same crawl run again after
  // whatever failed the first time is fixed — cheap and correct by
  // construction. Re-running `ingest()` over an unchanged scope costs nothing
  // extra for pages that already succeeded, and only pays again for the ones
  // that were never reached or came back `failed`.
  const wiki = opts.wiki ?? 'wiki';
  const alreadyDone = donePages(world, wiki);
  const work: Array<{ title: string; page: WikiPage; entity: Entity }> = [];
  for (const candidate of targets) {
    const page = scoped.pages.get(candidate.title);
    if (!page) continue;
    if (alreadyDone.has(page.pageId)) continue;
    const entity = world.graph.resolveName(candidate.title);
    if (!entity) continue;
    work.push({ title: candidate.title, page, entity });
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_PASSB_CONCURRENCY, work.length || 1));

  // `null` marks a page whose extraction threw past the extractor's own
  // try/catch (should not happen for `LlmPassBExtractor`, which never throws
  // across a page, but a hand-written `PassBExtractor` in a test might): one
  // bad extraction must not abort the pass, and it must not shift the commit
  // order of the others. A result with `.failed === true` is the extractor's
  // own, more informative report of the same situation and is handled the
  // same way below, just with a status recorded rather than only skipped.
  const results: Array<PassBOutput | null | undefined> = new Array(work.length);

  // Commit in order as results arrive, so memory stays bounded by the pool
  // rather than growing to hold every page's delta until the end.
  let nextToCommit = 0;
  let settled = 0;
  const drain = () => {
    while (nextToCommit < work.length && results[nextToCommit] !== undefined) {
      const item = work[nextToCommit]!;
      const result = results[nextToCommit];
      // Release the reference as soon as it is applied.
      results[nextToCommit] = undefined;
      nextToCommit++;
      if (result && !result.failed) {
        applyPassB(world, spec, item.title, item.entity, result, out);
        recordPassBStatus(world, wiki, item.page.pageId, 'done');
      } else {
        // Not committed and not stamped to depth: `belowDepth`/the resume path
        // must keep seeing this page as pending, exactly as if Pass B had
        // never been attempted, so a later retry (once whatever failed is
        // fixed) picks it back up rather than skipping it as "already done".
        recordPassBStatus(world, wiki, item.page.pageId, 'failed');
      }
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= work.length) return;
      const item = work[index]!;
      try {
        results[index] = await extractor.extract(item.page, item.entity);
      } catch {
        results[index] = null; // see above: skip this page, keep the pass alive
      }
      settled++;
      opts.onProgress?.(settled, work.length, item.title);
      // Commit whatever prefix is now contiguous. Safe to call from any worker:
      // this is single-threaded, and `drain` only touches indices it consumes.
      drain();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // A final drain is belt-and-braces: the last worker's own drain already
  // flushed, but this keeps the invariant local to this function.
  drain();

  return out;
}

/** Page ids already marked `done` for this wiki, so a resume never re-pays for them. */
function donePages(world: World, wiki: string): Set<string> {
  const rows = world.db.prepare(`SELECT page_id FROM ingest_pages WHERE wiki = ? AND passb_status = 'done'`).all(wiki) as Array<{
    page_id: string;
  }>;
  return new Set(rows.map((r) => r.page_id));
}

/** Records whether Pass B genuinely succeeded on a page, for later resume. */
function recordPassBStatus(world: World, wiki: string, pageId: string, status: 'done' | 'failed'): void {
  world.db
    .prepare(`UPDATE ingest_pages SET passb_status = ? WHERE page_id = ? AND wiki = ?`)
    .run(status, pageId, wiki);
}

/**
 * Commits one page's extraction. Split out of `runPassB` so the ordering
 * guarantee above is enforced by construction: this is the only writer, and it
 * is only ever called from `drain`, serially, in candidate order.
 */
function applyPassB(
  world: World,
  spec: DepthSpec,
  title: string,
  entity: Entity,
  result: PassBOutput,
  out: { pages: number; edges: number; events: number; voiceCards: number },
): void {
  out.pages++;

  for (const e of result.edges) {
    const target = world.graph.resolveName(e.objectName);
    if (!target || target.id === entity.id) continue;
    world.graph.assertEdge(
      { subject: entity.id, predicate: e.predicate, object: target.id, weight: e.weight ?? 0.6, evidence: e.evidence },
      0,
      'canon',
      `passB:${title}`,
    );
    out.edges++;
  }

  for (const ev of result.events) {
    const id = `event:${entity.id}:${out.events}`;
    world.graph.upsert(
      {
        id,
        type: 'Event',
        name: ev.text.slice(0, 70),
        summary: ev.text,
        provenance: `passB:${title}`,
        depthLevel: spec.level,
        props: ev.inWorldDate ? { inWorldDate: ev.inWorldDate } : {},
      },
      'canon',
    );
    world.graph.assertEdge({ subject: entity.id, predicate: 'INVOLVED_IN', object: id, weight: 0.6 }, 0, 'canon');
    out.events++;
  }

  if (result.voiceCard && spec.voiceCards !== 'none') {
    const sheet = world.cast.getOrBlank(entity.id);
    const v = result.voiceCard;
    sheet.voice = {
      diction: v.diction || sheet.voice.diction,
      tics: [...new Set([...sheet.voice.tics, ...(v.tics ?? [])])],
      samples: [...new Set([...sheet.voice.samples, ...(v.samples ?? [])])].slice(0, 8),
      never: [...new Set([...sheet.voice.never, ...(v.never ?? [])])],
    };
    world.cast.put(sheet, 'canon');
    out.voiceCards++;
  }

  // Contradictions are kept as competing claims with sources rather than
  // resolved: wikis mix continuities, and the fidelity dial decides at play time.
  for (const c of result.contradictions ?? []) {
    world.chronicle.addDivergence(0, 'canon-contradiction', `${c.claim} (conflicts with: ${c.conflictsWith})`, title);
  }

  world.graph.setDepth(entity.id, spec.level);
}

/**
 * Upgrades existing nodes to a higher depth. Only touches nodes below the
 * target, so this is a diff rather than a re-run.
 */
export async function upgradeDepth(
  world: World,
  target: DepthMode,
  opts: { client: PageSource; extractor?: PassBExtractor; limit?: number; wiki?: string },
): Promise<{ examined: number; upgraded: number; passA: PassAResult | null }> {
  const spec = MODES[target];
  const stale = world.graph.belowDepth(spec.level, opts.limit ?? 200);
  if (!stale.length) return { examined: 0, upgraded: 0, passA: null };

  const pages = await opts.client.fetchPages(stale.map((e) => e.name));
  const passA = runPassA(world, pages, {
    depth: spec.level,
    wiki: opts.wiki ?? 'wiki',
    voiceCards: spec.voiceCards !== 'none',
  });

  // Mark even the nodes with no page, or they are re-examined on every upgrade.
  const fetched = new Set(pages.map((p) => p.title.toLowerCase()));
  for (const e of stale) {
    if (!fetched.has(e.name.toLowerCase())) world.graph.setDepth(e.id, spec.level);
  }

  return { examined: stale.length, upgraded: passA.entities, passA };
}

/**
 * Deepens a neighbourhood rather than the whole wiki. This is the per-subgraph
 * lever: deep pockets only where the story actually goes.
 */
export async function promoteRegion(
  world: World,
  rootId: EntityId,
  target: DepthMode,
  opts: { client: PageSource; hops?: number; extractor?: PassBExtractor; wiki?: string },
): Promise<{ titles: string[]; passA: PassAResult | null }> {
  const spec = MODES[target];
  const hops = opts.hops ?? 1;

  const seen = new Set<EntityId>([rootId]);
  let frontier = [rootId];
  for (let h = 0; h < hops; h++) {
    const next: EntityId[] = [];
    for (const id of frontier) {
      for (const { otherId } of world.graph.neighbours(id)) {
        if (seen.has(otherId)) continue;
        seen.add(otherId);
        next.push(otherId);
      }
    }
    frontier = next;
  }

  const needed = [...seen]
    .map((id) => world.graph.get(id))
    .filter((e): e is Entity => !!e && e.depthLevel < spec.level);
  if (!needed.length) return { titles: [], passA: null };

  const pages = await opts.client.fetchPages(needed.map((e) => e.name));
  const passA = runPassA(world, pages, { depth: spec.level, wiki: opts.wiki ?? 'wiki', voiceCards: spec.voiceCards !== 'none' });
  for (const e of needed) world.graph.setDepth(e.id, spec.level);

  return { titles: needed.map((e) => e.name), passA };
}

/**
 * Just-in-time deepening for play time: when the story approaches a node still
 * at skim level, deepen it before the scene. This is what makes skim a viable
 * permanent baseline.
 */
export async function deepenOnDemand(
  world: World,
  entityId: EntityId,
  target: DepthMode,
  opts: { client: PageSource; extractor?: PassBExtractor; wiki?: string },
): Promise<boolean> {
  const entity = world.graph.get(entityId);
  const spec = MODES[target];
  if (!entity || entity.depthLevel >= spec.level) return false;

  const page = await opts.client.fetchPage(entity.name);
  if (!page) {
    // Emergent entities have no page and never will; marking them prevents an
    // endless retry every time the player walks back into the room.
    world.graph.setDepth(entityId, spec.level);
    return false;
  }
  runPassA(world, [page], { depth: spec.level, wiki: opts.wiki ?? 'wiki', voiceCards: spec.voiceCards !== 'none' });
  world.graph.setDepth(entityId, spec.level);
  return true;
}

/** Nodes the Director should pre-deepen, given where the story is pointing. */
export function deepenTargets(world: World, target: DepthMode, limit = 5): Entity[] {
  const spec = MODES[target];
  return world.graph
    .list({ limit: 200, minSalience: 0.3 })
    .filter((e) => e.depthLevel < spec.level && !e.provenance.startsWith('emergent'))
    .slice(0, limit);
}
