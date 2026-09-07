import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WikiPage } from '../src/ingest/client.ts';
import {
  DumpSource,
  HybridSource,
  dbNameOf,
  ensureDumpXml,
  guessDumpUrl,
  resolveDumpUrl,
  streamDumpPages,
} from '../src/ingest/dump.ts';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'story-dump-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FIXTURE_XML = join(import.meta.dirname, 'fixtures', 'dump', 'testwiki_pages_current.xml');
const FIXTURE_7Z = join(import.meta.dirname, 'fixtures', 'dump', 'testwiki_pages_current.xml.7z');

// ------------------------------------------------------------------ URL resolution

test('dbNameOf extracts the fandom subdomain', () => {
  assert.equal(dbNameOf('https://masseffect.fandom.com'), 'masseffect');
  assert.equal(dbNameOf('https://witcher.fandom.com/'), 'witcher');
  assert.equal(dbNameOf('not a url'), 'not a url');
});

test('guessDumpUrl follows the observed S3 convention', () => {
  assert.equal(
    guessDumpUrl('masseffect'),
    'https://s3.amazonaws.com/wikia_xml_dumps/m/ma/masseffect_pages_current.xml.7z',
  );
  assert.equal(guessDumpUrl('witcher'), 'https://s3.amazonaws.com/wikia_xml_dumps/w/wi/witcher_pages_current.xml.7z');
});

test('resolveDumpUrl takes the guessed URL when it HEADs ok, without touching Special:Statistics', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string, opts?: RequestInit) => {
    calls.push(`${opts?.method ?? 'GET'} ${url}`);
    return { ok: true, status: 200, body: null, text: async () => '' } as unknown as Response;
  }) as typeof fetch;

  const url = await resolveDumpUrl({ wikiUrl: 'https://masseffect.fandom.com', fetcher });
  assert.equal(url, guessDumpUrl('masseffect'));
  assert.equal(calls.length, 1, 'one HEAD, no fallback page load');
  assert.match(calls[0]!, /^HEAD /);
});

test('resolveDumpUrl falls back to scraping Special:Statistics when the guess misses', async () => {
  const html = `<a href="https://s3.amazonaws.com/wikia_xml_dumps/x/xy/xyzwiki_pages_current.xml.7z" target="_blank">2026-01-01</a>`;
  const fetcher = (async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'HEAD') return { ok: false, status: 404, body: null, text: async () => '' } as unknown as Response;
    assert.match(url, /Special:Statistics$/);
    return { ok: true, status: 200, body: null, text: async () => html } as unknown as Response;
  }) as typeof fetch;

  const url = await resolveDumpUrl({ wikiUrl: 'https://xyzwiki.fandom.com', fetcher });
  assert.equal(url, 'https://s3.amazonaws.com/wikia_xml_dumps/x/xy/xyzwiki_pages_current.xml.7z');
});

test('resolveDumpUrl prefers the "current pages" link over "current pages and history"', async () => {
  const html = `
    <a href="https://s3.amazonaws.com/wikia_xml_dumps/x/xy/xyzwiki_pages_current.xml.7z">current</a>
    <a href="https://s3.amazonaws.com/wikia_xml_dumps/x/xy/xyzwiki_pages_full.xml.7z">full</a>
  `;
  const fetcher = (async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'HEAD') return { ok: false, status: 404, body: null, text: async () => '' } as unknown as Response;
    return { ok: true, status: 200, body: null, text: async () => html } as unknown as Response;
  }) as typeof fetch;

  const url = await resolveDumpUrl({ wikiUrl: 'https://xyzwiki.fandom.com', fetcher });
  assert.match(url, /_pages_current\.xml\.7z$/);
});

test('resolveDumpUrl throws a legible error when nothing is found', async () => {
  const fetcher = (async (_url: string, opts?: RequestInit) => {
    if (opts?.method === 'HEAD') return { ok: false, status: 404, body: null, text: async () => '' } as unknown as Response;
    return { ok: true, status: 200, body: null, text: async () => '<html>no dump here</html>' } as unknown as Response;
  }) as typeof fetch;

  await assert.rejects(() => resolveDumpUrl({ wikiUrl: 'https://xyzwiki.fandom.com', fetcher }), /no dump link found/);
});

// ------------------------------------------------------------------ XML streaming

