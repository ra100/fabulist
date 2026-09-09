/**
 * Branching, forking and rollback — Postgres. See DESIGN.md §11.
 *
 * Full retcon means recomputing every downstream consequence, and the design is
 * explicit that branching gets ~80% of the value at ~5% of the cost. So the past
 * is edited by forking a story at a scene rather than by rewriting history in
 * place, which also means the original playthrough is never destroyed.
 *
 * ## What the split changed here
 *
 * The SQLite version had to be schema-driven: it read `PRAGMA table_info` per
 * table, filtered out `rowid_pk`, decided per table whether the `id` column was an
 * AUTOINCREMENT integer to drop or a text id to rewrite, built a remap per table,
 * and then re-inserted row by row from JS. All of that existed because `entities`,
 * `edges` and `sheets` mixed canon and chronicle in one table, so a copy had to
 * filter `layer = 'chronicle'` and could not simply say "copy this story's rows".
 *
 * Here chronicle rows live in their own tables keyed by `story_id`, so a fork is a
 * set of `INSERT ... SELECT` statements — the database does the copy, and the ids
 * that need to be fresh are generated in SQL. Two consequences worth stating:
 *
 *   - **`branchSave` is gone.** It copied a *file* and then discarded every story
 *     but one, because handing someone a save meant handing them a file. There is
 *     no file now; `forkStory` already produces an independent story, and
 *     `pg_dump` is the tool for taking data out. Keeping a function that copied
 *     the whole library to isolate one story would be worse than not having it.
 *
 *   - **Id remapping got narrower and more honest.** Only four tables mint text
 *     ids that another table references (`events`, `consequences`, `facts`,
 *     `turns`), and only three columns reference them. The SQLite version built
 *     remaps for `edges`, `divergences` and `style_anchors` too and its own comment
 *     admitted "nothing ever reads it" — those are BIGSERIAL here and Postgres
 *     assigns them, so the dead code is simply absent.
 */
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/pg.ts';
import { World } from '../store/index-pg.ts';
import { createStory, getStory } from '../store/world-pg.ts';
import type { Story, StoryId } from '../domain/types.ts';

export interface TruncateResult {
  turns: number;
  events: number;
  consequences: number;
  facts: number;
  chronicleEntities: number;
  chronicleEdges: number;
  retiredEdgesRestored: number;
  threads: number;
  divergences: number;
}

/**
 * Truncates a story back to the state at the *start* of `scene`.
 *
 * Canon is never touched — it is the source material, shared by every story
 * reading that world, and a branch is a different playthrough of it, not a
 * different universe. Under SQLite this needed care: an early version deleted
 * every story's turns rather than one story's, a corruption bug the
 * single-story-per-file model had never had a chance to expose. Here `story_id` is
 * NOT NULL with a real foreign key on every table below, so the scoping is
 * structural.
 */
