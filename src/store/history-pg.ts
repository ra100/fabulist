import { randomUUID } from 'node:crypto';
import { decryptStoryValue, encryptStoryValue } from '../crypto/story-envelope.ts';
import { jsonGet, type Db, type Queryable } from '../db/pg.ts';
import { SceneSplitTargetError, type EligibleTurn, type HistoryCheckpoint, type SceneSplit, type StoryId, type StorySnapshot } from '../domain/types.ts';
import type { ChronicleCrypto } from './chronicle-pg.ts';

const TABLES = [
  'chron_entities',
  'chron_edges',
  'chron_sheets',
  'relationships',
  'facts',
  'fact_knowledge',
  'threads',
  'events',
  'consequences',
  'scenes',
  'scene_metadata',
  'chapters',
  'directives',
  'divergences',
  'style_anchors',
  'illustrations',
] as const;

const DELETE_ORDER = [...TABLES].reverse();
const ENCRYPTED_LAYOUT_TABLES = [...TABLES, 'stories'] as const;

interface CheckpointRow {
  id: string;
  story_id: string;
  turn_id: string | null;
  position: number;
  state: unknown;
  created_at: Date | string;
}

interface EncryptedRow {
  tableName: string;
  recordId: string;
  fieldName: string;
  version: number;
  nonce: string;
  ciphertext: string;
}

type HistoryLayout = StorySnapshot & { encryptedValues?: EncryptedRow[] };

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function checkpointOf(value: CheckpointRow, state: HistoryLayout): HistoryCheckpoint {
  return {
    id: value.id,
    storyId: value.story_id,
    turnId: value.turn_id,
    position: value.position,
    state,
    createdAt: isoOf(value.created_at),
  };
}

export class HistoryStore {
  private db: Queryable;
  private storyId: StoryId;
  private crypto: ChronicleCrypto | undefined;

  constructor(db: Queryable, storyId: StoryId, crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.crypto = crypto;
  }

  async capture(turnId?: string): Promise<HistoryCheckpoint> {
    return this.transaction((queryable) => this.captureIn(queryable, turnId));
  }

  async checkpointForTurn(turnId: string): Promise<HistoryCheckpoint | undefined> {
    const key = await this.privateKey(this.db);
    const { rows } = await this.db.query<CheckpointRow>(
      `SELECT * FROM history_checkpoints WHERE story_id = $1 AND turn_id = $2`,
      [this.storyId, turnId],
    );
    return rows[0] ? checkpointOf(rows[0], await this.readState(this.db, rows[0], key)) : undefined;
  }

  async checkpointsThrough(position: number): Promise<HistoryCheckpoint[]> {
    const key = await this.privateKey(this.db);
    const { rows } = await this.db.query<CheckpointRow>(
      `SELECT * FROM history_checkpoints WHERE story_id = $1 AND position <= $2 ORDER BY position`,
      [this.storyId, position],
    );
    return Promise.all(rows.map(async (checkpoint) => checkpointOf(checkpoint, await this.readState(this.db, checkpoint, key))));
  }

  async eligibleTurn(turnId: string): Promise<EligibleTurn | undefined> {
    const { rows } = await this.db.query<EligibleTurn>(
      `SELECT t.id AS "turnId", t.scene, t.turn, t.history_position AS position
         FROM turns t JOIN history_checkpoints h ON h.story_id = t.story_id AND h.turn_id = t.id
        WHERE t.story_id = $1 AND t.id = $2 AND t.history_position IS NOT NULL`,
      [this.storyId, turnId],
    );
    return rows[0];
  }

  async eligibleTurns(): Promise<EligibleTurn[]> {
    const { rows } = await this.db.query<EligibleTurn>(
      `SELECT t.id AS "turnId", t.scene, t.turn, t.history_position AS position
         FROM turns t JOIN history_checkpoints h ON h.story_id = t.story_id AND h.turn_id = t.id
        WHERE t.story_id = $1 AND t.history_position IS NOT NULL
        ORDER BY t.history_position`,
      [this.storyId],
    );
    return rows;
  }

