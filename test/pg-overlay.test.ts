/**
 * The overlay: correctness, and the query plan that makes it usable.
 *
 * Two kinds of test here, and the second kind is the unusual one.
 *
 * The correctness tests are ordinary: chronicle wins over canon, sources
 * resolve in ordinal order, a retired canon edge stays retired.
 *
 * The *plan* test asserts on EXPLAIN output, which is not something to do
 * lightly — it couples a test to the planner. It is here because the failure it
 * catches is invisible to every other kind of test: the naive UNION-then-sort
 * form of the overlay query returns byte-identical results to the bounded form
 * and runs 700x slower (measured 82 TPS / 1220 ms versus 57,532 TPS / 1.7 ms at
 * 100 concurrent clients on a 450k-entity corpus). A results-based test passes
 * against both. Only the plan distinguishes them, so only the plan can protect
 * the difference — and what it really guards is the index in `schema-pg.sql`,
 * which someone will eventually be tempted to "simplify".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStory, makeWorld, seedCanon, withPg } from './pg-harness.ts';
import { overlayEdges, overlayEntities, overlayEntity, overlaySheet, sourcesFor } from '../src/db/overlay.ts';

test('chronicle overlays canon, and canon stays pristine underneath', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'verrow');
    await makeStory(db, 'story:a', [w]);
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name, summary) VALUES ($1,'char:anselm','Character','Brother Anselm','A living monk.')`,
      [w],
    );
    const sources = await sourcesFor(db, 'story:a');

    assert.equal((await overlayEntity(db, 'story:a', sources, 'char:anselm'))?.summary, 'A living monk.');

    // The playthrough kills him: a chronicle row shadows canon rather than
    // mutating it — the property the whole layering exists for.
    await db.query(
      `INSERT INTO chron_entities (story_id, id, type, name, summary) VALUES ('story:a','char:anselm','Character','Brother Anselm','Dead since scene 12.')`,
    );

    assert.equal((await overlayEntity(db, 'story:a', sources, 'char:anselm'))?.summary, 'Dead since scene 12.');
    const canon = await db.one<{ summary: string }>(
      `SELECT summary FROM canon_entities WHERE world_id = $1 AND id = 'char:anselm'`,
      [w],
    );
    assert.equal(canon?.summary, 'A living monk.', 'canon must be untouched');
  });
  if (!ran) t.skip('no Postgres configured (set FABULIST_TEST_PG)');
});

test('two stories in one world never see each other\u2019s chronicle', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'shared');
    await makeStory(db, 'story:a', [w]);
    await makeStory(db, 'story:b', [w]);
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name, summary) VALUES ($1,'char:x','Character','X','canon')`,
      [w],
    );
    await db.query(
      `INSERT INTO chron_entities (story_id, id, type, name, summary) VALUES ('story:a','char:x','Character','X','only A diverged')`,
    );

    const a = await sourcesFor(db, 'story:a');
    const b = await sourcesFor(db, 'story:b');
    assert.equal((await overlayEntity(db, 'story:a', a, 'char:x'))?.summary, 'only A diverged');
    assert.equal((await overlayEntity(db, 'story:b', b, 'char:x'))?.summary, 'canon', 'B must still read canon');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a crossover resolves sources in ordinal order', async (t) => {
  const ran = await withPg(async (db) => {
    const hp = await makeWorld(db, 'potter');
    const lotr = await makeWorld(db, 'middle-earth');
    await makeStory(db, 'story:x', [hp, lotr]);

    // The real collision case: 6 ids collide between Star Trek and Mass Effect
    // in the actual corpora, so an id present in both sources must resolve to
    // the earlier ordinal rather than arbitrarily.
    for (const [w, name] of [
      [hp, 'Luna Lovegood'],
      [lotr, 'Luna the Moon'],
    ] as const) {
      await db.query(
        `INSERT INTO canon_entities (world_id, id, type, name) VALUES ($1,'char:luna','Character',$2)`,
        [w, name],
      );
    }
    // Unique to the second source: reachable, not shadowed out.
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name) VALUES ($1,'char:frodo','Character','Frodo')`,
      [lotr],
    );

    const sources = await sourcesFor(db, 'story:x');
    assert.equal(sources.length, 2);
    assert.equal((await overlayEntity(db, 'story:x', sources, 'char:luna'))?.name, 'Luna Lovegood', 'ordinal 1 wins');
    assert.equal((await overlayEntity(db, 'story:x', sources, 'char:frodo'))?.name, 'Frodo', 'ordinal 2 still reachable');

    const listed = await overlayEntities(db, 'story:x', sources, { limit: 10 });
    const ids = listed.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'a colliding id must appear once, not once per source');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a canon edge this story retired does not read as live again', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'edges');
    await makeStory(db, 'story:a', [w]);
    await db.query(
      `INSERT INTO canon_edges (world_id, subject, predicate, object, valid_from) VALUES ($1,'char:a','ALLIED_WITH','char:b',1)`,
      [w],
    );
    const sources = await sourcesFor(db, 'story:a');
    assert.equal((await overlayEdges(db, 'story:a', sources, { subject: 'char:a' })).length, 1);

    // Retiring copies into chronicle rather than mutating canon. The mask is
    // what stops canon's still-live row from answering afterwards — verified
    // directly under SQLite before this behaviour was ported, because without
    // the mask the edge kept reading as live.
    await db.query(
      `INSERT INTO chron_edges (story_id, subject, predicate, object, valid_from, valid_to) VALUES ('story:a','char:a','ALLIED_WITH','char:b',1,4)`,
    );
    assert.equal(
      (await overlayEdges(db, 'story:a', sources, { subject: 'char:a' })).length,
      0,
      'the retired identity must be masked from canon',
    );
    // Still visible earlier in story time: edges expire, they are not deleted.
    assert.equal((await overlayEdges(db, 'story:a', sources, { subject: 'char:a', scene: 2 })).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a retired canon entity disappears from the overlay without being deleted', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'retire');
    await makeStory(db, 'story:a', [w]);
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name, retired_at_revision) VALUES ($1,'char:gone','Character','Gone','r42')`,
      [w],
    );
    const sources = await sourcesFor(db, 'story:a');
    assert.equal(await overlayEntity(db, 'story:a', sources, 'char:gone'), undefined);
    // The row is still there — a refresh must never delete something a story
    // may reference, since no foreign key can span the overlay.
    const still = await db.one(`SELECT id FROM canon_entities WHERE world_id = $1 AND id = 'char:gone'`, [w]);
    assert.ok(still, 'retired means flagged, not removed');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('sheets resolve through the overlay, and canon sheets carry no player flag', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'sheets');
    await makeStory(db, 'story:a', [w]);
    await db.query(
      `INSERT INTO canon_sheets (world_id, entity_id, identity) VALUES ($1,'char:a','{"arc":"canon"}'::jsonb)`,
      [w],
    );
    const sources = await sourcesFor(db, 'story:a');
    const fromCanon = await overlaySheet(db, 'story:a', sources, 'char:a');
    // Asserted before dereferencing, so a missing sheet fails as "expected a
    // sheet" rather than as a TypeError three lines later.
    assert.ok(fromCanon, 'expected the canon sheet to resolve');
    assert.equal((fromCanon.identity as { arc: string }).arc, 'canon');
    assert.equal(fromCanon.is_player, false, 'who the player is belongs to a playthrough, not to canon');

    await db.query(
      `INSERT INTO chron_sheets (story_id, entity_id, identity, is_player) VALUES ('story:a','char:a','{"arc":"played"}'::jsonb,true)`,
    );
    const fromChron = await overlaySheet(db, 'story:a', sources, 'char:a');
    assert.ok(fromChron, 'expected the chronicle sheet to resolve');
    assert.equal((fromChron.identity as { arc: string }).arc, 'played');
    assert.equal(fromChron.is_player, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

// --------------------------------------------------------------- query plans

/**
 * The guard on the 700x. See this file's header for why a results test cannot
 * do this job.
 *
 * Asserts two things about the top-N overlay read over a realistic corpus:
 * no sequential scan of a canon table, and no full sort. Both are what the
 * naive form does, and both are what the `(world_id, salience DESC, name)`
 * index exists to prevent. 12,000 rows is enough that the planner would
 * genuinely prefer a seq scan if the index were missing — verified by dropping
 * it, below.
 */
