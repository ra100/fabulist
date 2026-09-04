/**
 * Wiki discovery: turn "the witcher" into a real MediaWiki endpoint.
 *
 * A player should never have to know what a seed page or an api.php URL is, so
 * this does the guessing. Three strategies in order of reliability, because no
 * single one is dependable: Fandom's own wiki directory, then a slug guess
 * verified against siteinfo, then a search on the community wiki.
 *
 * Every candidate is verified by actually fetching siteinfo before being
 * offered. Suggesting a wiki that turns out not to exist is a worse experience
 * than offering fewer options.
 */

export interface WikiCandidate {
  /** Human name, from siteinfo where available. */
  name: string;
  /** Base URL, no trailing slash and no /api.php. */
  baseUrl: string;
  /** Article count, the best cheap proxy for whether this is the main wiki. */
  articles: number;
  language: string;
  /** How it was found, surfaced so a guess can be labelled as one. */
  via: 'directory' | 'slug' | 'search' | 'explicit';
  confidence: number;
}

export interface DirectoryOptions {
  fetcher?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Politeness delay between probes, in ms. */
  delayMs?: number;
  limit?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Strips the words people add that are never in a wiki slug. */
function slugCandidates(query: string): string[] {
  const cleaned = query
    .toLowerCase()
    .replace(/\b(universe|wiki|fandom|series|saga|franchise|world of|the world of)\b/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(Boolean);
  const out = new Set<string>();
  if (words.length) {
    out.add(words.join(''));
    out.add(words.join('-'));
    // Dropping a leading article is the single most common fix.
    if (words[0] === 'the' && words.length > 1) {
      out.add(words.slice(1).join(''));
      out.add(words.slice(1).join('-'));
    }
    out.add(words[0]!);
  }
  return [...out].filter((s) => s.length >= 2);
}

export class WikiDirectory {
  private fetcher: NonNullable<DirectoryOptions['fetcher']>;
  private delayMs: number;
  private limit: number;
  requests = 0;

  constructor(opts: DirectoryOptions = {}) {
    this.fetcher = opts.fetcher ?? ((url: string) => fetch(url));
    this.delayMs = opts.delayMs ?? 150;
    this.limit = opts.limit ?? 6;
  }

  private async json(url: string): Promise<unknown | null> {
    this.requests++;
    try {
      const res = await this.fetcher(url);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Confirms a wiki exists and reports its real name and size. This is the only
   * function that decides whether a candidate is offered at all.
   */
  async verify(baseUrl: string, via: WikiCandidate['via'], confidence: number): Promise<WikiCandidate | null> {
    const base = baseUrl.replace(/\/$/, '').replace(/\/api\.php$/, '');
    const data = (await this.json(
      `${base}/api.php?action=query&meta=siteinfo&siprop=general|statistics&format=json&formatversion=2`,
    )) as {
      query?: { general?: { sitename?: string; lang?: string }; statistics?: { articles?: number } };
    } | null;

    const general = data?.query?.general;
    if (!general?.sitename) return null;

    return {
      name: general.sitename,
      baseUrl: base,
      articles: data?.query?.statistics?.articles ?? 0,
      language: general.lang ?? 'en',
      via,
      confidence,
    };
  }

  /**
   * Ranked candidates for a free-text universe name.
   *
   * Article count breaks ties, because when several wikis exist for one franchise
   * the largest is almost always the one with the lore a player wants. A tiny
   * wiki that happens to match the slug exactly is usually a fan spinoff.
   */
  async resolve(query: string): Promise<WikiCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // An explicit URL means the player already knows what they want.
    if (/^https?:\/\//i.test(trimmed)) {
      const verified = await this.verify(trimmed, 'explicit', 1);
      return verified ? [verified] : [];
    }

    const found = new Map<string, WikiCandidate>();
    const add = (c: WikiCandidate | null) => {
      if (!c) return;
      const existing = found.get(c.baseUrl);
      if (!existing || c.confidence > existing.confidence) found.set(c.baseUrl, c);
    };

    for (const c of await this.fromDirectory(trimmed)) add(c);

    // Slug probing only if the directory was unhelpful; it costs a request each.
    if (found.size < 3) {
      for (const slug of slugCandidates(trimmed).slice(0, 4)) {
        if (found.size >= this.limit) break;
        await sleep(this.delayMs);
        add(await this.verify(`https://${slug}.fandom.com`, 'slug', 0.65));
      }
    }

    if (found.size === 0) {
      for (const c of await this.fromSearch(trimmed)) add(c);
    }

    return [...found.values()]
      .sort((a, b) => b.confidence - a.confidence || b.articles - a.articles)
      .slice(0, this.limit);
  }

  /** Fandom's own wiki index. Best signal when it answers. */
  private async fromDirectory(query: string): Promise<WikiCandidate[]> {
    const data = (await this.json(
      `https://community.fandom.com/api/v1/Wikis/ByString?string=${encodeURIComponent(query)}&limit=8&lang=en`,
    )) as { items?: Array<{ name?: string; url?: string; wordmark?: string; stats?: { articles?: number } }> } | null;

    const items = data?.items ?? [];
    const out: WikiCandidate[] = [];
    for (const item of items.slice(0, 4)) {
      if (!item.url) continue;
      const verified = await this.verify(item.url, 'directory', 0.9);
      if (verified) out.push(verified);
    }
    return out;
  }

  /** Last resort: search the community wiki for a page naming the franchise. */
  private async fromSearch(query: string): Promise<WikiCandidate[]> {
    const data = (await this.json(
      `https://community.fandom.com/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&formatversion=2`,
    )) as { query?: { search?: Array<{ title?: string }> } } | null;

    const titles = (data?.query?.search ?? []).map((s) => s.title ?? '').filter(Boolean);
    const out: WikiCandidate[] = [];
    for (const title of titles.slice(0, 2)) {
      for (const slug of slugCandidates(title).slice(0, 2)) {
        const verified = await this.verify(`https://${slug}.fandom.com`, 'search', 0.4);
        if (verified) {
          out.push(verified);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Suggests where in a universe to play. Top-level categories are the closest
   * thing a wiki has to a table of contents, so they make far better seed
   * suggestions than a raw search would.
   */
  async suggestStartingPoints(baseUrl: string, hint = ''): Promise<Array<{ title: string; kind: 'category' | 'page'; members: number }>> {
    const base = baseUrl.replace(/\/$/, '');
    const out: Array<{ title: string; kind: 'category' | 'page'; members: number }> = [];

    const cats = (await this.json(
      `${base}/api.php?action=query&list=allcategories&aclimit=60&acmin=8&acprop=size&format=json&formatversion=2`,
    )) as { query?: { allcategories?: Array<{ category?: string; size?: number }> } } | null;

    // Categories that group *story*, not metadata. A wiki's biggest categories
    // are usually housekeeping ("Articles needing images"), which are useless here.
    //
    // Stems are matched without a trailing word boundary on purpose. Wiki
    // categories are almost always plural — "Characters", "Locations",
    // "Organizations" — and `\bcharacter\b` matches none of them, which would
    // silently drop the most useful categories on the wiki.
    const meta = /\b(stub|article|image|disambig|template|candidate|needing|browse|wiki|policy|user|file|galler|unreleased|maintenance)/i;
    const interesting = /\b(character|location|planet|region|era|season|episode|book|quest|faction|organi|house|clan|war|event|arc|chapter|volume|realm|cit(y|ies)|kingdom|creature|species|people)/i;

    for (const c of cats?.query?.allcategories ?? []) {
      const title = c.category ?? '';
      if (!title || meta.test(title)) continue;
      if (!interesting.test(title)) continue;
      out.push({ title, kind: 'category', members: c.size ?? 0 });
    }

    // If the player already said where they want to be, search for it directly:
    // a named arc beats any category.
    if (hint.trim()) {
      const hits = (await this.json(
        `${base}/api.php?action=query&list=search&srsearch=${encodeURIComponent(hint)}&srlimit=8&format=json&formatversion=2`,
      )) as { query?: { search?: Array<{ title?: string }> } } | null;
      for (const s of hits?.query?.search ?? []) {
        if (s.title) out.unshift({ title: s.title, kind: 'page', members: 0 });
      }
    }

    return out.slice(0, 30);
  }
}

/** Fixture-backed fetcher for tests and offline replay. */
export function directoryFixture(config: {
  wikis: Record<string, { sitename: string; articles: number; lang?: string }>;
  directory?: Record<string, Array<{ name: string; url: string }>>;
  categories?: Record<string, Array<{ category: string; size: number }>>;
  search?: Record<string, string[]>;
}): NonNullable<DirectoryOptions['fetcher']> {
  return async (url: string) => {
    const u = new URL(url);
    const notFound = { ok: false, status: 404, json: async () => ({}) };

    if (u.pathname.startsWith('/api/v1/Wikis/ByString')) {
      const q = (u.searchParams.get('string') ?? '').toLowerCase();
      const items = config.directory?.[q];
      if (!items) return notFound;
      return { ok: true, status: 200, json: async () => ({ items }) };
    }

    const action = u.searchParams.get('list') ?? u.searchParams.get('meta');
    const origin = `${u.protocol}//${u.host}`;

    if (action === 'siteinfo') {
      const wiki = config.wikis[origin];
      if (!wiki) return notFound;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: {
            general: { sitename: wiki.sitename, lang: wiki.lang ?? 'en' },
            statistics: { articles: wiki.articles },
          },
        }),
      };
    }

    if (action === 'allcategories') {
      const cats = config.categories?.[origin] ?? [];
      return { ok: true, status: 200, json: async () => ({ query: { allcategories: cats } }) };
    }

    if (action === 'search') {
      const q = (u.searchParams.get('srsearch') ?? '').toLowerCase();
      const titles = config.search?.[q] ?? [];
      return { ok: true, status: 200, json: async () => ({ query: { search: titles.map((t) => ({ title: t })) } }) };
    }

    return notFound;
  };
}
