/**
 * Scale validation for the schema and the overlay, through the real code path.
 *
 * Distinct from `pg-overlay.test.ts`, which proves correctness and guards the
 * query plan on small fixtures. This file answers the capacity question the
 * migration was justified on — "20+ worlds and 100 users at the same time" —
 * and it deliberately calls `src/db/overlay.ts` rather than hand-written SQL,
 * because the benchmark that justified this design used hand-written SQL and a
 * benchmark of code you are not shipping proves nothing about the code you are.
 *
 * Opt-in via FABULIST_TEST_PG_SCALE, because building the corpus takes tens of
 * seconds and nobody wants that on every `pnpm test`. Run it before believing
 * any claim about capacity:
 *
 *     pnpm pg:start
 *     FABULIST_TEST_PG=… FABULIST_TEST_PG_SCALE=1 node --test test/pg-scale.test.ts
 *
 * The thresholds are set well above the measured numbers, not at them: this is
 * a regression guard against an accidental full scan, not a benchmark that
 * fails when a laptop is busy. Measured on the reference machine, the top-N
 * overlay ran at 0.275 ms isolated and 1.74 ms at 100 concurrent clients; a
 * threshold of 50 ms catches a 700x regression while tolerating a 20x slower
 * machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStory, makeWorld, withPg } from './pg-harness.ts';
import { overlayEdges, overlayEntities, overlayEntity, sourcesFor } from '../src/db/overlay.ts';
import type { Db } from '../src/db/pg.ts';

const SCALE = process.env.FABULIST_TEST_PG_SCALE === '1';

/** Worlds, entities per world, and stories, matching the stated target. */
const WORLDS = 20;
const ENTITIES_PER_WORLD = 22_500; // 20 x 22.5k = 450k, the measured corpus size
const EDGES_PER_WORLD = 40_000;
const USERS = 100;
const STORIES_PER_USER = 3;

/**
 * Builds the corpus with `generate_series` server-side rather than row-by-row
 * inserts from Node: this is 450k entities and 800k edges, and shipping them
 * over the wire one INSERT at a time would dominate the runtime of a test whose
 * subject is read latency.
 */
