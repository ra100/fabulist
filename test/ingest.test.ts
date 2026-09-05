import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { WikiClient, fixtureFetcher } from '../src/ingest/client.ts';
import {
  fieldValues,
  firstParagraph,
  inferEntityType,
  parseCategories,
  parseInfobox,
  parseLinks,
  parseQuotes,
  parseSections,
  slugId,
  slugify,
  stripMarkup,
} from '../src/ingest/parse.ts';
import { crawl, discover, isIndexTitle, prune } from '../src/ingest/scope.ts';
import { runPassA } from '../src/ingest/passA.ts';
import {
  deepenOnDemand,
  ingest,
  MODES,
  NullPassBExtractor,
  promoteRegion,
  upgradeDepth,
  type PassBExtractor,
} from '../src/ingest/depth.ts';
import { WIKI } from './fixtures/wiki.ts';

const client = () => new WikiClient({ baseUrl: 'https://vale.fandom.com', fetcher: fixtureFetcher(WIKI), delayMs: 0 });

// ------------------------------------------------------------------ parsers

test('infobox fields parse, with links unwrapped', () => {
  const box = parseInfobox(WIKI['Warden Ilsa Crowe']!.wikitext!)!;
  assert.match(box.template, /^Infobox character$/i);
  assert.equal(box.fields.species, 'Human');
  assert.equal(box.fields.status, 'Alive');
  assert.equal(box.fields.location, 'Duskhollow', 'wiki link reduced to its target');
});

test('a <br/> separated field becomes multiple values', () => {
  const box = parseInfobox(WIKI['Warden Ilsa Crowe']!.wikitext!)!;
  assert.equal(box.fields.affiliation, 'Wardens of the Vale; The Bridge Council');
  assert.deepEqual(fieldValues(box.fields.affiliation!), ['Wardens of the Vale', 'The Bridge Council']);
});

test('nested templates do not terminate the infobox early', () => {
  // {{nowrap|[[...]]}} and {{Date|...}} appear inside values here.
  const box = parseInfobox(WIKI['The Bridge Council']!.wikitext!)!;
  assert.equal(box.fields.headquarters, 'Duskhollow', 'a field after the nested template still parses');
  assert.ok(box.fields.members, 'and so does the one after that');
});

test('a piped link inside a nested template keeps its display text', () => {
  const box = parseInfobox(WIKI['The Bridge Council']!.wikitext!)!;
  assert.match(box.fields.leader ?? '', /Ilsa Crowe/);
});

test('an unterminated infobox yields fields instead of losing the page', () => {
  const box = parseInfobox(WIKI['Sundering of Marrow']!.wikitext!)!;
  assert.ok(box, 'parser recovered');
  assert.equal(box.fields.date, '388 AV');
});

test('a page with no infobox returns null rather than throwing', () => {
  assert.equal(parseInfobox('Just prose, no templates.'), null);
});

test('categories and links extract, excluding other namespaces', () => {
  const text = `[[Category:Characters]] [[Duskhollow]] [[File:x.png]] [[Category:Wardens]] [[Emberfall|the town]]`;
  assert.deepEqual(parseCategories(text), ['Characters', 'Wardens']);
  const links = parseLinks(text);
  assert.ok(links.includes('Duskhollow'));
  assert.ok(links.includes('Emberfall'));
  assert.ok(!links.some((l) => /File|Category/.test(l)), 'file and category links are not entities');
});

test('interlanguage links are also excluded from parsed links', () => {
  // A real wiki index page's actual link set: mostly interlanguage tags plus
  // one genuine category, and one real content link.
  const text = `[[de:Personen]] [[es:Personajes]] [[fr:Catégorie:Personnages]] [[Category:Characters]] [[Duskhollow]]`;
  const links = parseLinks(text);
  assert.deepEqual(links, ['Duskhollow'], 'only the real content link survives');
});

