/**
 * Setup service. The single entry point the UI talks to.
 *
 * The flow it enforces matters as much as the steps: nothing is committed until
 * the player has seen a preview with a page count and a cost. A crawl that
 * silently pulls three thousand pages of a continuity nobody cares about is the
 * likeliest way this whole step goes wrong, so the preview is not skippable.
 */
import type { World } from '../store/index.ts';
import type { Registry } from '../providers/provider.ts';
import { WikiClient } from '../ingest/client.ts';
import { crawl, discover, prune, type CrawlResult, type DiscoveryPreview } from '../ingest/scope.ts';
import { runPassA } from '../ingest/passA.ts';
import { LlmPassBExtractor } from '../ingest/passB.ts';
import { MODES, type DepthMode } from '../ingest/depth.ts';
import { WikiDirectory, type DirectoryOptions, type WikiCandidate } from './directory.ts';
import { SetupPlanner, type IngestPlan, type CharacterSketch } from './planner.ts';
import { applyCustomWorld, applyStyle, assignPlayerCharacter, proposeOpening, type ApplyCustomResult } from './apply.ts';
import { JobRegistry, type Job } from './jobs.ts';
import { seedWorld } from '../seed/verrow.ts';

export type WorldSource = 'fandom' | 'custom' | 'sample';

export interface SetupServiceOptions {
  world: World;
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

export class SetupService {
  private world: World;
  private providers: Registry;
  private directory: WikiDirectory;
  private planner: SetupPlanner;
  private wikiFetcher: SetupServiceOptions['wikiFetcher'];
  readonly jobs: JobRegistry;
  /** Cached crawl per preview, so committing does not re-fetch every page. */
  private crawls = new Map<string, { crawl: CrawlResult; baseUrl: string; mode: DepthMode; title: string }>();

  constructor(opts: SetupServiceOptions) {
    this.world = opts.world;
    this.providers = opts.providers;
    this.directory = new WikiDirectory(opts.directoryOptions ?? {});
    // A getter, not a resolved provider: a live profile switch replaces what
    // `this.providers.get()` returns, and the planner must see that on its next
    // call rather than keep writing on whatever was live at construction.
    this.planner = new SetupPlanner(() => opts.providers.get('setup'));
    this.wikiFetcher = opts.wikiFetcher;
    this.jobs = opts.jobs ?? new JobRegistry();
  }