export async function truncateToScene(db: Db, world: World, scene: number): Promise<TruncateResult> {
  const storyId = world.storyId;

  return db.tx(async (tx) => {
    const count = async (sql: string, params: unknown[]): Promise<number> => {
      const { rows } = await tx.query<{ n: string }>(sql, params);
      return Number(rows[0]?.n ?? 0);
    };

    const removed: TruncateResult = {
      turns: await count(`SELECT count(*) n FROM turns WHERE story_id = $1 AND scene >= $2`, [storyId, scene]),
      events: await count(`SELECT count(*) n FROM events WHERE story_id = $1 AND scene >= $2`, [storyId, scene]),
      consequences: await count(
        `SELECT count(*) n FROM consequences WHERE story_id = $1 AND created_scene >= $2`,
        [storyId, scene],
      ),
      facts: await count(`SELECT count(*) n FROM facts WHERE story_id = $1 AND scene >= $2`, [storyId, scene]),
      chronicleEntities: await count(
        `SELECT count(*) n FROM chron_entities WHERE story_id = $1 AND created_scene >= $2`,
        [storyId, scene],
      ),
      chronicleEdges: await count(
        `SELECT count(*) n FROM chron_edges WHERE story_id = $1 AND valid_from >= $2`,
        [storyId, scene],
      ),
      retiredEdgesRestored: await count(
        `SELECT count(*) n FROM chron_edges WHERE story_id = $1 AND valid_to IS NOT NULL AND valid_to >= $2`,
        [storyId, scene],
      ),
      threads: await count(`SELECT count(*) n FROM threads WHERE story_id = $1 AND created_scene >= $2`, [storyId, scene]),
      divergences: await count(`SELECT count(*) n FROM divergences WHERE story_id = $1 AND scene >= $2`, [storyId, scene]),
    };

    // fact_knowledge is scoped through fact_id rather than carrying story_id, so
    // it is deleted per dropped fact. The FK cascades anyway; this keeps the
    // scene filter, which the cascade cannot express.
    await tx.query(
      `DELETE FROM fact_knowledge WHERE since_scene >= $1
         AND fact_id IN (SELECT id FROM facts WHERE story_id = $2 AND scene >= $1)`,
      [scene, storyId],
    );

    for (const [table, col] of [
      ['turns', 'scene'],
      ['events', 'scene'],
      ['consequences', 'created_scene'],
      ['facts', 'scene'],
      ['chron_entities', 'created_scene'],
      ['chron_edges', 'valid_from'],
      ['threads', 'created_scene'],
      ['divergences', 'scene'],
      ['scenes', 'scene'],
      ['style_anchors', 'scene'],
      ['directives', 'created_scene'],
    ] as const) {
      await tx.query(`DELETE FROM ${table} WHERE story_id = $1 AND ${col} >= $2`, [storyId, scene]);
    }

    // An edge retired during the discarded scenes was live at the branch point,
    // so un-expire it. Without this the branch inherits relationships that ended
    // because of events that no longer happened.
    //
    // Only chronicle rows, unlike the SQLite version which also matched
    // `layer = 'canon'`. That arm was already dead code there — its own comment
    // explained that `retireEdge` always copies into a chronicle row rather than
    // mutating canon — and here the play role could not write canon anyway.
    await tx.query(
      `UPDATE chron_edges SET valid_to = NULL WHERE story_id = $1 AND valid_to IS NOT NULL AND valid_to >= $2`,
      [storyId, scene],
    );

    // Vows broken in the discarded future are unbroken again: the break was an
    // event, and that event is gone.
    const w = new World({ db: tx, storyId, sources: world.sources });
    for (const sheet of await w.cast.list()) {
      const vows = sheet.contract.vows.map((v) =>
        v.broken && v.brokenScene !== null && v.brokenScene >= scene ? { ...v, broken: false, brokenScene: null } : v,
      );
      if (vows.some((v, i) => v.broken !== sheet.contract.vows[i]?.broken)) {
        await w.cast.put({ ...sheet, contract: { ...sheet.contract, vows } });
      }
    }

    await w.session.set({ scene, turn: 0 });
    return removed;
  });
}

/**
 * "First scene of chapter N" — the mapping the rollback UI's chapter granularity
 * needs onto `truncateToScene`'s scene-only primitive.
 *
 * Reads `scenes.chapter` rather than recomputing `Compactor.chapterOf(scene)`:
 * that formula depends on a runtime-configurable `chapterSize` this module has no
 * access to, and the stored column is the authoritative record of which chapter
 * each scene actually landed in.
 */
export async function firstSceneOfChapter(world: World, chapter: number): Promise<number | undefined> {
  const inChapter = (await world.chronicle.scenes()).filter((s) => s.chapter === chapter);
  if (!inChapter.length) return undefined;
  return Math.min(...inChapter.map((s) => s.scene));
}

export interface RollbackOptions {
  /** Roll back to the start of this scene. */
  toScene?: number;
  /** Or to the start of this chapter, resolved through `firstSceneOfChapter`. */
  toChapter?: number;
  /**
   * `'fork'` (the default) leaves the long version completely untouched as a
   * story you can switch back to, so "I want it back" means "open the other
   * book" rather than "you should have forked first". `'destructive'` truncates
   * in place, for the one-story-forever case.
   */
  mode?: 'fork' | 'destructive';
  ownerUserId?: string;
}

export interface RollbackResult {
  mode: 'fork' | 'destructive';
  atScene: number;
  /** Present for `mode: 'fork'` — the new sibling story. */
  story: Story | null;
  /** Present for `mode: 'destructive'`. */
  removed: TruncateResult | null;
}