test('interlanguage and category links do not leak into a summary', () => {
  // This is the exact shape a Fandom "Characters" index page has: almost no
  // prose, just interlanguage tags and category membership. Before the fix,
  // firstParagraph() surfaced this markup residue as the entity's summary.
  const text = `[[de:Personen]] [[es:Personajes]] [[fi:Hahmot]] [[fr:Catégorie:Personnages]] [[hu:Karakterek]] [[pl:Postacie]] [[nl:Personages]] [[ru:Персонажи]] [[uk:Персонажі]] [[Category:Characters]] [[Category:Gameplay]]`;
  const plain = stripMarkup(text);
  assert.equal(plain.trim(), '', 'nothing readable remains once interlanguage/category links are stripped');
  assert.equal(firstParagraph(text), '', 'no garbled interlanguage residue becomes the summary');
});

test('an infobox field with an interlanguage link inside it drops the link, not the field', () => {
  const box = parseInfobox(`{{Infobox character
| name = Someone
| affiliation = [[de:Etwas]] [[Some Real Faction]]
}}`)!;
  assert.equal(box.fields.affiliation, 'Some Real Faction');
});

test('a wiki-namespace-style title is recognised as navigation, not content, by title shape', () => {
  // The original hub-penalty regex only matched an English "list of ..."
  // prefix. Fandom's own convention for a character index is a bare
  // group-noun title, or that noun as a subpage root — neither starts with
  // "list of", so both sailed through unpenalised on a real ingest.
  for (const title of ['Characters', 'Category:Characters', 'Characters/Mass Effect 2', 'Locations/Andromeda']) {
    assert.ok(isIndexTitle(title), `"${title}" should be recognised as an index page`);
  }
  for (const title of ['Warden Ilsa Crowe', 'Characters of the Vale']) {
    assert.ok(!isIndexTitle(title), `"${title}" should NOT be recognised as an index page`);
  }
});

test('sections split on headings', () => {
  const sections = parseSections(WIKI['Duskhollow']!.wikitext!);
  assert.deepEqual(sections.map((s) => s.title), ['History', 'Notable residents', 'See also']);
  assert.match(sections[0]!.body, /Sundering of Marrow/);
});

test('quoted dialogue is mined for voice cards', () => {
  const quotes = parseQuotes(WIKI['Warden Ilsa Crowe']!.wikitext!);
  assert.ok(quotes.some((q) => /bridge stays open/.test(q)));
  assert.ok(quotes.some((q) => /buried better people/.test(q)));
});

test('markup stripping removes templates, tables and refs', () => {
  const plain = stripMarkup(WIKI['The Bridge Council']!.wikitext!);
  assert.ok(!plain.includes('{{'), 'no templates survive');
  assert.ok(!plain.includes('wikitable'), 'no tables survive');
  assert.match(plain, /Bridge Council sets tolls/);
});

test('the lead paragraph becomes a usable summary', () => {
  const summary = firstParagraph(WIKI['Duskhollow']!.wikitext!);
  assert.match(summary, /^Duskhollow is a terraced city/);
  assert.ok(!summary.includes("'''"));
});

test('entity type is inferred from categories first', () => {
  const cases: Array<[string, string]> = [
    ['Warden Ilsa Crowe', 'Character'],
    ['Duskhollow', 'Location'],
    ['Wardens of the Vale', 'Faction'],
    ['Cinder Riots', 'Event'],
  ];
  for (const [title, expected] of cases) {
    const page = WIKI[title]!;
    const type = inferEntityType(title, page.categories ?? [], parseInfobox(page.wikitext!), firstParagraph(page.wikitext!));
    assert.equal(type, expected, `${title} should be ${expected}`);
  }
});

test('infobox field shape rescues type inference when categories are useless', () => {
  const type = inferEntityType('Someone', ['Uncategorised'], { template: 'Infobox', fields: { species: 'Human', affiliation: 'X' } });
  assert.equal(type, 'Character');
});

test('slug ids are deterministic and namespaced by type', () => {
  assert.equal(slugId('Character', 'Warden Ilsa Crowe'), 'char:warden-ilsa-crowe');
  assert.equal(slugId('Location', 'Duskhollow'), 'loc:duskhollow');
  assert.equal(slugId('Character', 'Warden Ilsa Crowe'), slugId('Character', 'Warden Ilsa Crowe'), 'stable across calls');
  assert.equal(slugify('Bram the Lesser (disambiguation)'), 'bram-the-lesser');
});

