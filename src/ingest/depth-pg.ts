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
import { createHash } from 'node:crypto';
import type { DepthLevelValue, EdgeAssert, Entity, EntityId, EntityType } from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
import type { Db } from '../db/pg.ts';
import type { PageSource, WikiPage } from './client.ts';
import { runPassA, type PassAResult } from './passA-pg.ts';
import { crawl, discover, prune, type CrawlResult, type DiscoveryPreview } from './scope.ts';

export type DepthMode = 'skim' | 'mid' | 'deep' | 'all';

export interface DepthSpec {
  level: DepthLevelValue;
  hops: number;
  maxPages: number;
  passB: 'none' | 'core' | 'all';
  /**
   * Hard cap on how many pages Pass B runs on, applied *after* `passB`'s own
   * core/all selection. `UNLIMITED` means "no cap beyond that selection",
   * which is what every preset except `all` uses — so this field changes
   * nothing for skim/mid/deep.
   *
   * It exists because page breadth and extraction depth stopped being the
   * same decision the moment `maxPages` could be unlimited. Pass A is an
   * offline parse: 127k pages of a Fandom dump is minutes of CPU and costs
   * nothing. Pass B is one ~7k-token model call *per page*, so the same 127k
   * pages is 127k calls — days of wall-clock and a bill to match. Tying the
   * two together would have meant "crawl everything" was unusable in
   * practice, so the whole graph is now cheap to build while the expensive
   * typed-relation pass stays pointed at the pages that scored highest.
   */
  passBMaxPages: number;
  voiceCards: 'none' | 'main' | 'all';
  embeddings: 'leads' | 'sections-in-scope' | 'sections-all';
  reconcileContradictions: boolean;
}

/**
 * "No limit", for `maxPages`/`hops`/`passBMaxPages`.
 *
 * `Infinity` rather than a large sentinel so the arithmetic in `scope.ts`
 * (`maxPages * 3`, `slice(0, n)`, `hop <= hops`) stays correct without any
 * special-casing. It must never reach a JSON response — `JSON.stringify`
 * turns it into `null` — so anything crossing the wire goes through
 * `budgetToWire`/`parseBudget` instead.
 */
export const UNLIMITED = Number.POSITIVE_INFINITY;

/** The table from DESIGN.md §3.1, made executable. */
export const MODES: Record<DepthMode, DepthSpec> = {
  skim: { level: 1, hops: 1, maxPages: 150, passB: 'none', passBMaxPages: UNLIMITED, voiceCards: 'none', embeddings: 'leads', reconcileContradictions: false },
  mid: { level: 2, hops: 2, maxPages: 600, passB: 'core', passBMaxPages: UNLIMITED, voiceCards: 'main', embeddings: 'sections-in-scope', reconcileContradictions: false },
  deep: { level: 3, hops: 3, maxPages: 3000, passB: 'all', passBMaxPages: UNLIMITED, voiceCards: 'all', embeddings: 'sections-all', reconcileContradictions: true },
  /**
   * The whole wiki. `hops: UNLIMITED` means breadth-first until the frontier
   * stops producing new titles rather than stopping at a fixed radius, which
   * is the only way "all of it" is reachable — a 127k-page wiki is nowhere
   * near covered by deep's 3 hops.
   *
   * Reachability, stated honestly: this is still a crawl from the seeds, so
   * it covers everything link-connected to them. On a real wiki that is
   * effectively the whole main namespace; a genuinely orphaned page with no
   * inbound links from the connected component is not included, and no
   * ranking signal exists for one anyway.
   *
   * `passBMaxPages` is deliberately finite here (see that field's comment):
   * `all` means "build the whole graph", not "spend a five-figure model bill
   * without being asked". Raise it explicitly — `limits.passBMaxPages` — if
   * that is genuinely what you want.
   */
  all: { level: 3, hops: UNLIMITED, maxPages: UNLIMITED, passB: 'all', passBMaxPages: 3000, voiceCards: 'all', embeddings: 'sections-all', reconcileContradictions: true },
};

