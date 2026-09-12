/**
 * Chronicle store, Postgres: events, turns, scenes, facts, and the divergence
 * ledger. Epistemic state lives here because "who knows what" is
 * chronicle-scoped. See DESIGN.md §2 and §6.3.
 *
 * Everything here is story-scoped — this is the store with no canon layer at
 * all, so nothing in it needs the overlay. That is why it converts to Postgres
 * almost mechanically: only the dialect changes.
 *
 * ## Two behavioural notes worth keeping
 *
 * **`meta` moved and changed meaning.** The SQLite version's `getMeta`/`setMeta`
 * wrote a file-global `meta` table, which held `worldTitle` and `ingestContext`.
 * That was wrong the moment one story could compose two fandoms, and
 * `.design/DBFIXES.md` asked for the decision to be recorded: world identity now
 * lives on `worlds.title`/`worlds.ingest_context`, and anything else a world
 * needs to remember goes in `world_meta` keyed by `world_id`. So these methods
 * take a world id, and a story with several sources must say which world it
 * means rather than writing to a global key that would silently belong to
 * whichever world was ingested last.
 *
 * **`participants` membership is a jsonb containment test.** Under SQLite this
 * had to be `json_each`, after `LIKE '%id%'` was found matching any id the
 * target was a prefix of — searching `char:tem` also returned events whose only
 * participant was `char:tem-the-elder`. That was reproduced directly rather than
 * inferred, and it mattered because this is the POV mask: a false positive hands
 * the Narrator an event the player never saw. Here `participants @> $2::jsonb`
 * is both correct and served by a GIN index.
 */
import { randomUUID } from 'node:crypto';
import { decryptStoryValue, encryptStoryValue } from '../crypto/story-envelope.ts';
import { jsonGet, type Queryable } from '../db/pg.ts';
import { PrivateStoryLockedError } from './private-story-access.ts';
import type {
  Delta,
  EntityId,
  Fact,
  FactId,
  FactKnowledge,
  KnowledgeLevel,
  StoryEvent,
  StoryId,
  Turn,
  TurnMeta,
  Visibility,
} from '../domain/types.ts';

interface EventRow {
  id: string;
  scene: number;
  turn: number;
  text: string;
  participants: unknown;
  location_id: string | null;
  significance: number;
  visibility: Visibility;
  from_consequence_id: string | null;
}

interface TurnRow {
  id: string;
  scene: number;
  turn: number;
  raw_input: string;
  intent: unknown;
  delta: unknown;
  book_prose: string;
  pinned: boolean;
  meta: unknown;
  created_at: Date | string;
}

function toEvent(r: EventRow): StoryEvent {
  return {
    id: r.id,
    scene: r.scene,
    turn: r.turn,
    text: r.text,
    participants: jsonGet<EntityId[]>(r.participants, []),
    locationId: r.location_id,
    significance: r.significance,
    visibility: r.visibility,
    fromConsequenceId: r.from_consequence_id,
  };
}

/**
 * `TIMESTAMPTZ` comes back as a Date. Callers (the API, the book view, MCP)
 * expect the ISO string the SQLite version stored, so it is normalised here
 * rather than at each of them.
 */
function isoOf(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function toTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    scene: r.scene,
    turn: r.turn,
    rawInput: r.raw_input,
    intent: r.intent ? jsonGet(r.intent, null) : null,
    delta: r.delta ? jsonGet<Delta | null>(r.delta, null) : null,
    bookProse: r.book_prose,
    pinned: r.pinned,
    meta: jsonGet<TurnMeta>(r.meta, {
      integrity: null,
      referee: null,
      move: null,
      frameLog: null,
      lint: null,
      providerCalls: [],
    }),
    createdAt: isoOf(r.created_at),
  };
}

const EVENT_COLS = 'id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id';
const TURN_COLS = 'id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at';

export interface ChronicleStoreOptions {
  db: Queryable;
  storyId: StoryId;
  /** For `getMeta`/`setMeta`, which are world-level rather than story-level. */
  worldId?: number;
  /**
   * A process-local capability for private-story data. It deliberately supplies
   * no persistence mechanism: callers normally bridge this to an expiring,
   * user-scoped key grant.
   */
  crypto?: ChronicleCrypto;
}

export interface ChronicleCrypto {
  keyForStory(storyId: StoryId): Buffer | null;
}

type EncryptedValue = { field: string; value: unknown; writeOnUpdate?: boolean };
type DecryptedValues = Map<string, Map<string, unknown>>;