export async function rollback(db: Db, world: World, opts: RollbackOptions): Promise<RollbackResult> {
  const mode = opts.mode ?? 'fork';
  let scene = opts.toScene;
  if (scene === undefined && opts.toChapter !== undefined) {
    scene = await firstSceneOfChapter(world, opts.toChapter);
    if (scene === undefined) throw new Error(`chapter ${opts.toChapter} has no recorded scenes to roll back to`);
  }
  if (scene === undefined) throw new Error('rollback needs toScene or toChapter');
  if (scene < 1) throw new Error('scene must be 1 or greater');

  if (mode === 'destructive') {
    const removed = await truncateToScene(db, world, scene);
    return { mode, atScene: scene, story: null, removed };
  }

  const forked = await forkStory(db, world, {
    fromStoryId: world.storyId,
    atScene: scene,
    ...(opts.ownerUserId === undefined ? {} : { ownerUserId: opts.ownerUserId }),
  });
  return { mode, atScene: scene, story: forked.story, removed: null };
}

export interface ForkOptions {
  fromStoryId: StoryId;
  title?: string;
  /**
   * Omit for a fresh, non-overlapping story: reads the same canon, no chronicle
   * copied — exactly like starting a new ingest-free playthrough. Pass a scene to
   * copy `fromStoryId`'s chronicle up to (not including) that scene: a
   * continuation, "branch from here".
   */
  atScene?: number;
  ownerUserId?: string;
}

export interface ForkResult {
  story: Story;
  copiedFrom: StoryId | null;
  copiedUpToScene: number | null;
}

/**
 * Tables copied by a scene-bounded fork, in dependency order.
 *
 * `scene` names the column bounding the copy, or null for tables with no scene
 * dimension (a sheet or a relationship is current state, not history, so all of
 * it comes across). `freshId` marks tables whose text `id` must be regenerated,
 * because a fork's rows are new rows: reusing the source's ids would collide on
 * the primary key, which is exactly the bug this shipped with once.
 *
 * BIGSERIAL tables (`chron_edges`, `divergences`, `style_anchors`) are absent from
 * `freshId` because Postgres assigns their ids; the SQLite version built remaps
 * for them anyway and its own comment noted nothing read them.
 */
const FORK_TABLES = [
  { table: 'chron_entities', scene: 'created_scene', freshId: false },
  { table: 'chron_edges', scene: 'valid_from', freshId: false },
  { table: 'chron_sheets', scene: null, freshId: false },
  { table: 'relationships', scene: null, freshId: false },
  { table: 'facts', scene: 'scene', freshId: true },
  { table: 'threads', scene: 'created_scene', freshId: true },
  { table: 'events', scene: 'scene', freshId: true },
  { table: 'consequences', scene: 'created_scene', freshId: true },
  { table: 'turns', scene: 'scene', freshId: true },
  { table: 'scenes', scene: 'scene', freshId: false },
  { table: 'chapters', scene: null, freshId: false },
  { table: 'directives', scene: 'created_scene', freshId: true },
  { table: 'divergences', scene: 'scene', freshId: false },
  { table: 'style_anchors', scene: 'scene', freshId: false },
  { table: 'illustrations', scene: 'created_scene', freshId: true },
] as const;

/** Columns that reference another forked table's text id, and which table. */
const CROSS_REFS: Record<string, Record<string, string>> = {
  events: { from_consequence_id: 'consequences' },
  consequences: { cause_event_id: 'events' },
  illustrations: { turn_id: 'turns' },
};

