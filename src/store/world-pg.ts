/**
 * Threads, consequences, directives, and story state — Postgres.
 *
 * Threads exist instead of a plot: a plot breaks when the player deviates, a
 * thread just gets re-aimed (DESIGN §2). Consequences are a propagation queue
 * rather than a world simulation (DESIGN §6.1).
 *
 * Every table here is story-scoped, so like `chronicle-pg.ts` there is no
 * overlay to resolve and the conversion is dialect-only. Two stories in the same
 * world never share a thread, a consequence, a directive, or session state, even
 * when they diverge from the same canon — and that is now enforced by real
 * foreign keys with ON DELETE CASCADE rather than by every query remembering to
 * filter, which is what lets `deleteStory` be one statement instead of the
 * hand-maintained 17-table sweep that twice went stale.
 */
import { randomUUID } from 'node:crypto';
import { decryptStoryValue, encryptStoryValue } from '../crypto/story-envelope.ts';
import { jsonGet, type Queryable } from '../db/pg.ts';
import { PrivateStoryLockedError } from './private-story-access.ts';
import type { ChronicleCrypto } from './chronicle-pg.ts';
import {
  defaultKnobs,
  defaultStyleContract,
  type Consequence,
  type ConsequenceId,
  type Directive,
  type EntityId,
  type Knobs,
  type Maturity,
  type SessionState,
  type Story,
  type StoryId,
  type StyleContract,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type Trigger,
  type Visibility,
} from '../domain/types.ts';

type EncryptedValue = { field: string; value: unknown };
type DecryptedValues = Map<string, Map<string, unknown>>;

/**
 * Private-value access shared by the story-owned stores in this file. The
 * encryption version remains database-authoritative so a missing capability
 * cannot downgrade a verified encrypted story to plaintext.
 */
class StoryPrivateValues {
  private encryptionVersion: number | undefined;
  private db: Queryable;
  private storyId: StoryId;
  private crypto: ChronicleCrypto | undefined;

  constructor(db: Queryable, storyId: StoryId, crypto: ChronicleCrypto | undefined) {
    this.db = db;
    this.storyId = storyId;
    this.crypto = crypto;
  }

