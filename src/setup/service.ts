/**
 * Setup service. The single entry point the UI talks to.
 *
 * The flow it enforces matters as much as the steps: nothing is committed until
 * the player has seen a preview with a page count and a cost. A crawl that
 * silently pulls three thousand pages of a continuity nobody cares about is the
 * likeliest way this whole step goes wrong, so the preview is not skippable.
 */
import type { World } from '../store/index.ts';
import { createStory } from '../store/world.ts';
import type { StoryId } from '../domain/types.ts';
import type { Registry } from '../providers/provider.ts';
import { WikiClient } from '../ingest/client.ts';
import { crawl, discover, prune, type CrawlProgress, type CrawlResult, type DiscoveryPreview } from '../ingest/scope.ts';
import { runPassA } from '../ingest/passA.ts';
import { LlmPassBExtractor } from '../ingest/passB.ts';
import { applyPassB, depthByHops, emptyPassBCounters, specFor, parseBudget, budgetToWire, budgetLabel, UNLIMITED, type DepthMode, type DepthSpec, type IngestLimits } from '../ingest/depth.ts';
import { WikiDirectory, type DirectoryOptions, type WikiCandidate } from './directory.ts';
import { SetupPlanner, type IngestPlan, type CharacterSketch } from './planner.ts';
import { applyCustomWorld, applyStyle, assignPlayerCharacter, proposeOpening, type ApplyCustomResult } from './apply.ts';
import { JobRegistry, type Job, type JobHandle } from './jobs.ts';
import { seedWorld } from '../seed/verrow.ts';
import { installPack, packById, packSummaries, type PackSummary } from '../packs/index.ts';

export type WorldSource = 'fandom' | 'custom' | 'sample';

export interface SetupServiceOptions {
  world: World | (() => World);
  providers: Registry;
  /** Injected for tests: fetchers for the directory and for wiki content. */
  directoryOptions?: DirectoryOptions;
  wikiFetcher?: ConstructorParameters<typeof WikiClient>[0]['fetcher'];
  jobs?: JobRegistry;
}

export interface PreviewResult {
  preview: DiscoveryPreview;
  mode: DepthMode;
  seeds: string[];
  /** Time estimate in seconds, so "deep" is an informed choice. */
  estimatedSeconds: number;
  /**
   * The budgets this preview actually ran with, mode preset plus any
   * overrides, in JSON-safe form (`'all'` rather than `Infinity`). Returned
   * because a caller that passed no overrides still needs to know what it is
   * about to commit to, and because "the preview said 3,000 pages" should be
   * checkable against what the run does.
   */
  budgets: { maxPages: number | 'all'; hops: number | 'all'; passBMaxPages: number | 'all' };
}

export interface IngestJobResult {
  entities: number;
  edges: number;
  sheets: number;
  passB: { pages: number; relations: number; events: number; voiceCards: number; dropped: number } | null;
  playerCharacterId: string;
  opening: string;
  warnings: string[];
}

/**
 * What a later session needs to continue reading a wiki without asking the
 * player to re-enter the universe, seeds and mode. Stored as one JSON blob
 * under a single `meta` key rather than its own table: this is world-level
 * bookkeeping in the same spirit as `worldTitle` (`ChronicleStore.setMeta`),
 * not canon, and a table would be one column read/written as a unit anyway.
 */
export interface IngestContext {
  baseUrl: string;
  mode: DepthMode;
  seeds: string[];
  excludeCategories: string[];
  title: string;
  wikiName: string;
  /**
   * Budget overrides this world was built with, so "continue reading this
   * wiki" resumes at the same breadth instead of silently falling back to the
   * mode preset. Stored in wire form (`'all'`, never `Infinity`) because this
   * blob is JSON in a `meta` row. Absent on every world ingested before
   * budgets were overridable, which reads as "use the preset" — the behaviour
   * those worlds already had.
   */
  budgets?: { maxPages?: number | 'all'; hops?: number | 'all'; passBMaxPages?: number | 'all' };
}

const INGEST_CONTEXT_META_KEY = 'ingestContext';

/**
 * Refuses an unlimited budget on the server-side ingest path.
 *
 * This service crawls live `api.php` (see `SetupService.client`) — it has no
 * dump-backed `PageSource` wired into it. An unlimited crawl there is a walk
 * until the link frontier runs dry: tens of thousands of requests against
 * somebody else's wiki, and unbounded rather than merely slow. So the
 * *budget* is uncapped (any finite page count you ask for is honoured, the
 * old 3,000 ceiling is gone) while *unlimited* stays a dump-only operation,
 * which today means `pnpm ingest --dump --mode=all`.
 *
 * Thrown rather than clamped: silently turning "all" into 3,000 pages is
 * exactly the kind of quiet substitution that makes an ingest look complete
 * when it is not.
 */
