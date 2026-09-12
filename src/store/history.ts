import { randomUUID } from 'node:crypto';
import { jsonGet, row, rows, tx, type Db } from '../db/db.ts';
import type { EligibleTurn, HistoryCheckpoint, SceneSplit, StoryId, StoryLayout } from '../domain/types.ts';

const TABLES = [
  'entities',
  'edges',
  'sheets',
  'relationships',
  'facts',
  'fact_knowledge',
  'threads',
  'events',
  'consequences',
  'scenes',
  'chapters',
  'directives',
  'divergences',
  'style_anchors',
  'illustrations',
] as const;

const DELETE_ORDER = [...TABLES].reverse();

interface CheckpointRow {
  id: string;
  story_id: string;
  turn_id: string | null;
  position: number;
  state: string;
  created_at: string;
}

function toCheckpoint(rowValue: CheckpointRow): HistoryCheckpoint {
  return {
    id: rowValue.id,
    storyId: rowValue.story_id,
    turnId: rowValue.turn_id,
    position: rowValue.position,
    state: jsonGet<StoryLayout>(rowValue.state, { session: {} as StoryLayout['session'], tables: {} }),
    createdAt: rowValue.created_at,
  };
}

/**
 * Immutable, exact story projections. The generic row layout is intentional:
 * it preserves every mutable column while the table list is the explicit
 * boundary that prevents canon and other stories from entering a snapshot.
 */