test('streamDumpPages yields every page with title, ns, id, revision and text decoded', async () => {
  const pages: Array<{ title: string; ns: number; pageId: string; isRedirect: boolean; revision: string; wikitext: string }> = [];
  await streamDumpPages(FIXTURE_XML, (p) => pages.push(p));

  assert.equal(pages.length, 4);
  const alpha = pages.find((p) => p.title === 'Alpha')!;
  assert.equal(alpha.ns, 0);
  assert.equal(alpha.pageId, '1');
  assert.equal(alpha.revision, '101');
  assert.equal(alpha.isRedirect, false);
  assert.match(alpha.wikitext, /Infobox character/);
  assert.match(alpha.wikitext, /\[\[Beta Faction\]\]/, 'entities decoded, links intact');

  const redirect = pages.find((p) => p.title === 'Redirect Page')!;
  assert.equal(redirect.isRedirect, true, 'the <redirect> element is detected');

  const talk = pages.find((p) => p.title === 'Talk:Alpha')!;
  assert.equal(talk.ns, 1, 'non-zero namespace is reported, not silently coerced to 0');
});

test('streamDumpPages respects a namespace/title filter without materialising skipped pages', async () => {
  const seen: string[] = [];
  await streamDumpPages(FIXTURE_XML, (p) => seen.push(p.title), { filter: (_t, ns) => ns === 0 });
  assert.deepEqual(seen.sort(), ['Alpha', 'Beta Faction', 'Redirect Page']);
});

test('streamDumpPages does not corrupt non-ASCII text (accents, em dash, curly quote)', async () => {
  let beta: { wikitext: string } | undefined;
  await streamDumpPages(FIXTURE_XML, (p) => {
    if (p.title === 'Beta Faction') beta = p;
  });
  assert.ok(beta);
  assert.match(beta!.wikitext, /café/);
  assert.match(beta!.wikitext, /naïve/);
  assert.match(beta!.wikitext, /—/);
  assert.doesNotMatch(beta!.wikitext, /\ufffd/, 'no replacement-character corruption');
});

test('streamDumpPages correctly disambiguates <page><id> from <revision><id>', async () => {
  const pages: Array<{ pageId: string; revision: string }> = [];
  await streamDumpPages(FIXTURE_XML, (p) => pages.push(p));
  const beta = pages.find((p) => (p as unknown as { title: string }).title === 'Beta Faction')!;
  assert.equal(beta.pageId, '4');
  assert.equal(beta.revision, '104');
});

// ------------------------------------------------------------------ DumpSource

test('DumpSource.load indexes main-namespace, non-redirect pages as WikiPage records', async () => {
  const src = await DumpSource.load(FIXTURE_XML);
  assert.equal(src.size(), 2, 'Alpha and Beta Faction only: redirect and Talk: excluded');
  assert.ok(src.has('Alpha'));
  assert.ok(src.has('Beta Faction'));
  assert.equal(src.has('Redirect Page'), false);
  assert.equal(src.has('Talk:Alpha'), false);
});

test('DumpSource derives categories and links from wikitext, same as the live parser fallback', async () => {
  const src = await DumpSource.load(FIXTURE_XML);
  const alpha = await src.fetchPage('Alpha');
  assert.ok(alpha);
  assert.deepEqual(alpha!.categories, ['Characters']);
  assert.ok(alpha!.links.includes('Beta Faction'));
  assert.ok(alpha!.links.includes('Beta City'));
});

test('DumpSource.fetchPages dedupes, trims, and skips titles it does not have', async () => {
  const src = await DumpSource.load(FIXTURE_XML);
  const pages = await src.fetchPages(['Alpha', ' Alpha ', 'Alpha', 'Nonexistent']);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.title, 'Alpha');
});

test('DumpSource makes no requests — the whole point of reading a local file', async () => {
  const src = await DumpSource.load(FIXTURE_XML);
  assert.equal(src.requests, 0);
});

// ------------------------------------------------------------------ HybridSource

function stubLive(pages: Record<string, WikiPage>) {
  const calls: string[][] = [];
  return {
    calls,
    fetchPages: async (titles: string[]) => {
      calls.push(titles);
      return titles.map((t) => pages[t]).filter((p): p is WikiPage => !!p);
    },
    fetchPage: async (title: string) => {
      calls.push([title]);
      return pages[title] ?? null;
    },
  };
}

test('HybridSource serves dump-covered titles without touching the live source', async () => {
  const dump = await DumpSource.load(FIXTURE_XML);
  const live = stubLive({});
  const hybrid = new HybridSource(dump, live);

  const pages = await hybrid.fetchPages(['Alpha', 'Beta Faction']);
  assert.equal(pages.length, 2);
  assert.equal(live.calls.length, 0, 'the dump alone answered both titles');
});

