/**
 * Referential integrity check. See `.design/DBFIXES.md` B3.
 *
 * Every foreign key in `schema.sql` points at `stories(id)`. Not one entity
 * reference is constrained: `edges.subject`/`object`, `sheets.entity_id`,
 * `relationships.from_id`/`to_id`, `fact_knowledge.entity_id`,
 * `events.location_id`/`participants`, `consequences.actor_id`,
 * `threads.parties`, `scenes.location_id`, `illustrations.entity_id`/
 * `location_id`, and `stories.player_character_id`/`current_location_id`.
 *
 * That is deliberate and cannot be fixed with a foreign key. An entity id
 * resolves through the canon/chronicle overlay — it is valid if *either* a
 * canon row or this story's chronicle row exists — and SQL has no way to
 * express "either of these two rows, one of which is scoped by a column in a
 * different table". A real FK would either reject legitimate chronicle-only
 * entities or force canon and chronicle into one unscoped table, losing the
 * property the whole design rests on.
 *
 * So the constraint moves from the engine to a check that can be run. The cost
 * of not having one is not theoretical: `forkStory` shipped in Slice 3 copying
 * rows with their source ids, colliding primary keys against the story it
 * forked from (fixed in 075d282), and `truncateToScene` deletes rows that other
 * rows may still point at. Both are exactly the shape this catches.
 *
 * Read-only by design. It reports, never repairs — a dangling reference means
 * something upstream is wrong, and quietly deleting the evidence would remove
 * the only signal that it happened.
 */
import type { Db } from '../db/db.ts';
import { rows } from '../db/db.ts';
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
  /** The story the row belongs to, or null for canon/world-level rows. */
  storyId: StoryId | null;
}

export interface IntegrityReport {
  orphans: Orphan[];
  /** Rows examined, so "clean" can be distinguished from "nothing to check". */
  checked: number;
  ok: boolean;
}

/**
 * Every unconstrained entity reference, as a query that yields the orphans.
 *
 * Each entry resolves its reference against the *overlay* — canon rows plus the
 * referencing row's own story's chronicle rows — rather than against `entities`
 * flatly. Checking flatly would miss the interesting failure: an id that exists
 * only as story A's chronicle entity, referenced from story B, is dangling from
 * B's point of view even though `SELECT 1 FROM entities WHERE id = ?` succeeds.
 * That is precisely the cross-story leak a fork bug produces.
 *
 * `entityRef` builds the common case. The JSON-array columns and the
 * intra-story id references (`events.from_consequence_id` and friends) are
 * spelled out separately below because their shapes differ.
 */
function entityRef(table: string, column: string, keyExpr: string, storyExpr: string): string {
  return `
    SELECT '${table}' AS tbl, '${column}' AS col, t.${column} AS missing_id,
           ${keyExpr} AS row_key, ${storyExpr} AS story_id
    FROM ${table} t
    WHERE t.${column} IS NOT NULL AND t.${column} <> ''
      AND NOT EXISTS (
        SELECT 1 FROM entities e
        WHERE e.id = t.${column}
          AND (e.layer = 'canon' OR e.story_id IS ${storyExpr})
      )`;
}

/**
 * A JSON array of entity ids (`events.participants`, `threads.parties`).
 * `json_each` rather than `LIKE`, for the reason `chronicle.witnessedEvents`
 * learned the hard way: `LIKE '%id%'` matches any id the target is a prefix of.
 */