export class HistoryStore {
  private db: Db;
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  capture(turnId?: string): HistoryCheckpoint {
    return tx(this.db, () => {
      if (turnId) {
        const existing = row<CheckpointRow>(
          this.db
            .prepare(`SELECT * FROM history_checkpoints WHERE story_id = ? AND turn_id = ?`)
            .get(this.storyId, turnId),
        );
        if (existing) return toCheckpoint(existing);
      }

      const position = Number(
        row<{ position: number }>(
          this.db
            .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS position FROM history_checkpoints WHERE story_id = ?`)
            .get(this.storyId),
        )!.position,
      );
      let segmentId: string | null = null;
      if (turnId) {
        const turn = row<{ history_position: number | null; scene_segment_id: string | null }>(
          this.db
            .prepare(`SELECT history_position, scene_segment_id FROM turns WHERE id = ? AND story_id = ?`)
            .get(turnId, this.storyId),
        );
        if (!turn) throw new Error(`no committed turn ${turnId}`);
        if (turn.history_position != null) {
          const checkpoint = row<CheckpointRow>(
            this.db
              .prepare(`SELECT * FROM history_checkpoints WHERE story_id = ? AND position = ?`)
              .get(this.storyId, turn.history_position),
          );
          if (checkpoint) return toCheckpoint(checkpoint);
          throw new Error(`turn ${turnId} already has history position without a checkpoint`);
        }
        segmentId =
          turn.scene_segment_id ??
          row<{ active_scene_segment_id: string | null }>(
            this.db.prepare(`SELECT active_scene_segment_id FROM stories WHERE id = ?`).get(this.storyId),
          )!.active_scene_segment_id;
        if (!segmentId) {
          segmentId = `segment:${randomUUID()}`;
          this.db
            .prepare(`INSERT INTO scene_segments (id, story_id, start_position, created_at) VALUES (?,?,?,?)`)
            .run(segmentId, this.storyId, position, new Date().toISOString());
          this.db.prepare(`UPDATE stories SET active_scene_segment_id = ? WHERE id = ?`).run(segmentId, this.storyId);
        }
        this.db
          .prepare(`UPDATE turns SET history_position = ?, scene_segment_id = ? WHERE id = ? AND story_id = ?`)
          .run(position, segmentId, turnId, this.storyId);
      }

      const checkpoint: HistoryCheckpoint = {
        id: `checkpoint:${randomUUID()}`,
        storyId: this.storyId,
        turnId: turnId ?? null,
        position,
        state: this.layout(),
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          checkpoint.id,
          checkpoint.storyId,
          checkpoint.turnId,
          checkpoint.position,
          JSON.stringify(checkpoint.state),
          checkpoint.createdAt,
        );
      return checkpoint;
    });
  }

  checkpointForTurn(turnId: string): HistoryCheckpoint | undefined {
    const found = row<CheckpointRow>(
      this.db.prepare(`SELECT * FROM history_checkpoints WHERE story_id = ? AND turn_id = ?`).get(this.storyId, turnId),
    );
    return found ? toCheckpoint(found) : undefined;
  }

  eligibleTurn(turnId: string): EligibleTurn | undefined {
    return row<EligibleTurn>(
      this.db
        .prepare(
          `SELECT t.id AS turnId, t.scene, t.turn, t.history_position AS position
             FROM turns t JOIN history_checkpoints h ON h.story_id = t.story_id AND h.turn_id = t.id
            WHERE t.story_id = ? AND t.id = ? AND t.history_position IS NOT NULL`,
        )
        .get(this.storyId, turnId),
    );
  }

  eligibleTurns(): EligibleTurn[] {
    return rows<EligibleTurn>(
      this.db
        .prepare(
          `SELECT t.id AS turnId, t.scene, t.turn, t.history_position AS position
             FROM turns t JOIN history_checkpoints h ON h.story_id = t.story_id AND h.turn_id = t.id
            WHERE t.story_id = ? AND t.history_position IS NOT NULL
            ORDER BY t.history_position`,
        )
        .all(this.storyId),
    );
  }

  startsScene(turnId: string): boolean {
    const eligible = this.eligibleTurn(turnId);
    if (!eligible) return false;
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM scene_segments WHERE story_id = ? AND start_position = ?`)
        .get(this.storyId, eligible.position),
    );
  }

  restore(checkpoint: HistoryCheckpoint): void {
    if (checkpoint.storyId !== this.storyId) throw new Error(`checkpoint ${checkpoint.id} belongs to another story`);
    tx(this.db, () => this.restoreLayout(checkpoint.state));
  }

  splitBefore(turnId: string): SceneSplit {
    return tx(this.db, () => {
      const eligible = this.eligibleTurn(turnId);
      if (!eligible) throw new Error(`turn ${turnId} has no exact history checkpoint`);
      if (this.startsScene(turnId)) throw new Error(`turn ${turnId} already starts a scene`);
      const id = `segment:${randomUUID()}`;
      this.db
        .prepare(`INSERT INTO scene_segments (id, story_id, start_position, created_at) VALUES (?,?,?,?)`)
        .run(id, this.storyId, eligible.position, new Date().toISOString());
      this.db
        .prepare(`UPDATE turns SET scene_segment_id = ? WHERE story_id = ? AND history_position >= ?`)
        .run(id, this.storyId, eligible.position);
      this.db.prepare(`UPDATE stories SET active_scene_segment_id = ? WHERE id = ?`).run(id, this.storyId);
      return { id, storyId: this.storyId, turnId, position: eligible.position };
    });
  }

  private layout(): StoryLayout {
    const tables: StoryLayout['tables'] = {};
    for (const table of TABLES) {
      const query =
        table === 'fact_knowledge'
          ? `SELECT fk.* FROM fact_knowledge fk JOIN facts f ON f.id = fk.fact_id WHERE f.story_id = ?`
          : table === 'entities' || table === 'edges' || table === 'sheets'
            ? `SELECT * FROM ${table} WHERE story_id = ? AND layer = 'chronicle'`
            : `SELECT * FROM ${table} WHERE story_id = ?`;
      tables[table] = rows<Record<string, unknown>>(this.db.prepare(query).all(this.storyId));
    }
    const session = row<StoryLayout['session'] & { active_scene_segment_id?: string | null }>(
      this.db
        .prepare(
          `SELECT scene, turn, player_character_id AS playerCharacterId, current_location_id AS currentLocationId,
                  style, knobs, active_scene_segment_id
             FROM stories WHERE id = ?`,
        )
        .get(this.storyId),
    );
    if (!session) throw new Error(`no story ${this.storyId}`);
    return {
      session: {
        ...session,
        style: jsonGet(session.style, {}) as StoryLayout['session']['style'],
        knobs: jsonGet(session.knobs, {}) as StoryLayout['session']['knobs'],
      },
      tables,
    };
  }

  private restoreLayout(layout: StoryLayout): void {
    for (const table of DELETE_ORDER) {
      const query =
        table === 'fact_knowledge'
          ? `DELETE FROM fact_knowledge WHERE fact_id IN (SELECT id FROM facts WHERE story_id = ?)`
          : table === 'entities' || table === 'edges' || table === 'sheets'
            ? `DELETE FROM ${table} WHERE story_id = ? AND layer = 'chronicle'`
            : `DELETE FROM ${table} WHERE story_id = ?`;
      this.db.prepare(query).run(this.storyId);
    }
    for (const table of TABLES) {
      for (const entry of layout.tables[table] ?? []) this.insert(table, entry);
    }
    this.db
      .prepare(
        `UPDATE stories SET scene=?, turn=?, player_character_id=?, current_location_id=?, style=?, knobs=?,
         active_scene_segment_id=? WHERE id=?`,
      )
      .run(
        layout.session.scene,
        layout.session.turn,
        layout.session.playerCharacterId,
        layout.session.currentLocationId,
        JSON.stringify(layout.session.style),
        JSON.stringify(layout.session.knobs),
        this.activeSegment(layout),
        this.storyId,
      );
  }

  private insert(table: string, entry: Record<string, unknown>): void {
    const columns = Object.keys(entry);
    if (!columns.length) return;
    this.db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...(columns.map((column) => entry[column]) as never[]));
  }

  private activeSegment(layout: StoryLayout): string | null {
    const session = layout.session as StoryLayout['session'] & { active_scene_segment_id?: string | null };
    return session.active_scene_segment_id ?? null;
  }
}
