/**
 * The overlay: how `chronicle ?? canon` is expressed in SQL, across N worlds.
 *
 * This module exists because the overlay is the one part of the schema where a
 * correct-looking query is 700x too slow, and that fact belongs in one place
 * with the measurements attached rather than being rediscovered per store.
 *
 * ## What the overlay has to do
 *
 * A read resolves an entity by precedence:
 *
 *   1. this story's chronicle row, if it has diverged that entity
 *   2. canon from source ordinal 1
 *   3. canon from source ordinal 2 …
 *
 * Under SQLite this was one table with a `layer` column and
 * `ROW_NUMBER() OVER (PARTITION BY id ORDER BY CASE layer …)`. Here it is a
 * UNION ALL over one chronicle arm plus one arm per `story_sources` row,
 * carrying an explicit `pri` (0 for chronicle, else the source ordinal) that
 * the same ROW_NUMBER/ORDER BY then ranks. Semantics are unchanged; only the
 * source of the rows differs.
 *
 * ## The performance trap, measured
 *
 * The obvious form — UNION ALL every candidate row, then ORDER BY salience,
 * then LIMIT — is what a reasonable person writes, and it is a disaster,
 * because "top 40 by salience" over a union makes Postgres materialise every
 * canon row in every attached source before sorting. On a 20-world corpus
 * (450,120 canon entities, 2,263,100 canon edges):
 *
 *   naive UNION ALL + sort + LIMIT     82 TPS,     1220 ms   @100 clients
 *   LIMIT pushed into each arm      57,532 TPS,       1.7 ms  @100 clients
 *
 * 700x, same data, same engine. The fix is to make every arm independently
 * ordered and LIMIT-bounded, so each one is an index scan that stops early and
 * the outer query merges at most `limit * (1 + sources)` rows. `Merge Append`
 * then does the rest for free because each arm arrives already sorted.
 *
 * Two things are load-bearing and easy to break:
 *
 *   - **The index must match the ORDER BY exactly**, including the tie-break.
 *     `(world_id, salience DESC, name)` serves `ORDER BY salience DESC, name`.
 *     With only `(world_id, salience DESC)` the planner adds an Incremental
 *     Sort and the same query measures 7.5 ms instead of 0.275 ms — still fast
 *     enough to pass a test, slow enough to matter at 100 concurrent users.
 *   - **Every arm needs its own LIMIT.** Omitting it on one arm reintroduces
 *     the full scan for that source alone, which is invisible in a one-world
 *     test and appears the first time somebody builds a crossover.
 *
 * `test/pg-overlay.test.ts` asserts the EXPLAIN plan contains no Seq Scan on a
 * canon table and no full Sort, because a unit test on the *results* passes
 * either way — the naive form returns exactly the same rows.
 */
import type { QueryResultRow } from 'pg';
import type { Queryable } from './pg.ts';

/** A canon world a story reads from, in precedence order. */
export interface OverlaySource {
  worldId: number;
  ordinal: number;
  /** Namespace prefix for ids that collide with another source; '' when unique. */
  alias: string;
}

/**
 * The sources a story reads, ordered. One row for an ordinary story, several
 * for a crossover.
 *
 * Ordered by `ordinal` here rather than left to the caller: precedence is the
 * whole meaning of the list, and a caller that forgot to sort would silently
 * resolve a crossover the wrong way round — the sort is not a detail the
 * overlay can afford to trust anyone else with.
 */
export async function sourcesFor(db: Queryable, storyId: string): Promise<OverlaySource[]> {
  const { rows } = await db.query<{ world_id: string; ordinal: number; alias: string }>(
    `SELECT world_id, ordinal, alias FROM story_sources WHERE story_id = $1 ORDER BY ordinal`,
    [storyId],
  );
  return rows.map((r) => ({ worldId: Number(r.world_id), ordinal: r.ordinal, alias: r.alias }));
}

const ENTITY_COLUMNS =
  'id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene';

/**
 * Top-N entities for a story, resolved through the overlay.
 *
 * The `DISTINCT ON (id)` with `ORDER BY id, pri` is what collapses a
 * canon/chronicle pair to the winning row. It replaces SQLite's
 * `ROW_NUMBER() OVER (PARTITION BY id …)` and is both shorter and faster here;
 * the ordering inside `DISTINCT ON` is what picks the row, so `pri` must be the
 * second key.
 *
 * Note the double sort: once by `(id, pri)` to dedupe, then by the caller's
 * order to rank. Both are cheap because the input is already at most
 * `limit * (1 + sources)` rows.
 */