  async key(): Promise<Buffer | null> {
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

  async write(
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
        const offset = first + 4 + index * 4;
        valueParams.push(envelope.field, envelope.version, envelope.nonce, envelope.ciphertext);
        return `($${offset}::text,$${offset + 1}::integer,$${offset + 2}::bytea,$${offset + 3}::bytea)`;
      })
      .join(', ');
    await this.db.query(
      `WITH written AS (${statement})
       INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
       SELECT $${first + 1}, $${first + 2}, $${first + 3}, value.field_name, value.version, value.nonce, value.ciphertext
         FROM written CROSS JOIN (VALUES ${tuples}) AS value(field_name, version, nonce, ciphertext)
       ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
         version = EXCLUDED.version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [...statementParams, this.storyId, table, recordId, ...valueParams],
    );
  }

  async read(table: string, recordIds: string[], fields: string[], key: Buffer): Promise<DecryptedValues> {
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
        if (!values.get(recordId)?.has(field)) throw new Error(`missing encrypted private story value ${table}.${field}`);
      }
    }
    return values;
  }

  string(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new Error(`invalid encrypted private story value ${field}`);
    return value;
  }
}

// ------------------------------------------------------------------ threads

interface ThreadRow {
  id: string;
  title: string;
  stakes: string;
  tension: number;
  parties: unknown;
  resolutions: unknown;
  status: ThreadStatus;
  created_scene: number;
}

const THREAD_COLS = 'id, title, stakes, tension, parties, resolutions, status, created_scene';

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    title: r.title,
    stakes: r.stakes,
    tension: r.tension,
    parties: jsonGet<EntityId[]>(r.parties, []),
    resolutions: jsonGet<string[]>(r.resolutions, []),
    status: r.status,
    createdScene: r.created_scene,
  };
}

export class ThreadStore {
  private db: Queryable;
  private storyId: StoryId;
  private privateValues: StoryPrivateValues;

  constructor(db: Queryable, storyId: StoryId, crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.privateValues = new StoryPrivateValues(db, storyId, crypto);
  }

  async create(t: Omit<Thread, 'id'> & { id?: ThreadId }): Promise<Thread> {
    const id = t.id ?? `thread:${randomUUID()}`;
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `INSERT INTO threads (id, story_id, title, stakes, tension, parties, resolutions, status, created_scene)
         VALUES ($1,$2,'','',$3,'[]'::jsonb,'[]'::jsonb,$4,$5) RETURNING 1`,
        [id, this.storyId, t.tension, t.status, t.createdScene],
        'threads',
        id,
        key,
        [
          { field: 'title', value: t.title },
          { field: 'stakes', value: t.stakes },
          { field: 'parties', value: t.parties },
          { field: 'resolutions', value: t.resolutions },
        ],
      );
      return { ...t, id };
    }
    await this.db.query(
      `INSERT INTO threads (id, story_id, title, stakes, tension, parties, resolutions, status, created_scene)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
      [
        id,
        this.storyId,
        t.title,
        t.stakes,
        t.tension,
        JSON.stringify(t.parties),
        JSON.stringify(t.resolutions),
        t.status,
        t.createdScene,
      ],
    );
    return { ...t, id };
  }

  async get(id: ThreadId): Promise<Thread | undefined> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLS} FROM threads WHERE id = $1 AND story_id = $2`,
      [id, this.storyId],
    );
    return rows[0] ? (await this.toThreads(rows, key))[0] : undefined;
  }

  /** Open threads ranked by tension: the Director's menu. */
  async open(limit = 12): Promise<Thread[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLS} FROM threads WHERE story_id = $1 AND status = 'open' ORDER BY tension DESC LIMIT $2`,
      [this.storyId, limit],
    );
    return this.toThreads(rows, key);
  }

  async all(): Promise<Thread[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLS} FROM threads WHERE story_id = $1 ORDER BY tension DESC`,
      [this.storyId],
    );
    return this.toThreads(rows, key);
  }

  async update(id: ThreadId, patch: Partial<Omit<Thread, 'id'>>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `UPDATE threads SET title='', stakes='', tension=$1, parties='[]'::jsonb, resolutions='[]'::jsonb, status=$2
           WHERE id=$3 AND story_id=$4 RETURNING 1`,
        [Math.max(0, Math.min(1, next.tension)), next.status, id, this.storyId],
        'threads',
        id,
        key,
        [
          { field: 'title', value: next.title },
          { field: 'stakes', value: next.stakes },
          { field: 'parties', value: next.parties },
          { field: 'resolutions', value: next.resolutions },
        ],
      );
      return;
    }
    await this.db.query(
      `UPDATE threads SET title=$1, stakes=$2, tension=$3, parties=$4::jsonb, resolutions=$5::jsonb, status=$6
         WHERE id=$7 AND story_id=$8`,
      [
        next.title,
        next.stakes,
        Math.max(0, Math.min(1, next.tension)),
        JSON.stringify(next.parties),
        JSON.stringify(next.resolutions),
        next.status,
        id,
        this.storyId,
      ],
    );
  }

  async adjustTension(id: ThreadId, delta: number): Promise<void> {
    const cur = await this.get(id);
    if (!cur) return;
    await this.update(id, { tension: cur.tension + delta });
  }

  private async toThreads(rows: ThreadRow[], key: Buffer | null): Promise<Thread[]> {
    if (!key) return rows.map(toThread);
    const values = await this.privateValues.read(
      'threads',
      rows.map((row) => row.id),
      ['title', 'stakes', 'parties', 'resolutions'],
      key,
    );
    return rows.map((row) => {
      const privateValues = values.get(row.id)!;
      return toThread({
        ...row,
        title: this.privateValues.string(privateValues.get('title'), 'threads.title'),
        stakes: this.privateValues.string(privateValues.get('stakes'), 'threads.stakes'),
        parties: privateValues.get('parties'),
        resolutions: privateValues.get('resolutions'),
      });
    });
  }
}

// ------------------------------------------------------------ consequences

interface ConsequenceRow {
  id: string;
  cause_event_id: string;
  trigger: unknown;
  actor_id: string;
  action: string;
  visibility: Visibility;
  maturity: Maturity;
  depth: number;
  significance: number;
  created_scene: number;
  fired_scene: number | null;
  superseded_by: string | null;
}

const CONS_COLS =
  'id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene, fired_scene, superseded_by';

function toConsequence(r: ConsequenceRow): Consequence {
  return {
    id: r.id,
    causeEventId: r.cause_event_id,
    trigger: jsonGet<Trigger>(r.trigger, { kind: 'immediate' }),
    actorId: r.actor_id,
    action: r.action,
    visibility: r.visibility,
    maturity: r.maturity,
    depth: r.depth,
    significance: r.significance,
    createdScene: r.created_scene,
    firedScene: r.fired_scene,
    supersededBy: r.superseded_by,
  };
}

export class ConsequenceStore {
  private db: Queryable;
  private storyId: StoryId;
  private privateValues: StoryPrivateValues;

  constructor(db: Queryable, storyId: StoryId, crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.privateValues = new StoryPrivateValues(db, storyId, crypto);
  }

  async enqueue(
    c: Omit<Consequence, 'id' | 'firedScene' | 'supersededBy'> & { id?: string },
  ): Promise<Consequence> {
    const id = c.id ?? `cons:${randomUUID()}`;
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `INSERT INTO consequences
           (id, story_id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene, fired_scene, superseded_by)
         VALUES ($1,$2,$3,'{}'::jsonb,$4,'',$5,$6,$7,$8,$9,NULL,NULL) RETURNING 1`,
        [
          id,
          this.storyId,
          c.causeEventId,
          c.actorId,
          c.visibility,
          c.maturity,
          c.depth,
          c.significance,
          c.createdScene,
        ],
        'consequences',
        id,
        key,
        [
          { field: 'trigger', value: c.trigger },
          { field: 'action', value: c.action },
        ],
      );
      return { ...c, id, firedScene: null, supersededBy: null };
    }
    await this.db.query(
      `INSERT INTO consequences
         (id, story_id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene, fired_scene, superseded_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,NULL,NULL)`,
      [
        id,
        this.storyId,
        c.causeEventId,
        JSON.stringify(c.trigger),
        c.actorId,
        c.action,
        c.visibility,
        c.maturity,
        c.depth,
        c.significance,
        c.createdScene,
      ],
    );
    return { ...c, id, firedScene: null, supersededBy: null };
  }

  async get(id: ConsequenceId): Promise<Consequence | undefined> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ConsequenceRow>(
      `SELECT ${CONS_COLS} FROM consequences WHERE id = $1 AND story_id = $2`,
      [id, this.storyId],
    );
    return rows[0] ? (await this.toConsequences(rows, key))[0] : undefined;
  }

  async pending(): Promise<Consequence[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ConsequenceRow>(
      `SELECT ${CONS_COLS} FROM consequences WHERE story_id = $1 AND maturity IN ('pending','ripening') ORDER BY created_scene`,
      [this.storyId],
    );
    return this.toConsequences(rows, key);
  }

  async all(limit = 500): Promise<Consequence[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ConsequenceRow>(
      `SELECT ${CONS_COLS} FROM consequences WHERE story_id = $1 ORDER BY created_scene DESC LIMIT $2`,
      [this.storyId, limit],
    );
    return this.toConsequences(rows, key);
  }

  async byCause(eventId: string): Promise<Consequence[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<ConsequenceRow>(
      `SELECT ${CONS_COLS} FROM consequences WHERE cause_event_id = $1 AND story_id = $2`,
      [eventId, this.storyId],
    );
    return this.toConsequences(rows, key);
  }

  async setMaturity(id: ConsequenceId, maturity: Maturity, scene?: number): Promise<void> {
    await this.privateValues.key();
    if (maturity === 'fired') {
      await this.db.query(
        `UPDATE consequences SET maturity = $1, fired_scene = $2 WHERE id = $3 AND story_id = $4`,
        [maturity, scene ?? null, id, this.storyId],
      );
      return;
    }
    await this.db.query(`UPDATE consequences SET maturity = $1 WHERE id = $2 AND story_id = $3`, [
      maturity,
      id,
      this.storyId,
    ]);
  }

  async supersede(id: ConsequenceId, by: string): Promise<void> {
    await this.privateValues.key();
    await this.db.query(
      `UPDATE consequences SET maturity = 'superseded', superseded_by = $1 WHERE id = $2 AND story_id = $3`,
      [by, id, this.storyId],
    );
  }

  async retime(id: ConsequenceId, trigger: Trigger): Promise<void> {
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `UPDATE consequences SET trigger = '{}'::jsonb WHERE id = $1 AND story_id = $2 RETURNING 1`,
        [id, this.storyId],
        'consequences',
        id,
        key,
        [{ field: 'trigger', value: trigger }],
      );
      return;
    }
    await this.db.query(`UPDATE consequences SET trigger = $1::jsonb WHERE id = $2 AND story_id = $3`, [
      JSON.stringify(trigger),
      id,
      this.storyId,
    ]);
  }

  /** How much has matured unseen; drives the ignorance budget (DESIGN §6.5). */
  async hiddenFiredCount(): Promise<number> {
    await this.privateValues.key();
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT COUNT(*) n FROM consequences WHERE story_id = $1 AND maturity = 'fired' AND visibility <> 'onscreen'`,
      [this.storyId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async toConsequences(rows: ConsequenceRow[], key: Buffer | null): Promise<Consequence[]> {
    if (!key) return rows.map(toConsequence);
    const values = await this.privateValues.read(
      'consequences',
      rows.map((row) => row.id),
      ['trigger', 'action'],
      key,
    );
    return rows.map((row) => {
      const privateValues = values.get(row.id)!;
      return toConsequence({
        ...row,
        trigger: privateValues.get('trigger'),
        action: this.privateValues.string(privateValues.get('action'), 'consequences.action'),
      });
    });
  }
}