// ------------------------------------------------------------------- client

test('the client fetches pages and records revisions', async () => {
  const page = await client().fetchPage('Duskhollow');
  assert.equal(page?.title, 'Duskhollow');
  assert.equal(page?.revision, '101', 'revision is stored so re-ingest can diff');
  assert.ok(page!.categories.includes('Locations'));
});

test('the links query is scoped to the main namespace', async () => {
  // Without plnamespace=0, MediaWiki's `links` prop includes Category:,
  // Template:, File: etc as if they were content links — which is how
  // Category:Characters ended up crawled and scored as a "character" on a
  // real wiki. This asserts the request itself carries the restriction,
  // not just that a fixture happens to come back clean.
  let seenNamespace: string | null = null;
  const spy = async (url: string) => {
    const params = new URL(url, 'http://fixture').searchParams;
    if (params.get('action') === 'query' && params.has('titles')) seenNamespace = params.get('plnamespace');
    return fixtureFetcher(WIKI)(url);
  };
  const c = new WikiClient({ baseUrl: 'https://vale.fandom.com', fetcher: spy, delayMs: 0 });
  await c.fetchPage('Duskhollow');
  assert.equal(seenNamespace, '0', 'the links query restricts to namespace 0');
});

test('a missing page is skipped, not thrown', async () => {
  const c = client();
  const pages = await c.fetchPages(['Duskhollow', 'Does Not Exist']);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.title, 'Duskhollow');
});

test('pages are cached so re-fetching costs no requests', async () => {
  const c = client();
  await c.fetchPages(['Duskhollow', 'Emberfall']);
  const after = c.requests;
  await c.fetchPages(['Duskhollow', 'Emberfall']);
  assert.equal(c.requests, after, 'second fetch served from cache');
});

test('fetches are batched rather than one request per title', async () => {
  const c = new WikiClient({ baseUrl: 'x', fetcher: fixtureFetcher(WIKI), delayMs: 0, batchSize: 50 });
  await c.fetchPages(Object.keys(WIKI));
  assert.equal(c.requests, 1, `13 titles in one request, got ${c.requests}`);
});

test('category members resolve', async () => {
  const members = await client().categoryMembers('Characters');
  assert.ok(members.includes('Warden Ilsa Crowe'));
  assert.ok(members.includes('Vesh Auld'));
});

// -------------------------------------------------------------------- scope

test('the crawl respects the hop limit', async () => {
  const oneHop = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 1, maxPages: 100 });
  const zeroHop = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 0, maxPages: 100 });
  assert.equal(zeroHop.pages.size, 1, 'zero hops is the seed alone');
  assert.ok(oneHop.pages.size > 1, 'one hop reaches the neighbours');
  assert.ok(oneHop.pages.has('Warden Ilsa Crowe'));
});

test('an index page is ranked below arc pages despite linking to everything', async () => {
  // "Index of Vale Topics" links to every page in the wiki, so a ranking based on
  // link count would promote navigation furniture over the story.
  const result = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 2, maxPages: 100 });
  const index = result.candidates.find((c) => c.title === 'Index of Vale Topics');
  assert.ok(index, 'the hub page was reachable and crawled');

  const arcPages = result.candidates.filter(
    (c) => c.title !== 'Index of Vale Topics' && c.categoryOverlap > 0,
  );
  assert.ok(arcPages.length >= 3, 'there are arc pages to compare against');
  assert.ok(
    arcPages.every((c) => c.score > index!.score),
    `every arc page outranks the hub (hub scored ${index!.score})`,
  );

  // And it has the highest outbound degree in the fixture, which is exactly the
  // signal a naive ranking would have rewarded.
  const linkCount = (t: string) => (result.pages.get(t)?.links ?? []).length;
  assert.ok(
    linkCount('Index of Vale Topics') > linkCount('Warden Ilsa Crowe'),
    'the hub really does link more widely than the protagonist',
  );
});

