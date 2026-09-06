/**
 * Scope selection and the discovery preview. See DESIGN.md §3 and §3.1.
 *
 * Scope control is the whole game here: a large wiki is 50k-200k pages and a
 * playthrough needs a few hundred. The ranking below is the part that matters,
 * and it deliberately does not use raw link count.
 */
import type { WikiClient, WikiPage } from './client.ts';
import { firstParagraph, inferEntityType, parseCategories, parseInfobox, parseLinks } from './parse.ts';
import type { EntityType } from '../domain/types.ts';

export interface Candidate {
  title: string;
  hops: number;
  score: number;
  type: EntityType;
  summary: string;
  /** How many in-scope pages link here; the numerator of the ranking. */
  inboundInScope: number;
  inboundTotal: number;
  categoryOverlap: number;
}

export interface CrawlOptions {
  client: WikiClient;
  seeds: string[];
  hops: number;
  maxPages: number;
  /** Categories that mark a page as relevant even at distance. */
  seedCategories?: string[];
  /** Titles to never include. */
  exclude?: string[];
  /**
   * Reported after each hop's batch of pages is fetched, so a caller running
   * this inside a job can show real progress instead of a blind wait. The
   * frontier is still expanding while hops remain, so `total` is the hop
   * count, not a page count — the honest total during a crawl is "how many
   * more passes", not "how many more pages", which is not known until the
   * crawl stops discovering new links.
   */
  onProgress?: (info: { hop: number; hops: number; pagesFetched: number }) => void;
}

export interface CrawlResult {
  pages: Map<string, WikiPage>;
  candidates: Candidate[];
  seedCategories: string[];
}

/**
 * Breadth-first crawl from the seeds, then rank.
 *
 * Ranking formula, and why it is not link count:
 *
 *   score = 0.40 * seedProximity        (1 at a seed, decaying by hop)
 *         + 0.30 * inScopeConcentration (inbound from in-scope / inbound seen)
 *         + 0.20 * categoryOverlap      (share of seed categories matched)
 *         - 0.30 * hubPenalty           (indexes and list pages)
 *
 * Concentration is the term the design argues for: a character linked from two
 * hundred pages, six of them in the chosen arc, scores 0.03, while a character
 * linked from six pages all inside the arc scores 1.0. Raw popularity would
 * invert that.
 *
 * Honest limitation: inbound counts come only from pages this crawl fetched, so
 * they under-count a genuinely wiki-famous entity. Real totals would need the
 * `linkshere` API, which costs a request per page. The hub penalty compensates
 * for the pathology that survives: index and list pages, which link outward to
 * everything and inbound to almost nothing, so concentration cannot see them.
 * They are caught instead by their outbound breadth and category incoherence.
 */

/**
 * Recognises navigation furniture by title shape: Fandom's own `Category:`
 * namespace, and the "index of a group, not a member of it" convention a
 * character-list page uses — either a bare group-noun title (`Characters`)
 * or that noun as a subpage root (`Characters/Mass Effect 2`). The original
 * `/^(list of|...)/` prefix match caught none of these: real ingest against
 * `masseffect.fandom.com` surfaced `Characters`, `Category:Characters`, and
 * fourteen `Characters/*` subpages as playable "characters" because their
 * titles never start with "list of" even though they are exactly that.
 */