export class ChronicleStore {
  private db: Queryable;
  private storyId: StoryId;
  private worldId: number | undefined;
  private crypto: ChronicleCrypto | undefined;
  private encryptionVersion: number | undefined;

  constructor(opts: ChronicleStoreOptions) {
    this.db = opts.db;
    this.storyId = opts.storyId;
    this.worldId = opts.worldId;
    this.crypto = opts.crypto;
  }

  /**
   * The database, not the presence of a key, decides whether this story is
   * private. This prevents an accidentally omitted capability from downgrading
   * an encrypted row to plaintext writes.
   */
  private async privateKey(): Promise<Buffer | null> {
    if (this.encryptionVersion === undefined) {
      const { rows } = await this.db.query<{ encryption_version: number }>(
        `SELECT encryption_version FROM stories WHERE id = $1`,
        [this.storyId],
      );
      const version = rows[0]?.encryption_version;
      if (version === undefined) throw new Error(`no story ${this.storyId}`);
      if (version !== 0 && version !== 1) throw new Error(`unsupported private-story format ${version}`);
      this.encryptionVersion = version;
    }
    if (this.encryptionVersion === 0) return null;
    const key = this.crypto?.keyForStory(this.storyId) ?? null;
    if (!key) throw new PrivateStoryLockedError(this.storyId);
    if (key.length !== 32) throw new Error('invalid private-story key');
    return Buffer.from(key);
  }

  /**
   * One statement writes the structural row and every encrypted field, so a
   * failed envelope write cannot leave a readable row without its content.
   * Callers allocate serial record ids before this statement so their public
   * routing identity can be bound into each envelope's AAD.
   */
  private async writePrivateValues(
    statement: string,
    statementParams: unknown[],
    table: string,
    recordId: string,
    key: Buffer,
    values: EncryptedValue[],
  ): Promise<void> {
    const envelopes = values.map(({ field, value }) => ({
      field,
      ...encryptStoryValue(key, { storyId: this.storyId, table, recordId, field }, value),
    }));
    const first = statementParams.length;
    const valueParams: unknown[] = [];
    const tuples = envelopes
      .map((envelope, index) => {
        const offset = first + 4 + index * 5;
        valueParams.push(
          envelope.field,
          envelope.version,
          envelope.nonce,
          envelope.ciphertext,
          values[index]!.writeOnUpdate ?? true,
        );
        return `($${offset}::text,$${offset + 1}::integer,$${offset + 2}::bytea,$${offset + 3}::bytea,$${offset + 4}::boolean)`;
      })
      .join(', ');
    await this.db.query(
      `WITH written AS (${statement})
       INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
       SELECT $${first + 1}, $${first + 2}, $${first + 3}, value.field_name, value.version, value.nonce, value.ciphertext
         FROM written CROSS JOIN (VALUES ${tuples}) AS value(field_name, version, nonce, ciphertext, write_on_update)
        WHERE written.inserted::boolean OR value.write_on_update::boolean
       ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
         version = EXCLUDED.version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [...statementParams, this.storyId, table, recordId, ...valueParams],
    );
  }

  private async encryptedValues(
    table: string,
    recordIds: string[],
    fields: string[],
    key: Buffer,
  ): Promise<DecryptedValues> {
    const values: DecryptedValues = new Map();
    if (!recordIds.length) return values;
    const { rows } = await this.db.query<{
      record_id: string;
      field_name: string;
      version: number;
      nonce: Buffer;
      ciphertext: Buffer;
    }>(
      `SELECT record_id, field_name, version, nonce, ciphertext
         FROM encrypted_story_values
        WHERE story_id = $1 AND table_name = $2
          AND record_id = ANY($3::text[]) AND field_name = ANY($4::text[])`,
      [this.storyId, table, recordIds, fields],
    );
    for (const row of rows) {
      const fieldsForRecord = values.get(row.record_id) ?? new Map<string, unknown>();
      fieldsForRecord.set(
        row.field_name,
        decryptStoryValue(
          key,
          { storyId: this.storyId, table, recordId: row.record_id, field: row.field_name },
          { version: row.version, nonce: row.nonce, ciphertext: row.ciphertext },
        ),
      );
      values.set(row.record_id, fieldsForRecord);
    }
    for (const recordId of recordIds) {
      for (const field of fields) {
        if (!values.get(recordId)?.has(field)) {
          throw new Error(`missing encrypted private story value ${table}.${field}`);
        }
      }
    }
    return values;
  }

  private static stringValue(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new Error(`invalid encrypted private story value ${field}`);
    return value;
  }

  // --------------------------------------------------------------- events

  async addEvent(e: Omit<StoryEvent, 'id'> & { id?: string }): Promise<StoryEvent> {
    const id = e.id ?? `ev:${randomUUID()}`;
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `INSERT INTO events (id, story_id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id)
         VALUES ($1,$2,$3,$4,'',$5::jsonb,$6,$7,$8,$9) RETURNING true AS inserted`,
        [
          id,
          this.storyId,
          e.scene,
          e.turn,
          JSON.stringify(e.participants),
          e.locationId,
          e.significance,
          e.visibility,
          e.fromConsequenceId,
        ],
        'events',
        id,
        key,
        [{ field: 'text', value: e.text }],
      );
      return { ...e, id };
    }
    await this.db.query(
      `INSERT INTO events (id, story_id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        id,
        this.storyId,
        e.scene,
        e.turn,
        e.text,
        JSON.stringify(e.participants),
        e.locationId,
        e.significance,
        e.visibility,
        e.fromConsequenceId,
      ],
    );
    return { ...e, id };
  }

