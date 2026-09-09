/**
 * Referential integrity check, Postgres. See `.design/DBFIXES.md` B3.
 *
 * ## Why this cannot be a foreign key
 *
 * An entity id resolves through the canon/chronicle overlay: it is valid if
 * *either* a canon row in one of the story's worlds exists, *or* this story's own
 * chronicle row does. SQL has no way to express "either of these rows, one of
 * which is reached through a join table". A real foreign key would have to pick
 * one and would then reject the other — either legitimate chronicle-only
 * entities (emergent, player-invented) or every canon reference.
 *
 * So the constraint moves from the engine to a check that can be run. Postgres
 * closes some of the gap the SQLite version had to leave open —
 * `story_id`/`world_id` are now NOT NULL with real references, and every
 * story-scoped table cascades — but the entity references below are still
 * unconstrained by necessity, and they are exactly the ones a fork, a truncate,
 * or a canon refresh can break.
 *
 * The cost of not having this is not theoretical. `forkStory` shipped copying
 * rows with their source ids and collided primary keys against the story it
 * forked from; `truncateToScene` deletes rows other rows may still point at; and
 * the SQLite version's first run against a real save found three illustrations
 * pointing at `char:brother-anselm` after `entities` had been emptied, because
 * `SetupService.reset()`'s hand-maintained table list had never been told about
 * the `illustrations` table.
 *
 * ## What changed with the split
 *
 * The overlay is now per story rather than per file, because a story reads its
 * own ordered set of canon worlds (`story_sources`). "Does this id resolve?" is
 * therefore a question about *that story's* sources, not about the database as a
 * whole — an id present only in a world some other story reads is dangling from
 * here, which is precisely the cross-story leak worth catching.
 *
 * Still whole-database rather than per-story, for the same reason as before: the
 * interesting failures are leaks *between* stories, and a per-story check looks
 * clean on both sides of one.
 *
 * Read-only by design. It reports, never repairs — a dangling reference means
 * something upstream is wrong, and deleting the evidence would remove the only
 * signal that it happened.
 *
 * ## Cost, and why the refresh gate uses `worldId`
 *
 * Every individual query here is fast when the tables are in cache: measured on
 * the real corpora (45,034 canon entities, 226,347 canon edges) each check is
 * 4–18 ms and the whole unscoped sweep is **56 ms warm**. Cold, straight after an
 * import, the same sweep took **124 seconds** — it reads every row of twelve
 * tables from disk, and nothing has touched them yet.
 *
 * That gap matters because this runs inside the refresh transaction, where 124
 * seconds would hold a write lock on canon for two minutes. Hence two things:
 * `applyRefresh` always passes `worldId`, which restricts every check to the one
 * world being refreshed; and the `limit` below bounds the report rather than
 * materialising every orphan a badly-broken refresh could produce.
 *
 * An operator running the unscoped check as a diagnostic should expect the first
 * run after a restart to be slow and the next to be instant. That is disk, not
 * the queries.
 */
import type { Queryable } from '../db/pg.ts';
import type { StoryId } from '../domain/types.ts';

export interface Orphan {
  /** Table holding the bad reference. */
  table: string;
  /** Column holding it — or `participants[]`/`parties[]` for a JSON array element. */
  column: string;
  /** The id that resolves to nothing. */
  missingId: string;
  /** Primary key of the offending row, for going and looking at it. */
  rowKey: string;
  /** The story the row belongs to, or null for a canon/world-level row. */
  storyId: StoryId | null;
}

export interface IntegrityReport {
  orphans: Orphan[];
  /** Rows examined, so "clean" is distinguishable from "nothing to check". */
  checked: number;
  ok: boolean;
}

/**
 * The resolution predicate, as a correlated EXISTS.
 *
 * This is the whole overlay expressed for one id: it resolves if this story has a
 * chronicle row for it, or if any world the story reads has a live canon row.
 * `retired_at_revision IS NULL` matters — a refresh retires a canon id rather
 * than deleting it, so a story still pointing at a retired entity *is* dangling
 * and must be reported.
 */
function resolves(idExpr: string, storyExpr: string): string {
  return `(
    EXISTS (SELECT 1 FROM chron_entities ce WHERE ce.story_id = ${storyExpr} AND ce.id = ${idExpr})
    OR EXISTS (
      SELECT 1 FROM canon_entities c
        JOIN story_sources ss ON ss.world_id = c.world_id
       WHERE ss.story_id = ${storyExpr} AND c.id = ${idExpr} AND c.retired_at_revision IS NULL
    )
  )`;
}

/** A plain column holding an entity id. */
function entityRef(table: string, column: string, keyExpr: string, storyExpr = 't.story_id'): string {
  return `
    SELECT '${table}' AS tbl, '${column}' AS col, t.${column} AS missing_id,
           ${keyExpr} AS row_key, ${storyExpr} AS story_id
    FROM ${table} t
    WHERE t.${column} IS NOT NULL AND t.${column} <> ''
      AND NOT ${resolves(`t.${column}`, storyExpr)}`;
}