export function isIndexTitle(title: string): boolean {
  if (/^(list of|index of|glossary|timeline of|category of)\b/i.test(title)) return true;
  if (/^Category:/i.test(title)) return true;
  const root = title.split('/')[0]!.trim();
  return /^(characters?|locations?|episodes?|chapters?|factions?|organi[sz]ations?|items?|events?|timeline|gallery|images?)$/i.test(root);
}

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const { client, seeds, hops, maxPages } = opts;
  const exclude = new Set((opts.exclude ?? []).map((t) => t.toLowerCase()));

  const pages = new Map<string, WikiPage>();
  const hopOf = new Map<string, number>();
  const linkGraph = new Map<string, string[]>();

  let frontier = seeds.filter((t) => !exclude.has(t.toLowerCase()));
  for (const t of frontier) hopOf.set(t, 0);

  for (let hop = 0; hop <= hops && frontier.length; hop++) {
    const fetched = await client.fetchPages(frontier.slice(0, Math.max(0, maxPages * 3 - pages.size)));
    const next: string[] = [];

    for (const page of fetched) {
      if (pages.has(page.title)) continue;
      pages.set(page.title, page);
      // MediaWiki `links` is authoritative when present; fall back to parsing.
      const links = page.links.length ? page.links : parseLinks(page.wikitext);
      linkGraph.set(page.title, links);

      if (hop < hops) {
        for (const link of links) {
          if (exclude.has(link.toLowerCase())) continue;
          if (hopOf.has(link)) continue;
          hopOf.set(link, hop + 1);
          next.push(link);
        }
      }
    }
    frontier = next;
    opts.onProgress?.({ hop: hop + 1, hops: hops + 1, pagesFetched: pages.size });
  }

  // Seed categories anchor the relevance signal for the whole crawl.
  const seedCategories = new Set<string>(opts.seedCategories ?? []);
  for (const title of seeds) {
    const page = pages.get(title);
    if (!page) continue;
    for (const c of page.categories.length ? page.categories : parseCategories(page.wikitext)) {
      seedCategories.add(c);
    }
  }

  const inScope = new Set(pages.keys());
  const inboundInScope = new Map<string, number>();
  const inboundTotal = new Map<string, number>();
  for (const [from, links] of linkGraph) {
    for (const to of links) {
      inboundTotal.set(to, (inboundTotal.get(to) ?? 0) + 1);
      if (inScope.has(from)) inboundInScope.set(to, (inboundInScope.get(to) ?? 0) + 1);
    }
  }

  // Median outbound degree, so "links to unusually many things" is measured
  // against this wiki rather than an arbitrary constant.
  const degrees = [...linkGraph.values()].map((l) => l.length).sort((a, b) => a - b);
  const medianDegree = degrees.length ? (degrees[Math.floor(degrees.length / 2)] ?? 1) : 1;

  const candidates: Candidate[] = [];
  for (const [title, page] of pages) {
    const hop = hopOf.get(title) ?? hops;
    const cats = page.categories.length ? page.categories : parseCategories(page.wikitext);
    const infobox = parseInfobox(page.wikitext);
    const summary = firstParagraph(page.wikitext);

    const proximity = 1 / (1 + hop);
    const inS = inboundInScope.get(title) ?? 0;
    const inT = inboundTotal.get(title) ?? 0;
    const concentration = inT > 0 ? inS / inT : 0;
    const overlap = seedCategories.size
      ? cats.filter((c) => seedCategories.has(c)).length / seedCategories.size
      : 0;

    // Hub penalty: an index or list page links outward far more than a story
    // page does, carries no infobox, and shares no arc category. Any one of
    // those is unremarkable; together they identify navigation furniture, which
    // is worthless to play in and expensive to extract.
    const outDegree = linkGraph.get(title)?.length ?? 0;
    const breadth = medianDegree > 0 ? outDegree / (medianDegree * 2.5) : 0;
    const looksLikeIndex = isIndexTitle(title);
    const hubPenalty = Math.min(
      1,
      (looksLikeIndex ? 0.6 : 0) + (breadth > 1 ? Math.min(0.5, (breadth - 1) * 0.5) : 0) + (overlap === 0 && !infobox ? 0.3 : 0),
    );

    candidates.push({
      title,
      hops: hop,
      score: Number(
        (0.4 * proximity + 0.3 * concentration + 0.2 * Math.min(1, overlap * 2) - 0.3 * hubPenalty).toFixed(4),
      ),
      type: inferEntityType(title, cats, infobox, summary),
      summary,
      inboundInScope: inS,
      inboundTotal: inT,
      categoryOverlap: overlap,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { pages, candidates, seedCategories: [...seedCategories] };
}

export interface DiscoveryPreview {
  candidatePages: number;
  byHop: Record<number, number>;
  byType: Record<string, number>;
  topEntities: Array<{ title: string; type: string; score: number; summary: string }>;
  factions: string[];
  locations: string[];
  characters: string[];
  estimatedTokens: number;
  estimatedCostUsd: number;
  seedCategories: string[];
}

/**
 * Proposes a scope without committing anything. The design calls this out as
 * the most likely place ingest goes wrong: a crawl that silently pulls 3,000
 * pages of a continuity you do not care about.
 */
export function discover(result: CrawlResult, opts: { maxPages?: number; costPerMTokens?: number } = {}): DiscoveryPreview {
  const limit = opts.maxPages ?? result.candidates.length;
  const chosen = result.candidates.slice(0, limit);

  const byHop: Record<number, number> = {};
  const byType: Record<string, number> = {};
  for (const c of chosen) {
    byHop[c.hops] = (byHop[c.hops] ?? 0) + 1;
    byType[c.type] = (byType[c.type] ?? 0) + 1;
  }

  const pick = (type: EntityType) => chosen.filter((c) => c.type === type).map((c) => c.title);

  // Rough: Pass B reads roughly the page text plus prompt overhead per page.
  const chars = chosen.reduce((n, c) => n + (result.pages.get(c.title)?.wikitext.length ?? 0), 0);
  const estimatedTokens = Math.ceil(chars / 4) + chosen.length * 400;
  const costPerM = opts.costPerMTokens ?? 0.6;

  return {
    candidatePages: chosen.length,
    byHop,
    byType,
    topEntities: chosen.slice(0, 25).map((c) => ({ title: c.title, type: c.type, score: Number(c.score.toFixed(3)), summary: c.summary.slice(0, 120) })),
    factions: pick('Faction').slice(0, 20),
    locations: pick('Location').slice(0, 20),
    characters: pick('Character').slice(0, 30),
    estimatedTokens,
    estimatedCostUsd: Number(((estimatedTokens / 1_000_000) * costPerM).toFixed(4)),
    seedCategories: result.seedCategories,
  };
}

/** Applies the caller's confirmed pruning to a crawl result. */
export function prune(
  result: CrawlResult,
  opts: { exclude?: string[]; excludeCategories?: string[]; maxPages?: number; minScore?: number } = {},
): CrawlResult {
  const excluded = new Set((opts.exclude ?? []).map((t) => t.toLowerCase()));
  const badCats = (opts.excludeCategories ?? []).map((c) => c.toLowerCase());

  let candidates = result.candidates.filter((c) => {
    if (excluded.has(c.title.toLowerCase())) return false;
    if (opts.minScore !== undefined && c.score < opts.minScore) return false;
    if (badCats.length) {
      const page = result.pages.get(c.title);
      const cats = (page?.categories ?? []).map((x) => x.toLowerCase());
      if (cats.some((x) => badCats.includes(x))) return false;
    }
    return true;
  });

  if (opts.maxPages !== undefined) candidates = candidates.slice(0, opts.maxPages);

  const keep = new Set(candidates.map((c) => c.title));
  const pages = new Map([...result.pages].filter(([title]) => keep.has(title)));
  return { pages, candidates, seedCategories: result.seedCategories };
}