async function buildCorpus(db: Db): Promise<number[]> {
  const worldIds: number[] = [];
  for (let w = 1; w <= WORLDS; w += 1) {
    const id = await makeWorld(db, `world-${w}`, `World ${w}`);
    worldIds.push(id);
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name, summary, salience, depth_level, props)
       SELECT $1,
              CASE g % 4 WHEN 0 THEN 'char:' WHEN 1 THEN 'loc:' WHEN 2 THEN 'fac:' ELSE 'concept:' END || 'w${w}-e' || g,
              CASE g % 4 WHEN 0 THEN 'Character' WHEN 1 THEN 'Location' WHEN 2 THEN 'Faction' ELSE 'Concept' END,
              'Entity ' || g, 'canon summary ' || g, (g % 1000)::real / 1000, g % 4, '{}'::jsonb
       FROM generate_series(1, $2) g`,
      [id, ENTITIES_PER_WORLD],
    );
    await db.query(
      `INSERT INTO canon_edges (world_id, subject, predicate, object, valid_from, weight)
       SELECT $1, 'char:w${w}-e' || (1 + (g * 4) % $2), 'ALLIED_WITH', 'fac:w${w}-e' || (3 + (g * 4) % $2), 0, 0.5
       FROM generate_series(1, $3) g
       ON CONFLICT DO NOTHING`,
      [id, ENTITIES_PER_WORLD, EDGES_PER_WORLD],
    );
  }

  // 300 stories; every third is a crossover reading two worlds, which is what
  // makes the multi-arm overlay path realistic rather than theoretical.
  for (let u = 1; u <= USERS; u += 1) {
    for (let s = 1; s <= STORIES_PER_USER; s += 1) {
      const primary = worldIds[(u + s) % WORLDS]!;
      const sources = (u + s) % 3 === 0 ? [primary, worldIds[(u + s + 7) % WORLDS]!] : [primary];
      const uniq = [...new Set(sources)];
      await makeStory(db, `story:${u}:${s}`, uniq, `user_${u}`);
      // A realistic chronicle: some entities diverged, some edges asserted.
      await db.query(
        `INSERT INTO chron_entities (story_id, id, type, name, summary, salience, created_scene)
         SELECT $1, 'char:diverged-' || g, 'Character', 'Diverged ' || g, 'chronicle', 0.7, g
         FROM generate_series(1, 40) g`,
        [`story:${u}:${s}`],
      );
    }
  }

  await db.query('ANALYZE');
  return worldIds;
}

test('20 worlds and 300 stories: the overlay stays fast through the real code path', async (t) => {
  if (!SCALE) {
    t.skip('set FABULIST_TEST_PG_SCALE=1 to run the scale validation');
    return;
  }
  const ran = await withPg(async (db) => {
    const t0 = Date.now();
    await buildCorpus(db);
    const buildMs = Date.now() - t0;

    const counts = await db.one<{ ent: string; edg: string; st: string; src: string }>(
      `SELECT (SELECT count(*) FROM canon_entities) ent,
              (SELECT count(*) FROM canon_edges) edg,
              (SELECT count(*) FROM stories) st,
              (SELECT count(*) FROM story_sources) src`,
    );
    console.log(
      `  corpus: ${Number(counts!.ent).toLocaleString()} canon entities, ${Number(counts!.edg).toLocaleString()} canon edges, ` +
        `${counts!.st} stories, ${counts!.src} story-source links (built in ${(buildMs / 1000).toFixed(1)}s)`,
    );
    assert.ok(Number(counts!.ent) >= 400_000, 'corpus should be at target scale');

    // A crossover story, so every measurement below exercises the multi-arm path.
    const crossover = await db.one<{ story_id: string }>(
      `SELECT story_id FROM story_sources GROUP BY story_id HAVING count(*) > 1 LIMIT 1`,
    );
    assert.ok(crossover, 'expected at least one crossover story in the corpus');
    const storyId = crossover.story_id;
    const sources = await sourcesFor(db, storyId);
    assert.equal(sources.length, 2);

    const bench = async (label: string, n: number, fn: () => Promise<unknown>) => {
      await fn(); // warm
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i += 1) await fn();
      const ms = Number(process.hrtime.bigint() - start) / 1e6 / n;
      console.log(`  ${label}: ${ms.toFixed(3)} ms/op`);
      return ms;
    };

    // The query the frame builder issues every turn — the one that was 1220 ms
    // in its naive form. This is the number that matters most.
    const topN = await bench('top-40 overlay (crossover, 2 sources)', 50, () =>
      overlayEntities(db, storyId, sources, { limit: 40 }),
    );
    assert.ok(topN < 50, `top-N overlay regressed to ${topN.toFixed(1)} ms — check idx_canon_entities_salience`);

    const point = await bench('point lookup by id', 200, () => overlayEntity(db, storyId, sources, 'char:diverged-7'));
    assert.ok(point < 20, `point lookup regressed to ${point.toFixed(1)} ms`);

    const walk = await bench('edge walk from a subject', 200, () =>
      overlayEdges(db, storyId, sources, { subject: 'char:diverged-7' }),
    );
    assert.ok(walk < 20, `edge walk regressed to ${walk.toFixed(1)} ms`);

    const typed = await bench('top-40 filtered by type', 50, () =>
      overlayEntities(db, storyId, sources, { limit: 40, type: 'Character' }),
    );
    assert.ok(typed < 50, `typed overlay regressed to ${typed.toFixed(1)} ms`);

    // Concurrency: 100 simultaneous readers, the stated target. The pool is
    // smaller than 100 by design, so this also proves requests queue and drain
    // rather than failing — the behaviour that a too-small max_connections
    // turns into "sorry, too many clients already".
    const concurrentStart = process.hrtime.bigint();
    const stories = await db.many<{ story_id: string }>(`SELECT story_id FROM story_sources ORDER BY story_id LIMIT 100`);
    await Promise.all(
      stories.map(async (s) => {
        const src = await sourcesFor(db, s.story_id);
        return overlayEntities(db, s.story_id, src, { limit: 40 });
      }),
    );
    const concurrentMs = Number(process.hrtime.bigint() - concurrentStart) / 1e6;
    console.log(`  100 concurrent overlay reads: ${concurrentMs.toFixed(0)} ms total`);
    assert.ok(concurrentMs < 10_000, `100 concurrent reads took ${concurrentMs.toFixed(0)} ms`);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a canon write is rejected for the play role even at scale', async (t) => {
  if (!SCALE) {
    t.skip('set FABULIST_TEST_PG_SCALE=1 to run the scale validation');
    return;
  }
  // The grant boundary is the reason this migration exists, so it is asserted
  // here too rather than only in a small fixture — a privilege that holds on 3
  // rows and not on 450,000 would be a very expensive surprise.
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'grants');
    await db.query(`INSERT INTO canon_entities (world_id, id, type, name) VALUES ($1,'char:a','Character','A')`, [w]);
    // The harness connects as the owner, so the boundary is proven by asking
    // Postgres directly what it would allow the play role to do.
    const perms = await db.one<{ upd: boolean; del: boolean; sel: boolean }>(
      `SELECT has_table_privilege('fabulist_play','canon_entities','UPDATE') upd,
              has_table_privilege('fabulist_play','canon_entities','DELETE') del,
              has_table_privilege('fabulist_play','canon_entities','SELECT') sel`,
    );
    assert.equal(perms?.upd, false, 'the play role must not be able to UPDATE canon');
    assert.equal(perms?.del, false, 'the play role must not be able to DELETE canon');
    assert.equal(perms?.sel, true, 'the play role must still be able to read canon');
  });
  if (!ran) t.skip('no Postgres configured');
});