  /** True when this save has no canon yet, which is what the UI gates the wizard on. */
  isFresh(): boolean {
    return this.world.graph.counts().entities === 0;
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
   */
  async preview(baseUrl: string, seeds: string[], mode: DepthMode, excludeCategories: string[] = [], title = ''): Promise<PreviewResult & { previewKey: string }> {
    const spec = MODES[mode];
    const client = this.client(baseUrl);
    const crawled = await crawl({ client, seeds, hops: spec.hops, maxPages: spec.maxPages });
    const scoped = prune(crawled, { maxPages: spec.maxPages, excludeCategories });
    const preview = discover(scoped, { maxPages: spec.maxPages });

    const previewKey = `${baseUrl}|${seeds.join(',')}|${mode}`;
    this.crawls.set(previewKey, { crawl: scoped, baseUrl, mode, title });

    // Pass A is fast; Pass B is one model call per page and dominates everything.
    const passBPages = spec.passB === 'all' ? preview.candidatePages : Math.floor(preview.candidatePages * 0.25);
    const estimatedSeconds = Math.round(preview.candidatePages * 0.15 + (spec.passB === 'none' ? 0 : passBPages * 3));

    return { preview, mode, seeds, estimatedSeconds, previewKey };
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

    const { crawl: scoped, baseUrl, mode, title } = cached;
    const spec = MODES[mode];
    const world = this.world;
    const wikiName = new URL(baseUrl).hostname.split('.')[0] ?? 'wiki';
    world.chronicle.setMeta('worldTitle', title || wikiName);

    return this.jobs.start<IngestJobResult>('ingest', async (handle) => {
      const warnings: string[] = [];
      const pages = [...scoped.pages.values()];

      handle.stage('reading pages', `${pages.length} pages`);
      handle.count(pages.length, pages.length);

      handle.stage('building the graph', 'infoboxes, categories, links');
      const passA = runPassA(world, pages, { depth: spec.level, wiki: wikiName, voiceCards: spec.voiceCards !== 'none' });
      handle.log(`${passA.entities} entities, ${passA.edges} typed edges, ${passA.sheets} sheets`);
      if (passA.skipped.length) handle.log(`skipped ${passA.skipped.length} thin or malformed page(s)`);

      let passB: IngestJobResult['passB'] = null;
      if (spec.passB !== 'none') {
        const extractor = new LlmPassBExtractor({
          provider: this.providers.get('passb'),
          world,
          onError: (title, err) => handle.log(`pass B failed on ${title}: ${err instanceof Error ? err.message : String(err)}`),
        });

        const targets =
          spec.passB === 'all'
            ? scoped.candidates
            : scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));

        handle.stage('reading the prose', `${targets.length} pages`);
        let done = 0;
        let edges = 0;
        let events = 0;
        let voice = 0;

        for (const candidate of targets) {
          if (handle.cancelled()) {
            handle.log('cancelled; keeping what was already written');
            break;
          }
          const page = scoped.pages.get(candidate.title);
          const entity = page ? world.graph.resolveName(candidate.title) : undefined;
          if (!page || !entity) continue;

          const out = await extractor.extract(page, entity);
          for (const e of out.edges) {
            const target = world.graph.resolveName(e.objectName);
            if (!target || target.id === entity.id) continue;
            world.graph.assertEdge(
              { subject: entity.id, predicate: e.predicate, object: target.id, weight: e.weight ?? 0.6, evidence: e.evidence },
              0, 'canon', `passB:${candidate.title}`,
            );
            edges++;
          }
          if (out.voiceCard) {
            const sheet = world.cast.getOrBlank(entity.id);
            sheet.voice = {
              diction: out.voiceCard.diction || sheet.voice.diction,
              tics: [...new Set([...sheet.voice.tics, ...(out.voiceCard.tics ?? [])])],
              samples: [...new Set([...sheet.voice.samples, ...(out.voiceCard.samples ?? [])])].slice(0, 8),
              never: [...new Set([...sheet.voice.never, ...(out.voiceCard.never ?? [])])],
            };
            world.cast.put(sheet);
            voice++;
          }
          events += out.events.length;
          for (const c of out.contradictions ?? []) {
            world.chronicle.addDivergence(0, 'canon-contradiction', `${c.claim} (conflicts with: ${c.conflictsWith})`, candidate.title);
          }
          handle.count(++done, targets.length);
        }

        const st = extractor.stats;
        const dropped = st.droppedNoEvidence + st.droppedBadPredicate + st.droppedUnknownObject;
        passB = { pages: done, relations: edges, events, voiceCards: voice, dropped };
        handle.log(`kept ${edges} relations, dropped ${dropped} unevidenced or unresolvable`);
      }

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

  /** Builds an authored world from a description. No wiki involved. */
  startCustomWorld(description: string, style?: Partial<IngestPlan['style']>): Job<ApplyCustomResult> {
    const world = this.world;
    const planner = this.planner;

    return this.jobs.start<ApplyCustomResult>('custom-world', async (handle) => {
      handle.stage('inventing the world', 'locations, factions, cast');
      const raw = await planner.customWorld(description);

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
    seedWorld(this.world);
    this.world.chronicle.setMeta('worldTitle', 'Saint Verrow');
    return {
      playerCharacterId: this.world.session.get().playerCharacterId,
      opening: proposeOpening(this.world),
    };
  }

  /** Wipes a save so the wizard can be run again. Canon included: this is a reset. */
  reset(): void {
    const tables = [
      'turns', 'events', 'consequences', 'fact_knowledge', 'facts', 'threads',
      'directives', 'divergences', 'style_anchors', 'relationships', 'sheets',
      'edges', 'entities', 'scenes', 'chapters', 'ingest_pages',
    ];
    for (const t of tables) this.world.db.prepare(`DELETE FROM ${t}`).run();
    this.world.session.set({ scene: 1, turn: 0, playerCharacterId: '', currentLocationId: null });
  }
}