test('HybridSource falls back to the live source only for titles the dump lacks', async () => {
  const dump = await DumpSource.load(FIXTURE_XML);
  const freshPage: WikiPage = { pageId: '99', title: 'Gamma', revision: '1', wikitext: 'Gamma text', categories: [], links: [] };
  const live = stubLive({ Gamma: freshPage });
  const hybrid = new HybridSource(dump, live);

  const pages = await hybrid.fetchPages(['Alpha', 'Gamma']);
  assert.equal(pages.length, 2);
  assert.ok(pages.some((p) => p.title === 'Alpha'));
  assert.ok(pages.some((p) => p.title === 'Gamma'));
  assert.deepEqual(live.calls, [['Gamma']], 'only the missing title reached the live client');
});

test('HybridSource.fetchPage mirrors the same dump-first, live-fallback order', async () => {
  const dump = await DumpSource.load(FIXTURE_XML);
  const freshPage: WikiPage = { pageId: '99', title: 'Gamma', revision: '1', wikitext: 'Gamma text', categories: [], links: [] };
  const live = stubLive({ Gamma: freshPage });
  const hybrid = new HybridSource(dump, live);

  const alpha = await hybrid.fetchPage('Alpha');
  assert.equal(alpha?.title, 'Alpha');
  assert.equal(live.calls.length, 0);

  const gamma = await hybrid.fetchPage('Gamma');
  assert.equal(gamma?.title, 'Gamma');
  assert.deepEqual(live.calls, [['Gamma']]);
});

test('HybridSource reports fallbacks through onFallback', async () => {
  const dump = await DumpSource.load(FIXTURE_XML);
  const live = stubLive({});
  const fellBack: string[] = [];
  const hybrid = new HybridSource(dump, live, (title) => fellBack.push(title));

  await hybrid.fetchPages(['Alpha', 'Missing']);
  assert.deepEqual(fellBack, ['Missing']);
});

// ------------------------------------------------------------------ download + cache (ensureDumpXml)

test('ensureDumpXml downloads, extracts, and caches — a second call costs nothing', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('.7z')) {
      res.setHeader('content-type', 'application/x-7z-compressed');
      createReadStream(FIXTURE_7Z).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  const { dir, cleanup } = tmp();

  try {
    // ensureDumpXml resolves the guessed convention URL from the wiki's real
    // hostname, which cannot point at the local fixture server — so this test
    // redirects that one guessed URL to the fixture server and lets every
    // other request through untouched. `resolveDumpUrl`'s own resolution
    // logic (HEAD-then-scrape) is covered directly above.
    const guessUrl = `http://127.0.0.1:${port}/dump.7z`;
    const guessedRealUrl = guessDumpUrl('testwiki');
    let liveCalls = 0;
    const fetcher = (async (url: string, opts?: RequestInit) => {
      liveCalls++;
      return fetch(url === guessedRealUrl ? guessUrl : url, opts);
    }) as typeof fetch;

    const xmlPath = await ensureDumpXml({ wikiUrl: 'https://testwiki.fandom.com', cacheDir: dir, fetcher });
    assert.ok(existsSync(xmlPath));
    assert.match(xmlPath, /testwiki_pages_current\.xml$/);
    assert.ok(liveCalls > 0);

    const archivePath = join(dir, 'testwiki_pages_current.xml.7z');
    assert.equal(existsSync(archivePath), false, 'the archive is removed once extracted');

    // Second call: cached, must not hit the server again.
    const callsBefore = liveCalls;
    const xmlPath2 = await ensureDumpXml({ wikiUrl: 'https://testwiki.fandom.com', cacheDir: dir, fetcher });
    assert.equal(xmlPath2, xmlPath);
    assert.equal(liveCalls, callsBefore, 'a cached dump is reused, not re-downloaded');

    const src = await DumpSource.load(xmlPath);
    assert.equal(src.size(), 2);
  } finally {
    server.close();
    cleanup();
  }
});

test('ensureDumpXml surfaces a clear error when the download fails', async () => {
  const { dir, cleanup } = tmp();
  const fetcher = (async (_url: string, opts?: RequestInit) => {
    if (opts?.method === 'HEAD') return { ok: true, status: 200, body: null, text: async () => '' };
    return { ok: false, status: 403, body: null, text: async () => '' };
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => ensureDumpXml({ wikiUrl: 'https://masseffect.fandom.com', cacheDir: dir, fetcher }),
      /dump download failed/,
    );
  } finally {
    cleanup();
  }
});