test('a bare group-noun title is scored below real content, not just prefix-matched hubs', async () => {
  // Reproduces the real-world shape (masseffect.fandom.com's "Characters" page):
  // a title that is exactly the name of an entity type, linking to real pages
  // but carrying none of the "list of ..." wording the old regex needed.
  const extra = {
    ...WIKI,
    Characters: {
      title: 'Characters',
      pageId: '900',
      revision: '900',
      categories: ['Meta'],
      wikitext: `[[de:Personen]] [[Category:Characters]] [[Warden Ilsa Crowe]] [[Bram the Lesser]] [[Vesh Auld]]`,
      links: ['Warden Ilsa Crowe', 'Bram the Lesser', 'Vesh Auld'],
    },
  };
  const fixtureClient = new WikiClient({ baseUrl: 'https://vale.fandom.com', fetcher: fixtureFetcher(extra), delayMs: 0 });
  const result = await crawl({ client: fixtureClient, seeds: ['Characters', 'Duskhollow'], hops: 1, maxPages: 100 });
  const index = result.candidates.find((c) => c.title === 'Characters');
  const ilsa = result.candidates.find((c) => c.title === 'Warden Ilsa Crowe');
  assert.ok(index, 'the index page was reachable and crawled');
  assert.ok(ilsa, 'a real character was reachable and crawled');
  assert.ok(index!.score < ilsa!.score, `index (${index!.score}) should score below real content (${ilsa!.score})`);
});

test('a page whose inbound links are mostly out of scope is deprioritised', async () => {
  // The concentration term: sharing few in-scope referrers should cost score
  // relative to a page whose referrers are all inside the arc.
  const result = await crawl({ client: client(), seeds: ['Warden Ilsa Crowe'], hops: 2, maxPages: 100 });
  const scored = new Map(result.candidates.map((c) => [c.title, c]));
  const bram = scored.get('Bram the Lesser')!;
  const vale = scored.get('The Ashen Vale')!;
  // Bram sits inside the arc categories; the Vale is shared background with none.
  assert.ok(bram.categoryOverlap > vale.categoryOverlap);
  assert.ok(bram.score > vale.score, `${bram.score} > ${vale.score}`);
});

test('seed categories are collected to anchor relevance', async () => {
  const result = await crawl({ client: client(), seeds: ['Warden Ilsa Crowe'], hops: 1, maxPages: 100 });
  assert.ok(result.seedCategories.includes('Ashgrove Arc'));
});

test('excluded titles never enter the crawl', async () => {
  const result = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 2, maxPages: 100, exclude: ['Emberfall'] });
  assert.ok(!result.pages.has('Emberfall'));
});

test('discovery previews the scope without committing anything', async () => {
  const world = World.open(':memory:');
  const before = world.graph.counts().entities;
  const result = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 2, maxPages: 100 });
  const preview = discover(result);

  assert.ok(preview.candidatePages > 5);
  assert.ok(preview.characters.length > 0, 'names the cast it found');
  assert.ok(preview.locations.length > 0);
  assert.ok(preview.estimatedTokens > 0, 'estimates the spend');
  assert.ok(preview.estimatedCostUsd >= 0);
  assert.ok(Object.keys(preview.byHop).length > 1, 'shows the hop distribution');
  assert.equal(world.graph.counts().entities, before, 'nothing was written');
  world.close();
});

test('pruning drops pages by title, category and score', async () => {
  const result = await crawl({ client: client(), seeds: ['Duskhollow'], hops: 2, maxPages: 100 });
  const pruned = prune(result, { exclude: ['Emberfall'], excludeCategories: ['Indexes'], maxPages: 6 });
  assert.ok(pruned.candidates.length <= 6);
  assert.ok(!pruned.pages.has('Emberfall'));
  assert.ok(!pruned.candidates.some((c) => c.title === 'Index of Vale Topics'));
});

// ------------------------------------------------------------------- pass A