// -------------------------------------------------------------- directives

interface DirectiveRow {
  id: string;
  text: string;
  scope: Directive['scope'];
  strength: Directive['strength'];
  lifetime_scenes: number | null;
  status: Directive['status'];
  created_scene: number;
}

function toDirective(r: DirectiveRow): Directive {
  return {
    id: r.id,
    text: r.text,
    scope: r.scope,
    strength: r.strength,
    lifetimeScenes: r.lifetime_scenes,
    status: r.status,
    createdScene: r.created_scene,
  };
}

export class DirectiveStore {
  private db: Queryable;
  private storyId: StoryId;
  private privateValues: StoryPrivateValues;

  constructor(db: Queryable, storyId: StoryId, crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.privateValues = new StoryPrivateValues(db, storyId, crypto);
  }

  async create(d: Omit<Directive, 'id'> & { id?: string }): Promise<Directive> {
    const id = d.id ?? `dir:${randomUUID()}`;
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `INSERT INTO directives (id, story_id, text, scope, strength, lifetime_scenes, status, created_scene)
         VALUES ($1,$2,'',$3,$4,$5,$6,$7) RETURNING 1`,
        [id, this.storyId, d.scope, d.strength, d.lifetimeScenes, d.status, d.createdScene],
        'directives',
        id,
        key,
        [{ field: 'text', value: d.text }],
      );
      return { ...d, id };
    }
    await this.db.query(
      `INSERT INTO directives (id, story_id, text, scope, strength, lifetime_scenes, status, created_scene)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, this.storyId, d.text, d.scope, d.strength, d.lifetimeScenes, d.status, d.createdScene],
    );
    return { ...d, id };
  }

  async active(): Promise<Directive[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<DirectiveRow>(
      `SELECT id, text, scope, strength, lifetime_scenes, status, created_scene
         FROM directives WHERE story_id = $1 AND status = 'active' ORDER BY created_scene DESC`,
      [this.storyId],
    );
    if (!key) return rows.map(toDirective);
    const values = await this.privateValues.read('directives', rows.map((row) => row.id), ['text'], key);
    return rows.map((row) =>
      toDirective({
        ...row,
        text: this.privateValues.string(values.get(row.id)!.get('text'), 'directives.text'),
      }),
    );
  }

  async setStatus(id: string, status: Directive['status']): Promise<void> {
    await this.privateValues.key();
    await this.db.query(`UPDATE directives SET status = $1 WHERE id = $2 AND story_id = $3`, [
      status,
      id,
      this.storyId,
    ]);
  }

  /**
   * Expire directives whose lifetime has run out, so stale steering decays.
   *
   * One statement with RETURNING rather than select-then-loop: the SQLite version
   * read the ids and then issued an UPDATE per id, which is N+1 round trips over
   * a network connection where it was N+1 function calls in-process.
   */
  async expire(scene: number): Promise<string[]> {
    await this.privateValues.key();
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE directives SET status = 'retired'
         WHERE story_id = $1 AND status = 'active' AND lifetime_scenes IS NOT NULL
           AND created_scene + lifetime_scenes <= $2
       RETURNING id`,
      [this.storyId, scene],
    );
    return rows.map((r) => r.id);
  }
}