function assertBudgetIsServable(mode: DepthMode, spec: DepthSpec): void {
  if (Number.isFinite(spec.maxPages) && Number.isFinite(spec.hops)) return;
  throw new Error(
    `an unlimited ingest budget (mode "${mode}": maxPages=${budgetLabel(spec.maxPages)}, hops=${budgetLabel(spec.hops)}) ` +
      `is only supported against a wiki XML dump, which this server does not load. ` +
      `Run it offline instead — pnpm ingest --wiki=<url> --seed="…" --dump --mode=all --commit — ` +
      `or give a finite page budget here (any size; there is no 3,000-page ceiling any more).`,
  );
}

/**
 * One place that turns a phase's counters into the stage detail every ingest
 * path shows, so the wizard, the API and MCP all report progress identically.
 *
 * A percentage appears only when the total is real. During a crawl that means
 * a dump-backed source or a finite page budget; the live-crawl-with-no-budget
 * case falls back to "3,502 fetched, 1,900 queued", which is a true statement
 * about a moving target rather than a percentage against a guess — the
 * distinction `JobProgress`'s own header comment insists on.
 */
export function progressDetail(done: number, total: number | null, noun = 'pages'): string {
  const n = done.toLocaleString();
  if (!total || total <= 0) return `${n} ${noun}`;
  const pct = Math.min(100, Math.floor((done / total) * 100));
  return `${n} of ${total.toLocaleString()} ${noun} \u00b7 ${pct}%`;
}

function saveIngestContext(world: World, ctx: IngestContext): void {
  world.chronicle.setMeta(INGEST_CONTEXT_META_KEY, JSON.stringify(ctx));
}

function loadIngestContext(world: World): IngestContext | null {
  const raw = world.chronicle.getMeta(INGEST_CONTEXT_META_KEY, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IngestContext;
  } catch {
    return null;
  }
}

/**
 * The stored wire form of a world's budgets back into `IngestLimits`.
 * Tolerant on purpose: this is JSON that an older build wrote (no `budgets`
 * key at all) or that a hand-edited `meta` row could malform, and the right
 * answer to anything unreadable is "fall back to the mode preset", not a
 * thrown error that makes the world un-continuable.
 */