/**
 * Per-run overrides on top of a mode's preset, so the presets stay the
 * common answer without becoming a ceiling. Every field is optional and
 * absent means "whatever the mode says" — passing `{}` is exactly today's
 * behaviour.
 */
export interface IngestLimits {
  /** Pages kept in scope (and therefore Pass A'd). `UNLIMITED` for the whole crawl. */
  maxPages?: number;
  /** Crawl radius from the seeds. `UNLIMITED` to walk until the frontier is exhausted. */
  hops?: number;
  /** Cap on Pass B pages. See `DepthSpec.passBMaxPages`. */
  passBMaxPages?: number;
}

/** A mode's preset with any caller overrides applied. */
export function specFor(mode: DepthMode, limits: IngestLimits = {}): DepthSpec {
  const base = MODES[mode];
  if (!base) throw new Error(`unknown depth mode "${mode}"`);
  return {
    ...base,
    ...(limits.maxPages !== undefined ? { maxPages: limits.maxPages } : {}),
    ...(limits.hops !== undefined ? { hops: limits.hops } : {}),
    ...(limits.passBMaxPages !== undefined ? { passBMaxPages: limits.passBMaxPages } : {}),
  };
}

/**
 * Parses a budget off the wire (an HTTP body, an MCP argument, a CLI flag).
 *
 * Accepts a positive number, or `'all'`/`'unlimited'`/`Infinity` for no
 * limit. Returns `undefined` for absent/empty so a caller can spread it into
 * `IngestLimits` without inventing a value, and throws on anything else
 * rather than silently degrading to a default — a mistyped budget that
 * quietly becomes 600 pages is the failure mode this exists to prevent.
 */