// ------------------------------------------------------------------ stories

interface StoryRow {
  id: string;
  title: string;
  scene: number;
  turn: number;
  player_character_id: string;
  current_location_id: string | null;
  style: unknown;
  knobs: unknown;
  forked_from: string | null;
  forked_at_scene: number | null;
  created_at: Date | string;
  last_played_at: Date | string;
  encryption_version: number;
  owner_user_id: string | null;
}

const STORY_COLS =
  'id, title, scene, turn, player_character_id, current_location_id, style, knobs, forked_from, forked_at_scene, created_at, last_played_at, encryption_version, owner_user_id';

function isoOf(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function toStory(r: StoryRow): Story {
  return {
    id: r.id,
    title: r.title,
    scene: r.scene,
    turn: r.turn,
    playerCharacterId: r.player_character_id,
    currentLocationId: r.current_location_id,
    style: { ...defaultStyleContract(), ...jsonGet<Partial<StyleContract>>(r.style, {}) },
    knobs: { ...defaultKnobs(), ...jsonGet<Partial<Knobs>>(r.knobs, {}) },
    forkedFrom: r.forked_from,
    forkedAtScene: r.forked_at_scene,
    createdAt: isoOf(r.created_at),
    lastPlayedAt: isoOf(r.last_played_at),
    encryptionVersion: r.encryption_version,
    ownerUserId: r.owner_user_id,
  };
}

function toSession(story: Story): SessionState {
  return {
    scene: story.scene,
    turn: story.turn,
    playerCharacterId: story.playerCharacterId,
    currentLocationId: story.currentLocationId,
    style: story.style,
    knobs: story.knobs,
  };
}

/** Every story, most recently played first. Used by the save browser. */
/**
 * `NULLS LAST` is defensive, not a fix.
 *
 * `ORDER BY last_played_at DESC` puts NULLs first in Postgres and last in SQLite, and I
 * initially blamed that for the wrong-default bug. It cannot be the cause — the column is
 * `NOT NULL DEFAULT now()`, so a NULL never occurs — and the real cause was that the
 * default therefore makes "most recently played" mean "most recently created" until
 * someone plays (see `resolveOrCreateStoryForUser`). Kept because the clause states the
 * intent explicitly and costs nothing, so a future migration that drops the NOT NULL
 * cannot silently invert the order.
 */
export async function listStories(db: Queryable): Promise<Story[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT ${STORY_COLS} FROM stories ORDER BY last_played_at DESC NULLS LAST, created_at DESC`,
  );
  return rows.map(toStory);
}

/** Stories reading a given world — the per-world analogue of `listStories`. */
export async function listStoriesInWorld(db: Queryable, worldId: number): Promise<Story[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT ${STORY_COLS.split(', ').map((c) => `s.${c}`).join(', ')} FROM stories s
       JOIN story_sources ss ON ss.story_id = s.id
      WHERE ss.world_id = $1
      ORDER BY s.last_played_at DESC, s.created_at DESC`,
    [worldId],
  );
  return rows.map(toStory);
}

