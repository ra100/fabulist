/**
 * Branching and forking. See DESIGN.md §11.
 *
 * Full retcon means recomputing every downstream consequence, and the design
 * is explicit that branching gets ~80% of the value at ~5% of the cost. So
 * the past is edited by forking a story at a scene rather than by rewriting
 * history in place, which also means the original playthrough is never
 * destroyed.
 *
 * Two forks, one underlying primitive:
 * - `forkStory` — same file, new `stories` row. Omit `atScene` for a fresh,
 *   non-overlapping story that reads the same canon and nothing else
 *   ("start a new story in this world"); pass `atScene` to copy that story's
 *   own chronicle up to the scene boundary first ("branch from here" /
 *   "continue from an earlier point"). No id ever needs remapping on copy:
 *   every row that isn't itself the `story_id` column is either a canon
 *   reference (unscoped, untouched) or a globally-unique id (turn/event/
 *   fact/thread/consequence ids are UUIDs) that stays identical and unique
 *   in the new story — checked directly against the schema's own FKs before
 *   relying on it, not assumed.
 * - `branchSave` — a different *file*, for taking a story out of a shared
 *   world file entirely (e.g. handing someone a save that is just their
 *   playthrough, not the whole library). Copies the file, then keeps only
 *   the one story being branched (every other story in the copy is
 *   discarded) and truncates that story to the scene boundary.
 *
 * `truncateToScene` is the scene-boundary logic both forks and both
 * `POST /api/branch` and `forkStory`'s continuation case share; it deletes
 * everything at or after a scene from *one* story, never touching canon or
 * any other story in the same file.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { checkpoint, rows, tx } from '../db/db.ts';
import { createStory, getStory } from '../store/world.ts';
import type { Story, StoryId } from '../domain/types.ts';

export interface BranchResult {
  path: string;
  atScene: number;
  removed: {
    turns: number;
    events: number;
    consequences: number;
    facts: number;
    chronicleEntities: number;
    chronicleEdges: number;
    retiredEdgesRestored: number;
    threads: number;
    divergences: number;
  };
}

/**
 * Truncates a story back to the state at the *start* of `scene`.
 *
 * Canon is never touched — it is the source material, shared by every story
 * in the world file, and a branch is a different playthrough of it, not a
 * different universe. Scoped to `world.storyId` throughout: reproduced
 * directly against a real two-story world before writing this that the old,
 * unscoped version deleted every story's turns/events/etc, not just the one
 * being truncated — a real corruption bug the single-story-per-file model
 * never had a chance to expose, since there was never a second story to
 * collide with.
 */