export async function overlayEntities<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  storyId: string,
  sources: OverlaySource[],
  opts: { limit?: number; type?: string; minSalience?: number } = {},
): Promise<R[]> {
  const limit = opts.limit ?? 500;

  // One filter descriptor per predicate, re-numbered per arm by
  // `buildFilteredArms` — see its own note for why they cannot be built once.
  const filters: Array<{ sql: string; value: unknown }> = [];
  if (opts.type !== undefined) filters.push({ sql: 'type = ', value: opts.type });
  if (opts.minSalience !== undefined) filters.push({ sql: 'salience >= ', value: opts.minSalience });

  const built = buildFilteredArms({
    canonTable: 'canon_entities',
    chronTable: 'chron_entities',
    columns: ENTITY_COLUMNS,
    storyId,
    sources,
    order: 'salience DESC, name',
    limit,
    filters,
  });

  // Three nested levels, each doing one job: the arms produce bounded
  // candidates, DISTINCT ON collapses canon/chronicle pairs to the winner, and
  // the outer query re-ranks. DISTINCT ON requires its own leading ORDER BY
  // (`id, pri`), which is why the caller's ranking cannot be folded into it.
  const sql = `
    SELECT ${ENTITY_COLUMNS}, pri FROM (
      SELECT DISTINCT ON (id) ${ENTITY_COLUMNS}, pri
      FROM (
      ${built.sql}
      ) q
      ORDER BY id, pri
    ) d
    ORDER BY salience DESC, name
    LIMIT $${built.next}
  `;
  const { rows } = await db.query<R>(sql, [...built.params, limit]);
  return rows;
}

/**
 * Per-arm filter assembly. Split out because the same logical predicate
 * ("type = 'Character'") needs a distinct parameter number in every arm, which
 * makes the naive "build the WHERE once and concatenate" approach wrong in a
 * way that only shows up with more than one source.
 */
function buildFilteredArms(opts: {
  canonTable: string;
  chronTable: string;
  columns: string;
  storyId: string;
  sources: OverlaySource[];
  order: string;
  limit: number;
  filters: Array<{ sql: string; value: unknown }>;
}): { sql: string; params: unknown[]; next: number } {
  const { canonTable, chronTable, columns, storyId, sources, order, limit, filters } = opts;
  const params: unknown[] = [];
  let n = 1;
  const p = (v: unknown) => {
    params.push(v);
    return `$${n++}`;
  };
  const filterSql = () => filters.map((f) => ` AND ${f.sql}${p(f.value)}`).join('');

  const arms: string[] = [];
  arms.push(
    `(SELECT ${columns}, 0 AS pri FROM ${chronTable} WHERE story_id = ${p(storyId)}${filterSql()}
        ORDER BY ${order} LIMIT ${p(limit)})`,
  );
  for (const s of sources) {
    arms.push(
      `(SELECT ${columns}, ${p(s.ordinal)} AS pri FROM ${canonTable} WHERE world_id = ${p(s.worldId)}
          AND retired_at_revision IS NULL${filterSql()}
          ORDER BY ${order} LIMIT ${p(limit)})`,
    );
  }
  return { sql: arms.join('\n      UNION ALL\n      '), params, next: n };
}

/**
 * One entity by id, resolved through the overlay.
 *
 * Kept separate from `overlayEntities` rather than expressed as a filter on it:
 * a point lookup wants primary-key access on every arm (measured 101,269 TPS,
 * 0.99 ms at 100 clients) and has no use for the salience index or a per-arm
 * LIMIT. Folding the two would give the point lookup the list query's plan.
 */
export async function overlayEntity<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  storyId: string,
  sources: OverlaySource[],
  id: string,
): Promise<R | undefined> {
  const params: unknown[] = [];
  let n = 1;
  const p = (v: unknown) => {
    params.push(v);
    return `$${n++}`;
  };
  const arms = [
    `SELECT ${ENTITY_COLUMNS}, 0 AS pri FROM chron_entities WHERE story_id = ${p(storyId)} AND id = ${p(id)}`,
  ];
  for (const s of sources) {
    arms.push(
      `SELECT ${ENTITY_COLUMNS}, ${p(s.ordinal)} AS pri FROM canon_entities
         WHERE world_id = ${p(s.worldId)} AND id = ${p(id)} AND retired_at_revision IS NULL`,
    );
  }
  const { rows } = await db.query<R>(
    `SELECT ${ENTITY_COLUMNS}, pri FROM (${arms.join(' UNION ALL ')}) q ORDER BY pri LIMIT 1`,
    params,
  );
  return rows[0];
}

const EDGE_COLUMNS = 'subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence';

