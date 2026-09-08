/**
 * Fandom XML database dump ingest. See `docs/legal-briefing-fandom-ingest.md`
 * §6.1 and DESIGN.md §3.
 *
 * Every Fandom wiki's `Special:Statistics` page carries a "Database download"
 * section, captioned by Fandom itself as "usually best for bot use", linking a
 * `.7z`-compressed MediaWiki XML export of every current page — the same
 * export format `dumpBackup.php` produces on any MediaWiki install, not a
 * Fandom-proprietary shape. `Help:Database_download` documents it as a
 * supported, admin-refreshable feature, refreshed roughly weekly on request.
 *
 * That makes this a materially better position than the live `api.php` crawl
 * in `client.ts`: instead of relying on a favourable-but-contested reading of
 * "for any purpose" in the ToU (robots.txt allows `Allow: /api.php?` to a
 * generic UA, but the Terms separately ban "any robot… to scrape, extract,
 * retrieve or index any portion of the content"), this is a single request
 * against a bulk-export endpoint Fandom itself points bot operators at. It is
 * also just better engineering: one bounded download replaces thousands of
 * paginated API calls, and the whole link graph is available at once instead
 * of only the portion this crawl happens to fetch — which is exactly the
 * limitation `scope.ts` calls out in its own inbound-count caveat.
 *
 * The download URL follows a fixed, guessable convention —
 * `{first letter}/{first two letters}/{dbname}_pages_current.xml.7z` — which
 * this module tries directly before falling back to scraping the link off
 * `Special:Statistics`, since a wiki with an unusual `dbname` (rare, but the
 * convention is a heuristic, not a spec) would otherwise 404 silently.
 *
 * What this module does *not* do: replace the live crawler. A dump is a
 * snapshot, current as of its last (admin-triggered, weekly-at-best) refresh.
 * `DumpSource` implements the same narrow interface `crawl()` already depends
 * on (`fetchPages`/`fetchPage`), so `src/cli/ingest.ts` builds a hybrid: read
 * from the dump first, and fall back to the live `WikiClient` only for titles
 * the dump does not have — new pages created after the snapshot. Nothing in
 * `scope.ts`, `passA.ts`, or `passB.ts` needs to change for this to work.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import sax from 'sax';
import _7z from '7zip-min';
import type { PageSource, WikiPage } from './client.ts';
import { parseCategories, parseLinks } from './parse.ts';

export type { PageSource };

export interface DumpOptions {
  /** e.g. "https://masseffect.fandom.com" — same shape `--wiki=` already takes. */
  wikiUrl: string;
  /** Where the downloaded `.7z` and extracted `.xml` are cached. Default `data/dumps/<dbname>`. */
  cacheDir?: string;
  /** Overrides `DEFAULT_USER_AGENT` from `client.ts`; same honesty requirement applies to this one request. */
  userAgent?: string;
  fetcher?: typeof fetch;
}

const DEFAULT_USER_AGENT = 'Fabulist/0.1 (+https://github.com/fabulist/fabulist; local worldbuilding tool)';

/** `masseffect.fandom.com` -> `masseffect`. Also accepts a bare dbname. */
export function dbNameOf(wikiUrl: string): string {
  try {
    const host = new URL(wikiUrl).hostname;
    return host.split('.')[0] ?? host;
  } catch {
    return wikiUrl;
  }
}

/**
 * The convention observed across masseffect, witcher, and elderscrolls:
 * `s3.amazonaws.com/wikia_xml_dumps/{c0}/{c0}{c1}/{dbname}_pages_current.xml.7z`.
 * A guess, not a promise — `resolveDumpUrl` verifies it and falls back to
 * scraping `Special:Statistics` when it does not exist.
 */
export function guessDumpUrl(dbName: string): string {
  const c0 = dbName[0] ?? '';
  const c1 = dbName.slice(0, 2);
  return `https://s3.amazonaws.com/wikia_xml_dumps/${c0}/${c1}/${dbName}_pages_current.xml.7z`;
}

/**
 * Resolves the real download URL: tries the guessed convention with a cheap
 * HEAD first, and only pays for a full HTML fetch of `Special:Statistics` —
 * one page load, not a crawl — when the guess misses.
 */
export async function resolveDumpUrl(opts: DumpOptions): Promise<string> {
  const fetcher = opts.fetcher ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const dbName = dbNameOf(opts.wikiUrl);
  const guess = guessDumpUrl(dbName);

  try {
    const head = await fetcher(guess, { method: 'HEAD', headers: { 'User-Agent': userAgent } });
    if (head.ok) return guess;
  } catch {
    // fall through to the statistics-page scrape
  }

  const base = opts.wikiUrl.replace(/\/$/, '');
  const res = await fetcher(`${base}/wiki/Special:Statistics`, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`could not reach ${base}/wiki/Special:Statistics (${res.status})`);
  const html = await res.text();
  // The "current pages" link is the one Fandom itself captions "best for bot
  // use" — deliberately not the "current pages and history" link, which can be
  // an order of magnitude larger for no benefit here: this ingest only ever
  // wants one revision per page.
  const match = html.match(/href="(https:\/\/s3\.amazonaws\.com\/wikia_xml_dumps\/[^"]*_pages_current\.xml\.7z)"/);
  if (!match?.[1]) throw new Error(`no dump link found on ${base}/wiki/Special:Statistics`);
  return match[1].replace(/\\\//g, '/');
}

