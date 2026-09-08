#!/usr/bin/env node
/**
 * Wiki ingest. Discovery is the default: it shows what a crawl would pull and
 * what it would cost, and commits nothing until asked.
 *
 *   pnpm ingest --wiki=https://x.fandom.com --seed="A Page" --seed="Another"
 *   pnpm ingest ... --mode=mid --commit
 *   pnpm ingest ... --dump --commit          # offline-first: dump backbone, live fallback
 *   pnpm ingest ... --world=empyrean-series --dump --commit
 *   pnpm ingest --upgrade=deep
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { pathsFor } from '../store/worlds.ts';
import { loadConfig } from '../config/config.ts';
import { WikiClient, type PageSource } from '../ingest/client.ts';
import { DumpSource, HybridSource, ensureDumpXml } from '../ingest/dump.ts';
import { crawl, discover, prune } from '../ingest/scope.ts';
import {
  ingest,
  MODES,
  specFor,
  parseBudget,
  budgetLabel,
  upgradeDepth,
  DEFAULT_PASSB_CONCURRENCY,
  type DepthMode,
  type IngestLimits,
  type PassBExtractor,
} from '../ingest/depth.ts';
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
const worldSlug = flag('world');
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

// Budget overrides on top of the mode's preset. Each accepts a positive
// integer or "all"; absent leaves the preset alone. See `IngestLimits`.
let limits: IngestLimits;
try {
  limits = {
    ...(parseBudget(flag('max-pages'), '--max-pages') !== undefined ? { maxPages: parseBudget(flag('max-pages'), '--max-pages')! } : {}),
    ...(parseBudget(flag('hops'), '--hops') !== undefined ? { hops: parseBudget(flag('hops'), '--hops')! } : {}),
    ...(parseBudget(flag('passb-max-pages'), '--passb-max-pages') !== undefined
      ? { passBMaxPages: parseBudget(flag('passb-max-pages'), '--passb-max-pages')! }
      : {}),
  };
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (passBConcurrency !== undefined && (!Number.isFinite(passBConcurrency) || passBConcurrency < 1)) {
  console.error(`--concurrency must be a positive integer, got "${concurrencyRaw}"`);
  process.exit(1);
}

if (!MODES[mode]) {
  console.error(`unknown mode "${mode}". one of: ${Object.keys(MODES).join(', ')}`);
  process.exit(1);
}

const cfg = loadConfig();
const dbPath = worldSlug ? pathsFor(worldSlug).dbPath : cfg.dbPath;
mkdirSync(dirname(dbPath), { recursive: true });
const world = World.open(dbPath);

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
  --mode=skim|mid|deep|all   default skim; "all" is the whole wiki (needs --dump)
  --max-pages=N|all          override the mode's page budget
  --hops=N|all               override the mode's crawl radius
  --passb-max-pages=N|all    cap the LLM pass independently of --max-pages
  --exclude="Page Title"     repeatable
  --world=<slug>              write to data/worlds/<slug>/world.db
  --commit                   write to the graph (otherwise discovery only)
  --upgrade=mid|deep|all     deepen what is already ingested
  --dump                     read from Fandom's XML database dump first, live api.php only as fallback
  --concurrency=N            pass B extractions in flight (default ${DEFAULT_PASSB_CONCURRENCY})

Budgets: pass A (entities, infobox edges, wikilinks) is an offline parse and
scales to a whole wiki for free. Pass B is one model call per page, so
--max-pages and --passb-max-pages are separate knobs on purpose: "crawl
everything, extract relations from the best 3,000" is the intended shape of a
full-wiki run, and is what --mode=all does.

Unlimited budgets require --dump: walking a live api.php until the frontier
runs dry is tens of thousands of requests against someone else's server.

Discovery runs by default and commits nothing: a crawl that silently pulls
3,000 pages of a continuity you do not care about is the likeliest way this
step goes wrong.`);
  world.close();
  process.exit(0);
}

const base = wikiUrl.replace(/\/$/, '').replace(/\/api\.php$/, '');
const spec = specFor(mode, limits);

// Unlimited means "walk until the frontier is exhausted", which is only a
// bounded operation against a source with a bounded page set. Against live
// api.php it is an unbounded request storm aimed at a third party, so this
// refuses rather than warns — see docs/legal-briefing-fandom-ingest.md §6.1.
if ((!Number.isFinite(spec.maxPages) || !Number.isFinite(spec.hops)) && !useDump) {
  console.error(
    `an unlimited budget (mode=${mode}, max-pages=${budgetLabel(spec.maxPages)}, hops=${budgetLabel(spec.hops)}) needs --dump:\n` +
      `crawling a live wiki until the frontier is exhausted would be tens of thousands of api.php requests.\n` +
      `add --dump to read the XML database dump instead, or give a finite --max-pages/--hops.`,
  );
  world.close();
  process.exit(1);
}

const liveClient = new WikiClient({ baseUrl: base, delayMs: 200 });
const client: PageSource = useDump ? await buildDumpSource(wikiUrl, liveClient) : liveClient;

console.log(
  `crawling ${seeds.length} seed(s) at ${mode} (${budgetLabel(spec.hops)} hops, up to ${budgetLabel(spec.maxPages)} pages, ` +
    `pass B on up to ${spec.passB === 'none' ? 0 : budgetLabel(spec.passBMaxPages)})…`,
);

const crawled = await crawl({
  client,
  seeds,
  hops: spec.hops,
  maxPages: spec.maxPages,
  exclude,
  onProgress: ({ pagesFetched, queued, pageTotal }) => {
    // Counted in pages against a real ceiling when there is one (a dump knows
    // its own size; a finite --max-pages is one too), and as "fetched + queued"
    // when there is not. Never a percentage of a guess.
    process.stdout.write(`\r  crawling: ${pageProgress(pagesFetched, queued, pageTotal)}`.padEnd(72));
  },
});
process.stdout.write('\n');
const scoped = prune(crawled, { maxPages: spec.maxPages });
const preview = discover(scoped, { maxPages: spec.maxPages });

console.log(`\n${preview.candidatePages.toLocaleString()} pages, ${liveClient.requests} api request(s)${useDump ? ' (dump-backed; live requests are fallback only)' : ''}`);
// A crawl ends when the frontier runs dry, which on a full-wiki run is usually
// short of the source's total: the remainder is not reachable by links from
// these seeds. Saying so explicitly stops "88%" reading as a failure, and is
// real feedback on the seed choice.
const sourceSize = typeof client.size === 'function' ? client.size() : null;
if (sourceSize && crawled.pages.size < sourceSize) {
  const missed = sourceSize - crawled.pages.size;
  console.log(
    `  ${missed.toLocaleString()} of the source's ${sourceSize.toLocaleString()} pages were not reachable by links from these seeds` +
      `${Number.isFinite(spec.maxPages) ? '' : ' (the crawl stopped because the frontier ran dry, not because of a budget)'}`,
  );
}
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
  limits,
  wiki: hostOf(wikiUrl),
  // Pass A over tens of thousands of pages is otherwise a long silence, and its
  // total is exact before it starts — so this one is a true percentage.
  onPassAProgress: (done, total, phase) => {
    const pct = Math.min(100, Math.floor((done / total) * 100));
    process.stdout.write(`\r  ${phase === 'parsing' ? 'reading' : 'indexing'}: ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`.padEnd(72));
    if (done === total) process.stdout.write('\n');
  },
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
if (res.passA?.unmatchedRelationFields.length) {
  console.log(
    `\ninfobox fields that look relational but matched no rule in RELATION_FIELDS:\n  ${res.passA.unmatchedRelationFields
      .slice(0, 12)
      .map((f) => `${f.field} (${f.count})`)
      .join(', ')}`,
  );
}
if (res.passB) {
  console.log(
    `events: ${res.passB.events} node(s), ${res.passB.eventParticipants} participant link(s), ` +
      `${res.passB.eventsSkipped} undated single-subject statement(s) kept on their entity instead`,
  );
}

if (res.passB && extractor instanceof LlmPassBExtractor) {
  const st = extractor.stats;
  console.log(`\npass B: ${res.passB.pages} pages, ${res.passB.edges} relations, ${res.passB.events} events, ${res.passB.voiceCards} voice cards`);
  // The drop rate is the number worth watching: a low one usually means the
  // extractor is inventing rather than that the wiki is unusually clean.
  console.log(`dropped: ${st.droppedNoEvidence} unevidenced, ${st.droppedBadPredicate} off-vocabulary, ${st.droppedUnknownObject} unknown target`);
}
world.close();

/** "3,502 of 4,323 pages · 81%", or "3,502 pages, 1,900 queued" when nothing bounds it. */
function pageProgress(done: number, queued: number, total: number | null): string {
  if (total && total > 0) {
    const pct = Math.min(100, Math.floor((done / total) * 100));
    return `${done.toLocaleString()} of ${total.toLocaleString()} pages · ${pct}%`;
  }
  return `${done.toLocaleString()} pages, ${queued.toLocaleString()} queued`;
}

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