export function truncateToScene(world: World, scene: number): BranchResult['removed'] {
  const storyId = world.storyId;
  return tx(world.db, () => {
    const count = (sql: string, ...args: unknown[]) =>
      Number((world.db.prepare(sql).get(...(args as never[])) as { n?: number } | undefined)?.n ?? 0);

    const removed = {
      turns: count(`SELECT COUNT(*) n FROM turns WHERE story_id = ? AND scene >= ?`, storyId, scene),
      events: count(`SELECT COUNT(*) n FROM events WHERE story_id = ? AND scene >= ?`, storyId, scene),
      consequences: count(`SELECT COUNT(*) n FROM consequences WHERE story_id = ? AND created_scene >= ?`, storyId, scene),
      facts: count(`SELECT COUNT(*) n FROM facts WHERE story_id = ? AND scene >= ?`, storyId, scene),
      chronicleEntities: count(
        `SELECT COUNT(*) n FROM entities WHERE layer = 'chronicle' AND story_id = ? AND created_scene >= ?`,
        storyId, scene,
      ),
      chronicleEdges: count(
        `SELECT COUNT(*) n FROM edges WHERE layer = 'chronicle' AND story_id = ? AND valid_from >= ?`,
        storyId, scene,
      ),
      retiredEdgesRestored: count(
        `SELECT COUNT(*) n FROM edges WHERE (story_id = ? OR layer = 'canon') AND valid_to IS NOT NULL AND valid_to >= ?`,
        storyId, scene,
      ),
      threads: count(`SELECT COUNT(*) n FROM threads WHERE story_id = ? AND created_scene >= ?`, storyId, scene),
      divergences: count(`SELECT COUNT(*) n FROM divergences WHERE story_id = ? AND scene >= ?`, storyId, scene),
    };

    world.db.prepare(`DELETE FROM turns WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM events WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM consequences WHERE story_id = ? AND created_scene >= ?`).run(storyId, scene);
    // fact_knowledge has no story_id of its own — it inherits scope through
    // fact_id, so deleting per dropped fact id is what stays correctly scoped.
    const droppedFacts = rows<{ id: string }>(
      world.db.prepare(`SELECT id FROM facts WHERE story_id = ? AND scene >= ?`).all(storyId, scene),
    ).map((r) => r.id);
    world.db.prepare(`DELETE FROM facts WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    for (const factId of droppedFacts) {
      world.db.prepare(`DELETE FROM fact_knowledge WHERE fact_id = ? AND since_scene >= ?`).run(factId, scene);
    }
    world.db
      .prepare(`DELETE FROM entities WHERE layer = 'chronicle' AND story_id = ? AND created_scene >= ?`)
      .run(storyId, scene);
    world.db
      .prepare(`DELETE FROM edges WHERE layer = 'chronicle' AND story_id = ? AND valid_from >= ?`)
      .run(storyId, scene);

    // An edge retired during the discarded scenes was live at the branch
    // point, so un-expire it. Without this, the branch inherits relationships
    // that ended because of events that no longer happened. A canon row
    // matching "retired at scene >= the branch point" can only have gotten
    // that valid_to via *this* story's own retireEdge (which always copies
    // into a chronicle row rather than mutating the shared canon row), so
    // including layer='canon' here is safe — it is never another story's edit.
    world.db
      .prepare(`UPDATE edges SET valid_to = NULL WHERE (story_id = ? OR layer = 'canon') AND valid_to IS NOT NULL AND valid_to >= ?`)
      .run(storyId, scene);

    world.db.prepare(`DELETE FROM threads WHERE story_id = ? AND created_scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM divergences WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM scenes WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM style_anchors WHERE story_id = ? AND scene >= ?`).run(storyId, scene);
    world.db.prepare(`DELETE FROM directives WHERE story_id = ? AND created_scene >= ?`).run(storyId, scene);

    // Vows broken in the discarded future are unbroken again: the break was
    // an event, and that event is gone.
    for (const sheet of world.cast.list()) {
      const vows = sheet.contract.vows.map((v) =>
        v.broken && v.brokenScene !== null && v.brokenScene >= scene
          ? { ...v, broken: false, brokenScene: null }
          : v,
      );
      if (vows.some((v, i) => v.broken !== sheet.contract.vows[i]?.broken)) {
        world.cast.put({ ...sheet, contract: { ...sheet.contract, vows } });
      }
    }

    world.session.set({ scene, turn: 0 });
    return removed;
  });
}

/**
 * Every chronicle-scoped table `forkStory`'s copy-forward touches, in
 * dependency order (referenced-by-id tables before the tables that reference
 * them, so a remap is available by the time it is needed).
 *
 * `idColumn` describes what to do with a primary key that would otherwise
 * collide with the still-existing source row:
 * - `null`: nothing to do. `entities`/`sheets` key on `(id, layer,
 *   story_id)`, backed by a synthetic `rowid_pk` that is already excluded
 *   from every copy (see the `rowid_pk` filter below) — SQLite assigns it a
 *   fresh one automatically. `scenes`/`chapters`/`relationships` key on
 *   `story_id` plus a natural column, which is already being rewritten.
 * - `'text'`: a bare `TEXT PRIMARY KEY` (`facts`, `threads`, `events`,
 *   `consequences`, `turns`, `directives`, `divergences`... — checked
 *   directly against the schema, not assumed) gets a fresh UUID, prefixed
 *   with its own id's existing type tag (`fact:`, `thread:`, etc).
 * - `'integer'`: an `INTEGER PRIMARY KEY AUTOINCREMENT` (`edges`,
 *   `divergences`, `style_anchors`) cannot hold a generated UUID string —
 *   confirmed directly (a real "datatype mismatch" from trying) — so the
 *   column is dropped from the copy entirely and SQLite assigns the next
 *   integer itself, exactly like `rowid_pk`.
 *
 * `refs` names columns elsewhere in *this same row* that must be rewritten
 * through an already-built remap (e.g. `events.id` must be remapped before
 * `consequences.cause_event_id` can be rewritten, which is why `events`
 * precedes `consequences` in this list).
 */
const CHRONICLE_TABLES = [
  { table: 'edges', sceneCol: 'valid_from', extra: `AND layer = 'chronicle'`, idColumn: 'integer' as const, refs: [] },
  { table: 'entities', sceneCol: 'created_scene', extra: `AND layer = 'chronicle'`, idColumn: null, refs: [] },
  { table: 'sheets', sceneCol: null, extra: `AND layer = 'chronicle'`, idColumn: null, refs: [] },
  { table: 'relationships', sceneCol: null, extra: '', idColumn: null, refs: [] },
  { table: 'facts', sceneCol: 'scene', extra: '', idColumn: 'text' as const, refs: [] },
  { table: 'threads', sceneCol: 'created_scene', extra: '', idColumn: 'text' as const, refs: [] },
  { table: 'events', sceneCol: 'scene', extra: '', idColumn: 'text' as const, refs: ['from_consequence_id'] },
  { table: 'consequences', sceneCol: 'created_scene', extra: '', idColumn: 'text' as const, refs: ['cause_event_id'] },
  { table: 'turns', sceneCol: 'scene', extra: '', idColumn: 'text' as const, refs: [] },
  { table: 'scenes', sceneCol: 'scene', extra: '', idColumn: null, refs: [] },
  { table: 'chapters', sceneCol: null, extra: '', idColumn: null, refs: [] },
  { table: 'directives', sceneCol: 'created_scene', extra: '', idColumn: 'text' as const, refs: [] },
  { table: 'divergences', sceneCol: 'scene', extra: '', idColumn: 'integer' as const, refs: [] },
  { table: 'style_anchors', sceneCol: 'scene', extra: '', idColumn: 'integer' as const, refs: [] },
  { table: 'illustrations', sceneCol: 'created_scene', extra: '', idColumn: 'text' as const, refs: ['turn_id'] },
] as const;

export interface ForkOptions {
  /** The story to fork from. */
  fromStoryId: StoryId;
  /** Title for the new story. */
  title?: string;
  /**
   * Omit for a fresh, non-overlapping story: reads the same canon, no
   * chronicle copied — exactly like starting a new ingest-free playthrough.
   * Pass a scene to copy `fromStoryId`'s chronicle up to (not including)
   * that scene — a continuation / "branch from here".
   */
  atScene?: number;
}

export interface ForkResult {
  story: Story;
  copiedFrom: StoryId | null;
  copiedUpToScene: number | null;
}

/**
 * Same-file fork: the primitive behind both "start a new story in this
 * world" (no `atScene`) and "branch this story from an earlier point"
 * (`atScene` given). One transaction, one new `stories` row, and — when
 * continuing — a per-table `INSERT ... SELECT` with `story_id` rewritten and
 * every table's own id regenerated (with cross-references remapped to
 * match, table-by-table in dependency order). No file copy, because
 * switching which story is current in this file is already just a
 * different `story_id` filter (`World.withStory`); there is nothing to
 * close and reopen.
 */
export function forkStory(world: World, opts: ForkOptions): ForkResult {
  const source = getStory(world.db, opts.fromStoryId);
  if (!source) throw new Error(`no story ${opts.fromStoryId} in this world`);
  if (opts.atScene !== undefined && opts.atScene < 1) throw new Error('scene must be 1 or greater');

  return tx(world.db, () => {
    const story = createStory(world.db, {
      title: opts.title ?? (source.title ? `${source.title} (fork)` : ''),
      forkedFrom: opts.atScene === undefined ? undefined : opts.fromStoryId,
      forkedAtScene: opts.atScene,
    });

    if (opts.atScene === undefined) {
      return { story, copiedFrom: null, copiedUpToScene: null };
    }

    const scene = opts.atScene;
    // Old id -> new id, per table that needed a fresh one. Built table by
    // table, in the dependency order CHRONICLE_TABLES already lists, so a
    // ref column can always find its target's remap already populated.
    const idMaps = new Map<string, Map<string, string>>();

    for (const { table, sceneCol, extra, idColumn, refs } of CHRONICLE_TABLES) {
      const allCols = rows<{ name: string }>(world.db.prepare(`PRAGMA table_info(${table})`).all())
        .map((r) => r.name)
        .filter((c) => c !== 'rowid_pk');
      // An 'integer' id (AUTOINCREMENT) is dropped from both the select and
      // the insert, exactly like rowid_pk — SQLite assigns the next one
      // itself. A 'text' id is kept in both lists and rewritten per row below.
      const cols = idColumn === 'integer' ? allCols.filter((c) => c !== 'id') : allCols;
      const sceneClause = sceneCol ? `AND ${sceneCol} < ?` : '';
      const selectArgs: unknown[] = [opts.fromStoryId];
      if (sceneCol) selectArgs.push(scene);

      // 'integer' ids still need their *old* value read (to build the remap
      // other tables' refs would look up, though none actually do for these
      // three tables — kept for symmetry, not because anything needs it),
      // even though the column is excluded from the copy itself. Tables with
      // no id-collision concern at all (`idColumn: null`) have no `id`
      // column forced in either — `scenes`/`chapters` key on `story_id` plus
      // a natural column and have no `id` column at all.
      const selectCols = idColumn === 'integer' ? ['id', ...cols] : cols;
      const source_rows = rows<Record<string, unknown>>(
        world.db
          .prepare(`SELECT ${selectCols.join(', ')} FROM ${table} WHERE story_id = ? ${extra} ${sceneClause}`)
          .all(...(selectArgs as never[])),
      );
      if (!source_rows.length) continue;

      const ownMap: Map<string, string> | null = idColumn ? new Map() : null;
      if (ownMap) idMaps.set(table, ownMap);

      const insertCols = cols.join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = world.db.prepare(`INSERT INTO ${table} (${insertCols}) VALUES (${placeholders})`);

      for (const row of source_rows) {
        if (idColumn === 'integer') {
          // Nothing in this codebase's schema references edges/divergences/
          // style_anchors ids from another table (checked directly against
          // every FOREIGN KEY in schema.sql before relying on it), so the
          // remap only needs to exist for completeness — nothing ever reads it.
          ownMap!.set(String(row.id), '');
        }
        const values = cols.map((c) => {
          if (c === 'story_id') return story.id;
          if (c === 'id' && idColumn === 'text') {
            const fresh = `${String(row.id).split(':')[0] ?? table}:${randomUUID()}`;
            ownMap!.set(String(row.id), fresh);
            return fresh;
          }
          if ((refs as readonly string[]).includes(c) && row[c] != null) {
            // The referenced table was already copied (dependency order), so
            // its remap exists. A ref to a row this fork did *not* copy (out
            // of scene range, e.g. an illustration for a turn before the
            // fork's own window that somehow points forward — should not
            // happen, but the fallback is "drop the reference" rather than
            // insert a dangling one) leaves the column NULL.
            const table_for_ref = c === 'turn_id' ? 'turns' : c === 'cause_event_id' ? 'events' : c === 'from_consequence_id' ? 'consequences' : null;
            const refMap = table_for_ref ? idMaps.get(table_for_ref) : undefined;
            return refMap?.get(String(row[c])) ?? null;
          }
          return row[c] as never;
        });
        stmt.run(...(values as never[]));
      }
    }

    // fact_knowledge has no story_id column of its own; it is scoped through
    // fact_id, so it is copied per remapped fact id, using the fact_knowledge
    // rows attached to the *original* fact (since since_scene lives on
    // fact_knowledge, not facts, the scene filter belongs here too).
    const factMap = idMaps.get('facts');
    if (factMap) {
      for (const [oldFactId, newFactId] of factMap) {
        const knowledge = rows<Record<string, unknown>>(
          world.db.prepare(`SELECT * FROM fact_knowledge WHERE fact_id = ? AND since_scene < ?`).all(oldFactId, scene),
        );
        for (const k of knowledge) {
          world.db
            .prepare(`INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion) VALUES (?,?,?,?,?)`)
            .run(newFactId, ...([k.entity_id, k.level, k.since_scene, k.distortion] as never[]));
        }
      }
    }

    // The new story resumes exactly where the copy ends, same as truncateToScene.
    world.withStory(story.id).session.set({ scene, turn: 0 });

    return { story, copiedFrom: opts.fromStoryId, copiedUpToScene: scene };
  });
}

export interface BranchOptions {
  /** Path of the save to branch from. Must be a real file, not :memory:. */
  fromPath: string;
  /** Path for the new save. */
  toPath: string;
  /** Which story in the source file to branch. Defaults to the sole story if there is only one. */
  storyId?: StoryId;
  /** The branch resumes at the start of this scene. */
  atScene: number;
  overwrite?: boolean;
}

/**
 * Forks a save at a scene, into a different *file*. The source is left
 * completely untouched. The copy keeps canon and only the one story being
 * branched — every other story that happened to share the source file is
 * dropped from the copy, so the result reads like the single-story save this
 * always used to produce, not a whole library handed over by accident.
 */
export function branchSave(opts: BranchOptions): BranchResult {
  const { fromPath, toPath, atScene } = opts;
  if (!existsSync(fromPath)) throw new Error(`no save at ${fromPath}`);
  if (existsSync(toPath) && !opts.overwrite) throw new Error(`${toPath} already exists (pass overwrite to replace)`);
  if (atScene < 1) throw new Error('scene must be 1 or greater');

  mkdirSync(dirname(toPath), { recursive: true });

  // WAL means recent writes may live in a sidecar file, so checkpoint the source
  // into the main database before copying it. `checkpoint` is the same pragma
  // this open-coded, shared with the scene-close path (see `db.ts`).
  const source = World.open(fromPath, opts.storyId);
  const storyId = source.storyId;
  try {
    checkpoint(source.db);
  } finally {
    source.close();
  }

  copyFileSync(fromPath, toPath);

  const branch = World.open(toPath, storyId);
  try {
    // Drop every other story from the copy: this file is meant to read as
    // "the branch", not "the whole library minus nothing".
    const others = rows<{ id: string }>(branch.db.prepare(`SELECT id FROM stories WHERE id != ?`).all(storyId)).map(
      (r) => r.id,
    );
    for (const id of others) branch.db.prepare(`DELETE FROM stories WHERE id = ?`).run(id);

    const removed = truncateToScene(branch, atScene);
    return { path: toPath, atScene, removed };
  } finally {
    branch.close();
  }
}