  async startsScene(turnId: string): Promise<boolean> {
    const eligible = await this.eligibleTurn(turnId);
    if (!eligible) return false;
    const [{ rows: prior }, { rowCount }] = await Promise.all([
      this.db.query<{ scene: number }>(
        `SELECT scene FROM turns WHERE story_id = $1 AND history_position IS NOT NULL AND history_position < $2
         ORDER BY history_position DESC LIMIT 1`,
        [this.storyId, eligible.position],
      ),
      this.db.query(
        `SELECT 1 FROM scene_segments WHERE story_id = $1 AND start_position = $2`,
        [this.storyId, eligible.position],
      ),
    ]);
    return !prior[0] || prior[0].scene !== eligible.scene || Boolean(rowCount);
  }

  async sceneStartPositions(): Promise<number[]> {
    const { rows } = await this.db.query<{ start_position: number }>(
      `SELECT start_position FROM scene_segments WHERE story_id = $1`,
      [this.storyId],
    );
    return rows.map(({ start_position }) => start_position);
  }

  async sceneSegments(): Promise<Array<{ id: string; startPosition: number }>> {
    const { rows } = await this.db.query<{ id: string; start_position: number }>(
      `SELECT id, start_position FROM scene_segments WHERE story_id = $1 ORDER BY start_position`,
      [this.storyId],
    );
    return rows.map((segment) => ({ id: segment.id, startPosition: segment.start_position }));
  }