export function parseBudget(value: unknown, label = 'budget'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === Number.POSITIVE_INFINITY) return UNLIMITED;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'all' || v === 'unlimited' || v === 'none') return UNLIMITED;
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) return n;
    throw new Error(`${label} must be a positive integer or "all", got "${value}"`);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${label} must be a positive integer or "all", got ${JSON.stringify(value)}`);
}

/** The JSON-safe form of a budget: `Infinity` would serialise to `null`. */
export function budgetToWire(n: number): number | 'all' {
  return Number.isFinite(n) ? n : 'all';
}

/** For a log line or a progress label. */
export function budgetLabel(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : 'all';
}

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
  /** Per-run overrides on the mode's preset. See `IngestLimits`. */
  limits?: IngestLimits;
  wiki?: string;
  exclude?: string[];
  extractor?: PassBExtractor;
  /** Stop after the preview rather than committing. */
  previewOnly?: boolean;
  /** Pass B extractions in flight at once. See `runPassB`. */
  passBConcurrency?: number;
  /** Progress for the long pass, forwarded to `runPassB`'s `onProgress`. */
  onPassBProgress?: (done: number, total: number, title: string) => void;
  /**
   * Progress for Pass A, forwarded to `runPassA`'s `onProgress`. Worth wiring
   * even though Pass A is fast per page: over a whole-wiki scope it is tens of
   * thousands of pages of otherwise silent work, and unlike the crawl its total
   * is exact from the start.
   */
  onPassAProgress?: (done: number, total: number, phase: 'parsing' | 'writing') => void;
  /** Forwarded to `runPassA`. See `PassAOptions.secondary` for the merge policy this drives. */
  secondary?: boolean;
}

export interface IngestResult {
  preview: DiscoveryPreview;
  passA: PassAResult | null;
  passB: PassBCounters | null;
  mode: DepthMode;
}

/**
 * Full ingest for a mode: crawl, preview, commit Pass A, then Pass B if the mode
 * calls for it.
 */
export async function ingest(opts: IngestOptions & { world?: World; db?: Db }): Promise<IngestResult> {
  const spec = specFor(opts.mode, opts.limits ?? {});
  const crawled = await crawl({
    client: opts.client,
    seeds: opts.seeds,
    hops: spec.hops,
    maxPages: spec.maxPages,
    exclude: opts.exclude,
  });

  const scoped = prune(crawled, { maxPages: spec.maxPages });
  const preview = discover(scoped, { maxPages: spec.maxPages });

  if (opts.previewOnly || !opts.world || !opts.db) {
    // `db` is required alongside `world` for a committing run: Pass A writes in one
    // transaction and a `World` alone cannot begin one.
    return { preview, passA: null, passB: null, mode: opts.mode };
  }

  const pages = [...scoped.pages.values()];
  const passA = await runPassA(opts.db, opts.world, pages, {
    depth: spec.level,
    depthByTitle: depthByHops(scoped, spec.level),
    wiki: opts.wiki ?? 'wiki',
    voiceCards: spec.voiceCards !== 'none',
    ...(opts.secondary !== undefined ? { secondary: opts.secondary } : {}),
    ...(opts.onPassAProgress ? { onProgress: opts.onPassAProgress } : {}),
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
): Promise<PassBCounters> {
  const selected =
    spec.passB === 'all'
      ? scoped.candidates
      : scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));
  // Candidates are already sorted by score (see `crawl`), so capping is
  // "the best N pages", not "the first N the crawler happened to reach".
  const targets = Number.isFinite(spec.passBMaxPages) ? selected.slice(0, spec.passBMaxPages) : selected;

  const out = emptyPassBCounters();

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
  const alreadyDone = await donePages(world, wiki);
  const work: Array<{ title: string; page: WikiPage; entity: Entity }> = [];
  for (const candidate of targets) {
    const page = scoped.pages.get(candidate.title);
    if (!page) continue;
    if (alreadyDone.has(page.pageId)) continue;
    const entity = await world.graph.resolveName(candidate.title);
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

/**
 * A short, human label for an event node.
 *
 * The first clause, or a truncation — never the whole sentence. `name` is what
 * the graph explorer draws and what name resolution reads; a 70-character
 * sentence fragment there is both unreadable in a node label and, before
 * `resolveName` was tightened, a match for almost any proper noun in the world.
 */
function shortEventLabel(text: string): string {
  const clause = text.split(/[,;:.\u2014]/)[0]!.trim();
  const label = clause.length >= 12 && clause.length <= 60 ? clause : text.slice(0, 60).trim();
  return label.length < text.length ? `${label}\u2026` : label;
}

/**
 * Per-page depth from crawl distance: a seed gets the mode's full level, and
 * every hop outward is one level shallower, floored at 1.
 *
 * This is what makes depth mean anything in the data. The mode's level is a
 * *ceiling*, not a uniform stamp — "you play in a small corner of a universe"
 * (DESIGN.md §3.1) only holds if the corner you are in is recorded as deeper
 * than the rim. With every entity stamped at the mode level, `belowDepth`
 * returned nothing and `upgradeDepth`/`promoteRegion`/`deepenOnDemand` had
 * nothing to act on.
 */
export function depthByHops(scoped: CrawlResult, level: DepthLevelValue): Map<string, DepthLevelValue> {
  const map = new Map<string, DepthLevelValue>();
  for (const c of scoped.candidates) {
    const value = Math.max(1, Math.min(level, level - c.hops));
    map.set(c.title, value as DepthLevelValue);
  }
  return map;
}

/** Page ids already marked `done` for this wiki, so a resume never re-pays for them. */
async function donePages(world: World, wiki: string): Promise<Set<string>> {
  const worldId = world.sources[0]?.worldId;
  if (worldId === undefined) return new Set();
  const { rows } = await world.db.query<{ page_id: string }>(
    `SELECT page_id FROM ingest_pages WHERE world_id = $1 AND wiki = $2 AND passb_status = 'done'`,
    [worldId, wiki],
  );
  return new Set(rows.map((r) => r.page_id));
}

/** Records whether Pass B genuinely succeeded on a page, for later resume. */
async function recordPassBStatus(
  world: World,
  wiki: string,
  pageId: string,
  status: 'done' | 'failed',
): Promise<void> {
  const worldId = world.sources[0]?.worldId;
  if (worldId === undefined) return;
  await world.db.query(
    `UPDATE ingest_pages SET passb_status = $1 WHERE world_id = $2 AND wiki = $3 AND page_id = $4`,
    [status, worldId, wiki, pageId],
  );
}

/** Counters `applyPassB` accumulates across a whole pass. */
export interface PassBCounters {
  pages: number;
  edges: number;
  events: number;
  voiceCards: number;
  /**
   * Extracted statements that did not become event nodes because they were
   * neither dated nor shared by two known entities. Kept on the subject
   * instead — see `applyPassB`'s own note on why that is not data loss.
   */
  eventsSkipped: number;
  /** `INVOLVED_IN` edges written, which is what makes an event a *shared* node. */
  eventParticipants: number;
}

export function emptyPassBCounters(): PassBCounters {
  return { pages: 0, edges: 0, events: 0, voiceCards: 0, eventsSkipped: 0, eventParticipants: 0 };
}

/** Statements kept on the subject rather than promoted to event nodes. Capped, because props are read into prompts. */
const MAX_ENTITY_EVENT_NOTES = 12;

/**
 * The id of an event, derived from *what happened* rather than from who
 * reported it.
 *
 * This is the whole of the identity fix. The old id was
 * `event:<subject>:<counter>`, which made an event a property of the page it
 * was read on: the same battle described on three pages became three
 * single-participant nodes, and re-running the pass renumbered the counter so
 * a second ingest duplicated rather than converged. Hashing the normalised
 * text plus the in-world date means all three pages `upsert` the *same* node
 * and each contributes an `INVOLVED_IN` edge, which is how an event ends up
 * with the participants it actually had.
 *
 * Measured on the world that prompted this: 8,760 synthetic events, 8,140 of
 * them at degree 1, and 26 groups sharing byte-identical summaries.
 */
export function eventIdFor(text: string, inWorldDate?: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const digest = createHash('sha256').update(`${norm}|${inWorldDate ?? ''}`).digest('hex').slice(0, 16);
  return `event:${digest}`;
}

/**
 * Commits one page's extraction.
 *
 * Exported because `SetupService.runResumablePassB` runs its own loop (it needs
 * per-page job progress and cooperative cancellation) and used to duplicate
 * this logic — with one consequence nobody had noticed: that copy handled
 * relations, voice and contradictions but *never created event nodes at all*,
 * only counted them. So a wizard/API/MCP ingest and a CLI ingest produced
 * materially different graphs from the same pages. One writer now, called from
 * both loops.
 *
 * Still the only writer, and still called serially in candidate order (see
 * `runPassB`'s note on why the commit order is load-bearing).
 */
export async function applyPassB(
  world: World,
  spec: DepthSpec,
  title: string,
  entity: Entity,
  result: PassBOutput,
  out: PassBCounters,
): Promise<void> {
  out.pages++;

  // Every name this page's extraction mentions, resolved once. `resolveName` is a
  // query now, and Pass B calls it for every relation object and every event
  // participant on every page — the single biggest source of round trips in an
  // ingest if left inline.
  const names = new Set<string>();
  for (const e of result.edges) names.add(e.objectName);
  for (const ev of result.events) for (const n of ev.participants ?? []) names.add(n);
  const resolved = new Map<string, string | null>();
  for (const n of names) {
    resolved.set(n, (await world.graph.resolveName(n))?.id ?? null);
  }

  // Accumulated and flushed in batches at the end of this page's application.
  const edgeWrites: EdgeAssert[] = [];
  const entityWrites: Array<Partial<Entity> & { id: string; type: EntityType; name: string }> = [];

  for (const e of result.edges) {
    const targetId = resolved.get(e.objectName);
    if (!targetId || targetId === entity.id) continue;
    edgeWrites.push({
      subject: entity.id,
      predicate: e.predicate,
      object: targetId,
      weight: e.weight ?? 0.6,
      evidence: e.evidence,
    });
    out.edges++;
  }

  const keptNotes: string[] = [];
  for (const ev of result.events) {
    const text = ev.text.trim();
    if (!text) continue;

    // Everyone this event names *and that this world already knows*, the
    // subject included. Resolution is exact-or-nothing now (see
    // `GraphStore.resolveName`), so an unknown name drops out rather than
    // binding to the nearest-looking row.
    const participants = new Set<string>([entity.id]);
    for (const name of ev.participants ?? []) {
      const hit = resolved.get(name);
      if (hit) participants.add(hit);
    }

    // The threshold. An undated statement with one known participant is not an
    // event, it is a sentence about the subject — and 8,140 of those were what
    // made the graph look like confetti: a node per sentence, each hanging off
    // its own page by a single edge, contributing nothing a traversal can use.
    //
    // Not discarded: it is appended to the subject's own props below, which is
    // where a statement about one entity belongs. Nothing is lost, it just
    // stops pretending to be a shared node.
    const dated = !!ev.inWorldDate?.trim();
    if (!dated && participants.size < 2) {
      keptNotes.push(text);
      out.eventsSkipped++;
      continue;
    }

    const id = eventIdFor(text, ev.inWorldDate ?? undefined);
    entityWrites.push(
      {
        id,
        type: 'Event',
        // A short label, not the sentence: the full text lives in `summary`.
        // A prose-length `name` is what made these nodes magnets for name
        // resolution before `resolveName` stopped guessing.
        name: shortEventLabel(text),
        summary: text,
        provenance: `passB:${title}`,
        depthLevel: spec.level,
        props: ev.inWorldDate ? { inWorldDate: ev.inWorldDate } : {},
      },
    );
    for (const participantId of participants) {
      edgeWrites.push({ subject: participantId, predicate: 'INVOLVED_IN', object: id, weight: 0.6 });
      out.eventParticipants++;
    }
    out.events++;
  }

  // Entities before edges, so INVOLVED_IN lands against event rows that exist.
  await world.graph.upsertMany(entityWrites, 'canon');
  await world.graph.assertEdgesMany(edgeWrites, 0, 'canon', `passB:${title}`);

  if (keptNotes.length) {
    const current = await world.graph.get(entity.id);
    if (current) {
      const existing = Array.isArray(current.props?.pageEvents) ? (current.props.pageEvents as unknown[]).map(String) : [];
      const merged = [...new Set([...existing, ...keptNotes])].slice(0, MAX_ENTITY_EVENT_NOTES);
      await world.graph.upsert({ ...current, props: { ...current.props, pageEvents: merged } }, 'canon');
    }
  }

  if (result.voiceCard && spec.voiceCards !== 'none') {
    const sheet = await world.cast.getOrBlank(entity.id);
    const v = result.voiceCard;
    sheet.voice = {
      diction: v.diction || sheet.voice.diction,
      tics: [...new Set([...sheet.voice.tics, ...(v.tics ?? [])])],
      samples: [...new Set([...sheet.voice.samples, ...(v.samples ?? [])])].slice(0, 8),
      never: [...new Set([...sheet.voice.never, ...(v.never ?? [])])],
    };
    await world.cast.put(sheet, 'canon');
    out.voiceCards++;
  }

  // Contradictions are kept as competing claims with sources rather than
  // resolved: wikis mix continuities, and the fidelity dial decides at play time.
  for (const c of result.contradictions ?? []) {
    await world.chronicle.addDivergence(0, 'canon-contradiction', `${c.claim} (conflicts with: ${c.conflictsWith})`, title);
  }

  await world.graph.setDepth(entity.id, spec.level);
}

/**
 * Upgrades existing nodes to a higher depth. Only touches nodes below the
 * target, so this is a diff rather than a re-run.
 */
export async function upgradeDepth(
  db: Db,
  world: World,
  target: DepthMode,
  opts: { client: PageSource; extractor?: PassBExtractor; limit?: number; wiki?: string },
): Promise<{ examined: number; upgraded: number; passA: PassAResult | null }> {
  const spec = MODES[target];
  const stale = await world.graph.belowDepth(spec.level, opts.limit ?? 200);
  if (!stale.length) return { examined: 0, upgraded: 0, passA: null };

  const pages = await opts.client.fetchPages(stale.map((e) => e.name));
  const passA = await runPassA(db, world, pages, {
    depth: spec.level,
    wiki: opts.wiki ?? 'wiki',
    voiceCards: spec.voiceCards !== 'none',
  });

  // Mark even the nodes with no page, or they are re-examined on every upgrade.
  const fetched = new Set(pages.map((p) => p.title.toLowerCase()));
  for (const e of stale) {
    if (!fetched.has(e.name.toLowerCase())) await world.graph.setDepth(e.id, spec.level);
  }

  return { examined: stale.length, upgraded: passA.entities, passA };
}

/**
 * Deepens a neighbourhood rather than the whole wiki. This is the per-subgraph
 * lever: deep pockets only where the story actually goes.
 */
export async function promoteRegion(
  db: Db,
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
    // One batched neighbourhood read per hop rather than one per node.
    const hopNeighbours = await world.graph.neighboursMany(frontier);
    for (const list of hopNeighbours.values()) {
      for (const { otherId } of list) {
        if (seen.has(otherId)) continue;
        seen.add(otherId);
        next.push(otherId);
      }
    }
    frontier = next;
  }

  const fetched = await world.graph.getMany([...seen]);
  const needed = [...fetched.values()].filter((e) => e.depthLevel < spec.level);
  if (!needed.length) return { titles: [], passA: null };

  const pages = await opts.client.fetchPages(needed.map((e) => e.name));
  const passA = await runPassA(db, world, pages, { depth: spec.level, wiki: opts.wiki ?? 'wiki', voiceCards: spec.voiceCards !== 'none' });
  for (const e of needed) await world.graph.setDepth(e.id, spec.level);

  return { titles: needed.map((e) => e.name), passA };
}

/**
 * Just-in-time deepening for play time: when the story approaches a node still
 * at skim level, deepen it before the scene. This is what makes skim a viable
 * permanent baseline.
 */
export async function deepenOnDemand(
  db: Db,
  world: World,
  entityId: EntityId,
  target: DepthMode,
  opts: { client: PageSource; extractor?: PassBExtractor; wiki?: string },
): Promise<boolean> {
  const entity = await world.graph.get(entityId);
  const spec = MODES[target];
  if (!entity || entity.depthLevel >= spec.level) return false;

  const page = await opts.client.fetchPage(entity.name);
  if (!page) {
    // Emergent entities have no page and never will; marking them prevents an
    // endless retry every time the player walks back into the room.
    await world.graph.setDepth(entityId, spec.level);
    return false;
  }
  await runPassA(db, world, [page], { depth: spec.level, wiki: opts.wiki ?? 'wiki', voiceCards: spec.voiceCards !== 'none' });
  await world.graph.setDepth(entityId, spec.level);
  return true;
}

/** Nodes the Director should pre-deepen, given where the story is pointing. */
export async function deepenTargets(world: World, target: DepthMode, limit = 5): Promise<Entity[]> {
  const spec = MODES[target];
  const salient = await world.graph.list({ limit: 200, minSalience: 0.3 });
  return salient
    .filter((e) => e.depthLevel < spec.level && !e.provenance.startsWith('emergent'))
    .slice(0, limit);
}