/**
 * Downloads (if not already cached) and extracts the dump, returning the path
 * to the decompressed XML. Idempotent: a cached `.xml` with a nonzero size is
 * reused rather than re-fetched, so a repeated ingest run against the same
 * wiki costs nothing extra — the whole point of moving off live crawling.
 */
export async function ensureDumpXml(opts: DumpOptions): Promise<string> {
  const dbName = dbNameOf(opts.wikiUrl);
  const cacheDir = opts.cacheDir ?? join('data', 'dumps', dbName);
  const xmlPath = join(cacheDir, `${dbName}_pages_current.xml`);
  const archivePath = join(cacheDir, `${dbName}_pages_current.xml.7z`);

  if (existsSync(xmlPath) && (await stat(xmlPath)).size > 0) return xmlPath;

  mkdirSync(cacheDir, { recursive: true });
  const url = await resolveDumpUrl(opts);
  const fetcher = opts.fetcher ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  const res = await fetcher(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok || !res.body) throw new Error(`dump download failed: ${url} (${res.status})`);

  await finished(Readable.fromWeb(res.body as never).pipe(createWriteStream(archivePath)));
  await _7z.unpack(archivePath, cacheDir);
  await rm(archivePath).catch(() => {}); // the .xml is what gets reused; no reason to keep the archive too

  if (!existsSync(xmlPath)) {
    // 7-Zip preserves the name stored in the archive, which should match, but
    // a wiki whose dump was packed under a different filename should not
    // silently look like a missing dump.
    throw new Error(`extracted archive did not produce the expected ${xmlPath}`);
  }
  return xmlPath;
}

interface DumpPage {
  title: string;
  ns: number;
  pageId: string;
  isRedirect: boolean;
  revision: string;
  wikitext: string;
}

/**
 * Streams the dump XML with `sax`, rather than parsing it as a DOM, because
 * even a single-wiki "current pages" export runs to hundreds of megabytes
 * uncompressed — `masseffect_pages_current.xml` alone is ~215MB for one
 * mid-sized wiki — and this module's whole reason to exist is trading network
 * limits for a bounded local cost, not trading them for an unbounded memory
 * one. `filter` lets a caller stop paying attention to namespaces and pages it
 * will never keep, without materialising them first.
 */
export async function streamDumpPages(
  xmlPath: string,
  onPage: (page: DumpPage) => void,
  opts: { filter?: (title: string, ns: number) => boolean } = {},
): Promise<void> {
  const parser = sax.parser(true, { trim: false, lowercase: false });

  let current: Partial<DumpPage> | null = null;
  let field: 'title' | 'ns' | 'text' | 'id' | 'revid' | null = null;
  let inRevision = false;
  let seenPageId = false; // <page><id> comes before <revision>; the first bare <id> is the page id
  let text = '';

  parser.onopentag = (node) => {
    const name = node.name;
    if (name === 'page') {
      current = { ns: 0, isRedirect: false, wikitext: '' };
      seenPageId = false;
      field = null;
      return;
    }
    if (!current) return;
    if (name === 'revision') {
      inRevision = true;
      return;
    }
    if (name === 'redirect') {
      current.isRedirect = true;
      return;
    }
    field = name === 'title' || name === 'ns' || name === 'text' ? name : name === 'id' ? (inRevision ? 'revid' : 'id') : null;
    text = '';
  };

  parser.ontext = (t) => {
    if (field) text += t;
  };

  parser.onclosetag = (name) => {
    if (!current) return;
    if (name === 'revision') {
      inRevision = false;
      field = null;
      return;
    }
    // `field` is the semantic slot, not always the raw tag name: both the
    // page id and the revision id are `<id>` elements, disambiguated above by
    // `inRevision` into `'id'` vs `'revid'`.
    const matches = name === field || (name === 'id' && field === 'revid');
    if (matches) {
      switch (field) {
        case 'title':
          current.title = text;
          break;
        case 'ns':
          current.ns = Number(text.trim()) || 0;
          break;
        case 'text':
          current.wikitext = decodeEntities(text);
          break;
        case 'id':
          if (!seenPageId) {
            current.pageId = text.trim();
            seenPageId = true;
          }
          break;
        case 'revid':
          current.revision = text.trim();
          break;
      }
      field = null;
      text = '';
    }

    if (name === 'page') {
      const p = current;
      current = null;
      if (!p.title || !p.pageId) return;
      if (opts.filter && !opts.filter(p.title, p.ns ?? 0)) return;
      onPage({
        title: p.title,
        ns: p.ns ?? 0,
        pageId: p.pageId,
        isRedirect: p.isRedirect ?? false,
        revision: p.revision ?? '',
        wikitext: p.wikitext ?? '',
      });
    }
  };

  // `encoding: 'utf8'` matters, not just convenience: the dump is full of
  // non-ASCII prose (accented names, em dashes, curly quotes — over a million
  // non-ASCII bytes in a single mid-sized wiki's export), and reading raw
  // buffers in fixed-size chunks then calling `.toString('utf8')` per chunk
  // would corrupt any multi-byte character that lands on a chunk boundary.
  // `createReadStream`'s string mode runs every chunk through Node's
  // `StringDecoder`, which buffers a trailing partial multi-byte sequence
  // until the next chunk completes it — the one part of "stream this file in
  // pieces" that is genuinely easy to get silently wrong.
  const stream = createReadStream(xmlPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) parser.write(chunk as string);
  parser.close();
}