/**
 * A jsonb array of entity ids (`events.participants`, `threads.parties`).
 *
 * `jsonb_array_elements_text` rather than a LIKE over the serialised array, for
 * the reason `witnessedEvents` learned the hard way: `LIKE '%id%'` matches any id
 * the target is a prefix of.
 */
function entityRefArray(table: string, column: string, keyExpr: string, storyExpr = 't.story_id'): string {
  return `
    SELECT '${table}' AS tbl, '${column}[]' AS col, j.value AS missing_id,
           ${keyExpr} AS row_key, ${storyExpr} AS story_id
    FROM ${table} t, jsonb_array_elements_text(t.${column}) j(value)
    WHERE j.value IS NOT NULL AND j.value <> ''
      AND NOT ${resolves('j.value', storyExpr)}`;
}

/** A reference to another row in the same story (not an entity). */
function rowRef(table: string, column: string, target: string, keyExpr: string): string {
  return `
    SELECT '${table}' AS tbl, '${column}' AS col, t.${column} AS missing_id,
           ${keyExpr} AS row_key, t.story_id AS story_id
    FROM ${table} t
    WHERE t.${column} IS NOT NULL AND t.${column} <> ''
      AND NOT EXISTS (SELECT 1 FROM ${target} x WHERE x.id = t.${column} AND x.story_id = t.story_id)`;
}

/**
 * Every unconstrained reference, enumerated.
 *
 * The SQLite version's surface was 15 entity references plus 3 intra-story row
 * references across 10 tables, enumerated from `pragma_foreign_key_list` rather
 * than by reading the schema by eye. The same set applies here, minus the ones
 * Postgres now constrains for real (every `story_id`) and plus the canon side,
 * where a canon edge can point at an entity its own world does not have — which
 * is exactly what a bad refresh or a partial import produces.
 */
function buildQueries(): string[] {
  return [
    // Chronicle edges: both endpoints must resolve for the owning story.
    entityRef('chron_edges', 'subject', 't.eid::text'),
    entityRef('chron_edges', 'object', 't.eid::text'),
    entityRef('chron_sheets', 'entity_id', 't.entity_id'),
    entityRef('relationships', 'from_id', `t.from_id || '->' || t.to_id`),
    entityRef('relationships', 'to_id', `t.from_id || '->' || t.to_id`),
    entityRef('events', 'location_id', 't.id'),
    entityRefArray('events', 'participants', 't.id'),
    entityRef('consequences', 'actor_id', 't.id'),
    entityRefArray('threads', 'parties', 't.id'),
    entityRef('scenes', 'location_id', 't.scene::text'),
    entityRef('illustrations', 'entity_id', 't.id'),
    entityRef('illustrations', 'location_id', 't.id'),

    // fact_knowledge has no story_id of its own; it is scoped through fact_id,
    // so the story has to be reached via the join rather than read off the row.
    `SELECT 'fact_knowledge' AS tbl, 'entity_id' AS col, fk.entity_id AS missing_id,
            fk.fact_id || '/' || fk.entity_id AS row_key, f.story_id AS story_id
     FROM fact_knowledge fk JOIN facts f ON f.id = fk.fact_id
     WHERE fk.entity_id <> '' AND NOT ${resolves('fk.entity_id', 'f.story_id')}`,

    // The story's own pointers. A story whose player character does not exist is
    // unplayable, and it is the single most valuable row here to know about.
    `SELECT 'stories' AS tbl, 'player_character_id' AS col, s.player_character_id AS missing_id,
            s.id AS row_key, s.id AS story_id
     FROM stories s
     WHERE s.player_character_id <> '' AND NOT ${resolves('s.player_character_id', 's.id')}`,
    `SELECT 'stories' AS tbl, 'current_location_id' AS col, s.current_location_id AS missing_id,
            s.id AS row_key, s.id AS story_id
     FROM stories s
     WHERE s.current_location_id IS NOT NULL AND s.current_location_id <> ''
       AND NOT ${resolves('s.current_location_id', 's.id')}`,

    // Canon's own internal consistency, which the SQLite version could not ask:
    // an edge whose endpoint is not in the same world. A partial import or a
    // refresh that retired an entity still referenced by an edge lands here.
    `SELECT 'canon_edges' AS tbl, 'subject' AS col, e.subject AS missing_id,
            e.eid::text AS row_key, NULL AS story_id
     FROM canon_edges e
     WHERE NOT EXISTS (
       SELECT 1 FROM canon_entities c
        WHERE c.world_id = e.world_id AND c.id = e.subject AND c.retired_at_revision IS NULL)`,
    `SELECT 'canon_edges' AS tbl, 'object' AS col, e.object AS missing_id,
            e.eid::text AS row_key, NULL AS story_id
     FROM canon_edges e
     WHERE NOT EXISTS (
       SELECT 1 FROM canon_entities c
        WHERE c.world_id = e.world_id AND c.id = e.object AND c.retired_at_revision IS NULL)`,
    `SELECT 'canon_sheets' AS tbl, 'entity_id' AS col, s.entity_id AS missing_id,
            s.entity_id AS row_key, NULL AS story_id
     FROM canon_sheets s
     WHERE NOT EXISTS (
       SELECT 1 FROM canon_entities c
        WHERE c.world_id = s.world_id AND c.id = s.entity_id AND c.retired_at_revision IS NULL)`,

    // Intra-story row references. These are what a fork or a truncate breaks.
    rowRef('events', 'from_consequence_id', 'consequences', 't.id'),
    rowRef('consequences', 'cause_event_id', 'events', 't.id'),
    rowRef('illustrations', 'turn_id', 'turns', 't.id'),
  ];
}