export function budgetsToLimits(budgets: IngestContext['budgets']): IngestLimits {
  if (!budgets) return {};
  const one = (v: number | 'all' | undefined): number | undefined => {
    if (v === 'all') return UNLIMITED;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const maxPages = one(budgets.maxPages);
  const hops = one(budgets.hops);
  const passBMaxPages = one(budgets.passBMaxPages);
  return {
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(hops !== undefined ? { hops } : {}),
    ...(passBMaxPages !== undefined ? { passBMaxPages } : {}),
  };
}

/**
 * Parses the three budget fields off a request body / MCP argument object into
 * `IngestLimits`. One place, so the REST routes and the MCP tools cannot drift
 * on what `"all"` or a bad value means — `parseBudget` throws on anything that
 * is neither a positive integer nor `"all"`.
 */
export function limitsFromWire(input: {
  maxPages?: unknown;
  hops?: unknown;
  passBMaxPages?: unknown;
}): IngestLimits {
  const maxPages = parseBudget(input.maxPages, 'maxPages');
  const hops = parseBudget(input.hops, 'hops');
  const passBMaxPages = parseBudget(input.passBMaxPages, 'passBMaxPages');
  return {
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(hops !== undefined ? { hops } : {}),
    ...(passBMaxPages !== undefined ? { passBMaxPages } : {}),
  };
}

export interface IngestHealth {
  /** False when this world was never ingested from a wiki (custom or sample). */
  hasContext: boolean;
  context: IngestContext | null;
  /** Pages Pass B has genuinely finished, across every ingest run on this wiki. */
  pagesDone: number;
  /** Pages Pass B attempted and failed — a dead token, a rate limit, and so on. */
  pagesFailed: number;
  /** Pages Pass A has logged that Pass B has not yet reached at all. */
  pagesPending: number;
}

export class SetupService {
  /**
   * A getter, not a resolved `World`. Same reasoning as `Engine`/`Compactor`:
   * this service is held for the process lifetime, but which world/story is
   * "current" can change under it. `startIngest`/`startCustomWorld` in
   * particular capture this synchronously and use it later inside an async
   * job closure — exactly the shape that goes stale silently if it is a
   * resolved reference instead of a live one.
   */
  private getWorld: () => World;
  private providers: Registry;
  private directory: WikiDirectory;
  private planner: SetupPlanner;
  private wikiFetcher: SetupServiceOptions['wikiFetcher'];
  readonly jobs: JobRegistry;
  /** Cached crawl per preview, so committing does not re-fetch every page. */
  private crawls = new Map<
    string,
    { crawl: CrawlResult; baseUrl: string; mode: DepthMode; limits: IngestLimits; title: string; seeds: string[]; excludeCategories: string[] }
  >();

  constructor(opts: SetupServiceOptions) {
    this.getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
    this.providers = opts.providers;
    this.directory = new WikiDirectory(opts.directoryOptions ?? {});
    // A getter, not a resolved provider: a live profile switch replaces what
    // `this.providers.get()` returns, and the planner must see that on its next
    // call rather than keep writing on whatever was live at construction.
    this.planner = new SetupPlanner(() => opts.providers.get('setup'));
    this.wikiFetcher = opts.wikiFetcher;
    this.jobs = opts.jobs ?? new JobRegistry();
  }

  /**
   * True when this save has no canon yet, which is what the UI gates the wizard
   * on. An existence check rather than a count: see `GraphStore.isEmpty` for
   * why the difference is worth a method.
   */
  isFresh(): boolean {
    return this.getWorld().graph.isEmpty();
  }

  async resolveWiki(query: string): Promise<WikiCandidate[]> {
    return this.directory.resolve(query);
  }

  async startingPoints(baseUrl: string, hint = ''): Promise<Array<{ title: string; kind: string; members: number }>> {
    return this.directory.suggestStartingPoints(baseUrl, hint);
  }

  /** Free text plus a resolved wiki becomes an editable plan. */
  async plan(wish: string, wiki: WikiCandidate): Promise<IngestPlan & { startingPoints: Array<{ title: string; kind: string; members: number }> }> {
    const startingPoints = await this.startingPoints(wiki.baseUrl, wish);
    const plan = await this.planner.plan({ wish, wiki, startingPoints });
    return { ...plan, startingPoints };
  }

  private client(baseUrl: string): WikiClient {
    return new WikiClient({
      baseUrl,
      ...(this.wikiFetcher ? { fetcher: this.wikiFetcher } : {}),
      delayMs: this.wikiFetcher ? 0 : 200,
    });
  }

  /**
   * Crawls and reports what an ingest would cost, without writing anything.
   * The crawl is cached under a key the caller passes back to `startIngest`, so
   * confirming a preview does not pay for the fetch twice.
   *
   * `onProgress` is optional and exists so `discover` (below) can report real
   * stage/count during the crawl; called directly, `preview` stays a plain
   * async call with no job involved, which is what the test suite and any
   * caller not wired to `JobRegistry` still expect.
   *
   * `limits` raises or lowers the mode's page/hop budgets for this run. An
   * *unlimited* budget is refused here rather than attempted — see
   * `assertBudgetIsServable`.
   */
  async preview(
    baseUrl: string,
    seeds: string[],
    mode: DepthMode,
    excludeCategories: string[] = [],
    title = '',
    onProgress?: (info: CrawlProgress) => void,
    limits: IngestLimits = {},
  ): Promise<PreviewResult & { previewKey: string }> {
    const spec = specFor(mode, limits);
    assertBudgetIsServable(mode, spec);
    const client = this.client(baseUrl);
    const crawled = await crawl({ client, seeds, hops: spec.hops, maxPages: spec.maxPages, onProgress });
    const scoped = prune(crawled, { maxPages: spec.maxPages, excludeCategories });
    const preview = discover(scoped, { maxPages: spec.maxPages });

    // The budgets are part of the key: two previews of the same wiki and seeds
    // at different page budgets are different crawls, and sharing one cache
    // entry would let a commit run against the other one's scope.
    const previewKey = `${baseUrl}|${seeds.join(',')}|${mode}|${budgetToWire(spec.maxPages)}|${budgetToWire(spec.hops)}|${budgetToWire(spec.passBMaxPages)}`;
    this.crawls.set(previewKey, { crawl: scoped, baseUrl, mode, limits, title, seeds, excludeCategories });

    // Pass A is fast; Pass B is one model call per page and dominates everything.
    const selected = spec.passB === 'all' ? preview.candidatePages : Math.floor(preview.candidatePages * 0.25);
    const passBPages = spec.passB === 'none' ? 0 : Math.min(selected, spec.passBMaxPages);
    const estimatedSeconds = Math.round(preview.candidatePages * 0.15 + passBPages * 3);

    return {
      preview,
      mode,
      seeds,
      estimatedSeconds,
      budgets: {
        maxPages: budgetToWire(spec.maxPages),
        hops: budgetToWire(spec.hops),
        passBMaxPages: budgetToWire(spec.passBMaxPages),
      },
      previewKey,
    };
  }

  /**
   * Same work as `preview`, run as a background job so the UI can show real
   * progress instead of a bare "checking…" — a `mid`/`deep` crawl is easily
   * the slowest step in the whole wizard, and until now it was the one step
   * with no `JobRegistry` behind it at all.
   *
   * Also refines the character sketch against what the crawl actually found —
   * named characters, factions, locations — rather than leaving it as a guess
   * made from page *titles* before anything was read. Still just a proposal:
   * the result is returned for the player to edit, nothing is written to
   * canon here.
   */
  startDiscover(
    baseUrl: string,
    seeds: string[],
    mode: DepthMode,
    character: CharacterSketch,
    excludeCategories: string[] = [],
    title = '',
    limits: IngestLimits = {},
  ): Job<PreviewResult & { previewKey: string; character: CharacterSketch }> {
    return this.jobs.start('discover', async (handle) => {
      handle.stage('reading the wiki\u2019s map', 'finding pages in scope');
      const result = await this.preview(
        baseUrl,
        seeds,
        mode,
        excludeCategories,
        title,
        (info) => {
          // Counted in *pages*, not hops: a hop is a meaningless unit to watch
          // (hop 3 of 4 can be 90% of the work) and an unlimited crawl has no
          // hop total at all. Pages have an honest ceiling whenever the source
          // can count itself or a budget was given — see `info.pageTotal`.
          const detail = info.pageTotal
            ? progressDetail(info.pagesFetched, info.pageTotal)
            : `${info.pagesFetched.toLocaleString()} pages, ${info.queued.toLocaleString()} queued`;
          handle.stage('crawling', detail);
          handle.count(info.pagesFetched, info.pageTotal);
        },
        limits,
      );

      handle.stage('sharpening your character', 'matching it against what was actually found');
      const refined = await this.planner.refineCharacter(character, {
        characters: result.preview.characters,
        factions: result.preview.factions,
        locations: result.preview.locations,
      });

      handle.stage('done');
      return { ...result, character: refined };
    });
  }

  /**
   * Commits a previewed scope as a background job.
   *
   * Requires a preview key rather than accepting seeds directly, which makes the
   * "see the cost first" step structural instead of a convention the UI could
   * quietly skip.
   */
  startIngest(
    previewKey: string,
    plan: { character: CharacterSketch; style: Partial<IngestPlan['style']>; opening: string },
  ): Job<IngestJobResult> {
    const cached = this.crawls.get(previewKey);
    if (!cached) throw new Error('no preview for that key; run a preview first');

    const { crawl: scoped, baseUrl, mode, limits, title, seeds, excludeCategories } = cached;
    const spec = specFor(mode, limits);
    const wikiName = new URL(baseUrl).hostname.split('.')[0] ?? 'wiki';

    return this.jobs.start<IngestJobResult>('ingest', async (handle) => {
      // Resolved once, when the job actually starts running, not when it was
      // scheduled — and held for the job's whole lifetime rather than
      // re-resolved per step: an ingest is one continuous act of writing canon,
      // and letting the target world change mid-write would split the ingest
      // across two stories/worlds, which is a real corruption, not a stale-read.
      const world = this.getWorld();
      world.chronicle.setMeta('worldTitle', title || wikiName);
      // Persisted so a later session can offer "continue reading this wiki"
      // without asking the player to re-enter the universe, seeds and mode —
      // the whole reason a resume needs no return trip through the wizard.
      saveIngestContext(world, {
        baseUrl,
        mode,
        seeds,
        excludeCategories,
        title,
        wikiName,
        budgets: {
          maxPages: budgetToWire(spec.maxPages),
          hops: budgetToWire(spec.hops),
          passBMaxPages: budgetToWire(spec.passBMaxPages),
        },
      });
      const warnings: string[] = [];
      const pages = [...scoped.pages.values()];

      handle.stage('building the graph', 'infoboxes, categories, links');
      const passA = runPassA(world, pages, {
        depth: spec.level,
        // Crawl distance becomes depth, so the corner the player is in is
        // recorded as deeper than the rim — see `depthByHops`.
        depthByTitle: depthByHops(scoped, spec.level),
        wiki: wikiName,
        voiceCards: spec.voiceCards !== 'none',
        // Pass A knows its total from the first line, so this is the one phase
        // that can show a true percentage throughout. Over tens of thousands of
        // pages it is also long enough that silence reads as a hang.
        onProgress: (done, total, phase) => {
          handle.stage(phase === 'parsing' ? 'reading pages' : 'building the graph', progressDetail(done, total));
          handle.count(done, total);
        },
      });
      handle.log(`${passA.entities} entities, ${passA.edges} typed edges, ${passA.sheets} sheets`);
      if (passA.unmatchedRelationFields.length) {
        // Visible rather than silent: this is how you find out that a wiki
        // files its relations under names `RELATION_FIELDS` has never seen.
        handle.log(
          `infobox fields that look relational but matched no rule: ${passA.unmatchedRelationFields
            .slice(0, 8)
            .map((f) => `${f.field} (${f.count})`)
            .join(', ')}`,
        );
      }
      if (passA.skipped.length) handle.log(`skipped ${passA.skipped.length} thin or malformed page(s)`);

      const { passB, warnings: passBWarnings } = await this.runResumablePassB(world, handle, scoped, spec, wikiName);
      warnings.push(...passBWarnings);

      handle.stage('placing your character');
      const assigned = assignPlayerCharacter(world, plan.character);
      warnings.push(...assigned.warnings);

      applyStyle(world, plan.style);

      // Threads come from Pass B events and canon tension; if nothing emerged the
      // world is technically playable but has no pressure, which is worth saying.
      if (world.threads.open().length === 0) {
        warnings.push('no open threads yet — the Director will have to invent the first pressure');
      }

      const opening = plan.opening || proposeOpening(world);
      world.chronicle.upsertScene(1, { summary: '', chapter: 1 });

      handle.stage('done');
      return {
        entities: passA.entities,
        edges: passA.edges,
        sheets: passA.sheets,
        passB,
        playerCharacterId: assigned.playerCharacterId,
        opening,
        warnings,
      };
    });
  }

  /**
   * Runs Pass B over a scoped crawl, resuming rather than redoing: any page
   * this wiki already has marked `passb_status = 'done'` (from this run or an
   * earlier, interrupted one) is skipped outright. Shared by `startIngest`
   * and `continueIngest` — the wizard's first ingest and a later "finish
   * reading this wiki" are the same operation over a possibly-extended scope,
   * not two different code paths that could drift.
   *
   * Failures are recorded, not swallowed: `PassBOutput.failed` (set by
   * `LlmPassBExtractor` when the provider call itself threw — an expired
   * token, a rate limit, unparseable output) marks the page `'failed'`
   * instead of `'done'`, so the *next* resume retries exactly that page
   * rather than treating a dead credential as "read and found nothing".
   */
  private async runResumablePassB(
    world: World,
    handle: JobHandle,
    scoped: CrawlResult,
    spec: DepthSpec,
    wikiName: string,
  ): Promise<{ passB: IngestJobResult['passB']; warnings: string[] }> {
    const warnings: string[] = [];
    if (spec.passB === 'none') return { passB: null, warnings };

    const extractor = new LlmPassBExtractor({
      provider: this.providers.get('passb'),
      world,
      onError: (title, err) => handle.log(`pass B failed on ${title}: ${err instanceof Error ? err.message : String(err)}`),
    });

    const selected =
      spec.passB === 'all'
        ? scoped.candidates
        : scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));
    // The same cap `runPassB` applies (see `DepthSpec.passBMaxPages`). This
    // path duplicates target selection rather than calling `runPassB`, because
    // it needs per-page job progress and cooperative cancellation — so the cap
    // has to be applied here too, or a large crawl would quietly bill for one
    // model call per page on the server path while the CLI honoured the limit.
    // Candidates are score-sorted, so this keeps the best pages.
    const targets = Number.isFinite(spec.passBMaxPages) ? selected.slice(0, spec.passBMaxPages) : selected;
    if (targets.length < selected.length) {
      handle.log(`relation extraction capped at ${targets.length.toLocaleString()} of ${selected.length.toLocaleString()} pages, highest-scoring first`);
    }

    const already = new Set(
      (world.db.prepare(`SELECT page_id FROM ingest_pages WHERE wiki = ? AND passb_status = 'done'`).all(wikiName) as Array<{
        page_id: string;
      }>).map((r) => r.page_id),
    );
    const pending = targets.filter((c) => {
      const page = scoped.pages.get(c.title);
      return page && !already.has(page.pageId);
    });
    if (already.size) handle.log(`resuming: ${already.size} page(s) already extracted, ${pending.length} left`);

    handle.stage('reading the prose', progressDetail(0, pending.length));
    let done = 0;
    let failed = 0;
    const counters = emptyPassBCounters();

    for (const candidate of pending) {
      if (handle.cancelled()) {
        handle.log('cancelled; keeping what was already written');
        break;
      }
      const page = scoped.pages.get(candidate.title);
      const entity = page ? world.graph.resolveName(candidate.title) : undefined;
      if (!page || !entity) continue;

      const out = await extractor.extract(page, entity);
      if (out.failed) {
        // Recorded so a later resume retries exactly this page, not silently
        // treated as "read and found nothing" — which is the failure mode
        // that made a dead token unresumable before this status existed.
        world.db.prepare(`UPDATE ingest_pages SET passb_status = 'failed' WHERE page_id = ? AND wiki = ?`).run(page.pageId, wikiName);
        failed++;
        handle.count(done + failed, pending.length);
        handle.stage('reading the prose', progressDetail(done + failed, pending.length));
        continue;
      }
      // One writer, shared with the CLI path. This loop used to carry its own
      // copy of the apply logic, which handled relations, voice and
      // contradictions but silently never created event nodes at all — so the
      // same pages produced a different graph depending on whether the ingest
      // came through the wizard or the CLI. See `applyPassB`.
      applyPassB(world, spec, candidate.title, entity, out, counters);
      world.db.prepare(`UPDATE ingest_pages SET passb_status = 'done' WHERE page_id = ? AND wiki = ?`).run(page.pageId, wikiName);
      done++;
      handle.count(done + failed, pending.length);
      // Re-stated per page: this is the phase that runs for hours, so the
      // detail line is the only thing telling you it is still moving.
      handle.stage('reading the prose', progressDetail(done + failed, pending.length));
    }

    const st = extractor.stats;
    const dropped = st.droppedNoEvidence + st.droppedBadPredicate + st.droppedUnknownObject;
    const passB = {
      pages: done,
      relations: counters.edges,
      events: counters.events,
      voiceCards: counters.voiceCards,
      dropped,
    };
    handle.log(`kept ${counters.edges} relations, dropped ${dropped} unevidenced or unresolvable${failed ? `, ${failed} page(s) failed and can be resumed later` : ''}`);
    handle.log(
      `${counters.events} event(s) with ${counters.eventParticipants} participant link(s); ` +
        `${counters.eventsSkipped} undated single-subject statement(s) kept on their entity instead of becoming nodes`,
    );
    if (failed) warnings.push(`${failed} page(s) could not be read (a dead token or rate limit, most likely) — this ingest can be continued later from Settings without re-reading what already succeeded`);

    return { passB, warnings };
  }

  /**
   * What Settings shows: whether this world came from a wiki at all, and how
   * much of the last ingest's scope Pass B has actually finished. `pending`
   * covers both "never reached" (a page Pass A logged but Pass B has not yet
   * attempted, e.g. under mid's core-only subsetting) and, implicitly, a
   * wiki this world has no `ingest_pages` rows for yet.
   */
  ingestHealth(): IngestHealth {
    const world = this.getWorld();
    const context = loadIngestContext(world);
    if (!context) return { hasContext: false, context: null, pagesDone: 0, pagesFailed: 0, pagesPending: 0 };

    const counts = world.db
      .prepare(
        `SELECT
           SUM(CASE WHEN passb_status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN passb_status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN passb_status = '' THEN 1 ELSE 0 END) AS pending
         FROM ingest_pages WHERE wiki = ?`,
      )
      .get(context.wikiName) as { done: number | null; failed: number | null; pending: number | null };

    return {
      hasContext: true,
      context,
      pagesDone: counts.done ?? 0,
      pagesFailed: counts.failed ?? 0,
      pagesPending: counts.pending ?? 0,
    };
  }

  /**
   * Continues an ingest that was interrupted, or extends one with a broader
   * seed set or a deeper mode — the same mechanism either way, since both are
   * "re-crawl this scope, run Pass A (idempotent), run Pass B only on what
   * Pass B has not genuinely finished yet". Needs no return trip through the
   * wizard: `ingestHealth()`'s persisted context already has the wiki, seeds
   * and mode this world was built from.
   *
   * `overrides` lets a caller widen the scope for "read more" rather than
   * just "finish what was started" — a larger seed list, added exclusions, a
   * deeper mode, or a bigger page budget, all still resuming rather than
   * re-paying for pages already `done`. Raising `limits.maxPages` on a world
   * that was first read at 600 pages is the intended way to say "keep going,
   * further out" without starting over.
   */
  continueIngest(
    overrides: { seeds?: string[]; mode?: DepthMode; excludeCategories?: string[]; limits?: IngestLimits } = {},
  ): Job<IngestJobResult> {
    const world = this.getWorld();
    const context = loadIngestContext(world);
    if (!context) throw new Error('this world has no wiki ingest to continue — it was not built from a wiki, or predates this feature');

    const baseUrl = context.baseUrl;
    const mode = overrides.mode ?? context.mode;
    const seeds = overrides.seeds?.length ? overrides.seeds : context.seeds;
    const excludeCategories = overrides.excludeCategories ?? context.excludeCategories;
    // Budgets resolve newest-first: this call's overrides, else whatever this
    // world was last ingested with, else the mode preset.
    const limits: IngestLimits = { ...budgetsToLimits(context.budgets), ...(overrides.limits ?? {}) };
    const spec = specFor(mode, limits);
    assertBudgetIsServable(mode, spec);
    const wikiName = context.wikiName;

    return this.jobs.start<IngestJobResult>('continue-ingest', async (handle) => {
      handle.stage('reading the wiki\u2019s map', 'finding pages in scope');
      const client = this.client(baseUrl);
      const crawled = await crawl({ client, seeds, hops: spec.hops, maxPages: spec.maxPages, onProgress: (info) => {
        const detail = info.pageTotal
          ? progressDetail(info.pagesFetched, info.pageTotal)
          : `${info.pagesFetched.toLocaleString()} pages, ${info.queued.toLocaleString()} queued`;
        handle.stage('crawling', detail);
        handle.count(info.pagesFetched, info.pageTotal);
      } });
      const scoped = prune(crawled, { maxPages: spec.maxPages, excludeCategories });

      // Re-persist: a "read more" call may have widened seeds/mode/exclusions,
      // and the next resume should pick those up rather than the narrower
      // scope the very first ingest started from.
      saveIngestContext(world, {
        baseUrl,
        mode,
        seeds,
        excludeCategories,
        title: context.title,
        wikiName,
        budgets: {
          maxPages: budgetToWire(spec.maxPages),
          hops: budgetToWire(spec.hops),
          passBMaxPages: budgetToWire(spec.passBMaxPages),
        },
      });

      const warnings: string[] = [];
      const pages = [...scoped.pages.values()];
      handle.stage('building the graph', 'infoboxes, categories, links');
      // Idempotent by construction (`passA.ts`'s doc comment): entity ids are
      // deterministic slugs, so re-running over pages already ingested
      // updates in place rather than duplicating.
      const passA = runPassA(world, pages, {
        depth: spec.level,
        // Crawl distance becomes depth, so the corner the player is in is
        // recorded as deeper than the rim — see `depthByHops`.
        depthByTitle: depthByHops(scoped, spec.level),
        wiki: wikiName,
        voiceCards: spec.voiceCards !== 'none',
        onProgress: (done, total, phase) => {
          handle.stage(phase === 'parsing' ? 'reading pages' : 'building the graph', progressDetail(done, total));
          handle.count(done, total);
        },
      });
      handle.log(`${passA.entities} entities, ${passA.edges} typed edges, ${passA.sheets} sheets`);
      if (passA.unmatchedRelationFields.length) {
        // Visible rather than silent: this is how you find out that a wiki
        // files its relations under names `RELATION_FIELDS` has never seen.
        handle.log(
          `infobox fields that look relational but matched no rule: ${passA.unmatchedRelationFields
            .slice(0, 8)
            .map((f) => `${f.field} (${f.count})`)
            .join(', ')}`,
        );
      }

      const { passB, warnings: passBWarnings } = await this.runResumablePassB(world, handle, scoped, spec, wikiName);
      warnings.push(...passBWarnings);

      handle.stage('done');
      return {
        entities: passA.entities,
        edges: passA.edges,
        sheets: passA.sheets,
        passB,
        playerCharacterId: world.session.get().playerCharacterId,
        opening: '',
        warnings,
      };
    });
  }

  /** Builds an authored world from a description. No wiki involved. */
  startCustomWorld(description: string, style?: Partial<IngestPlan['style']>): Job<ApplyCustomResult> {
    const planner = this.planner;

    return this.jobs.start<ApplyCustomResult>('custom-world', async (handle) => {
      handle.stage('inventing the world', 'locations, factions, cast');
      const raw = await planner.customWorld(description);

      // Resolved after the (only) await in this job, same reasoning as
      // startIngest: one continuous act of authoring canon, held for its
      // whole lifetime rather than re-resolved mid-write.
      const world = this.getWorld();
      handle.stage('writing it down');
      const result = applyCustomWorld(world, raw);
      handle.log(`${result.entities} entities, ${result.edges} relations, ${result.threads} threads`);
      for (const w of result.warnings) handle.log(w);

      if (style) applyStyle(world, style);
      if (!result.opening) result.opening = proposeOpening(world);

      handle.stage('done');
      return result;
    });
  }

  /** The built-in example, for trying the engine without any setup at all. */
  useSample(): { playerCharacterId: string; opening: string } {
    const world = this.getWorld();
    seedWorld(world);
    world.chronicle.setMeta('worldTitle', 'Saint Verrow');
    return {
      playerCharacterId: world.session.get().playerCharacterId,
      opening: proposeOpening(world),
    };
  }

  /**
   * Installs one of the shipped original worlds and returns the story to bind to.
   *
   * Unlike every other route in this service, this one creates *several* stories
   * — one per scenario in the pack — because the canon is shared and the
   * scenarios are chronicle overlays on top of it (see `packs/apply.ts`). That
   * makes the return value load-bearing: the caller must rebind its
   * `CurrentStory` to `storyId`, or the next request resolves against whichever
   * story the file happened to open with rather than the scenario the player
   * just chose.
   *
   * Warnings are returned rather than thrown. A shipped pack should produce none
   * — `test/packs.test.ts` asserts exactly that for every registered pack — so
   * anything here means a pack regressed, and the player is better served by a
   * playable world plus a note than by a failed setup.
   */
  usePack(packId: string, scenarioId?: string): {
    storyId: StoryId;
    scenarioId: string;
    title: string;
    playerCharacterId: string;
    opening: string;
    scenarios: Array<{ id: string; title: string; storyId: StoryId }>;
    warnings: string[];
  } {
    const pack = packById(packId);
    if (!pack) throw new Error(`no such world pack: ${packId}`);

    const world = this.getWorld();
    const result = installPack(world, pack);
    if (!result.scenarios.length) throw new Error(`${packId} installed no playable scenario`);

    const chosen = scenarioId ? result.scenarios.find((s) => s.id === scenarioId) : result.scenarios[0];
    if (!chosen) throw new Error(`${packId} has no scenario "${scenarioId}"`);

    // `proposeOpening` reads the *current* story, and this service's world is
    // still bound to whatever the file opened with — not to the scenario just
    // chosen. Resolve the opening against the scenario's own story so the first
    // line describes the scene the player is about to be in.
    const scenarioWorld = world.withStory(chosen.storyId);
    return {
      storyId: chosen.storyId,
      scenarioId: chosen.id,
      title: pack.title,
      playerCharacterId: chosen.playerCharacterId,
      opening: chosen.opening || proposeOpening(scenarioWorld),
      scenarios: result.scenarios.map((s) => ({ id: s.id, title: s.title, storyId: s.storyId })),
      warnings: result.warnings,
    };
  }

  /** The shipped worlds, for the picker. Static data; no world access needed. */
  packs(): PackSummary[] {
    return packSummaries();
  }

  /**
   * Wipes a save so the wizard can be run again. Canon included: this is a
   * reset of the whole file, not of one story — under multi-story that is a
   * meaningfully different (and more destructive) operation than "delete this
   * story", which the save browser offers as a separate, less destructive
   * action.
   *
   * Returns the id of the single story the file is left holding, because that
   * is not necessarily the story the caller was on: every previous story row is
   * dropped and one blank story is created to replace them. A caller holding a
   * `CurrentStory` must rebind to this id or its next `world()` resolves against
   * a story that no longer exists.
   */
  reset(): StoryId {
    const world = this.getWorld();
    // Keep this list complete when a table is added. `illustrations` was
    // missing until the integrity check (`store/integrity.ts`) found three
    // portraits in a real save still pointing at `char:brother-anselm` after
    // `entities` had been emptied — the table postdates this method and nothing
    // linked the two. The image *files* under `data/images` are left alone
    // deliberately: they live outside the database, and orphaned files cost
    // disk rather than correctness.
    const tables = [
      'turns', 'events', 'consequences', 'fact_knowledge', 'facts', 'threads',
      'directives', 'divergences', 'style_anchors', 'relationships', 'sheets',
      'edges', 'entities', 'scenes', 'chapters', 'ingest_pages', 'illustrations',
    ];
    for (const t of tables) world.db.prepare(`DELETE FROM ${t}`).run();

    // `stories` was the same omission as `illustrations`, found the same way —
    // by checking rather than trusting. It postdates this method, so a reset
    // emptied canon and left every playthrough row behind: the stories tab
    // still listed them afterwards, contradicting the UI's own promise that
    // this "wipes every story in this file, and canon with them", and one row
    // still carried a `lastPlayedAt` from the world that had just been deleted.
    //
    // Replaced rather than merely emptied, because a file with zero stories is
    // not a valid state to leave behind: `World.open` resolves through
    // `resolveDefaultStory`, and every route resolves through a `CurrentStory`
    // holding an id. Deleting all rows and creating one fresh blank story in
    // the same operation keeps the file openable and gives the wizard exactly
    // the clean slate it would get from a brand-new file.
    world.db.prepare(`DELETE FROM stories`).run();
    const fresh = createStory(world.db, { title: '' });

    // The world label lives in `meta`, which is unscoped by design (it
    // describes the file, not a story) and so survives every table sweep
    // above. Left behind, `/api/state` reported the deleted world's title
    // against an empty graph — the header read "Saint Verrow" with 0 entities
    // until the wizard happened to overwrite it. Cleared here so a reset file
    // is indistinguishable from a new one. `meta` is deleted by key rather
    // than emptied, so anything else stored there later (a schema version, a
    // per-file preference) is not silently destroyed by a world reset.
    world.db.prepare(`DELETE FROM meta WHERE key = 'worldTitle'`).run();

    return fresh.id;
  }
}