function entityRefArray(table: string, column: string, keyExpr: string, storyExpr: string): string {
  return `
    SELECT '${table}' AS tbl, '${column}[]' AS col, j.value AS missing_id,
           ${keyExpr} AS row_key, ${storyExpr} AS story_id
    FROM ${table} t, json_each(t.${column}) j
    WHERE j.value IS NOT NULL AND j.value <> ''
      AND NOT EXISTS (
        SELECT 1 FROM entities e
        WHERE e.id = j.value
          AND (e.layer = 'canon' OR e.story_id IS ${storyExpr})
      )`;
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

function buildQueries(): string[] {
  const S = 't.story_id';
  return [
    // Canon edges have story_id NULL, so `e.story_id IS t.story_id` correctly
    // demands a canon target for them (`IS` treats NULL = NULL as true, which
    // `=` would not — the same NULL-comparison trap schema.sql documents).
    entityRef('edges', 'subject', 't.id', S),
    entityRef('edges', 'object', 't.id', S),
    entityRef('sheets', 'entity_id', 't.entity_id', S),
    entityRef('relationships', 'from_id', `t.from_id || '->' || t.to_id`, S),
    entityRef('relationships', 'to_id', `t.from_id || '->' || t.to_id`, S),
    entityRef('events', 'location_id', 't.id', S),
    entityRefArray('events', 'participants', 't.id', S),
    entityRef('consequences', 'actor_id', 't.id', S),
    entityRefArray('threads', 'parties', 't.id', S),
    entityRef('scenes', 'location_id', `CAST(t.scene AS TEXT)`, S),
    entityRef('illustrations', 'entity_id', 't.id', S),
    entityRef('illustrations', 'location_id', 't.id', S),

    // fact_knowledge has no story_id of its own; it is scoped through fact_id,
    // so the story has to be reached via the join rather than read off the row.
    `SELECT 'fact_knowledge' AS tbl, 'entity_id' AS col, fk.entity_id AS missing_id,
            fk.fact_id || '/' || fk.entity_id AS row_key, f.story_id AS story_id
     FROM fact_knowledge fk JOIN facts f ON f.id = fk.fact_id
     WHERE fk.entity_id <> ''
       AND NOT EXISTS (
         SELECT 1 FROM entities e
         WHERE e.id = fk.entity_id AND (e.layer = 'canon' OR e.story_id IS f.story_id)
       )`,

    // The story's own pointers. A story whose player character does not exist
    // is unplayable, and it is the single most valuable row here to know about.
    `SELECT 'stories' AS tbl, 'player_character_id' AS col, s.player_character_id AS missing_id,
            s.id AS row_key, s.id AS story_id
     FROM stories s
     WHERE s.player_character_id <> ''
       AND NOT EXISTS (
         SELECT 1 FROM entities e
         WHERE e.id = s.player_character_id AND (e.layer = 'canon' OR e.story_id IS s.id)
       )`,
    `SELECT 'stories' AS tbl, 'current_location_id' AS col, s.current_location_id AS missing_id,
            s.id AS row_key, s.id AS story_id
     FROM stories s
     WHERE s.current_location_id IS NOT NULL AND s.current_location_id <> ''
       AND NOT EXISTS (
         SELECT 1 FROM entities e
         WHERE e.id = s.current_location_id AND (e.layer = 'canon' OR e.story_id IS s.id)
       )`,

    // Intra-story row references. These are what a fork or a truncate breaks.
    rowRef('events', 'from_consequence_id', 'consequences', 't.id'),
    rowRef('consequences', 'cause_event_id', 'events', 't.id'),
    rowRef('illustrations', 'turn_id', 'turns', 't.id'),
  ];
}

/**
 * Scans the whole file — every story plus canon — for references that resolve
 * to nothing.
 *
 * Deliberately not scoped to one story: the failures worth catching are
 * cross-story leaks, and a per-story check would look clean on both sides of
 * one. `Orphan.storyId` says where each problem lives.
 */
export function checkIntegrity(db: Db): IntegrityReport {
  const orphans: Orphan[] = [];
  for (const sql of buildQueries()) {
    for (const r of rows<{ tbl: string; col: string; missing_id: string; row_key: string; story_id: string | null }>(
      db.prepare(sql).all(),
    )) {
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
  const counted = ['edges', 'sheets', 'relationships', 'events', 'consequences', 'threads', 'scenes', 'illustrations', 'fact_knowledge', 'stories'];
  let checked = 0;
  for (const t of counted) {
    const r = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number } | undefined;
    checked += Number(r?.n ?? 0);
  }

  return { orphans, checked, ok: orphans.length === 0 };
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