/**
 * Every story owned by one user, most recently played first.
 *
 * A story with `owner_user_id IS NULL` is never returned: null means unowned,
 * not "owned by everyone" — silently attributing a stranger's old local save to
 * whoever logs in first would be a real privacy bug, not a convenience.
 */
export async function listStoriesForUser(db: Queryable, ownerUserId: string): Promise<Story[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT ${STORY_COLS} FROM stories WHERE owner_user_id = $1 ORDER BY last_played_at DESC NULLS LAST, created_at DESC`,
    [ownerUserId],
  );
  return rows.map(toStory);
}

/**
 * Story-library projection with private titles restored under the caller's
 * process-local key grants. The ordinary list remains available to routing
 * code that only needs stable IDs and ordering.
 */
export async function listStoriesForUserWithPrivateValues(
  db: Queryable,
  ownerUserId: string,
  crypto: ChronicleCrypto,
): Promise<Story[]> {
  const stories = await listStoriesForUser(db, ownerUserId);
  return Promise.all(
    stories.map((story) =>
      story.encryptionVersion === 1 ? new StoryStore(db, story.id, crypto).info() : Promise.resolve(story),
    ),
  );
}

/**
 * Stories with no owner, for the "claim your imported books" flow.
 *
 * Imported SQLite saves arrive with `owner_user_id` NULL, because they predate login
 * and attributing them automatically would hand a stranger's writing to whoever signs
 * in first. But NULL never matches `owner_user_id = $1`, so on a logged-in instance
 * they became *invisible* — 13 imported books present in the database and absent from
 * the library, which is how this was noticed.
 *
 * Listing them separately is the honest middle: the owner can see that unclaimed work
 * exists and adopt it deliberately, and nothing is attributed behind their back.
 */
export async function listUnownedStories(db: Queryable): Promise<Story[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT ${STORY_COLS} FROM stories WHERE owner_user_id IS NULL ORDER BY last_played_at DESC NULLS LAST, created_at DESC`,
  );
  return rows.map(toStory);
}