/** The dump stores `&lt;`, `&amp;`, etc. — the same entities any XML export uses. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Builds an in-memory `PageSource` from a dump: one pass over the XML,
 * filtered to the main namespace and non-redirect pages, indexed by title. A
 * mid-sized wiki's main-namespace page count (a few thousand to tens of
 * thousands) is cheap to hold as parsed `WikiPage` records even though the
 * raw XML is not — this is the same tradeoff `WikiClient`'s cache already
 * makes, just filled from one file instead of from paginated requests.
 *
 * `links`/`categories` are not in the dump (they are API-computed, not
 * stored), so both come from `parseLinks`/`parseCategories` over the
 * wikitext — the exact fallback path `crawl()` already exercises whenever a
 * page's API-provided lists are empty, which is what makes this drop-in
 * rather than a parallel code path to maintain.
 */
export class DumpSource implements PageSource {
  private byTitle = new Map<string, WikiPage>();
  requests = 0; // kept for parity with WikiClient's reporting; a dump makes none

  static async load(xmlPath: string): Promise<DumpSource> {
    const src = new DumpSource();
    await streamDumpPages(
      xmlPath,
      (page) => {
        if (page.isRedirect || !page.wikitext.trim()) return;
        src.byTitle.set(page.title, {
          pageId: page.pageId,
          title: page.title,
          revision: page.revision,
          wikitext: page.wikitext,
          categories: parseCategories(page.wikitext),
          links: parseLinks(page.wikitext),
        });
      },
      { filter: (_title, ns) => ns === 0 },
    );
    return src;
  }

  async fetchPages(titles: string[]): Promise<WikiPage[]> {
    const out: WikiPage[] = [];
    for (const t of new Set(titles.map((x) => x.trim()).filter(Boolean))) {
      const hit = this.byTitle.get(t);
      if (hit) out.push(hit);
    }
    return out;
  }

  async fetchPage(title: string): Promise<WikiPage | null> {
    return this.byTitle.get(title.trim()) ?? null;
  }

  has(title: string): boolean {
    return this.byTitle.has(title.trim());
  }

  size(): number {
    return this.byTitle.size;
  }

  titles(): string[] {
    return [...this.byTitle.keys()];
  }
}

/**
 * A `PageSource` that reads the dump first and only calls out to a live
 * client (typically `WikiClient`) for titles the dump does not have — pages
 * created after the snapshot was generated, or on a wiki whose dump has never
 * been requested. This is the hybrid the design settled on: offline-first,
 * with the live path as a fallback rather than the default, so the ToU
 * exposure discussed in `client.ts` only applies to the pages a fresh dump
 * genuinely cannot cover.
 */
export class HybridSource implements PageSource {
  private dump: DumpSource;
  private live: PageSource;
  private onFallback?: (title: string) => void;

  constructor(dump: DumpSource, live: PageSource, onFallback?: (title: string) => void) {
    this.dump = dump;
    this.live = live;
    this.onFallback = onFallback;
  }

  async fetchPages(titles: string[]): Promise<WikiPage[]> {
    const wanted = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
    const fromDump = await this.dump.fetchPages(wanted);
    const covered = new Set(fromDump.map((p) => p.title));
    const missing = wanted.filter((t) => !covered.has(t));
    if (!missing.length) return fromDump;

    for (const t of missing) this.onFallback?.(t);
    const fromLive = await this.live.fetchPages(missing);
    return [...fromDump, ...fromLive];
  }

  async fetchPage(title: string): Promise<WikiPage | null> {
    const hit = await this.dump.fetchPage(title);
    if (hit) return hit;
    this.onFallback?.(title);
    return this.live.fetchPage(title);
  }

  /**
   * The dump's page count — the overwhelming majority of what this source will
   * ever serve, and the only part that is countable at all.
   *
   * Not a hard ceiling: the live fallback can serve titles created after the
   * snapshot, so a crawl can legitimately end up a few pages past this. It is
   * reported anyway because it is the difference between a progress bar and a
   * spinner over tens of thousands of pages, and `crawl` never lets the total
   * sit below the count it has already reached.
   */
  size(): number {
    return this.dump.size();
  }
}
