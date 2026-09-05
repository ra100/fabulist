/**
 * MediaWiki API client. See DESIGN.md §3.
 *
 * Fandom runs MediaWiki, so `/api.php` gives structured access and there is no
 * reason to scrape HTML. The fetcher is injectable so the test suite runs on
 * fixtures with no network.
 */

export interface WikiPage {
  pageId: string;
  title: string;
  revision: string;
  wikitext: string;
  categories: string[];
  links: string[];
}

export interface FetchLike {
  (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/**
 * Identifies the crawler honestly, which is load-bearing rather than polite.
 *
 * Fandom's `robots.txt` grants `User-agent: *` an explicit `Allow: /api.php?`
 * while `Disallow: /`-ing GPTBot, ClaudeBot and CCBot by name. That generic
 * allowance is the permission this ingest actually relies on, and relying on it
 * only holds while we are honestly a generic client rather than a named one in
 * disguise. Sending nothing (the previous behaviour — bare undici) is not
 * dishonest, but it also gives an operator no way to identify or contact the
 * source of the traffic, which is the first thing they look for.
 *
 * Deliberately never a browser-spoofing string: Fandom's Terms separately bar
 * forging headers to disguise automated access, so a fake Mozilla UA would turn
 * a defensible position into an indefensible one. See
 * `docs/legal-briefing-fandom-ingest.md`.
 */
export const DEFAULT_USER_AGENT = 'Fabulist/0.1 (+https://github.com/fabulist/fabulist; local worldbuilding tool)';

export interface ClientOptions {
  baseUrl: string;
  fetcher?: FetchLike;
  /** Politeness delay between batches, in ms. Zero in tests. */
  delayMs?: number;
  /** Max titles per query; MediaWiki allows 50 for anonymous callers. */
  batchSize?: number;
  /**
   * Overrides `DEFAULT_USER_AGENT`. Worth setting to something with your own
   * contact details for a large crawl — an operator who can reach you sends
   * mail before blocking a range.
   */
  userAgent?: string;
}

interface QueryPage {
  pageid?: number;
  title?: string;
  missing?: boolean | string;
  revisions?: Array<{ revid?: number; slots?: { main?: { content?: string } }; '*'?: string; content?: string }>;
  categories?: Array<{ title?: string }>;
  links?: Array<{ title?: string }>;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export class WikiClient {
  readonly baseUrl: string;
  readonly userAgent: string;
  private fetcher: FetchLike;
  private delayMs: number;
  private batchSize: number;
  /** Keyed by title. Re-ingest only needs the revision to decide staleness. */
  private cache = new Map<string, WikiPage>();
  requests = 0;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    // The header goes on the default fetcher rather than into `FetchLike`'s
    // signature: an injected fetcher is a test fixture or a caller's own
    // transport, and widening the interface would force every one of them to
    // thread a header they do not use. A caller supplying real transport sets
    // its own headers.
    this.fetcher = opts.fetcher ?? ((url: string) => fetch(url, { headers: { 'User-Agent': this.userAgent } }));
    this.delayMs = opts.delayMs ?? 250;
    this.batchSize = Math.min(50, Math.max(1, opts.batchSize ?? 20));
  }

  private url(params: Record<string, string>): string {
    const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    return `${this.baseUrl}/api.php?${q}`;
  }

  private async query(params: Record<string, string>): Promise<unknown> {
    this.requests++;
    const res = await this.fetcher(this.url(params));
    if (!res.ok) throw new Error(`wiki api ${res.status}`);
    return res.json();
  }

  /**
   * Fetches pages in batches. A single bad or missing page is skipped rather
   * than failing the batch: on a real wiki, redirects and deletions are normal
   * and an ingest that aborts on one of them is useless.
   */
  async fetchPages(titles: string[]): Promise<WikiPage[]> {
    const wanted = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
    const out: WikiPage[] = [];
    const missing: string[] = [];

    for (const title of wanted) {
      const hit = this.cache.get(title);
      if (hit) out.push(hit);
      else missing.push(title);
    }

    for (let i = 0; i < missing.length; i += this.batchSize) {
      const batch = missing.slice(i, i + this.batchSize);
      if (i > 0) await sleep(this.delayMs);

      let json: unknown;
      try {
        json = await this.query({
          action: 'query',
          prop: 'revisions|categories|links',
          rvprop: 'content|ids',
          rvslots: 'main',
          cllimit: 'max',
          pllimit: 'max',
          // Main namespace (0) only: without this, `links` includes Category:,
          // Template:, File: and other housekeeping pages, which then get
          // crawled and scored as if they were story content (they aren't
          // filtered client-side, because `parseLinks`'s SKIP_NS regex only
          // covers the wikitext-parsing fallback path, not this — the
          // authoritative — one).
          plnamespace: '0',
          redirects: '1',
          titles: batch.join('|'),
        });
      } catch {
        continue; // whole batch unavailable; the crawl carries on
      }

      const pages = (json as { query?: { pages?: QueryPage[] } })?.query?.pages ?? [];
      for (const p of pages) {
        const page = toPage(p);
        if (!page) continue;
        this.cache.set(page.title, page);
        out.push(page);
      }
    }
    return out;
  }

  async fetchPage(title: string): Promise<WikiPage | null> {
    const [page] = await this.fetchPages([title]);
    return page ?? null;
  }

  async search(query: string, limit = 20): Promise<string[]> {
    try {
      const json = await this.query({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit) });
      return ((json as { query?: { search?: Array<{ title?: string }> } })?.query?.search ?? [])
        .map((s) => s.title ?? '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async categoryMembers(category: string, limit = 200): Promise<string[]> {
    const name = category.startsWith('Category:') ? category : `Category:${category}`;
    try {
      const json = await this.query({
        action: 'query',
        list: 'categorymembers',
        cmtitle: name,
        cmlimit: String(Math.min(500, limit)),
      });
      return ((json as { query?: { categorymembers?: Array<{ title?: string }> } })?.query?.categorymembers ?? [])
        .map((m) => m.title ?? '')
        .filter((t) => t && !t.startsWith('Category:'));
    } catch {
      return [];
    }
  }

  /** Cached page, if already fetched. Lets callers avoid a round trip. */
  peek(title: string): WikiPage | undefined {
    return this.cache.get(title);
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

function toPage(p: QueryPage): WikiPage | null {
  if (!p.title || p.missing) return null;
  const rev = p.revisions?.[0];
  const wikitext = rev?.slots?.main?.content ?? rev?.content ?? rev?.['*'] ?? '';
  if (!wikitext) return null;
  return {
    pageId: String(p.pageid ?? p.title),
    title: p.title,
    revision: String(rev?.revid ?? ''),
    wikitext,
    categories: (p.categories ?? []).map((c) => (c.title ?? '').replace(/^Category:/, '')).filter(Boolean),
    links: (p.links ?? []).map((l) => l.title ?? '').filter(Boolean),
  };
}

/**
 * Builds a fetcher over a fixture map, for tests and for replaying a cached
 * crawl offline.
 */
export function fixtureFetcher(pages: Record<string, Partial<WikiPage> & { title: string }>): FetchLike {
  return async (url: string) => {
    const parsed = new URL(url, 'http://fixture');
    const action = parsed.searchParams.get('list') ?? 'query';

    if (action === 'search') {
      const q = (parsed.searchParams.get('srsearch') ?? '').toLowerCase();
      const hits = Object.values(pages)
        .filter((p) => p.title.toLowerCase().includes(q) || (p.wikitext ?? '').toLowerCase().includes(q))
        .map((p) => ({ title: p.title }));
      return { ok: true, status: 200, json: async () => ({ query: { search: hits } }) };
    }

    if (action === 'categorymembers') {
      const cat = (parsed.searchParams.get('cmtitle') ?? '').replace(/^Category:/, '');
      const hits = Object.values(pages)
        .filter((p) => (p.categories ?? []).some((c) => c.toLowerCase() === cat.toLowerCase()))
        .map((p) => ({ title: p.title }));
      return { ok: true, status: 200, json: async () => ({ query: { categorymembers: hits } }) };
    }

    const titles = (parsed.searchParams.get('titles') ?? '').split('|').filter(Boolean);
    const result = titles.map((t) => {
      const page = pages[t];
      if (!page) return { title: t, missing: true };
      return {
        pageid: page.pageId ?? t,
        title: page.title,
        revisions: [{ revid: Number(page.revision ?? 1), slots: { main: { content: page.wikitext ?? '' } } }],
        categories: (page.categories ?? []).map((c) => ({ title: `Category:${c}` })),
        links: (page.links ?? []).map((l) => ({ title: l })),
      };
    });
    return { ok: true, status: 200, json: async () => ({ query: { pages: result } }) };
  };
}