test('pass A writes typed entities into the canon layer', async () => {
  const world = World.open(':memory:');
  const pages = await client().fetchPages(Object.keys(WIKI));
  const res = runPassA(world, pages, { wiki: 'vale', depth: 1 });

  assert.ok(res.entities > 8, `created ${res.entities} entities`);
  const ilsa = world.graph.get('char:warden-ilsa-crowe')!;
  assert.equal(ilsa.layer, 'canon', 'ingested material is canon, never chronicle');
  assert.equal(ilsa.type, 'Character');
  assert.match(ilsa.provenance, /^vale:Warden Ilsa Crowe#102$/, 'traceable to page and revision');
  assert.equal(ilsa.props.species, 'Human', 'infobox fields land as props');
  world.close();
});

test('pass A derives typed edges from infobox fields', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });

  const edges = world.graph.edgesFrom('char:warden-ilsa-crowe').map((e) => `${e.predicate}->${e.object}`);
  assert.ok(edges.includes('MEMBER_OF->fac:wardens-of-the-vale'), `affiliation became MEMBER_OF: ${edges.join(', ')}`);
  assert.ok(edges.includes('KIN_OF->char:bram-the-lesser'), 'relatives became KIN_OF');
  assert.ok(edges.includes('LOCATED_IN->loc:duskhollow'), 'location became LOCATED_IN');
  assert.ok(edges.includes('HOSTILE_TO->fac:the-cinder-compact'), 'enemies became HOSTILE_TO');
  world.close();
});

test('typed edges carry evidence back to the source field', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });
  const kin = world.graph.edgesFrom('char:warden-ilsa-crowe').find((e) => e.predicate === 'KIN_OF')!;
  assert.match(kin.evidence ?? '', /infobox relatives/, 'every edge is traceable');
  world.close();
});

test('wikilinks become low-weight MENTIONS, distinct from typed relations', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });
  const mentions = world.graph.allEdges().filter((e) => e.predicate === 'MENTIONS');
  assert.ok(mentions.length > 0);
  assert.ok(mentions.every((m) => m.weight <= 0.2), 'weak evidence is weighted as such');
  world.close();
});

test('character sheets are seeded from infoboxes', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale', voiceCards: true });

  const sheet = world.cast.get('char:warden-ilsa-crowe')!;
  assert.ok(sheet.identity.allegiances.some((a) => /Wardens/.test(a)), 'affiliation seeded');
  assert.ok(sheet.identity.competencies.some((c) => /Warden of Duskhollow/.test(c)), 'occupation seeded');
  assert.equal(sheet.condition.locationId, 'loc:duskhollow', 'starting location resolved');
  assert.ok(sheet.voice.samples.some((s) => /bridge stays open/.test(s)), 'voice mined from quoted dialogue');
  world.close();
});

test('a deceased status is recorded so the validator can catch acting on the dead', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });
  assert.equal(world.graph.get('char:bram-the-lesser')?.props.status, 'dead');
  world.close();
});

test('a nearly empty page is skipped rather than becoming a hollow entity', async () => {
  const world = World.open(':memory:');
  const res = runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });
  assert.ok(res.skipped.includes('Marrowstub'));
  assert.equal(world.graph.get('concept:marrowstub'), undefined);
  world.close();
});

test('the malformed page still yields an entity', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(Object.keys(WIKI)), { wiki: 'vale' });
  assert.ok(world.graph.get('event:sundering-of-marrow'), 'a broken infobox does not lose the page');
  world.close();
});

test('re-running pass A is idempotent', async () => {
  const world = World.open(':memory:');
  const pages = await client().fetchPages(Object.keys(WIKI));
  runPassA(world, pages, { wiki: 'vale' });
  const first = world.graph.counts();
  const sheetsFirst = world.cast.list().length;

  runPassA(world, pages, { wiki: 'vale' });
  const second = world.graph.counts();

  assert.equal(second.entities, first.entities, 'no duplicate entities');
  assert.equal(second.edges, first.edges, 'no duplicate edges');
  assert.equal(world.cast.list().length, sheetsFirst, 'no duplicate sheets');
  world.close();
});

test('ingested pages are logged with their revision', async () => {
  const world = World.open(':memory:');
  runPassA(world, await client().fetchPages(['Duskhollow']), { wiki: 'vale' });
  const row = world.db.prepare(`SELECT * FROM ingest_pages WHERE title = 'Duskhollow'`).get() as { revision: string; wiki: string };
  assert.equal(row.revision, '101');
  assert.equal(row.wiki, 'vale');
  world.close();
});

