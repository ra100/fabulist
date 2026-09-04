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
import type { WikiClient, WikiPage } from './client.ts';
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
}

/** Does nothing, on purpose. Keeps depth.ts complete before the LLM pass exists. */
export class NullPassBExtractor implements PassBExtractor {
  async extract(): Promise<PassBOutput> {
    return { edges: [], events: [], contradictions: [] };
  }
}

export interface IngestOptions {
  client: WikiClient;
  seeds: string[];
  mode: DepthMode;
  wiki?: string;
  exclude?: string[];
  extractor?: PassBExtractor;
  /** Stop after the preview rather than committing. */
  previewOnly?: boolean;
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
    passB = await runPassB(opts.world, scoped, opts.extractor, spec);
  }

  return { preview, passA, passB, mode: opts.mode };
}

/**
 * Runs Pass B over the pages the mode selects: core entities only for mid, all
 * of the scope for deep. Core means the highest-scoring pages, which is where
 * relation quality actually pays off.
 */
export async function runPassB(
  world: World,
  scoped: CrawlResult,
  extractor: PassBExtractor,
  spec: DepthSpec,
): Promise<{ pages: number; edges: number; events: number; voiceCards: number }> {
  const targets =
    spec.passB === 'all'
      ? scoped.candidates
      : scoped.candidates.slice(0, Math.max(20, Math.floor(scoped.candidates.length * 0.25)));

  const out = { pages: 0, edges: 0, events: 0, voiceCards: 0 };

  for (const candidate of targets) {
    const page = scoped.pages.get(candidate.title);
    if (!page) continue;
    const entity = world.graph.resolveName(candidate.title);
    if (!entity) continue;

    let result: PassBOutput;
    try {
      result = await extractor.extract(page, entity);
    } catch {
      continue; // one bad extraction must not abort the pass
    }
    out.pages++;

    for (const e of result.edges) {
      const target = world.graph.resolveName(e.objectName);
      if (!target || target.id === entity.id) continue;
      world.graph.assertEdge(
        { subject: entity.id, predicate: e.predicate, object: target.id, weight: e.weight ?? 0.6, evidence: e.evidence },
        0,
        'canon',
        `passB:${candidate.title}`,
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
          provenance: `passB:${candidate.title}`,
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
      world.chronicle.addDivergence(0, 'canon-contradiction', `${c.claim} (conflicts with: ${c.conflictsWith})`, candidate.title);
    }

    world.graph.setDepth(entity.id, spec.level);
  }

  return out;
}

/**
 * Upgrades existing nodes to a higher depth. Only touches nodes below the
 * target, so this is a diff rather than a re-run.
 */
export async function upgradeDepth(
  world: World,
  target: DepthMode,
  opts: { client: WikiClient; extractor?: PassBExtractor; limit?: number; wiki?: string },
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
  opts: { client: WikiClient; hops?: number; extractor?: PassBExtractor; wiki?: string },
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
  opts: { client: WikiClient; extractor?: PassBExtractor; wiki?: string },
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
