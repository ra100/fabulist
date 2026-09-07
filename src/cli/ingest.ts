#!/usr/bin/env node
/**
 * Wiki ingest. Discovery is the default: it shows what a crawl would pull and
 * what it would cost, and commits nothing until asked.
 *
 *   pnpm ingest --wiki=https://x.fandom.com --seed="A Page" --seed="Another"
 *   pnpm ingest ... --mode=mid --commit
 *   pnpm ingest ... --dump --commit          # offline-first: dump backbone, live fallback
 *   pnpm ingest --upgrade=deep
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { loadConfig } from '../config/config.ts';
import { WikiClient, type PageSource } from '../ingest/client.ts';
import { DumpSource, HybridSource, ensureDumpXml } from '../ingest/dump.ts';
import { crawl, discover, prune } from '../ingest/scope.ts';
import { ingest, MODES, upgradeDepth, DEFAULT_PASSB_CONCURRENCY, type DepthMode, type PassBExtractor } from '../ingest/depth.ts';
import { LlmPassBExtractor } from '../ingest/passB.ts';
import { buildRegistry } from '../config/config.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const all = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.split('=').slice(1).join('='));

const wikiUrl = flag('wiki');
const seeds = all('seed');
const mode = (flag('mode') ?? 'skim') as DepthMode;
const commit = args.includes('--commit');
const upgrade = flag('upgrade') as DepthMode | undefined;
const exclude = all('exclude');
// See docs/legal-briefing-fandom-ingest.md §6.1 and src/ingest/dump.ts: reads
// Fandom's own XML database dump first (one bounded download, no repeated
// querying) and only calls the live api.php crawler for titles the dump
// does not have. Off by default so existing behaviour and tests are
// unaffected; on is the recommended path for any real ingest.
const useDump = args.includes('--dump');
// Pass B is the longest operation here — 150 sequential ~7k-token calls at mid,
// 3000 at deep — so the pool size is worth exposing rather than burying.
const concurrencyRaw = flag('concurrency');
const passBConcurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined;

if (passBConcurrency !== undefined && (!Number.isFinite(passBConcurrency) || passBConcurrency < 1)) {
  console.error(`--concurrency must be a positive integer, got "${concurrencyRaw}"`);
  process.exit(1);
}

if (!MODES[mode]) {
  console.error(`unknown mode "${mode}". one of: ${Object.keys(MODES).join(', ')}`);
  process.exit(1);
}

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const world = World.open(cfg.dbPath);

if (upgrade) {
  if (!wikiUrl) {
    console.error('--upgrade needs --wiki=<url> to fetch the pages it is missing');
    process.exit(1);
  }
  const client: PageSource = useDump
    ? await buildDumpSource(wikiUrl)
    : new WikiClient({ baseUrl: `${wikiUrl.replace(/\/$/, '')}/api.php`.replace('/api.php/api.php', '/api.php') });
  const res = await upgradeDepth(world, upgrade, { client, wiki: hostOf(wikiUrl) });
  console.log(`examined ${res.examined} node(s) below ${upgrade}, upgraded ${res.upgraded}`);
  world.close();
  process.exit(0);
}

if (!wikiUrl || seeds.length === 0) {
  console.log(`usage:
  --wiki=<fandom url>        e.g. https://elderscrolls.fandom.com
  --seed="Page Title"        repeatable; the arc, era or region to play in
  --mode=skim|mid|deep       default skim
  --exclude="Page Title"     repeatable
  --commit                   write to the graph (otherwise discovery only)
  --upgrade=mid|deep         deepen what is already ingested
  --dump                     read from Fandom's XML database dump first, live api.php only as fallback
  --concurrency=N            pass B extractions in flight (default ${DEFAULT_PASSB_CONCURRENCY})

Discovery runs by default and commits nothing: a crawl that silently pulls
3,000 pages of a continuity you do not care about is the likeliest way this
step goes wrong.`);
  world.close();
  process.exit(0);
}

const base = wikiUrl.replace(/\/$/, '').replace(/\/api\.php$/, '');
const liveClient = new WikiClient({ baseUrl: base, delayMs: 200 });
const client: PageSource = useDump ? await buildDumpSource(wikiUrl, liveClient) : liveClient;
const spec = MODES[mode];

console.log(`crawling ${seeds.length} seed(s) at ${mode} (${spec.hops} hops, up to ${spec.maxPages} pages)…`);

const crawled = await crawl({ client, seeds, hops: spec.hops, maxPages: spec.maxPages, exclude });
const scoped = prune(crawled, { maxPages: spec.maxPages });
const preview = discover(scoped, { maxPages: spec.maxPages });

console.log(`\n${preview.candidatePages} pages, ${liveClient.requests} api request(s)${useDump ? ' (dump-backed; live requests are fallback only)' : ''}`);
console.log(`by hop: ${Object.entries(preview.byHop).map(([h, n]) => `${h}=${n}`).join(' ')}`);
console.log(`by type: ${Object.entries(preview.byType).map(([t, n]) => `${t}=${n}`).join(' ')}`);
console.log(`seed categories: ${preview.seedCategories.slice(0, 8).join(', ')}`);
console.log(`\ntop entities:`);
for (const e of preview.topEntities.slice(0, 15)) {
  console.log(`  ${e.score.toFixed(3)} [${e.type}] ${e.title}`);
}
if (preview.characters.length) console.log(`\ncharacters: ${preview.characters.slice(0, 15).join(', ')}`);
if (preview.factions.length) console.log(`factions: ${preview.factions.slice(0, 10).join(', ')}`);
if (preview.locations.length) console.log(`locations: ${preview.locations.slice(0, 10).join(', ')}`);
console.log(`\nestimated pass B: ~${preview.estimatedTokens.toLocaleString()} tokens, ~$${preview.estimatedCostUsd}`);

if (!commit) {
  console.log(`\nnothing written. re-run with --commit to ingest.`);
  world.close();
  process.exit(0);
}

// Pass B needs a provider. On the mock profile it still runs and is still
// useful as a dry run, since the validation gate is what does the real work.
let extractor: PassBExtractor | undefined;
if (spec.passB !== 'none') {
  const { registry, notes } = buildRegistry(cfg);
  for (const n of notes) console.log(n);
  extractor = new LlmPassBExtractor({
    provider: registry.get('passb'),
    world,
    onError: (title, err) => console.log(`  pass B failed on ${title}: ${err instanceof Error ? err.message : String(err)}`),
  });
}

const res = await ingest({
  world,
  client,
  seeds,
  mode,
  wiki: hostOf(wikiUrl),
  exclude,
  extractor,
  ...(passBConcurrency !== undefined ? { passBConcurrency } : {}),
  // A run that prints nothing for an hour is indistinguishable from a hung one.
  onPassBProgress: (done, total, title) => {
    const pct = Math.floor((done / total) * 100);
    process.stdout.write(`\r  pass B ${done}/${total} (${pct}%) ${title.slice(0, 44).padEnd(44)}`);
    if (done === total) process.stdout.write('\n');
  },
});
console.log(`\ncommitted: ${res.passA?.entities} entities, ${res.passA?.edges} typed edges, ${res.passA?.mentions} mentions, ${res.passA?.sheets} sheets`);
if (res.passA?.skipped.length) console.log(`skipped ${res.passA.skipped.length} page(s): ${res.passA.skipped.slice(0, 5).join(', ')}`);

if (res.passB && extractor instanceof LlmPassBExtractor) {
  const st = extractor.stats;
  console.log(`\npass B: ${res.passB.pages} pages, ${res.passB.edges} relations, ${res.passB.events} events, ${res.passB.voiceCards} voice cards`);
  // The drop rate is the number worth watching: a low one usually means the
  // extractor is inventing rather than that the wiki is unusually clean.
  console.log(`dropped: ${st.droppedNoEvidence} unevidenced, ${st.droppedBadPredicate} off-vocabulary, ${st.droppedUnknownObject} unknown target`);
}
world.close();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0] ?? 'wiki';
  } catch {
    return 'wiki';
  }
}

/**
 * Downloads (or reuses the cached copy of) the wiki's XML dump and loads it
 * into memory, wrapped in a `HybridSource` when a live client is given so
 * pages the dump does not have — created after its last refresh — still
 * resolve instead of silently vanishing from the crawl.
 */
async function buildDumpSource(url: string, live?: PageSource): Promise<PageSource> {
  console.log(`fetching database dump for ${hostOf(url)} (cached after first run)…`);
  const xmlPath = await ensureDumpXml({ wikiUrl: url });
  const dump = await DumpSource.load(xmlPath);
  console.log(`dump loaded: ${dump.size().toLocaleString()} main-namespace pages`);
  return live ? new HybridSource(dump, live) : dump;
}

