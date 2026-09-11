/**
 * Illustration store, Postgres: metadata for every generated image, keyed to a
 * turn (a scene render) or an entity (a portrait).
 *
 * Image *bytes* stay on disk under an images directory, not in the database —
 * same reasoning as before: a generated PNG is tens to hundreds of KB, hundreds
 * of scenes would bloat the table, and nothing about an image benefits from
 * being inside a transaction the way a delta commit does. For encrypted stories
 * the disk file is an AES-GCM envelope, while the prompt fields use
 * `encrypted_story_values`; the row's `path` remains relative to `imagesDir`.
 *
 * What changed with Postgres: the images directory is no longer per world file.
 * A world used to be a directory (`data/worlds/<slug>/images/`) so a save could
 * move as a unit; now the database is one shared server and the natural home is
 * one library-wide directory. Paths stay relative, so the property that made
 * per-world directories work — a save directory can be moved or archived — still
 * holds for the library as a whole.
 *
 * Story-scoped throughout, so there is no overlay here: an illustration belongs
 * to a playthrough, never to canon.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../db/pg.ts';
import { decryptStoryBytes, decryptStoryValue, encryptStoryBytes, encryptStoryValue } from '../crypto/story-envelope.ts';
import type { ChronicleCrypto } from './chronicle-pg.ts';
import type {
  EntityId,
  Illustration,
  IllustrationId,
  IllustrationStatus,
  IllustrationSubject,
  StoryId,
  VisualStyle,
} from '../domain/types.ts';

type EncryptedValue = { field: string; value: unknown };
type DecryptedValues = Map<string, Map<string, unknown>>;

class IllustrationPrivateValues {
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
    if (!key) throw new Error(`private story ${this.storyId} is locked`);
    if (key.length !== 32) throw new Error('invalid private-story key');
    return Buffer.from(key);
  }

  async write(
    statement: string,
    statementParams: unknown[],
    recordId: string,
    key: Buffer,
    values: EncryptedValue[],
  ): Promise<void> {
    const envelopes = values.map(({ field, value }) => ({
      field,
      ...encryptStoryValue(key, { storyId: this.storyId, table: 'illustrations', recordId, field }, value),
    }));
    const first = statementParams.length;
    const valueParams: unknown[] = [];
    const tuples = envelopes
      .map((envelope, index) => {
        const offset = first + 3 + index * 4;
        valueParams.push(envelope.field, envelope.version, envelope.nonce, envelope.ciphertext);
        return `($${offset}::text,$${offset + 1}::integer,$${offset + 2}::bytea,$${offset + 3}::bytea)`;
      })
      .join(', ');
    await this.db.query(
      `WITH written AS (${statement})
       INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
       SELECT $${first + 1}, 'illustrations', $${first + 2}, value.field_name, value.version, value.nonce, value.ciphertext
         FROM written CROSS JOIN (VALUES ${tuples}) AS value(field_name, version, nonce, ciphertext)
       ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
         version = EXCLUDED.version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [...statementParams, this.storyId, recordId, ...valueParams],
    );
  }

  async read(recordIds: string[], key: Buffer): Promise<DecryptedValues> {
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
        WHERE story_id = $1 AND table_name = 'illustrations'
          AND record_id = ANY($2::text[]) AND field_name IN ('prompt', 'negative_prompt')`,
      [this.storyId, recordIds],
    );
    for (const row of rows) {
      const fields = values.get(row.record_id) ?? new Map<string, unknown>();
      fields.set(
        row.field_name,
        decryptStoryValue(
          key,
          { storyId: this.storyId, table: 'illustrations', recordId: row.record_id, field: row.field_name },
          { version: row.version, nonce: row.nonce, ciphertext: row.ciphertext },
        ),
      );
      values.set(row.record_id, fields);
    }
    for (const recordId of recordIds) {
      for (const field of ['prompt', 'negative_prompt']) {
        if (!values.get(recordId)?.has(field)) throw new Error(`missing encrypted private story value illustrations.${field}`);
      }
    }
    return values;
  }

  string(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new Error(`invalid encrypted private story value ${field}`);
    return value;
  }
}

interface IllustrationRow {
  id: string;
  kind: 'scene' | 'portrait';
  turn_id: string | null;
  entity_id: string | null;
  location_id: string | null;
  visual_style: VisualStyle;
  prompt: string;
  negative_prompt: string;
  seed: string | number | null;
  provider: string;
  status: IllustrationStatus;
  path: string | null;
  error: string | null;
  created_scene: number;
  created_at: Date | string;
}

const COLS =
  'id, kind, turn_id, entity_id, location_id, visual_style, prompt, negative_prompt, seed, provider, status, path, error, created_scene, created_at';

function toIllustration(r: IllustrationRow): Illustration {
  const subject: IllustrationSubject =
    r.kind === 'portrait'
      ? { kind: 'portrait', entityId: r.entity_id ?? '' }
      : { kind: 'scene', turnId: r.turn_id ?? '', locationId: r.location_id };
  return {
    id: r.id,
    subject,
    visualStyle: r.visual_style,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    // BIGINT arrives as a string. A seed is compared and re-sent to an image
    // provider, so it has to be a number again or a "same seed" request silently
    // becomes a different one.
    seed: r.seed === null ? null : Number(r.seed),
    provider: r.provider,
    status: r.status,
    path: r.path,
    error: r.error,
    createdScene: r.created_scene,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

export class IllustrationStore {
  private db: Queryable;
  private storyId: StoryId;
  readonly imagesDir: string;
  private privateValues: IllustrationPrivateValues;

  constructor(db: Queryable, storyId: StoryId, imagesDir = 'data/images', crypto?: ChronicleCrypto) {
    this.db = db;
    this.storyId = storyId;
    this.imagesDir = imagesDir;
    this.privateValues = new IllustrationPrivateValues(db, storyId, crypto);
  }

  /**
   * Reserves a row before the (slow, fallible) generation call, so a page reload
   * during generation shows "pending" rather than nothing.
   */
  async reserve(input: {
    subject: IllustrationSubject;
    visualStyle: VisualStyle;
    prompt: string;
    negativePrompt: string;
    seed: number | null;
    provider: string;
    createdScene: number;
  }): Promise<Illustration> {
    const key = await this.privateValues.key();
    const id: IllustrationId = `illus:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const kind = input.subject.kind;
    const turnId = kind === 'scene' ? input.subject.turnId : null;
    const entityId = kind === 'portrait' ? input.subject.entityId : null;
    const locationId = kind === 'scene' ? input.subject.locationId : null;
    const params = [
      id,
      this.storyId,
      kind,
      turnId,
      entityId,
      locationId,
      input.visualStyle,
      input.seed,
      input.provider,
      input.createdScene,
      createdAt,
    ];
    if (key) {
      await this.privateValues.write(
        `INSERT INTO illustrations
           (id, story_id, kind, turn_id, entity_id, location_id, visual_style, prompt, negative_prompt, seed, provider, status, path, error, created_scene, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'','',$8,$9,'pending',NULL,NULL,$10,$11)
         RETURNING 1`,
        params,
        id,
        key,
        [
          { field: 'prompt', value: input.prompt },
          { field: 'negative_prompt', value: input.negativePrompt },
        ],
      );
    } else {
      await this.db.query(
      `INSERT INTO illustrations
         (id, story_id, kind, turn_id, entity_id, location_id, visual_style, prompt, negative_prompt, seed, provider, status, path, error, created_scene, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',NULL,NULL,$12,$13)`,
        [
          id, this.storyId, kind, turnId, entityId, locationId, input.visualStyle, input.prompt, input.negativePrompt,
          input.seed, input.provider, input.createdScene, createdAt,
        ],
      );
    }
    return {
      id,
      subject: input.subject,
      visualStyle: input.visualStyle,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      seed: input.seed,
      provider: input.provider,
      status: 'pending',
      path: null,
      error: null,
      createdScene: input.createdScene,
      createdAt,
    };
  }

  /**
   * Writes bytes to disk and marks the row done.
   *
   * Disk first, then the row: a row saying `done` with no file behind it renders
   * as a broken image, while a file with no row is merely an orphan that costs
   * disk. Given the two failure modes, the harmless one is preferable.
   */
  async complete(
    id: IllustrationId,
    bytes: Uint8Array,
    mimeType: string,
    seed: number | null,
  ): Promise<Illustration | undefined> {
    const key = await this.privateValues.key();
    if (!(await this.get(id))) return undefined;
    mkdirSync(this.imagesDir, { recursive: true });
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const relPath = `${id.replace(/^illus:/, '')}.${ext}${key ? '.enc' : ''}`;
    const stored = key
      ? encryptStoryBytes(key, { storyId: this.storyId, table: 'illustration_files', recordId: id, field: 'bytes' }, bytes)
      : bytes;
    writeFileSync(join(this.imagesDir, relPath), stored);
    await this.db.query(
      `UPDATE illustrations SET status = 'done', path = $1, seed = $2 WHERE id = $3 AND story_id = $4`,
      [relPath, seed, id, this.storyId],
    );
    return this.get(id);
  }

  async fail(id: IllustrationId, error: string): Promise<Illustration | undefined> {
    await this.privateValues.key();
    await this.db.query(
      `UPDATE illustrations SET status = 'failed', error = $1 WHERE id = $2 AND story_id = $3`,
      [error, id, this.storyId],
    );
    return this.get(id);
  }

  async get(id: IllustrationId): Promise<Illustration | undefined> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE id = $1 AND story_id = $2`,
      [id, this.storyId],
    );
    return (await this.toIllustrations(rows, key))[0];
  }

  /** Absolute path to the image bytes on disk, or null if there are none (yet, or ever). */
  absolutePath(illustration: Illustration): string | null {
    return illustration.path ? join(this.imagesDir, illustration.path) : null;
  }

  /** Reads stored bytes, decrypting an encrypted story file only after key verification. */
  async readBytes(illustration: Illustration): Promise<Buffer | undefined> {
    const key = await this.privateValues.key();
    const path = this.absolutePath(illustration);
    if (!path || !existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    return key
      ? decryptStoryBytes(key, { storyId: this.storyId, table: 'illustration_files', recordId: illustration.id, field: 'bytes' }, bytes)
      : bytes;
  }

  /** Supplies a provider-safe reference without exposing encrypted disk bytes as a plaintext path. */
  async referenceInput(illustration: Illustration): Promise<{ path: string | null; bytes: Uint8Array | null }> {
    const key = await this.privateValues.key();
    if (!key) return { path: this.absolutePath(illustration), bytes: null };
    return { path: null, bytes: await this.readBytes(illustration) ?? null };
  }

  async forTurn(turnId: string): Promise<Illustration[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE story_id = $1 AND kind = 'scene' AND turn_id = $2 ORDER BY created_at`,
      [this.storyId, turnId],
    );
    return this.toIllustrations(rows, key);
  }

  /** Every portrait for this entity, newest first — the gallery a regenerate flow picks from. */
  async forEntity(entityId: EntityId): Promise<Illustration[]> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE story_id = $1 AND kind = 'portrait' AND entity_id = $2 ORDER BY created_at DESC`,
      [this.storyId, entityId],
    );
    return this.toIllustrations(rows, key);
  }

  /**
   * The current reference for an entity: the latest completed portrait. What
   * `Appearance.referenceImagePath` gets set to, and the character-consistency
   * anchor every later prompt for that entity is conditioned on.
   *
   * Filtered in SQL rather than by scanning `forEntity`: a long campaign
   * accumulates failed and pending rows, and fetching them all to find the first
   * `done` one gets slower the more generation has been retried.
   */
  async latestPortrait(entityId: EntityId): Promise<Illustration | undefined> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations
         WHERE story_id = $1 AND kind = 'portrait' AND entity_id = $2 AND status = 'done'
         ORDER BY created_at DESC LIMIT 1`,
      [this.storyId, entityId],
    );
    return (await this.toIllustrations(rows, key))[0];
  }

  /**
   * A location's most recent scene image, for place consistency — the same
   * treatment `latestPortrait` gives a character, applied to `locationId` across
   * every turn's scene row rather than one entity's portrait rows.
   */
  async latestLocationReference(locationId: EntityId): Promise<Illustration | undefined> {
    const key = await this.privateValues.key();
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations
         WHERE story_id = $1 AND kind = 'scene' AND location_id = $2 AND status = 'done'
         ORDER BY created_at DESC LIMIT 1`,
      [this.storyId, locationId],
    );
    return (await this.toIllustrations(rows, key))[0];
  }

  /** Deletes the row and its bytes together, so a retried generation cannot leak an orphaned file. */
  async delete(id: IllustrationId): Promise<void> {
    await this.privateValues.key();
    const illus = await this.get(id);
    if (illus?.path) {
      const abs = this.absolutePath(illus);
      if (abs && existsSync(abs)) unlinkSync(abs);
    }
    await this.db.query(`DELETE FROM illustrations WHERE id = $1 AND story_id = $2`, [id, this.storyId]);
    await this.db.query(
      `DELETE FROM encrypted_story_values WHERE story_id = $1 AND table_name = 'illustrations' AND record_id = $2`,
      [this.storyId, id],
    );
  }

  private async toIllustrations(rows: IllustrationRow[], key: Buffer | null): Promise<Illustration[]> {
    if (!rows.length || !key) return rows.map(toIllustration);
    const values = await this.privateValues.read(rows.map((row) => row.id), key);
    return rows.map((row) => {
      const fields = values.get(row.id)!;
      return toIllustration({
        ...row,
        prompt: this.privateValues.string(fields.get('prompt'), 'illustrations.prompt'),
        negative_prompt: this.privateValues.string(fields.get('negative_prompt'), 'illustrations.negative_prompt'),
      });
    });
  }
}