export async function forkStory(db: Db, world: World, opts: ForkOptions): Promise<ForkResult> {
  const source = await getStory(db, opts.fromStoryId);
  if (!source) throw new Error(`no story ${opts.fromStoryId}`);
  if (opts.atScene !== undefined && opts.atScene < 1) throw new Error('scene must be 1 or greater');

  return db.tx(async (tx) => {
    // The fork reads the same canon worlds the source did — that is what makes it
    // a different playthrough of one world rather than a different world.
    const { rows: sources } = await tx.query<{ world_id: string }>(
      `SELECT world_id FROM story_sources WHERE story_id = $1 ORDER BY ordinal`,
      [opts.fromStoryId],
    );
    const story = await createStory(tx, {
      title: opts.title ?? (source.title ? `${source.title} (fork)` : ''),
      worldIds: sources.map((r) => Number(r.world_id)),
      ...(opts.atScene === undefined ? {} : { forkedFrom: opts.fromStoryId, forkedAtScene: opts.atScene }),
      ...(opts.ownerUserId === undefined ? {} : { ownerUserId: opts.ownerUserId }),
    });

    if (opts.atScene === undefined) {
      return { story, copiedFrom: null, copiedUpToScene: null };
    }

    const scene = opts.atScene;
    // `createStory` opens scene 1 for every new story. A fork is the one caller
    // that then copies the source's own scene rows over the same range, so the
    // placeholder is dropped first rather than colliding on the way in.
    await tx.query(`DELETE FROM scenes WHERE story_id = $1`, [story.id]);

    // Old id -> new id, per table, built in dependency order so a referencing
    // column always finds its target's remap already populated.
    const idMaps = new Map<string, Map<string, string>>();

    for (const spec of FORK_TABLES) {
      const columns = await columnsOf(tx, spec.table);
      const copyable = columns.filter((c) => c !== 'eid' && c !== 'id');
      const bound = spec.scene ? ` AND ${spec.scene} < $2` : '';
      const params: unknown[] = [opts.fromStoryId];
      if (spec.scene) params.push(scene);

      if (!spec.freshId) {
        // No id to rewrite: one INSERT ... SELECT and the database does the copy.
        // `story_id` is substituted; everything else comes across as-is.
        const select = copyable.map((c) => (c === 'story_id' ? `$${params.length + 1}` : c)).join(', ');
        params.push(story.id);
        await tx.query(
          `INSERT INTO ${spec.table} (${copyable.join(', ')})
           SELECT ${select} FROM ${spec.table} WHERE story_id = $1${bound}`,
          params,
        );
        continue;
      }

      // Text ids must be fresh, and other tables may reference them, so these are
      // read out, remapped in JS, and inserted back. Only four tables need this.
      const { rows: sourceRows } = await tx.query<Record<string, unknown>>(
        `SELECT ${columns.join(', ')} FROM ${spec.table} WHERE story_id = $1${bound}`,
        params,
      );
      if (!sourceRows.length) continue;

      const ownMap = new Map<string, string>();
      idMaps.set(spec.table, ownMap);
      const refs = CROSS_REFS[spec.table] ?? {};

      const insertCols = columns.filter((c) => c !== 'eid');
      for (const row of sourceRows) {
        const oldId = String(row.id);
        const prefix = oldId.split(':')[0] ?? spec.table;
        const freshId = `${prefix}:${randomUUID()}`;
        ownMap.set(oldId, freshId);

        const values = insertCols.map((c) => {
          if (c === 'story_id') return story.id;
          if (c === 'id') return freshId;
          const refTable = refs[c];
          if (refTable && row[c] != null) {
            // The referenced table was copied earlier (dependency order). A
            // reference to a row this fork did *not* copy — out of scene range —
            // becomes NULL rather than a dangling pointer.
            return idMaps.get(refTable)?.get(String(row[c])) ?? null;
          }
          return row[c];
        });
        await tx.query(
          `INSERT INTO ${spec.table} (${insertCols.join(', ')}) VALUES (${insertCols.map((_, i) => `$${i + 1}`).join(', ')})`,
          values,
        );
      }
    }

    // fact_knowledge has no story_id of its own; it is scoped through fact_id, so
    // it is copied per remapped fact. `since_scene` lives here rather than on
    // `facts`, so the scene filter belongs here too.
    const factMap = idMaps.get('facts');
    if (factMap) {
      for (const [oldFactId, newFactId] of factMap) {
        await tx.query(
          `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion)
           SELECT $1, entity_id, level, since_scene, distortion
             FROM fact_knowledge WHERE fact_id = $2 AND since_scene < $3`,
          [newFactId, oldFactId, scene],
        );
      }
    }

    // The new story resumes exactly where the copy ends, same as truncateToScene.
    const forkedWorld = new World({ db: tx, storyId: story.id, sources: world.sources });
    await forkedWorld.session.set({ scene, turn: 0 });

    return { story, copiedFrom: opts.fromStoryId, copiedUpToScene: scene };
  });
}

/**
 * A table's columns, from the catalog.
 *
 * `information_schema` rather than a hardcoded list per table: the SQLite version
 * read `PRAGMA table_info` for the same reason, and the reason still holds — a
 * column added to a story-scoped table should be copied by a fork without anyone
 * remembering to update this file. Cached, because a fork touches fifteen tables
 * and the catalog does not change mid-transaction.
 */
const columnCache = new Map<string, string[]>();

async function columnsOf(tx: Queryable, table: string): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const { rows } = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  const cols = rows.map((r) => r.column_name);
  columnCache.set(table, cols);
  return cols;
}
