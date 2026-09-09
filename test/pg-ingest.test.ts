/**
 * The ingest path on Postgres: Pass A's bulk writes, and Pass B's application.
 *
 * Pass A is the bulk writer of the whole system — the real Star Trek ingest
 * produced 33,332 entities, 152,456 edges and 1,091 sheets from 6,000 pages — and
 * it used to write each of those with its own statement. In-process that was
 * microseconds; over a connection it would be one round trip each, which is hours
 * of pure latency for one wiki.
 *
 * So the test that matters most here counts statements: a 300-page batch must cost
 * a bounded number of them, not one per row. The rest assert the *decisions* are
 * unchanged — the secondary-source merge policy, the predicate rules, sheet
 * seeding from infoboxes, the dead-status flag the validator relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { runPassA } from '../src/ingest/passA-pg.ts';
import { applyPassB } from '../src/ingest/depth-pg.ts';
import { emptyPassBCounters, specFor } from '../src/ingest/depth-pg.ts';
import { checkIntegrity, formatIntegrityReport } from '../src/store/integrity-pg.ts';
import type { Db, Queryable } from '../src/db/pg.ts';
import type { WikiPage } from '../src/ingest/client.ts';

async function fresh(db: Db, slug = 'wiki'): Promise<World> {
  const worldId = await makeWorld(db, slug);
  const story = await createStory(db, { worldIds: [worldId] });
  return World.forStory(db, story.id);
}

/** A page shaped the way the real client returns them. */
function page(title: string, wikitext: string, pageId = title.toLowerCase()): WikiPage {
  return { pageId, title, wikitext, revision: 'r1', categories: [], links: [] };
}

/** A character page with an infobox, which is what makes Pass A produce a cast. */
function characterPage(name: string, fields: Record<string, string>, lead = ''): WikiPage {
  const infobox = ['{{Infobox character', ...Object.entries(fields).map(([k, v]) => `| ${k} = ${v}`), '}}'].join('\n');
  return page(name, `${infobox}\n\n${lead || `${name} is a person of note.`}`);
}