  async activeSegmentAt(position: number): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM scene_segments WHERE story_id = $1 AND start_position <= $2 ORDER BY start_position DESC LIMIT 1`,
      [this.storyId, position],
    );
    return rows[0]?.id ?? null;
  }

  async restore(checkpoint: HistoryCheckpoint): Promise<void> {
    if (checkpoint.storyId !== this.storyId) throw new Error(`checkpoint ${checkpoint.id} belongs to another story`);
    await this.transaction(async (queryable) => {
      const key = await this.privateKey(queryable);
      const { rows } = await queryable.query<CheckpointRow>(
        `SELECT * FROM history_checkpoints WHERE id = $1 AND story_id = $2`,
        [checkpoint.id, this.storyId],
      );
      if (!rows[0]) throw new Error(`no checkpoint ${checkpoint.id}`);
      await this.restoreLayout(queryable, await this.readState(queryable, rows[0], key));
    });
  }

  /** Restores one retained turn and atomically removes only its later history. */
  async restoreTurn(turnId: string): Promise<HistoryCheckpoint> {
    return this.transaction(async (queryable) => {
      await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.storyId]);
      const { rows: turns } = await queryable.query<{ history_position: number | null }>(
        `SELECT history_position FROM turns WHERE id = $1 AND story_id = $2`,
        [turnId, this.storyId],
      );
      const turn = turns[0];
      if (!turn) throw new Error(`rollback: unknown turn ${turnId}`);
      if (turn.history_position == null) throw new Error(`rollback: turn ${turnId} is legacy and has no exact history`);
      const { rows: checkpoints } = await queryable.query<CheckpointRow>(
        `SELECT * FROM history_checkpoints WHERE story_id = $1 AND turn_id = $2`,
        [this.storyId, turnId],
      );
      const checkpoint = checkpoints[0];
      if (!checkpoint) throw new Error(`rollback: turn ${turnId} has no exact history checkpoint`);

      const key = await this.privateKey(queryable);
      const retained = checkpointOf(checkpoint, await this.readState(queryable, checkpoint, key));
      await this.restoreLayout(queryable, retained.state);
      await queryable.query(`DELETE FROM turns WHERE story_id = $1 AND history_position > $2`, [
        this.storyId,
        retained.position,
      ]);
      await queryable.query(`DELETE FROM scene_segments WHERE story_id = $1 AND start_position > $2`, [
        this.storyId,
        retained.position,
      ]);
      await queryable.query(
        `DELETE FROM encrypted_story_values
          WHERE story_id = $1 AND table_name = 'history_checkpoints'
            AND record_id IN (
              SELECT id FROM history_checkpoints WHERE story_id = $1 AND position > $2
            )`,
        [this.storyId, retained.position],
      );
      await queryable.query(`DELETE FROM history_checkpoints WHERE story_id = $1 AND position > $2`, [
        this.storyId,
        retained.position,
      ]);
      await this.reconcileContinuation(queryable, retained.position);
      await this.invalidateStaleSummaries(queryable, key);
      return retained;
    });
  }

  /**
   * Segments are durable layout state rather than checkpoint state. A
   * checkpoint from before a split can therefore restore its parent summary
   * into a now-split layout; retain only metadata whose identity and chapter
   * membership still describe that layout.
   */
  async invalidateStaleSummaries(queryable: Queryable = this.db, suppliedKey?: Buffer | null): Promise<void> {
    const key = suppliedKey === undefined ? await this.privateKey(queryable) : suppliedKey;
    const [{ rows: turns }, { rows: segmentRows }, { rows: metadata }, { rows: chapters }] = await Promise.all([
      queryable.query<{ scene: number; history_position: number }>(
        `SELECT scene, history_position FROM turns
          WHERE story_id = $1 AND history_position IS NOT NULL
          ORDER BY history_position`,
        [this.storyId],
      ),
      queryable.query<{ id: string; start_position: number }>(
        `SELECT id, start_position FROM scene_segments WHERE story_id = $1`,
        [this.storyId],
      ),
      queryable.query<{ identity: string; scene: number; chapter: number }>(
        `SELECT identity, scene, chapter FROM scene_metadata WHERE story_id = $1`,
        [this.storyId],
      ),
      queryable.query<{ chapter: number }>(`SELECT chapter FROM chapters WHERE story_id = $1`, [this.storyId]),
    ]);
    const segments = new Map(segmentRows.map((segment) => [segment.start_position, segment.id]));
    const expected = new Map<string, { scene: number; chapter: number }>();
    const identitiesByRawScene = new Map<number, Set<string>>();
    let previousRawScene: number | undefined;
    let segmentId: string | undefined;
    let scene = 0;
    for (const turn of turns) {
      if (previousRawScene !== turn.scene) segmentId = undefined;
      if (segments.has(turn.history_position) && scene > 0) segmentId = segments.get(turn.history_position);
      if (previousRawScene !== turn.scene || (segments.has(turn.history_position) && scene > 0)) scene += 1;
      const identity = segmentId ? `segment:${segmentId}` : `raw:${turn.scene}`;
      expected.set(identity, { scene, chapter: Math.floor((scene - 1) / 8) + 1 });
      const identities = identitiesByRawScene.get(turn.scene) ?? new Set<string>();
      identities.add(identity);
      identitiesByRawScene.set(turn.scene, identities);
      previousRawScene = turn.scene;
    }
    const stale = metadata.filter((entry) => {
      const layout = expected.get(entry.identity);
      const rawScene = /^raw:(\d+)$/.exec(entry.identity);
      return !layout ||
        layout.scene !== entry.scene ||
        layout.chapter !== entry.chapter ||
        (rawScene !== null && (identitiesByRawScene.get(Number(rawScene[1]))?.size ?? 0) > 1);
    });
    for (const entry of stale) await this.clearSummary(queryable, key, 'scene_metadata', entry.identity);

    const expectedByChapter = new Map<number, Set<string>>();
    for (const [identity, layout] of expected) {
      const group = expectedByChapter.get(layout.chapter) ?? new Set<string>();
      group.add(identity);
      expectedByChapter.set(layout.chapter, group);
    }
    for (const { chapter } of chapters) {
      const stored = new Set(metadata.filter((entry) => entry.chapter === chapter).map((entry) => entry.identity));
      const expectedGroup = expectedByChapter.get(chapter) ?? new Set<string>();
      if (stored.size !== expectedGroup.size || [...stored].some((identity) => !expectedGroup.has(identity))) {
        await this.clearSummary(queryable, key, 'chapters', String(chapter));
      }
    }
  }

  async splitBefore(turnId: string): Promise<SceneSplit> {
    return this.transaction(async (queryable) => {
      await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.storyId]);
      const { rows: turns } = await queryable.query<{ history_position: number | null }>(
        `SELECT history_position FROM turns WHERE id = $1 AND story_id = $2`,
        [turnId, this.storyId],
      );
      const stored = turns[0];
      if (!stored) throw new SceneSplitTargetError(`split_scene: unknown turn ${turnId}`);
      if (stored.history_position == null) throw new SceneSplitTargetError(`split_scene: turn ${turnId} is legacy and has no exact history`);
      const eligible = await this.eligibleTurnFrom(queryable, turnId);
      if (!eligible) throw new SceneSplitTargetError(`split_scene: turn ${turnId} has no exact history checkpoint`);
      const [prior, exists] = await Promise.all([
        queryable.query<{ scene: number }>(
          `SELECT scene FROM turns WHERE story_id = $1 AND history_position IS NOT NULL AND history_position < $2
           ORDER BY history_position DESC LIMIT 1`,
          [this.storyId, eligible.position],
        ),
        queryable.query(`SELECT 1 FROM scene_segments WHERE story_id = $1 AND start_position = $2`, [
        this.storyId,
        eligible.position,
        ]),
      ]);
      if (!prior.rows[0] || prior.rows[0].scene !== eligible.scene || exists.rowCount)
        throw new SceneSplitTargetError(`turn ${turnId} already starts a scene`);
      const id = `segment:${randomUUID()}`;
      await queryable.query(`INSERT INTO scene_segments (id, story_id, start_position) VALUES ($1,$2,$3)`, [
        id,
        this.storyId,
        eligible.position,
      ]);
      await queryable.query(`UPDATE stories SET active_scene_segment_id = $1 WHERE id = $2`, [id, this.storyId]);
      return { id, storyId: this.storyId, turnId, position: eligible.position };
    });
  }

  private async captureIn(queryable: Queryable, turnId?: string): Promise<HistoryCheckpoint> {
    await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.storyId]);
    const key = await this.privateKey(queryable);
    if (turnId) {
      const { rows } = await queryable.query<CheckpointRow>(
        `SELECT * FROM history_checkpoints WHERE story_id = $1 AND turn_id = $2`,
        [this.storyId, turnId],
      );
      if (rows[0]) return checkpointOf(rows[0], await this.readState(queryable, rows[0], key));
    }
    const { rows: positions } = await queryable.query<{ position: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS position FROM history_checkpoints WHERE story_id = $1`,
      [this.storyId],
    );
    const position = Number(positions[0]!.position);
    if (turnId) await this.assignTurnPosition(queryable, turnId, position);
    const checkpoint: HistoryCheckpoint = {
      id: `checkpoint:${randomUUID()}`,
      storyId: this.storyId,
      turnId: turnId ?? null,
      position,
      state: await this.layout(queryable, key),
      createdAt: new Date().toISOString(),
    };
    await queryable.query(
      `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        checkpoint.id,
        this.storyId,
        checkpoint.turnId,
        checkpoint.position,
        key ? '{}' : JSON.stringify(checkpoint.state),
        checkpoint.createdAt,
      ],
    );
    if (key) {
      const envelope = encryptStoryValue(
        key,
        { storyId: this.storyId, table: 'history_checkpoints', recordId: checkpoint.id, field: 'state' },
        checkpoint.state,
      );
      await queryable.query(
        `INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          this.storyId,
          'history_checkpoints',
          checkpoint.id,
          'state',
          envelope.version,
          envelope.nonce,
          envelope.ciphertext,
        ],
      );
    }
    return checkpoint;
  }

  private async assignTurnPosition(queryable: Queryable, turnId: string, position: number): Promise<void> {
    const { rows } = await queryable.query<{ history_position: number | null; scene_segment_id: string | null }>(
      `SELECT history_position, scene_segment_id FROM turns WHERE id = $1 AND story_id = $2`,
      [turnId, this.storyId],
    );
    const turn = rows[0];
    if (!turn) throw new Error(`no committed turn ${turnId}`);
    if (turn.history_position != null)
      throw new Error(`turn ${turnId} already has history position without a checkpoint`);
    const { rows: stories } = await queryable.query<{ active_scene_segment_id: string | null }>(
      `SELECT active_scene_segment_id FROM stories WHERE id = $1`,
      [this.storyId],
    );
    let segmentId = turn.scene_segment_id ?? stories[0]?.active_scene_segment_id ?? null;
    if (!segmentId) {
      segmentId = `segment:${randomUUID()}`;
      await queryable.query(`INSERT INTO scene_segments (id, story_id, start_position) VALUES ($1,$2,$3)`, [
        segmentId,
        this.storyId,
        position,
      ]);
      await queryable.query(`UPDATE stories SET active_scene_segment_id = $1 WHERE id = $2`, [segmentId, this.storyId]);
    }
    await queryable.query(
      `UPDATE turns SET history_position = $1, scene_segment_id = $2 WHERE id = $3 AND story_id = $4`,
      [position, segmentId, turnId, this.storyId],
    );
  }

  private async layout(queryable: Queryable, key: Buffer | null): Promise<HistoryLayout> {
    const tables: StorySnapshot['tables'] = {};
    for (const table of TABLES) {
      const query =
        table === 'fact_knowledge'
          ? `SELECT fk.* FROM fact_knowledge fk JOIN facts f ON f.id = fk.fact_id WHERE f.story_id = $1`
          : `SELECT * FROM ${table} WHERE story_id = $1`;
      tables[table] = (await queryable.query<Record<string, unknown>>(query, [this.storyId])).rows;
    }
    const { rows } = await queryable.query<StorySnapshot['session'] & { active_scene_segment_id: string | null }>(
      `SELECT scene, turn, player_character_id AS "playerCharacterId", current_location_id AS "currentLocationId",
              style, knobs, active_scene_segment_id
         FROM stories WHERE id = $1`,
      [this.storyId],
    );
    if (!rows[0]) throw new Error(`no story ${this.storyId}`);
    const layout: HistoryLayout = { session: rows[0], tables };
    if (key) {
      const { rows: encrypted } = await queryable.query<{
        table_name: string;
        record_id: string;
        field_name: string;
        version: number;
        nonce: Buffer;
        ciphertext: Buffer;
      }>(
        `SELECT table_name, record_id, field_name, version, nonce, ciphertext
           FROM encrypted_story_values WHERE story_id = $1 AND table_name = ANY($2::text[])`,
        [this.storyId, ENCRYPTED_LAYOUT_TABLES],
      );
      layout.encryptedValues = encrypted.map((value) => ({
        tableName: value.table_name,
        recordId: value.record_id,
        fieldName: value.field_name,
        version: value.version,
        nonce: value.nonce.toString('base64'),
        ciphertext: value.ciphertext.toString('base64'),
      }));
    }
    return layout;
  }

  private async readState(queryable: Queryable, checkpoint: CheckpointRow, key: Buffer | null): Promise<HistoryLayout> {
    if (!key) return jsonGet<HistoryLayout>(checkpoint.state, { session: {} as StorySnapshot['session'], tables: {} });
    const { rows } = await queryable.query<{ version: number; nonce: Buffer; ciphertext: Buffer }>(
      `SELECT version, nonce, ciphertext FROM encrypted_story_values
        WHERE story_id = $1 AND table_name = 'history_checkpoints' AND record_id = $2 AND field_name = 'state'`,
      [this.storyId, checkpoint.id],
    );
    if (!rows[0]) throw new Error(`private checkpoint ${checkpoint.id} is missing its encrypted state`);
    return decryptStoryValue(
      key,
      { storyId: this.storyId, table: 'history_checkpoints', recordId: checkpoint.id, field: 'state' },
      rows[0],
    ) as HistoryLayout;
  }

  private async restoreLayout(queryable: Queryable, layout: HistoryLayout): Promise<void> {
    if (layout.encryptedValues) {
      await queryable.query(`DELETE FROM encrypted_story_values WHERE story_id = $1 AND table_name = ANY($2::text[])`, [
        this.storyId,
        ENCRYPTED_LAYOUT_TABLES,
      ]);
    }
    for (const table of DELETE_ORDER) {
      const query =
        table === 'fact_knowledge'
          ? `DELETE FROM fact_knowledge WHERE fact_id IN (SELECT id FROM facts WHERE story_id = $1)`
          : `DELETE FROM ${table} WHERE story_id = $1`;
      await queryable.query(query, [this.storyId]);
    }
    for (const table of TABLES) {
      for (const entry of layout.tables[table] ?? []) await this.insert(queryable, table, entry);
    }
    for (const value of layout.encryptedValues ?? []) {
      await queryable.query(
        `INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          this.storyId,
          value.tableName,
          value.recordId,
          value.fieldName,
          value.version,
          Buffer.from(value.nonce, 'base64'),
          Buffer.from(value.ciphertext, 'base64'),
        ],
      );
    }
    const session = layout.session as StorySnapshot['session'] & { active_scene_segment_id?: string | null };
    await queryable.query(
      `UPDATE stories SET scene=$1, turn=$2, player_character_id=$3, current_location_id=$4, style=$5::jsonb, knobs=$6::jsonb,
       active_scene_segment_id=$7 WHERE id=$8`,
      [
        session.scene,
        session.turn,
        session.playerCharacterId,
        session.currentLocationId,
        JSON.stringify(session.style),
        JSON.stringify(session.knobs),
        session.active_scene_segment_id ?? null,
        this.storyId,
      ],
    );
  }

  private async insert(queryable: Queryable, table: string, entry: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(entry);
    if (!columns.length) return;
    const slots = columns.map((_, index) => `$${index + 1}`).join(', ');
    await queryable.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${slots})`,
      columns.map((column) => entry[column]),
    );
  }

  private async eligibleTurnFrom(queryable: Queryable, turnId: string): Promise<EligibleTurn | undefined> {
    const { rows } = await queryable.query<EligibleTurn>(
      `SELECT t.id AS "turnId", t.scene, t.turn, t.history_position AS position
         FROM turns t JOIN history_checkpoints h ON h.story_id = t.story_id AND h.turn_id = t.id
        WHERE t.story_id = $1 AND t.id = $2 AND t.history_position IS NOT NULL`,
      [this.storyId, turnId],
    );
    return rows[0];
  }

  private async privateKey(queryable: Queryable): Promise<Buffer | null> {
    const { rows } = await queryable.query<{ encryption_version: number }>(
      `SELECT encryption_version FROM stories WHERE id = $1`,
      [this.storyId],
    );
    const version = rows[0]?.encryption_version;
    if (version === undefined) throw new Error(`no story ${this.storyId}`);
    if (version === 0) return null;
    if (version !== 1) throw new Error(`unsupported private-story format ${version}`);
    const key = this.crypto?.keyForStory(this.storyId) ?? null;
    if (!key) throw new Error(`private story ${this.storyId} is locked`);
    if (key.length !== 32) throw new Error('invalid private-story key');
    return Buffer.from(key);
  }

  private async clearSummary(
    queryable: Queryable,
    key: Buffer | null,
    table: 'scene_metadata' | 'chapters',
    recordId: string,
  ): Promise<void> {
    const idColumn = table === 'scene_metadata' ? 'identity' : 'chapter';
    await queryable.query(
      `UPDATE ${table} SET title = '', summary = '' WHERE story_id = $1 AND ${idColumn} = $2`,
      [this.storyId, recordId],
    );
    if (!key) return;
    for (const field of ['title', 'summary'] as const) {
      const envelope = encryptStoryValue(key, { storyId: this.storyId, table, recordId, field }, '');
      await queryable.query(
        `INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
           version = EXCLUDED.version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
        [this.storyId, table, recordId, field, envelope.version, envelope.nonce, envelope.ciphertext],
      );
    }
  }

  private async reconcileContinuation(queryable: Queryable, position: number): Promise<void> {
    const [{ rows: turns }, { rows: segments }] = await Promise.all([
      queryable.query<{ scene: number; turn: number; history_position: number }>(
        `SELECT scene, turn, history_position FROM turns WHERE story_id = $1 AND history_position <= $2 ORDER BY history_position`,
        [this.storyId, position],
      ),
      queryable.query<{ id: string; start_position: number }>(
        `SELECT id, start_position FROM scene_segments WHERE story_id = $1 AND start_position <= $2 ORDER BY start_position`,
        [this.storyId, position],
      ),
    ]);
    const starts = new Set(segments.map((segment) => segment.start_position));
    let previousScene: number | undefined;
    let scene = 0;
    for (const turn of turns) {
      if (previousScene !== turn.scene || starts.has(turn.history_position)) scene += 1;
      previousScene = turn.scene;
    }
    const last = turns.at(-1);
    await queryable.query(`UPDATE stories SET scene = $1, turn = $2, active_scene_segment_id = $3 WHERE id = $4`, [
      scene || 1, last?.turn ?? 0, segments.at(-1)?.id ?? null, this.storyId,
    ]);
  }

  private transaction<T>(fn: (queryable: Queryable) => Promise<T>): Promise<T> {
    const database = this.db as Db;
    return typeof database.tx === 'function' ? database.tx(fn) : fn(this.db);
  }
}