  async events(opts: { limit?: number; sinceScene?: number; visibility?: Visibility[] } = {}): Promise<StoryEvent[]> {
    const key = await this.privateKey();
    const where: string[] = ['story_id = $1'];
    const args: unknown[] = [this.storyId];
    if (opts.sinceScene !== undefined) {
      args.push(opts.sinceScene);
      where.push(`scene >= $${args.length}`);
    }
    if (opts.visibility?.length) {
      // `= ANY($n)` rather than an IN list built from placeholders: one
      // parameter regardless of how many values, so the statement text is stable
      // and Postgres can reuse its plan.
      args.push(opts.visibility);
      where.push(`visibility = ANY($${args.length})`);
    }
    args.push(opts.limit ?? 100);
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY scene, turn LIMIT $${args.length}`,
      args,
    );
    if (!key) return rows.map(toEvent);
    const values = await this.encryptedValues(
      'events',
      rows.map((row) => row.id),
      ['text'],
      key,
    );
    return rows.map((row) =>
      toEvent({ ...row, text: ChronicleStore.stringValue(values.get(row.id)!.get('text'), 'events.text') }),
    );
  }

  /**
   * Events the player character actually witnessed, for POV-safe recall.
   *
   * See this file's header for why membership is a containment test rather than
   * a substring match, and why that distinction is a correctness issue in the
   * epistemic layer rather than a tidiness one.
   */
  async witnessedEvents(playerId: EntityId, limit = 40): Promise<StoryEvent[]> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM events
         WHERE story_id = $1 AND visibility = 'onscreen' AND participants @> $2::jsonb
         ORDER BY scene DESC, turn DESC LIMIT $3`,
      [this.storyId, JSON.stringify([playerId]), limit],
    );
    if (!key) return rows.map(toEvent).reverse();
    const values = await this.encryptedValues(
      'events',
      rows.map((row) => row.id),
      ['text'],
      key,
    );
    return rows
      .map((row) =>
        toEvent({ ...row, text: ChronicleStore.stringValue(values.get(row.id)!.get('text'), 'events.text') }),
      )
      .reverse();
  }

  // ---------------------------------------------------------------- turns

  async addTurn(t: Omit<Turn, 'id' | 'createdAt'> & { id?: string }): Promise<Turn> {
    const id = t.id ?? `turn:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `INSERT INTO turns (id, story_id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at)
         VALUES ($1,$2,$3,$4,'',NULL,NULL,'',$5,'{}'::jsonb,$6) RETURNING true AS inserted`,
        [id, this.storyId, t.scene, t.turn, t.pinned, createdAt],
        'turns',
        id,
        key,
        [
          { field: 'raw_input', value: t.rawInput },
          { field: 'intent', value: t.intent },
          { field: 'delta', value: t.delta },
          { field: 'book_prose', value: t.bookProse },
          { field: 'meta', value: t.meta },
        ],
      );
      return { ...t, id, createdAt };
    }
    await this.db.query(
      `INSERT INTO turns (id, story_id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11)`,
      [
        id,
        this.storyId,
        t.scene,
        t.turn,
        t.rawInput,
        t.intent ? JSON.stringify(t.intent) : null,
        t.delta ? JSON.stringify(t.delta) : null,
        t.bookProse,
        t.pinned,
        JSON.stringify(t.meta),
        createdAt,
      ],
    );
    return { ...t, id, createdAt };
  }

  async turns(opts: { scene?: number; limit?: number } = {}): Promise<Turn[]> {
    const key = await this.privateKey();
    if (opts.scene !== undefined) {
      const { rows } = await this.db.query<TurnRow>(
        `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 AND scene = $2 ORDER BY turn`,
        [this.storyId, opts.scene],
      );
      return this.toTurns(rows, key);
    }
    const { rows } = await this.db.query<TurnRow>(
      `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 ORDER BY scene, turn LIMIT $2`,
      [this.storyId, opts.limit ?? 500],
    );
    return this.toTurns(rows, key);
  }

  async recentTurns(n: number): Promise<Turn[]> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<TurnRow>(
      `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 ORDER BY scene DESC, turn DESC LIMIT $2`,
      [this.storyId, n],
    );
    return (await this.toTurns(rows, key)).reverse();
  }

  async getTurn(id: string): Promise<Turn | undefined> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<TurnRow>(`SELECT ${TURN_COLS} FROM turns WHERE id = $1 AND story_id = $2`, [
      id,
      this.storyId,
    ]);
    return rows[0] ? (await this.toTurns(rows, key))[0] : undefined;
  }

  private async toTurns(rows: TurnRow[], key: Buffer | null): Promise<Turn[]> {
    if (!key) return rows.map(toTurn);
    const values = await this.encryptedValues(
      'turns',
      rows.map((row) => row.id),
      ['raw_input', 'intent', 'delta', 'book_prose', 'meta'],
      key,
    );
    return rows.map((row) => {
      const privateValues = values.get(row.id)!;
      return toTurn({
        ...row,
        raw_input: ChronicleStore.stringValue(privateValues.get('raw_input'), 'turns.raw_input'),
        intent: privateValues.get('intent'),
        delta: privateValues.get('delta'),
        book_prose: ChronicleStore.stringValue(privateValues.get('book_prose'), 'turns.book_prose'),
        meta: privateValues.get('meta'),
      });
    });
  }

  /**
   * Sums every provider call recorded across every turn's meta. Per-turn calls
   * are logged and shown in the why panel; nothing accumulated them, which on a
   * paid provider is exactly the number a player wants without doing the sum
   * themselves.
   *
   * Still summed in JS rather than pushed into SQL. It could be a
   * `jsonb_array_elements` aggregate, but the shape of `providerCalls` is a
   * TypeScript type that has changed twice; keeping the traversal here means the
   * types stay the single source of truth and a shape change cannot silently
   * produce wrong totals from a stale SQL projection.
   */
  async usageTotals(): Promise<{
    tokensIn: number;
    tokensOut: number;
    calls: number;
    byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }>;
  }> {
    const key = await this.privateKey();
    const total = { tokensIn: 0, tokensOut: 0, calls: 0 };
    const byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }> = {};
    const { rows } = await this.db.query<{ id: string; meta: unknown }>(
      `SELECT id, meta FROM turns WHERE story_id = $1`,
      [this.storyId],
    );
    const values = key
      ? await this.encryptedValues(
          'turns',
          rows.map((row) => row.id),
          ['meta'],
          key,
        )
      : null;
    for (const r of rows) {
      const meta = jsonGet<TurnMeta | null>(values?.get(r.id)?.get('meta') ?? r.meta, null);
      for (const c of meta?.providerCalls ?? []) {
        total.tokensIn += c.tokensIn;
        total.tokensOut += c.tokensOut;
        total.calls += 1;
        const acc = (byRole[c.role] ??= { tokensIn: 0, tokensOut: 0, calls: 0 });
        acc.tokensIn += c.tokensIn;
        acc.tokensOut += c.tokensOut;
        acc.calls += 1;
      }
    }
    return { ...total, byRole };
  }

  /** Re-render changes how it is told, never what happened (DESIGN §7.2). */
  async setProse(id: string, prose: string): Promise<void> {
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `UPDATE turns SET book_prose = '' WHERE id = $1 AND story_id = $2 AND NOT pinned RETURNING true AS inserted`,
        [id, this.storyId],
        'turns',
        id,
        key,
        [{ field: 'book_prose', value: prose }],
      );
      return;
    }
    await this.db.query(`UPDATE turns SET book_prose = $1 WHERE id = $2 AND story_id = $3 AND NOT pinned`, [
      prose,
      id,
      this.storyId,
    ]);
  }

  /** An explicit author edit replaces even pinned prose while preserving its delta. */
  async replaceProse(id: string, prose: string): Promise<boolean> {
    const key = await this.privateKey();
    if (key) {
      const turn = await this.getTurn(id);
      if (!turn) return false;
      await this.writePrivateValues(
        `UPDATE turns SET book_prose = '' WHERE id = $1 AND story_id = $2 RETURNING true AS inserted`,
        [id, this.storyId],
        'turns',
        id,
        key,
        [{ field: 'book_prose', value: prose }],
      );
      return true;
    }
    const result = await this.db.query(`UPDATE turns SET book_prose = $1 WHERE id = $2 AND story_id = $3`, [
      prose,
      id,
      this.storyId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Records a reroll's own provider calls and lint result onto the turn's stored
   * meta, so the why panel reflects the render actually on the page rather than
   * the original turn's now-stale one. Guarded by `NOT pinned` for the same
   * reason `setProse` is: a pinned turn's meta is part of the passage the author
   * chose to keep.
   */
  async appendRerollMeta(
    id: string,
    patch: { providerCalls: TurnMeta['providerCalls']; lint: TurnMeta['lint'] },
  ): Promise<void> {
    const turn = await this.getTurn(id);
    if (!turn || turn.pinned) return;
    const meta: TurnMeta = {
      ...turn.meta,
      providerCalls: [...turn.meta.providerCalls, ...patch.providerCalls],
      lint: patch.lint,
    };
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `UPDATE turns SET meta = '{}'::jsonb WHERE id = $1 AND story_id = $2 AND NOT pinned RETURNING true AS inserted`,
        [id, this.storyId],
        'turns',
        id,
        key,
        [{ field: 'meta', value: meta }],
      );
      return;
    }
    await this.db.query(`UPDATE turns SET meta = $1::jsonb WHERE id = $2 AND story_id = $3 AND NOT pinned`, [
      JSON.stringify(meta),
      id,
      this.storyId,
    ]);
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.query(`UPDATE turns SET pinned = $1 WHERE id = $2 AND story_id = $3`, [pinned, id, this.storyId]);
  }

  // --------------------------------------------------------------- scenes

  async upsertScene(
    scene: number,
    patch: { title?: string; summary?: string; locationId?: string | null; chapter?: number },
  ): Promise<void> {
    const key = await this.privateKey();
    // `NULLIF(..., '')` keeps a blank patch from erasing an existing title or
    // summary: the compactor writes summaries and the wizard writes titles, and
    // either may upsert the same scene without knowing the other's field.
    if (key) {
      await this.writePrivateValues(
        `INSERT INTO scenes (story_id, scene, title, summary, location_id, chapter) VALUES ($1,$2,'','',$3,$4)
         ON CONFLICT (story_id, scene) DO UPDATE SET
           title = scenes.title,
           summary = scenes.summary,
           location_id = COALESCE(EXCLUDED.location_id, scenes.location_id),
           chapter = EXCLUDED.chapter
         RETURNING (xmax = 0) AS inserted`,
        [this.storyId, scene, patch.locationId ?? null, patch.chapter ?? 1],
        'scenes',
        String(scene),
        key,
        [
          { field: 'title', value: patch.title ?? '', writeOnUpdate: !!patch.title },
          { field: 'summary', value: patch.summary ?? '', writeOnUpdate: !!patch.summary },
        ],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO scenes (story_id, scene, title, summary, location_id, chapter) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (story_id, scene) DO UPDATE SET
         title = COALESCE(NULLIF(EXCLUDED.title,''), scenes.title),
         summary = COALESCE(NULLIF(EXCLUDED.summary,''), scenes.summary),
         location_id = COALESCE(EXCLUDED.location_id, scenes.location_id),
         chapter = EXCLUDED.chapter`,
      [this.storyId, scene, patch.title ?? '', patch.summary ?? '', patch.locationId ?? null, patch.chapter ?? 1],
    );
  }

  async scenes(): Promise<
    Array<{ scene: number; title: string; summary: string; locationId: string | null; chapter: number }>
  > {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{
      scene: number;
      title: string;
      summary: string;
      location_id: string | null;
      chapter: number;
    }>(`SELECT scene, title, summary, location_id, chapter FROM scenes WHERE story_id = $1 ORDER BY scene`, [
      this.storyId,
    ]);
    if (!key)
      return rows.map((r) => ({
        scene: r.scene,
        title: r.title,
        summary: r.summary,
        locationId: r.location_id,
        chapter: r.chapter,
      }));
    const values = await this.encryptedValues(
      'scenes',
      rows.map((row) => String(row.scene)),
      ['title', 'summary'],
      key,
    );
    return rows.map((row) => {
      const privateValues = values.get(String(row.scene))!;
      return {
        scene: row.scene,
        title: ChronicleStore.stringValue(privateValues.get('title'), 'scenes.title'),
        summary: ChronicleStore.stringValue(privateValues.get('summary'), 'scenes.summary'),
        locationId: row.location_id,
        chapter: row.chapter,
      };
    });
  }

  async upsertChapter(chapter: number, patch: { title?: string; summary?: string }): Promise<void> {
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `INSERT INTO chapters (story_id, chapter, title, summary) VALUES ($1,$2,'','')
         ON CONFLICT (story_id, chapter) DO UPDATE SET
           title = chapters.title,
           summary = chapters.summary
         RETURNING (xmax = 0) AS inserted`,
        [this.storyId, chapter],
        'chapters',
        String(chapter),
        key,
        [
          { field: 'title', value: patch.title ?? '', writeOnUpdate: !!patch.title },
          { field: 'summary', value: patch.summary ?? '', writeOnUpdate: !!patch.summary },
        ],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO chapters (story_id, chapter, title, summary) VALUES ($1,$2,$3,$4)
       ON CONFLICT (story_id, chapter) DO UPDATE SET
         title = COALESCE(NULLIF(EXCLUDED.title,''), chapters.title),
         summary = COALESCE(NULLIF(EXCLUDED.summary,''), chapters.summary)`,
      [this.storyId, chapter, patch.title ?? '', patch.summary ?? ''],
    );
  }

  async chapter(chapter: number): Promise<{ chapter: number; title: string; summary: string } | undefined> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{ chapter: number; title: string; summary: string }>(
      `SELECT chapter, title, summary FROM chapters WHERE story_id = $1 AND chapter = $2`,
      [this.storyId, chapter],
    );
    if (!rows[0] || !key) return rows[0];
    const values = await this.encryptedValues('chapters', [String(chapter)], ['title', 'summary'], key);
    return {
      chapter: rows[0].chapter,
      title: ChronicleStore.stringValue(values.get(String(chapter))!.get('title'), 'chapters.title'),
      summary: ChronicleStore.stringValue(values.get(String(chapter))!.get('summary'), 'chapters.summary'),
    };
  }

  async chapters(): Promise<Array<{ chapter: number; title: string; summary: string }>> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{ chapter: number; title: string; summary: string }>(
      `SELECT chapter, title, summary FROM chapters WHERE story_id = $1 ORDER BY chapter`,
      [this.storyId],
    );
    if (!key) return rows;
    const values = await this.encryptedValues(
      'chapters',
      rows.map((row) => String(row.chapter)),
      ['title', 'summary'],
      key,
    );
    return rows.map((row) => {
      const privateValues = values.get(String(row.chapter))!;
      return {
        chapter: row.chapter,
        title: ChronicleStore.stringValue(privateValues.get('title'), 'chapters.title'),
        summary: ChronicleStore.stringValue(privateValues.get('summary'), 'chapters.summary'),
      };
    });
  }

  // ----------------------------------------------------------------- meta
  // World-level, and now explicitly per world rather than per file — see this
  // file's header for why a global key was wrong once a story could read two
  // worlds.

  /**
   * Thrown rather than defaulted: writing world identity to a guessed world is
   * how `worldTitle` ended up describing the wrong world in the SQLite data
   * (`star-trek-alpha-beta` carries the title "Saint Verrow" to this day).
   */
  private requireWorld(): number {
    if (this.worldId === undefined) {
      throw new Error(
        `no world for story ${this.storyId}: world-level meta needs a target world (pass worldId, or use worlds.title for identity)`,
      );
    }
    return this.worldId;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO world_meta (world_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (world_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.requireWorld(), key, value],
    );
  }

  async getMeta(key: string, fallback = ''): Promise<string> {
    if (this.worldId === undefined) return fallback;
    const { rows } = await this.db.query<{ value: string }>(
      `SELECT value FROM world_meta WHERE world_id = $1 AND key = $2`,
      [this.worldId, key],
    );
    return rows[0]?.value ?? fallback;
  }

  // ---------------------------------------------------------------- facts

  async addFact(text: string, scene: number): Promise<Fact> {
    const id = `fact:${randomUUID()}`;
    const key = await this.privateKey();
    if (key) {
      await this.writePrivateValues(
        `INSERT INTO facts (id, story_id, text, scene) VALUES ($1,$2,'',$3) RETURNING true AS inserted`,
        [id, this.storyId, scene],
        'facts',
        id,
        key,
        [{ field: 'text', value: text }],
      );
      return { id, text, scene, layer: 'chronicle' };
    }
    await this.db.query(`INSERT INTO facts (id, story_id, text, scene) VALUES ($1,$2,$3,$4)`, [
      id,
      this.storyId,
      text,
      scene,
    ]);
    return { id, text, scene, layer: 'chronicle' };
  }

  async facts(limit = 200): Promise<Fact[]> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{ id: string; text: string; scene: number }>(
      `SELECT id, text, scene FROM facts WHERE story_id = $1 ORDER BY scene DESC LIMIT $2`,
      [this.storyId, limit],
    );
    if (!key) return rows.map((r) => ({ ...r, layer: 'chronicle' as const }));
    const values = await this.encryptedValues(
      'facts',
      rows.map((row) => row.id),
      ['text'],
      key,
    );
    return rows.map((row) => ({
      ...row,
      text: ChronicleStore.stringValue(values.get(row.id)!.get('text'), 'facts.text'),
      layer: 'chronicle' as const,
    }));
  }

  /**
   * Records that an entity knows, suspects, or holds a distorted version of a
   * fact. Distortion rises with transmission hops (DESIGN §6.3).
   *
   * Not scoped by story_id directly — it inherits scope through `fact_id`, which
   * is already story-scoped via `facts`, and now enforced by a real foreign key
   * rather than by convention.
   *
   * `LEAST` on conflict, so learning a fact more directly can only *reduce*
   * distortion: hearing something first-hand after a rumour corrects the rumour,
   * it does not re-muddy it.
   */
  async setKnowledge(
    factId: FactId,
    entityId: EntityId,
    level: KnowledgeLevel,
    scene: number,
    distortion = 0,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fact_id, entity_id) DO UPDATE SET
         level = EXCLUDED.level,
         distortion = LEAST(fact_knowledge.distortion, EXCLUDED.distortion)`,
      [factId, entityId, level, scene, distortion],
    );
  }

  async knowledgeOf(entityId: EntityId): Promise<Array<FactKnowledge & { text: string }>> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{
      fact_id: string;
      entity_id: string;
      level: KnowledgeLevel;
      since_scene: number;
      distortion: number;
      text: string;
    }>(
      `SELECT k.fact_id, k.entity_id, k.level, k.since_scene, k.distortion, f.text
         FROM fact_knowledge k JOIN facts f ON f.id = k.fact_id
         WHERE f.story_id = $1 AND k.entity_id = $2
         ORDER BY k.since_scene DESC`,
      [this.storyId, entityId],
    );
    if (!key)
      return rows.map((r) => ({
        factId: r.fact_id,
        entityId: r.entity_id,
        level: r.level,
        sinceScene: r.since_scene,
        distortion: r.distortion,
        text: r.text,
      }));
    const values = await this.encryptedValues(
      'facts',
      rows.map((row) => row.fact_id),
      ['text'],
      key,
    );
    return rows.map((row) => ({
      factId: row.fact_id,
      entityId: row.entity_id,
      level: row.level,
      sinceScene: row.since_scene,
      distortion: row.distortion,
      text: ChronicleStore.stringValue(values.get(row.fact_id)!.get('text'), 'facts.text'),
    }));
  }

  async knowersOf(factId: FactId): Promise<FactKnowledge[]> {
    const { rows } = await this.db.query<{
      fact_id: string;
      entity_id: string;
      level: KnowledgeLevel;
      since_scene: number;
      distortion: number;
    }>(`SELECT fact_id, entity_id, level, since_scene, distortion FROM fact_knowledge WHERE fact_id = $1`, [factId]);
    return rows.map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
      level: r.level,
      sinceScene: r.since_scene,
      distortion: r.distortion,
    }));
  }

  /**
   * The undo of `setKnowledge` — removes the row outright rather than setting a
   * level, so a revoked entity goes back to "never told", not to some fourth
   * level meaning "explicitly does not know". The natural authoring move when
   * the extractor grants knowledge to the wrong NPC (DESIGN §11).
   */
  async revokeKnowledge(factId: FactId, entityId: EntityId): Promise<void> {
    await this.db.query(`DELETE FROM fact_knowledge WHERE fact_id = $1 AND entity_id = $2`, [factId, entityId]);
  }

  async knows(entityId: EntityId, factId: FactId): Promise<boolean> {
    const { rows } = await this.db.query<{ level: string }>(
      `SELECT level FROM fact_knowledge WHERE fact_id = $1 AND entity_id = $2`,
      [factId, entityId],
    );
    return rows[0]?.level === 'knows';
  }

  /**
   * Facts the player character does not know. This is what produces dramatic
   * irony rather than NPCs reacting to information they cannot possess.
   */
  async factsUnknownTo(entityId: EntityId, limit = 20): Promise<Fact[]> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{ id: string; text: string; scene: number }>(
      `SELECT f.id, f.text, f.scene FROM facts f
         WHERE f.story_id = $1 AND NOT EXISTS (
           SELECT 1 FROM fact_knowledge k
            WHERE k.fact_id = f.id AND k.entity_id = $2 AND k.level = 'knows')
         ORDER BY f.scene DESC LIMIT $3`,
      [this.storyId, entityId, limit],
    );
    if (!key) return rows.map((r) => ({ ...r, layer: 'chronicle' as const }));
    const values = await this.encryptedValues(
      'facts',
      rows.map((row) => row.id),
      ['text'],
      key,
    );
    return rows.map((row) => ({
      ...row,
      text: ChronicleStore.stringValue(values.get(row.id)!.get('text'), 'facts.text'),
      layer: 'chronicle' as const,
    }));
  }

  // ----------------------------------------------------------- divergences

  async addDivergence(scene: number, kind: string, detail: string, canon = ''): Promise<void> {
    const key = await this.privateKey();
    if (key) {
      const id = await this.nextSerialId('divergences');
      await this.writePrivateValues(
        `INSERT INTO divergences (id, story_id, scene, kind, detail, canon) VALUES ($1,$2,$3,$4,'','') RETURNING true AS inserted`,
        [id, this.storyId, scene, kind],
        'divergences',
        id,
        key,
        [
          { field: 'detail', value: detail },
          { field: 'canon', value: canon },
        ],
      );
      return;
    }
    await this.db.query(`INSERT INTO divergences (story_id, scene, kind, detail, canon) VALUES ($1,$2,$3,$4,$5)`, [
      this.storyId,
      scene,
      kind,
      detail,
      canon,
    ]);
  }

  async divergences(): Promise<Array<{ id: number; scene: number; kind: string; detail: string; canon: string }>> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{
      id: string;
      scene: number;
      kind: string;
      detail: string;
      canon: string;
    }>(`SELECT id, scene, kind, detail, canon FROM divergences WHERE story_id = $1 ORDER BY scene`, [this.storyId]);
    // BIGSERIAL arrives as a string; callers treat divergence ids as numbers.
    if (!key) return rows.map((r) => ({ ...r, id: Number(r.id) }));
    const values = await this.encryptedValues(
      'divergences',
      rows.map((row) => row.id),
      ['detail', 'canon'],
      key,
    );
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      detail: ChronicleStore.stringValue(values.get(row.id)!.get('detail'), 'divergences.detail'),
      canon: ChronicleStore.stringValue(values.get(row.id)!.get('canon'), 'divergences.canon'),
    }));
  }

  // --------------------------------------------------------- style anchors

  async addAnchor(text: string, note = '', scene = 0): Promise<void> {
    const key = await this.privateKey();
    if (key) {
      const id = await this.nextSerialId('style_anchors');
      await this.writePrivateValues(
        `INSERT INTO style_anchors (id, story_id, text, note, scene) VALUES ($1,$2,'','',$3) RETURNING true AS inserted`,
        [id, this.storyId, scene],
        'style_anchors',
        id,
        key,
        [
          { field: 'text', value: text },
          { field: 'note', value: note },
        ],
      );
      return;
    }
    await this.db.query(`INSERT INTO style_anchors (story_id, text, note, scene) VALUES ($1,$2,$3,$4)`, [
      this.storyId,
      text,
      note,
      scene,
    ]);
  }

  async anchors(limit = 5): Promise<Array<{ id: number; text: string; note: string; scene: number }>> {
    const key = await this.privateKey();
    const { rows } = await this.db.query<{ id: string; text: string; note: string; scene: number }>(
      `SELECT id, text, note, scene FROM style_anchors WHERE story_id = $1 ORDER BY id DESC LIMIT $2`,
      [this.storyId, limit],
    );
    if (!key) return rows.map((r) => ({ ...r, id: Number(r.id) }));
    const values = await this.encryptedValues(
      'style_anchors',
      rows.map((row) => row.id),
      ['text', 'note'],
      key,
    );
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      text: ChronicleStore.stringValue(values.get(row.id)!.get('text'), 'style_anchors.text'),
      note: ChronicleStore.stringValue(values.get(row.id)!.get('note'), 'style_anchors.note'),
    }));
  }

  private async nextSerialId(table: 'divergences' | 'style_anchors'): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT nextval(pg_get_serial_sequence($1, 'id'))::text AS id`,
      [table],
    );
    if (!rows[0]) throw new Error(`could not allocate ${table} id`);
    return rows[0].id;
  }
}
