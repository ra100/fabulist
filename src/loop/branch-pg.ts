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
import { RollbackTargetError, type HistoryCheckpoint, type Story, type StoryId, type StorySnapshot } from '../domain/types.ts';
import { reconcileContinuation } from './history-pg.ts';

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
    const w = new World({ db: tx, storyId, sources: world.sources, crypto: world.crypto });
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
  /** Retain this exact committed turn and discard only subsequent history. */
  turnId?: string;
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
  toTurnId?: string;
  /** Present for `mode: 'fork'` — the new sibling story. */
  story: Story | null;
  /** Present for `mode: 'destructive'`. */
  removed: TruncateResult | null;
}

export async function rollback(db: Db, world: World, opts: RollbackOptions): Promise<RollbackResult> {
  const targets = [opts.toScene, opts.toChapter, opts.turnId].filter((target) => target !== undefined);
  if (targets.length !== 1) throw new RollbackTargetError('rollback: pass exactly one of toScene, toChapter, or turnId');
  const mode = opts.mode ?? 'fork';
  if (opts.turnId !== undefined) return rollbackToTurn(db, world, opts.turnId, mode, opts.ownerUserId);
  let scene = opts.toScene;
  if (scene === undefined && opts.toChapter !== undefined) {
    scene = await firstSceneOfChapter(world, opts.toChapter);
    if (scene === undefined) throw new RollbackTargetError(`chapter ${opts.toChapter} has no recorded scenes to roll back to`);
  }

  if (scene === undefined) throw new RollbackTargetError('rollback needs toScene or toChapter');
  if (scene < 1) throw new RollbackTargetError('scene must be 1 or greater');
  const current = await world.session.get();
  if (scene > current.scene)
    throw new RollbackTargetError(`rollback: scene ${scene} has not happened yet (currently at scene ${current.scene})`);

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

/** Restores or forks at the immutable checkpoint directly after `turnId`. */
export async function rollbackToTurn(
  db: Db,
  world: World,
  turnId: string,
  mode: 'fork' | 'destructive',
  ownerUserId?: string,
): Promise<RollbackResult> {
  const checkpoint = await exactTurnCheckpoint(world, turnId, 'rollback', (message) => new RollbackTargetError(message));
  if (mode === 'destructive') {
    await world.history.restoreTurn(turnId);
    await reconcileContinuation(world);
    return { mode, atScene: (await world.session.get()).scene, toTurnId: turnId, story: null, removed: null };
  }
  const forked = await forkStory(db, world, {
    fromStoryId: world.storyId,
    atTurnId: turnId,
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  });
  return { mode, atScene: checkpoint.state.session.scene, toTurnId: turnId, story: forked.story, removed: null };
}

async function exactTurnCheckpoint(
  world: World,
  turnId: string,
  operation: string,
  invalidTarget: (message: string) => Error = (message) => new Error(message),
): Promise<HistoryCheckpoint> {
  const { rows } = await world.db.query<{ history_position: number | null }>(
    `SELECT history_position FROM turns WHERE id = $1 AND story_id = $2`,
    [turnId, world.storyId],
  );
  if (!rows[0]) throw invalidTarget(`${operation}: unknown turn ${turnId}`);
  if (rows[0].history_position == null) throw invalidTarget(`${operation}: turn ${turnId} is legacy and has no exact history`);
  const checkpoint = await world.history.checkpointForTurn(turnId);
  if (!checkpoint) throw invalidTarget(`${operation}: turn ${turnId} has no exact history checkpoint`);
  return checkpoint;
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
  /** Retain history through this exact committed turn, including the turn itself. */
  atTurnId?: string;
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
  { table: 'scene_metadata', scene: 'scene', freshId: false },
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
  if (opts.atScene !== undefined && opts.atTurnId !== undefined) throw new Error('fork: pass atScene or atTurnId, not both');
  if (opts.atTurnId !== undefined && opts.fromStoryId !== world.storyId)
    throw new Error('fork: exact turn target must belong to the current story');
  const checkpoint = opts.atTurnId === undefined ? undefined : await exactTurnCheckpoint(world, opts.atTurnId, 'fork');
  if (checkpoint && source.encryptionVersion !== 0)
    throw new Error('fork: private story exact-history fork is not ready for this key');
  const retainedPosition = checkpoint?.position;
  const retainedCheckpoints = checkpoint ? await world.history.checkpointsThrough(checkpoint.position) : [];

  return db.tx(async (tx) => {
    // The fork reads the same canon worlds the source did — that is what makes it
    // a different playthrough of one world rather than a different world.
    const { rows: sources } = await tx.query<{ world_id: string }>(
      `SELECT world_id FROM story_sources WHERE story_id = $1 ORDER BY ordinal`,
      [opts.fromStoryId],
    );
    const turnScene =
      opts.atTurnId === undefined
        ? undefined
        : (
            await tx.query<{ scene: number }>(`SELECT scene FROM turns WHERE id = $1 AND story_id = $2`, [
              opts.atTurnId,
              opts.fromStoryId,
            ])
          ).rows[0]!.scene;
    const forkScene = opts.atScene ?? turnScene;
    const story = await createStory(tx, {
      title: opts.title ?? (source.title ? `${source.title} (fork)` : ''),
      worldIds: sources.map((r) => Number(r.world_id)),
      ...(forkScene === undefined ? {} : { forkedFrom: opts.fromStoryId, forkedAtScene: forkScene }),
      ...(opts.ownerUserId === undefined ? {} : { ownerUserId: opts.ownerUserId }),
    });

    if (forkScene === undefined) {
      return { story, copiedFrom: null, copiedUpToScene: null };
    }

    const scene = forkScene;
    const segmentIds = new Map<string, string>();
    if (checkpoint) {
      const { rows: segments } = await tx.query<{ id: string; start_position: number; created_at: Date | string }>(
        `SELECT id, start_position, created_at FROM scene_segments WHERE story_id = $1 AND start_position <= $2 ORDER BY start_position`,
        [opts.fromStoryId, retainedPosition],
      );
      for (const segment of segments) {
        const id = `segment:${randomUUID()}`;
        segmentIds.set(segment.id, id);
        await tx.query(`INSERT INTO scene_segments (id, story_id, start_position, created_at) VALUES ($1,$2,$3,$4)`, [
          id,
          story.id,
          segment.start_position,
          segment.created_at,
        ]);
      }
    }
    // `createStory` opens scene 1 for every new story. A fork is the one caller
    // that then copies the source's own scene rows over the same range, so the
    // placeholder is dropped first rather than colliding on the way in.
    await tx.query(`DELETE FROM scenes WHERE story_id = $1`, [story.id]);

    // Old id -> new id, per table, built in dependency order so a referencing
    // column always finds its target's remap already populated.
    const idMaps = new Map<string, Map<string, string>>();

    for (const spec of FORK_TABLES) {
      const columns = await columnsOf(tx, spec.table);
      const jsonColumns = await jsonColumnsOf(tx, spec.table);
      // Which columns a copy may carry, and why this is asked of the catalog rather
      // than listed here.
      //
      // Three different things are called `id` or `eid` across these tables, and
      // getting them wrong fails in three different ways — all three of which this
      // hit while being written, each caught by the fork route test rather than by
      // reading the schema:
      //
      //   - A **sequence-backed** id (`style_anchors.id`, `divergences.id`, and
      //     every `eid`) must be omitted so Postgres assigns a new one. Copying it
      //     duplicates a primary key.
      //   - A **meaningful text** id (`chron_entities.id` = `char:anselm`) must be
      //     carried, or the overlay no longer describes the canon entity it is
      //     about. Omitting it violates NOT NULL.
      //   - A **surrogate text** id that other tables reference (`turns.id`,
      //     `facts.id`, `events.id`, `consequences.id`) must be regenerated *and*
      //     remapped, which is what `freshId` marks and the branch below does.
      //
      // Only the third needs declaring; the first two are a property of the column,
      // so `generatedColumnsOf` reads them from `information_schema`. A column added
      // later is then handled without anyone remembering this comment exists.
      const generated = await generatedColumnsOf(tx, spec.table);
      const copyable = columns.filter(
        (c) => !generated.has(c) && (spec.freshId ? c !== 'id' : true),
      );
      const bound = spec.scene ? ` AND ${spec.scene} < $2` : '';
      const params: unknown[] = [opts.fromStoryId];
      if (spec.scene) params.push(scene);

      if (!spec.freshId && checkpoint) {
        const sourceRows: Record<string, unknown>[] = checkpoint.state.tables[spec.table] ?? [];
        if (!sourceRows.length) continue;
        for (const row of sourceRows) {
          const values = copyable.map((column) => {
            if (column === 'story_id') return story.id;
            if (column === 'scene_segment_id' && row[column] != null) return segmentIds.get(String(row[column])) ?? null;
            if (spec.table === 'scene_metadata' && column === 'identity' && typeof row[column] === 'string')
              return remapSceneMetadataIdentity(row[column], segmentIds);
            return jsonColumns.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column];
          });
          await tx.query(
            `INSERT INTO ${spec.table} (${copyable.join(', ')}) VALUES (${copyable.map((_, i) => `$${i + 1}`).join(', ')})`,
            values,
          );
        }
        continue;
      }

      if (!spec.freshId && !checkpoint) {
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
      const selectColumns = columns.filter((c) => !generated.has(c) || c === 'id').join(', ');
      const sourceRows = checkpoint
        ? spec.table === 'turns'
          ? (
              await tx.query<Record<string, unknown>>(
                `SELECT ${selectColumns} FROM turns
                  WHERE story_id = $1 AND (history_position IS NULL OR history_position <= $2)
                  ORDER BY history_position`,
                [opts.fromStoryId, retainedPosition],
              )
            ).rows
          : checkpoint.state.tables[spec.table] ?? []
        : (
            await tx.query<Record<string, unknown>>(
              `SELECT ${selectColumns} FROM ${spec.table} WHERE story_id = $1${bound}`,
              params,
            )
          ).rows;
      if (!sourceRows.length) continue;

      const ownMap = new Map<string, string>();
      idMaps.set(spec.table, ownMap);
      const refs = CROSS_REFS[spec.table] ?? {};

      const insertCols = columns.filter((c) => !generated.has(c));
      for (const row of sourceRows) {
        const oldId = String(row.id);
        const prefix = oldId.split(':')[0] ?? spec.table;
        const freshId = `${prefix}:${randomUUID()}`;
        ownMap.set(oldId, freshId);

        const values = insertCols.map((c) => {
          if (c === 'story_id') return story.id;
          if (c === 'scene_segment_id' && row[c] != null) return segmentIds.get(String(row[c])) ?? null;
          if (c === 'id') return freshId;
          const refTable = refs[c];
          if (refTable && row[c] != null) {
            // The referenced table was copied earlier (dependency order). A
            // reference to a row this fork did *not* copy — out of scene range —
            // becomes NULL rather than a dangling pointer.
            return idMaps.get(refTable)?.get(String(row[c])) ?? null;
          }
          return jsonColumns.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c];
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
        if (checkpoint) {
          for (const entry of checkpoint.state.tables.fact_knowledge ?? []) {
            if (entry.fact_id !== oldFactId) continue;
            await tx.query(
              `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion) VALUES ($1,$2,$3,$4,$5)`,
              [newFactId, entry.entity_id, entry.level, entry.since_scene, entry.distortion],
            );
          }
        } else {
          await tx.query(
            `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion)
             SELECT $1, entity_id, level, since_scene, distortion
               FROM fact_knowledge WHERE fact_id = $2 AND since_scene < $3`,
            [newFactId, oldFactId, scene],
          );
        }
      }
    }

    const forkedWorld = new World({ db: tx, storyId: story.id, sources: world.sources, crypto: world.crypto });
    if (checkpoint) {
      await copyRetainedCheckpoints(tx, story.id, retainedCheckpoints, idMaps, segmentIds);
      const session = checkpoint.state.session as StorySnapshot['session'] & { active_scene_segment_id?: string | null };
      await forkedWorld.session.set(session);
      await tx.query(`UPDATE stories SET active_scene_segment_id = $1 WHERE id = $2`, [
        session.active_scene_segment_id ? segmentIds.get(session.active_scene_segment_id) ?? null : null,
        story.id,
      ]);
      await reconcileContinuation(forkedWorld);
      await forkedWorld.history.invalidateStaleSummaries();
    } else {
      // The new story resumes exactly where the copy ends, same as truncateToScene.
      await forkedWorld.session.set({ scene, turn: 0 });
    }

    return { story, copiedFrom: opts.fromStoryId, copiedUpToScene: scene };
  });
}

async function copyRetainedCheckpoints(
  tx: Queryable,
  storyId: StoryId,
  checkpoints: HistoryCheckpoint[],
  idMaps: Map<string, Map<string, string>>,
  segmentIds: Map<string, string>,
): Promise<void> {
  for (const checkpoint of checkpoints) {
    const state = remapCheckpointState(checkpoint.state, storyId, idMaps, segmentIds);
    const turnId = checkpoint.turnId ? idMaps.get('turns')?.get(checkpoint.turnId) ?? null : null;
    await tx.query(
      `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [`checkpoint:${randomUUID()}`, storyId, turnId, checkpoint.position, JSON.stringify(state), checkpoint.createdAt],
    );
  }
}

function remapCheckpointState(
  state: StorySnapshot,
  storyId: StoryId,
  idMaps: Map<string, Map<string, string>>,
  segmentIds: Map<string, string>,
): StorySnapshot {
  const copy = JSON.parse(JSON.stringify(state)) as StorySnapshot & {
    session: StorySnapshot['session'] & { active_scene_segment_id?: string | null };
  };
  copy.session.active_scene_segment_id = copy.session.active_scene_segment_id
    ? segmentIds.get(copy.session.active_scene_segment_id) ?? null
    : null;
  for (const [table, entries] of Object.entries(copy.tables)) {
    for (const entry of entries) {
      if ('story_id' in entry) entry.story_id = storyId;
      if (table === 'scene_metadata' && typeof entry.identity === 'string')
        entry.identity = remapSceneMetadataIdentity(entry.identity, segmentIds);
      if (typeof entry.id === 'string') entry.id = idMaps.get(table)?.get(entry.id) ?? entry.id;
      if (table === 'fact_knowledge' && typeof entry.fact_id === 'string')
        entry.fact_id = idMaps.get('facts')?.get(entry.fact_id) ?? entry.fact_id;
      if (table === 'events' && typeof entry.from_consequence_id === 'string')
        entry.from_consequence_id = idMaps.get('consequences')?.get(entry.from_consequence_id) ?? null;
      if (table === 'consequences' && typeof entry.cause_event_id === 'string')
        entry.cause_event_id = idMaps.get('events')?.get(entry.cause_event_id) ?? null;
      if (table === 'illustrations' && typeof entry.turn_id === 'string')
        entry.turn_id = idMaps.get('turns')?.get(entry.turn_id) ?? null;
    }
  }
  return copy;
}

function remapSceneMetadataIdentity(identity: string, segmentIds: Map<string, string>): string {
  if (!identity.startsWith('segment:')) return identity;
  const sourceSegmentId = identity.slice('segment:'.length);
  const forkSegmentId = segmentIds.get(sourceSegmentId);
  return forkSegmentId ? `segment:${forkSegmentId}` : identity;
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
const jsonColumnCache = new Map<string, Set<string>>();

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

/** node-postgres encodes JS arrays as SQL arrays, not JSON arrays. */
async function jsonColumnsOf(tx: Queryable, table: string): Promise<Set<string>> {
  const cached = jsonColumnCache.get(table);
  if (cached) return cached;
  const { rows } = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND data_type = 'jsonb'`,
    [table],
  );
  const columns = new Set(rows.map((row) => row.column_name));
  jsonColumnCache.set(table, columns);
  return columns;
}

/**
 * Columns the database fills in itself — anything with a `nextval(...)` default.
 *
 * Asked rather than listed because "is this id mine to copy" is a property of the
 * column, not a fact about the application: `style_anchors.id` and `divergences.id`
 * are sequences while `chron_entities.id` is `char:anselm`, and a copy that treats
 * them alike fails either on a duplicate key or on NOT NULL. Cached alongside
 * `columnsOf` for the same reason.
 */
const generatedCache = new Map<string, Set<string>>();

async function generatedColumnsOf(tx: Queryable, table: string): Promise<Set<string>> {
  const cached = generatedCache.get(table);
  if (cached) return cached;
  const { rows } = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
    [table],
  );
  const set = new Set(rows.map((r) => r.column_name));
  generatedCache.set(table, set);
  return set;
}