/**
 * Live edges from (or to) an entity, resolved through the overlay.
 *
 * The chronicle *mask* is the subtle part, carried over from SQLite's
 * `EDGE_OVERLAY`: once a story has touched a (subject, predicate, object)
 * identity at all — asserted it, retired it, whatever — canon is masked for
 * that identity entirely, and only this story's rows answer for it. Without the
 * mask a canon edge the story retired keeps reading as live, because canon's
 * row is untouched and still there. That was verified directly against
 * node:sqlite before the SQLite version shipped (an edge retired in a discarded
 * future, restored by truncateToScene, kept reading as retired afterward), and
 * the same NOT EXISTS is what preserves the behaviour here.
 *
 * `scene` filters to "live at that point in story time": `valid_to IS NULL OR
 * valid_to > scene`, which is what makes "who is their ally *now*" a
 * time-filtered traversal rather than a snapshot.
 */
export async function overlayEdges<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  storyId: string,
  sources: OverlaySource[],
  opts: { subject?: string; object?: string; scene?: number; limit?: number },
): Promise<R[]> {
  const col = opts.subject !== undefined ? 'subject' : 'object';
  const value = opts.subject ?? opts.object;
  if (value === undefined) throw new Error('overlayEdges needs a subject or an object');

  const params: unknown[] = [];
  let n = 1;
  const p = (v: unknown) => {
    params.push(v);
    return `$${n++}`;
  };
  /**
   * "Live at this point in story time" is two conditions, not one: the edge must
   * already exist (`valid_from <= scene`) *and* not yet have expired
   * (`valid_to IS NULL OR valid_to > scene`). Omitting the first would report an
   * edge asserted at scene 9 as live when asked about scene 2 — a subtle enough
   * error that the SQLite version spelled both out, and this port initially did
   * not.
   */
  const live = (t: string) =>
    opts.scene === undefined
      ? `${t}.valid_to IS NULL`
      : `${t}.valid_from <= ${p(opts.scene)} AND (${t}.valid_to IS NULL OR ${t}.valid_to > ${p(opts.scene)})`;

  // `pri` rides along so the caller can tell a chronicle edge from a canon one —
  // that is the `layer` field on the Edge domain type, not internal bookkeeping.
  const arms = [
    `SELECT c.eid, ${EDGE_COLUMNS}, 0 AS pri FROM chron_edges c
       WHERE c.story_id = ${p(storyId)} AND c.${col} = ${p(value)} AND ${live('c')}`,
  ];
  for (const s of sources) {
    // The mask: skip a canon edge whose identity this story has already
    // asserted or retired. Indexed by idx_chron_edges_identity.
    arms.push(
      `SELECT NULL::bigint AS eid, ${EDGE_COLUMNS}, ${p(s.ordinal)} AS pri FROM canon_edges e
         WHERE e.world_id = ${p(s.worldId)} AND e.${col} = ${p(value)} AND ${live('e')}
           AND NOT EXISTS (
             SELECT 1 FROM chron_edges m
              WHERE m.story_id = ${p(storyId)}
                AND m.subject = e.subject AND m.predicate = e.predicate AND m.object = e.object
           )`,
    );
  }
  // Wrapped in a subquery so LIMIT applies to the whole union rather than to the
  // last arm — a bare trailing LIMIT after UNION ALL binds to the final SELECT,
  // which would silently return more rows than asked for.
  const limitSql = opts.limit ? ` LIMIT ${p(opts.limit)}` : '';
  const { rows } = await db.query<R>(
    `SELECT * FROM (${arms.join('\n    UNION ALL\n    ')}) q${limitSql}`,
    params,
  );
  return rows;
}

/**
 * A sheet by entity id, resolved through the overlay. Same precedence, same
 * reasoning as `overlayEntity`.
 */
export async function overlaySheet<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  storyId: string,
  sources: OverlaySource[],
  entityId: string,
): Promise<R | undefined> {
  const cols = 'entity_id, identity, contract, voice, condition, appearance, locks';
  const params: unknown[] = [];
  let n = 1;
  const p = (v: unknown) => {
    params.push(v);
    return `$${n++}`;
  };
  const arms = [
    `SELECT ${cols}, is_player, 0 AS pri FROM chron_sheets WHERE story_id = ${p(storyId)} AND entity_id = ${p(entityId)}`,
  ];
  for (const s of sources) {
    // Canon sheets have no `is_player`: who the player is, is a property of a
    // playthrough, not of the source material. Defaulted here so both arms
    // present the same shape to the caller.
    arms.push(
      `SELECT ${cols}, false AS is_player, ${p(s.ordinal)} AS pri FROM canon_sheets
         WHERE world_id = ${p(s.worldId)} AND entity_id = ${p(entityId)}`,
    );
  }
  const { rows } = await db.query<R>(
    `SELECT ${cols}, is_player, pri FROM (${arms.join(' UNION ALL ')}) q ORDER BY pri LIMIT 1`,
    params,
  );
  return rows[0];
}