/**
 * Takes ownership of the unowned stories, all of them or one by one.
 *
 * `owner_user_id IS NULL` in the WHERE clause is the safety: this can only ever claim
 * work nobody owns, so it cannot transfer a story between users even if called with a
 * wrong id.
 */
export async function claimUnownedStories(db: Queryable, ownerUserId: string, storyId?: StoryId): Promise<number> {
  const { rowCount } = storyId
    ? await db.query(`UPDATE stories SET owner_user_id = $1 WHERE id = $2 AND owner_user_id IS NULL`, [
        ownerUserId,
        storyId,
      ])
    : await db.query(`UPDATE stories SET owner_user_id = $1 WHERE owner_user_id IS NULL`, [ownerUserId]);
  return rowCount ?? 0;
}

export async function getStory(db: Queryable, id: StoryId): Promise<Story | undefined> {
  const { rows } = await db.query<StoryRow>(`SELECT ${STORY_COLS} FROM stories WHERE id = $1`, [id]);
  return rows[0] ? toStory(rows[0]) : undefined;
}

/**
 * Creates a fresh story against one or more canon worlds — the "non-overlapping
 * new story in an existing world" case, and the entry point for a crossover.
 * No chronicle is copied; the story starts exactly like a brand-new ingest
 * would, minus re-ingesting.
 *
 * `worldIds` in order becomes `story_sources.ordinal`, which is the precedence
 * the overlay resolves by. An empty list is allowed (a story with no canon at
 * all is what the wizard creates before choosing a world) but then no canon
 * write can be targeted — see `GraphStore.requireCanonWorld`.
 *
 * `ownerUserId` omitted writes NULL — the login-off path, and any internal
 * caller with no session user in scope. Never inferred here; the caller (a route
 * with an already-verified SessionUser, or nothing) is the only place that knows.
 *
 * `encryptionVersion` controls storage format for this story only. `0` is the
 * legacy plaintext shape; `1` is reserved for a verified encrypted-at-rest
 * row and must not be selected merely because a user joined the pilot.
 */
export async function createStory(
  db: Queryable,
  opts: {
    title?: string;
    worldIds?: number[];
    forkedFrom?: StoryId;
    forkedAtScene?: number;
    ownerUserId?: string;
    encryptionVersion?: number;
  } = {},
): Promise<Story> {
  const id = `story:${randomUUID()}`;
  await db.query(
    `INSERT INTO stories
       (id, title, scene, turn, player_character_id, current_location_id, style, knobs,
        forked_from, forked_at_scene, owner_user_id, encryption_version)
     VALUES ($1,$2,1,0,'',NULL,'{}'::jsonb,'{}'::jsonb,$3,$4,$5,$6)`,
    [id, opts.title ?? '', opts.forkedFrom ?? null, opts.forkedAtScene ?? null, opts.ownerUserId ?? null, opts.encryptionVersion ?? 0],
  );

  for (const [i, worldId] of (opts.worldIds ?? []).entries()) {
    await db.query(`INSERT INTO story_sources (story_id, world_id, ordinal) VALUES ($1,$2,$3)`, [
      id,
      worldId,
      i + 1,
    ]);
  }

  // Scene 1 exists from the moment the story does.
  //
  // The `stories` row already says `scene = 1`, so every other part of the app
  // believes scene 1 is open; without a matching `scenes` row the chronicle
  // disagreed, and `GET /api/book` / `GET /api/state` reported zero scenes for a
  // story demonstrably in one. Only the wizard, the packs and the sample seed
  // called `upsertScene(1, ...)` afterwards, so every other creation path — a
  // plain new story, `create_story` over MCP, a fork, a per-user auto-resolve —
  // produced a book the UI could only render as "untitled, 0 scenes" for its
  // entire life.
  //
  // Done here rather than in each caller because "a story has a scene 1" is a
  // property of a story existing, not of who asked for it.
  await db.query(
    `INSERT INTO scenes (story_id, scene, title, summary, location_id, chapter)
     VALUES ($1, 1, '', '', NULL, 1) ON CONFLICT (story_id, scene) DO NOTHING`,
    [id],
  );

  return (await getStory(db, id))!;
}