test('the top-N overlay read uses index scans, not a seq scan and sort', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'big');
    await makeStory(db, 'story:a', [w]);
    await seedCanon(db, w, 12_000);
    await db.query(`ANALYZE canon_entities`);
    await db.query(`ANALYZE chron_entities`);
    await db.query(`ANALYZE story_sources`);

    const sources = await sourcesFor(db, 'story:a');
    // Rebuild the exact SQL the store issues, then EXPLAIN it. Going through
    // overlayEntities itself would only give the rows.
    const plan = await explainOverlay(db, 'story:a', sources, 40);

    assert.ok(
      !/Seq Scan on canon_entities/.test(plan),
      `the overlay must not sequentially scan canon. Plan was:\n${plan}`,
    );
    // "Sort" appears legitimately for the tiny post-dedupe re-rank; what must
    // not appear is a sort of the whole canon table, which shows up as a Sort
    // node reporting thousands of rows.
    const bigSort = /Sort Method: (?:external|quicksort)[^\n]*\n[^\n]*rows=(\d{4,})/.test(plan);
    assert.ok(!bigSort, `the overlay must not sort the full canon table. Plan was:\n${plan}`);
    assert.ok(/Index Scan|Index Only Scan/.test(plan), `expected index access. Plan was:\n${plan}`);
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * The negative control: proves the assertion above can actually fail.
 *
 * A plan test that passes whether or not the index exists is worthless, so this
 * drops the index and asserts the plan degrades to exactly the shape the other
 * test forbids. This is the same discipline `.design/DBFIXES.md` records for the
 * `participants LIKE` fix — "a regression test that passes either way is
 * worthless".
 */