test('Pass A writes entities, typed edges and sheets from infoboxes', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    const pages = [
      characterPage('Brother Anselm', { species: 'Human', occupation: 'Scribe', affiliation: 'The Order', status: 'alive' }),
      characterPage('Captain Sered', { species: 'Human', occupation: 'Soldier', affiliation: 'The Garrison', status: 'dead' }),
      page('The Order', '{{Infobox faction\n| leader = Brother Anselm\n| headquarters = The Scriptorium\n}}\n\nA monastic order.'),
      page('The Scriptorium', '{{Infobox location\n| region = North cloister\n| terrain = Stone\n}}\n\nA long room.'),
    ];

    const result = await runPassA(db, world, pages, { wiki: 'verrow', depth: 2 });

    assert.equal(result.entities, 4);
    assert.ok(result.edges > 0, 'infobox relations should produce typed edges');
    assert.equal(result.sheets, 2, 'one sheet per character page');

    // Ingested material is canon: it must stay pristine at play time.
    const anselm = await world.graph.getCanon('char:brother-anselm');
    assert.ok(anselm, 'the character should be in canon');
    assert.equal(anselm!.depthLevel, 2, 'depth records how deeply the source was read');
    assert.equal(anselm!.props.species, 'Human');
    assert.match(anselm!.provenance, /^verrow:Brother Anselm#r1$/, 'provenance names the page and revision');

    // A character infobox is effectively a pre-made sheet, which is why Pass A
    // alone produces a playable cast.
    const sheet = await world.cast.getCanon('char:brother-anselm');
    assert.ok(sheet!.identity.allegiances.includes('The Order'));
    assert.ok(sheet!.identity.competencies.includes('Scribe'));
    assert.match(sheet!.appearance.description, /Human/, 'species seeds how they are drawn');

    // Status from the infobox is what lets the validator catch acting on the dead.
    assert.equal((await world.graph.getCanon('char:captain-sered'))!.props.status, 'dead');

    // ingest_pages is what makes a resume and a refresh possible at all.
    const pageRows = await db.many<{ title: string; revision: string; depth: number }>(
      `SELECT title, revision, depth FROM ingest_pages ORDER BY title`,
    );
    assert.equal(pageRows.length, 4);
    assert.equal(pageRows[0]!.revision, 'r1');

    assert.equal((await checkIntegrity(db)).ok, true, formatIntegrityReport(await checkIntegrity(db)));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Pass A costs a bounded number of statements, not one per row', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    // 300 interlinked character pages: enough that per-row writing would be
    // hundreds of statements for entities alone, plus one per edge and sheet.
    const pages = Array.from({ length: 300 }, (_, i) =>
      characterPage(`Person ${i}`, {
        species: 'Human',
        occupation: 'Scribe',
        // Every page names the previous one, so the batch produces real edges.
        relatives: i > 0 ? `Person ${i - 1}` : '',
      }),
    );

    let queries = 0;
    const counting: Queryable = {
      query: ((sql: string, params?: unknown[]) => {
        queries += 1;
        return db.query(sql, params);
      }) as Queryable['query'],
    };
    const countingWorld = new World({ db: counting, storyId: world.storyId, sources: world.sources });

    const result = await runPassA(db, countingWorld, pages, { wiki: 'big', depth: 1 });

    assert.equal(result.entities, 300);
    assert.ok(result.sheets === 300, `expected 300 sheets, got ${result.sheets}`);
    assert.ok(result.edges > 0, 'the relatives field should have produced edges');
    // The whole point: statements grow with batches, not with rows.
    assert.ok(queries < 40, `expected a bounded statement count for 300 pages, got ${queries}`);
    console.log(`      300 pages, ${result.entities} entities + ${result.edges} edges + ${result.sheets} sheets: ${queries} statements`);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Pass A is idempotent: re-ingesting converges rather than duplicating', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    const pages = [characterPage('Anselm', { occupation: 'Scribe' })];

    await runPassA(db, world, pages, { wiki: 'w' });
    const first = await world.graph.counts();

    // Deterministic ids are what make a re-ingest a diff — the property
    // `slugId` exists for, and the one canon refresh depends on.
    await runPassA(db, world, pages, { wiki: 'w' });
    const second = await world.graph.counts();

    assert.deepEqual(second, first, 're-ingesting the same pages must not duplicate anything');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a duplicated relation within one batch does not abort the statement', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    // Two infobox fields implying the same relation. Postgres refuses to
    // ON CONFLICT DO UPDATE the same row twice in one statement, so the bulk
    // writer has to collapse duplicates — otherwise a perfectly ordinary wiki
    // page aborts the whole ingest with "cannot affect row a second time".
    const pages = [
      page(
        'Anselm',
        '{{Infobox character\n| affiliation = The Order\n| organization = The Order\n}}\n\nA monk.',
      ),
      page('The Order', '{{Infobox faction\n| leader = Anselm\n}}\n\nAn order.'),
    ];
    const result = await runPassA(db, world, pages, { wiki: 'w' });
    assert.equal(result.entities, 2);
    const edges = await world.graph.edgesFrom('char:anselm');
    const members = edges.filter((e) => e.object === 'fac:the-order');
    assert.equal(members.length, 1, 'the duplicate collapsed to one live edge');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a secondary source merges rather than overwriting the primary', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    // Two wikis sharing a universe routinely share titles for the same character,
    // each telling it slightly differently. Without the secondary policy whichever
    // was ingested second would silently overwrite the first entity-for-entity.
    await runPassA(db, world, [characterPage('Picard', { species: 'Human', rank: 'Captain' }, 'The captain of the Enterprise.')], {
      wiki: 'memoryalpha',
    });
    await runPassA(
      db,
      world,
      [characterPage('Picard', { species: 'Human', birthplace: 'La Barre' }, 'A different account entirely.')],
      { wiki: 'memorybeta', secondary: true },
    );

    const entity = await world.graph.getCanon('char:picard');
    assert.match(entity!.provenance, /memoryalpha/, 'the primary source keeps identity');
    assert.equal(entity!.summary, 'The captain of the Enterprise.', 'the primary summary survives');
    // The secondary only fills keys the primary never supplied.
    assert.equal(entity!.props.rank, 'Captain');
    assert.equal(entity!.props.birthplace, 'La Barre', 'a new key from the secondary is kept');
    // And the diverging account is recorded rather than discarded.
    const divergences = await world.chronicle.divergences();
    assert.ok(
      divergences.some((d) => d.kind === 'multi-source' && /memorybeta/.test(d.detail)),
      'a diverging summary should be kept as a divergence',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Pass B application writes relations, events and voice, then records depth', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    await runPassA(db, world, [characterPage('Anselm', {}), characterPage('Sered', {})], { wiki: 'w' });
    const entity = (await world.graph.getCanon('char:anselm'))!;
    const spec = specFor('mid');
    const out = emptyPassBCounters();

    await applyPassB(
      world,
      spec,
      'Anselm',
      entity,
      {
        edges: [{ predicate: 'ALLIED_WITH', objectName: 'Sered', weight: 0.7, evidence: 'They stood together.' }],
        events: [
          // Dated, so it is a real event node rather than a sentence about one entity.
          { text: 'Anselm and Sered defended the gate.', inWorldDate: '412 AV', participants: ['Sered'] },
          // Undated with one known participant: a statement, not an event. The
          // threshold that stopped the graph looking like confetti.
          { text: 'Anselm liked the cold.', participants: [] },
        ],
        voiceCard: { diction: 'plain and unhurried', tics: ['trails off'], samples: ['It will keep.'], never: ['profanity'] },
        contradictions: [{ claim: 'Anselm was never at the gate', conflictsWith: 'the gate account' }],
        failed: false,
      },
      out,
    );

    assert.equal(out.edges, 1);
    assert.equal(out.events, 1, 'the dated multi-party statement became an event');
    assert.equal(out.eventsSkipped, 1, 'the undated single-party statement did not');
    assert.equal(out.voiceCards, 1);

    const edges = await world.graph.edgesFrom('char:anselm');
    assert.ok(edges.some((e) => e.predicate === 'ALLIED_WITH' && e.object === 'char:sered'));
    assert.ok(edges.some((e) => e.predicate === 'INVOLVED_IN'), 'the participant edge should exist');

    // The skipped statement is appended to the subject rather than discarded.
    const after = await world.graph.getCanon('char:anselm');
    assert.ok(Array.isArray(after!.props.pageEvents));
    assert.ok((after!.props.pageEvents as string[]).some((n) => /liked the cold/.test(n)));

    // Voice comes from the page, which is the cheapest real source of it.
    const sheet = await world.cast.getCanon('char:anselm');
    assert.equal(sheet!.voice.diction, 'plain and unhurried');
    assert.ok(sheet!.voice.samples.includes('It will keep.'));

    // Contradictions are kept as competing claims, not resolved: wikis mix
    // continuities and the fidelity dial decides at play time.
    const divergences = await world.chronicle.divergences();
    assert.ok(divergences.some((d) => d.kind === 'canon-contradiction'));

    assert.equal(after!.depthLevel, spec.level, 'depth records that this page was read deeply');
    assert.equal((await checkIntegrity(db)).ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Pass B drops a relation whose object it cannot resolve', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await fresh(db);
    await runPassA(db, world, [characterPage('Anselm', {})], { wiki: 'w' });
    const entity = (await world.graph.getCanon('char:anselm'))!;
    const out = emptyPassBCounters();

    await applyPassB(
      world,
      specFor('mid'),
      'Anselm',
      entity,
      {
        edges: [{ predicate: 'ALLIED_WITH', objectName: 'Somebody Who Does Not Exist', weight: 0.7, evidence: 'x' }],
        events: [],
        contradictions: [],
        failed: false,
      },
      out,
    );

    // A missing edge is visible; a confidently wrong one is not. This is the same
    // reasoning that removed resolveName's similarity fallback after ~14,205
    // MENTIONS edges were found attached to synthetic event nodes.
    assert.equal(out.edges, 0);
    assert.equal((await world.graph.edgesFrom('char:anselm')).length, 0);
    assert.equal((await checkIntegrity(db)).ok, true, 'a dropped edge leaves nothing dangling');
  });
  if (!ran) t.skip('no Postgres configured');
});