/**
 * Deletes one story and everything scoped to it.
 *
 * One statement: every story-scoped table declares
 * `REFERENCES stories(id) ON DELETE CASCADE`, so the database does the sweep.
 * This is the direct replacement for `SetupService.reset()`'s hand-maintained
 * table list, which silently omitted `illustrations` and then `stories` — both
 * found by the integrity checker rather than by review. A table added later is
 * covered automatically.
 *
 * Canon is never touched: it has no `story_id` to cascade from.
 *
 * Unlike the SQLite version this does *not* refuse to delete the last story.
 * That guard existed because a world file needed at least one story to open
 * into; a Postgres database has no such constraint, and a library with zero
 * stories is an ordinary empty state.
 */
export async function deleteStory(db: Queryable, storyId: StoryId): Promise<void> {
  const { rowCount } = await db.query(`DELETE FROM stories WHERE id = $1`, [storyId]);
  if (!rowCount) throw new Error(`no story ${storyId}`);
}

/**
 * The per-user "which story am I in" resolution, called on every request once a
 * session user is known.
 *
 * Deliberately not an error when several stories exist for this user: that is
 * the ordinary case (anyone who has forked or started a second story), not a
 * configuration problem needing a human to disambiguate. Picks the most
 * recently played; a caller wanting a specific other story passes its id.
 */
export async function resolveOrCreateStoryForUser(
  db: Queryable,
  ownerUserId: string,
  worldIds: number[] = [],
  /** Storage format for a newly auto-created story when this user owns none yet. */
  encryptionVersion = 0,
): Promise<StoryId> {
  const existing = await listStoriesForUser(db, ownerUserId);
  if (existing.length > 0) {
    // Prefer a book that has actually been written in.
    //
    // `last_played_at` is `NOT NULL DEFAULT now()`, so "most recently played" is really
    // "most recently created" until someone plays — and every failed boot during the
    // Postgres migration created a blank story here (this function makes one when the
    // user owns none, and the imported books were unowned at the time). Those blanks were
    // newer than the real book and won the default, so the session landed on a story that
    // sourced no world: setup wizard, empty cast, on an instance holding a played book
    // and 33,000 canon entities.
    //
    // Turn count is the honest signal. A timestamp default can make an empty story look
    // recent; it cannot give it turns. Falls back to the list order when nothing has been
    // played, which is the ordinary first-run case.
    return (existing.find((st) => st.turn > 0) ?? existing[0]!).id;
  }
  // A first book reads whatever canon this instance already has, rather than nothing.
  //
  // With no sources, `graph.isEmpty()` is true — it only counts the worlds a story
  // actually sources — so the UI opened the setup wizard at a new user on an instance
  // holding five populated public worlds, offering to ingest a world from scratch.
  // Reported as "we should show those mass effect, star trek… worlds to anyone": they
  // were public and visible in the library the whole time, but the wizard sat in front
  // of them.
  //
  // Public worlds only, and ordered oldest-first so the default is the instance's
  // primary world rather than whatever was ingested most recently. A caller that knows
  // which worlds it wants still passes them explicitly.
  const seed = worldIds.length ? worldIds : await defaultWorldIds(db);
  return (await createStory(db, { title: '', ownerUserId, worldIds: seed, encryptionVersion })).id;
}

/**
 * The worlds a brand-new story should read when nobody has said which.
 *
 * Public only: a private world is nobody's default, and handing one to a new user is
 * the leak `worldsVisibleTo` exists to prevent. Empty on a genuinely fresh instance,
 * which is the one case where the setup wizard is the right answer.
 */