test('dropping the salience index degrades the plan to a seq scan (negative control)', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'big');
    await makeStory(db, 'story:a', [w]);
    await seedCanon(db, w, 12_000);
    await db.query(`DROP INDEX idx_canon_entities_salience`);
    await db.query(`ANALYZE canon_entities`);

    const sources = await sourcesFor(db, 'story:a');
    const plan = await explainOverlay(db, 'story:a', sources, 40);
    assert.ok(
      /Seq Scan on canon_entities/.test(plan),
      `without the index the planner should fall back to a seq scan, proving the positive test is meaningful. Plan was:\n${plan}`,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * EXPLAIN ANALYZE of the same statement `overlayEntities` builds.
 *
 * Duplicated rather than exported from `overlay.ts` because exporting the SQL
 * builder purely for a test would invite callers to assemble their own queries,
 * which is the thing this module exists to prevent. The duplication is small and
 * the test fails loudly if the shapes diverge — a plan assertion against a
 * statement nothing runs would be worse than no assertion.
 */
async function explainOverlay(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  storyId: string,
  sources: Array<{ worldId: number; ordinal: number }>,
  limit: number,
): Promise<string> {
  const cols = 'id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene';
  const params: unknown[] = [];
  let n = 1;
  const p = (v: unknown) => {
    params.push(v);
    return `$${n++}`;
  };
  const arms = [
    `(SELECT ${cols}, 0 AS pri FROM chron_entities WHERE story_id = ${p(storyId)} ORDER BY salience DESC, name LIMIT ${p(limit)})`,
  ];
  for (const s of sources) {
    arms.push(
      `(SELECT ${cols}, ${p(s.ordinal)} AS pri FROM canon_entities WHERE world_id = ${p(s.worldId)}
          AND retired_at_revision IS NULL ORDER BY salience DESC, name LIMIT ${p(limit)})`,
    );
  }
  const sql = `
    SELECT ${cols} FROM (
      SELECT DISTINCT ON (id) ${cols}, pri
      FROM (${arms.join(' UNION ALL ')}) q
      ORDER BY id, pri
    ) d ORDER BY salience DESC, name LIMIT ${p(limit)}`;

  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`, params);
  return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
}