// -------------------------------------------------------------------- depth

test('the mode table matches the design: deep is a superset of mid of skim', () => {
  assert.ok(MODES.skim.hops < MODES.mid.hops && MODES.mid.hops < MODES.deep.hops);
  assert.ok(MODES.skim.maxPages < MODES.mid.maxPages && MODES.mid.maxPages < MODES.deep.maxPages);
  assert.equal(MODES.skim.passB, 'none');
  assert.equal(MODES.mid.passB, 'core');
  assert.equal(MODES.deep.passB, 'all');
  assert.equal(MODES.deep.reconcileContradictions, true);
});

test('a skim ingest commits entities at depth 1', async () => {
  const world = World.open(':memory:');
  const res = await ingest({ world, client: client(), seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });
  assert.ok(res.passA!.entities > 5);
  assert.equal(res.passB, null, 'skim runs no LLM pass');
  assert.ok(world.graph.list({ limit: 100 }).every((e) => e.depthLevel >= 1));
  world.close();
});

test('previewOnly commits nothing', async () => {
  const world = World.open(':memory:');
  const res = await ingest({ world, client: client(), seeds: ['Duskhollow'], mode: 'mid', previewOnly: true });
  assert.equal(res.passA, null);
  assert.equal(world.graph.counts().entities, 0, 'discovery must never write');
  assert.ok(res.preview.candidatePages > 0);
  world.close();
});

test('upgrading depth only touches nodes below the target', async () => {
  const world = World.open(':memory:');
  const c = client();
  await ingest({ world, client: c, seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });

  // Pin one node at deep so the upgrade must skip it.
  world.graph.setDepth('loc:duskhollow', 3);
  const stale = world.graph.belowDepth(2).map((e) => e.id);
  assert.ok(!stale.includes('loc:duskhollow'), 'already-deep node is not stale');

  const res = await upgradeDepth(world, 'mid', { client: c, wiki: 'vale' });
  assert.ok(res.examined > 0);
  assert.equal(world.graph.belowDepth(2).length, 0, 'everything reached the target');
  world.close();
});

test('a second upgrade to the same depth is a no-op', async () => {
  const world = World.open(':memory:');
  const c = client();
  await ingest({ world, client: c, seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });
  await upgradeDepth(world, 'mid', { client: c, wiki: 'vale' });
  const again = await upgradeDepth(world, 'mid', { client: c, wiki: 'vale' });
  assert.equal(again.examined, 0, 'never re-extract what is already done');
  world.close();
});

test('promoting a region deepens a neighbourhood, not the whole wiki', async () => {
  const world = World.open(':memory:');
  const c = client();
  await ingest({ world, client: c, seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });

  const before = world.graph.list({ limit: 200 }).filter((e) => e.depthLevel >= 2).length;
  const res = await promoteRegion(world, 'char:warden-ilsa-crowe', 'mid', { client: c, hops: 1, wiki: 'vale' });
  const after = world.graph.list({ limit: 200 }).filter((e) => e.depthLevel >= 2);

  assert.ok(res.titles.length > 0, 'something was promoted');
  assert.ok(after.length > before, 'the neighbourhood advanced');
  assert.ok(
    world.graph.list({ limit: 200 }).some((e) => e.depthLevel < 2),
    'depth is per-subgraph: the rest of the wiki is untouched',
  );
  world.close();
});

test('just-in-time deepening upgrades one node on approach', async () => {
  const world = World.open(':memory:');
  const c = client();
  await ingest({ world, client: c, seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });
  const target = 'loc:the-ashen-vale';
  assert.ok(world.graph.get(target), 'the node exists at skim depth');
  assert.equal(world.graph.get(target)?.depthLevel, 1);

  const did = await deepenOnDemand(world, target, 'mid', { client: c, wiki: 'vale' });
  assert.equal(did, true);
  assert.ok((world.graph.get(target)?.depthLevel ?? 0) >= 2);

  const again = await deepenOnDemand(world, target, 'mid', { client: c, wiki: 'vale' });
  assert.equal(again, false, 'already at depth, so no work');
  world.close();
});