export async function defaultWorldIds(db: Queryable): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT w.id FROM worlds w
      WHERE w.visibility = 'public'
        AND EXISTS (SELECT 1 FROM canon_entities c WHERE c.world_id = w.id AND c.retired_at_revision IS NULL)
      ORDER BY w.id
      LIMIT 1`,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Where a login-off session lands: the most recently played story, else a fresh
 * one.
 *
 * Never throws on ambiguity. `resolveDefaultStory`'s SQLite ancestor did, and it
 * was fatal at boot: a world with two stories made `CurrentWorld.open` throw
 * during startup, the container crash-looped under `restart: unless-stopped`,
 * and the reverse proxy served 502s. Boot must not depend on a human
 * disambiguating.
 */
export async function resolveCurrentStory(db: Queryable, worldIds: number[] = []): Promise<StoryId> {
  const existing = await listStories(db);
  if (existing.length > 0) return existing[0]!.id;
  // Same default as the per-user path: a first book reads the canon that exists.
  return (await createStory(db, { title: '', worldIds: worldIds.length ? worldIds : await defaultWorldIds(db) })).id;
}

export class StoryStore {
  private db: Queryable;
  private storyId: StoryId;
  private privateValues: StoryPrivateValues;

  constructor(db: Queryable, storyId: StoryId, crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.privateValues = new StoryPrivateValues(db, storyId, crypto);
  }

  id(): StoryId {
    return this.storyId;
  }

  private async require(): Promise<StoryRow> {
    const { rows } = await this.db.query<StoryRow>(`SELECT ${STORY_COLS} FROM stories WHERE id = $1`, [
      this.storyId,
    ]);
    if (!rows[0]) throw new Error(`story ${this.storyId} does not exist`);
    return rows[0];
  }

  async get(): Promise<SessionState> {
    return toSession(await this.story());
  }

  /** Full record, including identity and lineage — what the save browser wants. */
  async info(): Promise<Story> {
    return this.story();
  }

  async set(patch: Partial<SessionState>): Promise<SessionState> {
    const cur = await this.get();
    const next = { ...cur, ...patch };
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `UPDATE stories SET scene=$1, turn=$2, player_character_id='', current_location_id=NULL,
           style='{}'::jsonb, knobs='{}'::jsonb, last_played_at=now() WHERE id=$3 RETURNING 1`,
        [next.scene, next.turn, this.storyId],
        'stories',
        this.storyId,
        key,
        [
          { field: 'player_character_id', value: next.playerCharacterId },
          { field: 'current_location_id', value: next.currentLocationId },
          { field: 'style', value: next.style },
          { field: 'knobs', value: next.knobs },
        ],
      );
      return next;
    }
    await this.db.query(
      `UPDATE stories SET scene=$1, turn=$2, player_character_id=$3, current_location_id=$4,
         style=$5::jsonb, knobs=$6::jsonb, last_played_at=now() WHERE id=$7`,
      [
        next.scene,
        next.turn,
        next.playerCharacterId,
        next.currentLocationId,
        JSON.stringify(next.style),
        JSON.stringify(next.knobs),
        this.storyId,
      ],
    );
    return next;
  }

  async rename(title: string): Promise<void> {
    const key = await this.privateValues.key();
    if (key) {
      await this.privateValues.write(
        `UPDATE stories SET title = '' WHERE id = $1 RETURNING 1`,
        [this.storyId],
        'stories',
        this.storyId,
        key,
        [{ field: 'title', value: title }],
      );
      return;
    }
    await this.db.query(`UPDATE stories SET title = $1 WHERE id = $2`, [title, this.storyId]);
  }

  private async story(): Promise<Story> {
    const key = await this.privateValues.key();
    const row = await this.require();
    if (!key) return toStory(row);
    const values = await this.privateValues.read(
      'stories',
      [this.storyId],
      ['title', 'player_character_id', 'current_location_id', 'style', 'knobs'],
      key,
    );
    const privateValues = values.get(this.storyId)!;
    return toStory({
      ...row,
      title: this.privateValues.string(privateValues.get('title'), 'stories.title'),
      player_character_id: this.privateValues.string(
        privateValues.get('player_character_id'),
        'stories.player_character_id',
      ),
      current_location_id: privateValues.get('current_location_id') as string | null,
      style: privateValues.get('style'),
      knobs: privateValues.get('knobs'),
    });
  }
}