export interface IntegrityOptions {
  /**
   * Restrict to one world's canon, for a refresh gate. The story-scoped checks
   * are then limited to stories that read that world, so a refresh is not blocked
   * by a pre-existing problem somewhere else in the library.
   */
  worldId?: number;
  /** Stop after this many orphans. A broken refresh can produce millions. */
  limit?: number;
}

/**
 * Scans for references that resolve to nothing.
 *
 * `limit` exists because the failure mode is not "a few bad rows": a refresh that
 * retired the wrong ids can dangle every edge in a 152,456-edge world, and
 * materialising all of them to report them would be its own outage. The first few
 * hundred are enough to diagnose.
 */
export async function checkIntegrity(db: Queryable, opts: IntegrityOptions = {}): Promise<IntegrityReport> {
  const limit = opts.limit ?? 500;
  const orphans: Orphan[] = [];

  for (const sql of buildQueries()) {
    if (orphans.length >= limit) break;
    const scoped = opts.worldId === undefined ? sql : scopeToWorld(sql, opts.worldId);
    const { rows } = await db.query<{
      tbl: string;
      col: string;
      missing_id: string;
      row_key: string;
      story_id: string | null;
    }>(`${scoped} LIMIT ${limit - orphans.length}`);
    for (const r of rows) {
      orphans.push({
        table: r.tbl,
        column: r.col,
        missingId: r.missing_id,
        rowKey: String(r.row_key),
        storyId: r.story_id,
      });
    }
  }

  // Row counts of the tables actually inspected, so an empty report is
  // distinguishable from an empty database.
  const counted = [
    'chron_edges',
    'chron_sheets',
    'canon_edges',
    'canon_sheets',
    'relationships',
    'events',
    'consequences',
    'threads',
    'scenes',
    'illustrations',
    'fact_knowledge',
    'stories',
  ];
  const { rows: countRows } = await db.query<{ n: string }>(
    `SELECT ${counted.map((t) => `(SELECT count(*) FROM ${t})`).join(' + ')} AS n`,
  );
  const checked = Number(countRows[0]?.n ?? 0);

  return { orphans, checked, ok: orphans.length === 0 };
}

/**
 * Narrows a check to one world.
 *
 * Textual rather than parameterised because each query has a different shape and
 * the alternative is threading a predicate through every builder above. The
 * injected value is a number this module controls, never user input — and it is
 * interpolated as a number, not a string, so there is nothing to escape.
 */
function scopeToWorld(sql: string, worldId: number): string {
  const id = Number(worldId);
  if (!Number.isInteger(id)) throw new Error(`worldId must be an integer, got ${worldId}`);
  if (sql.includes('FROM canon_edges e')) return `${sql} AND e.world_id = ${id}`;
  if (sql.includes('FROM canon_sheets s')) return `${sql} AND s.world_id = ${id}`;
  if (sql.includes('FROM stories s')) {
    return `${sql} AND EXISTS (SELECT 1 FROM story_sources ss WHERE ss.story_id = s.id AND ss.world_id = ${id})`;
  }
  if (sql.includes('JOIN facts f ON')) {
    return `${sql} AND EXISTS (SELECT 1 FROM story_sources ss WHERE ss.story_id = f.story_id AND ss.world_id = ${id})`;
  }
  return `${sql} AND EXISTS (SELECT 1 FROM story_sources ss WHERE ss.story_id = t.story_id AND ss.world_id = ${id})`;
}

/** One line per orphan, grouped, for a CLI or a log. */
export function formatIntegrityReport(report: IntegrityReport): string {
  if (report.ok) return `integrity ok: ${report.checked} rows checked, no dangling references`;
  const byTable = new Map<string, Orphan[]>();
  for (const o of report.orphans) {
    const key = `${o.table}.${o.column}`;
    const list = byTable.get(key) ?? [];
    list.push(o);
    byTable.set(key, list);
  }
  const lines = [`integrity: ${report.orphans.length} dangling reference(s) across ${byTable.size} column(s)`];
  for (const [key, list] of byTable) {
    lines.push(`  ${key}: ${list.length}`);
    for (const o of list.slice(0, 5)) {
      lines.push(`    row ${o.rowKey} -> missing ${o.missingId}${o.storyId ? ` (story ${o.storyId})` : ''}`);
    }
    if (list.length > 5) lines.push(`    … and ${list.length - 5} more`);
  }
  return lines.join('\n');
}