test('an emergent entity with no wiki page is marked rather than retried forever', async () => {
  const world = World.open(':memory:');
  world.graph.upsert(
    { id: 'loc:the-invented-tavern', type: 'Location', name: 'The Invented Tavern', provenance: 'emergent:4', depthLevel: 0 },
    'chronicle',
  );
  const did = await deepenOnDemand(world, 'loc:the-invented-tavern', 'mid', { client: client(), wiki: 'vale' });
  assert.equal(did, false);
  assert.ok(
    (world.graph.get('loc:the-invented-tavern')?.depthLevel ?? 0) >= 2,
    'marked, so the player walking back in does not retry the fetch',
  );
  world.close();
});

test('pass B contributes edges, events and voice, and records contradictions', async () => {
  const world = World.open(':memory:');
  const c = client();

  const extractor: PassBExtractor = {
    async extract(page, entity) {
      if (entity.id !== 'char:warden-ilsa-crowe') return { edges: [], events: [] };
      return {
        edges: [{ predicate: 'DISTRUSTS', objectName: 'Vesh Auld', weight: 0.8, evidence: 'she names him twice' }],
        events: [{ text: 'Crowe took the wardenship', inWorldDate: '412 AV' }],
        voiceCard: { diction: 'terse, official', never: ['pleads'] },
        contradictions: [{ claim: 'born 412 AV', conflictsWith: 'founded 388 AV' }],
      };
    },
  };

  await ingest({ world, client: c, seeds: ['Warden Ilsa Crowe', 'The Cinder Compact'], mode: 'mid', wiki: 'vale', extractor });

  const edges = world.graph.edgesFrom('char:warden-ilsa-crowe').map((e) => e.predicate);
  assert.ok(edges.includes('DISTRUSTS'), 'pass B relation landed');
  assert.ok(world.graph.list({ type: 'Event', limit: 50 }).some((e) => /wardenship/.test(e.summary)));
  assert.equal(world.cast.get('char:warden-ilsa-crowe')?.voice.diction, 'terse, official');
  assert.ok(
    world.chronicle.divergences().some((d) => d.kind === 'canon-contradiction'),
    'contradictions are kept as competing claims, not silently resolved',
  );
  world.close();
});

test('a throwing pass B extractor does not abort the pass', async () => {
  const world = World.open(':memory:');
  const extractor: PassBExtractor = {
    async extract() {
      throw new Error('model unavailable');
    },
  };
  const res = await ingest({ world, client: client(), seeds: ['Duskhollow'], mode: 'mid', wiki: 'vale', extractor });
  assert.equal(res.passB?.pages, 0);
  assert.ok(res.passA!.entities > 0, 'pass A survived');
  world.close();
});

test('the null extractor keeps depth orchestration testable before the llm pass exists', async () => {
  const world = World.open(':memory:');
  const res = await ingest({
    world, client: client(), seeds: ['Duskhollow'], mode: 'mid', wiki: 'vale',
    extractor: new NullPassBExtractor(),
  });
  assert.equal(res.passB?.edges, 0);
  assert.ok(res.passA!.entities > 0);
  world.close();
});

test('an ingested world is immediately playable', async () => {
  // The point of skim mode: start playing twenty minutes after picking a fandom.
  const world = World.open(':memory:');
  await ingest({ world, client: client(), seeds: ['Duskhollow'], mode: 'skim', wiki: 'vale' });

  const ilsa = world.graph.get('char:warden-ilsa-crowe')!;
  world.session.set({ playerCharacterId: ilsa.id, currentLocationId: 'loc:duskhollow' });

  const { Engine } = await import('../src/loop/engine.ts');
  const { MockProvider } = await import('../src/providers/mock.ts');
  const { ProviderRegistry } = await import('../src/providers/provider.ts');
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });

  const out = await engine.takeTurn('i walk the bridge markets and listen');
  assert.equal(out.kind, 'narrated', 'a wiki-derived world runs the loop unchanged');
  assert.ok(world.chronicle.events().length > 0);
  world.close();
});
