/**
 * Illustration store, Postgres: metadata for every generated image, keyed to a
 * turn (a scene render) or an entity (a portrait).
 *
 * Image *bytes* stay on disk under an images directory, not in the database —
 * same reasoning as before: a generated PNG is tens to hundreds of KB, hundreds
 * of scenes would bloat the table, and nothing about an image benefits from
 * being inside a transaction the way a delta commit does. The row's `path`
 * column stays relative to `imagesDir`.
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
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../db/pg.ts';
import type {
  EntityId,
  Illustration,
  IllustrationId,
  IllustrationStatus,
  IllustrationSubject,
  StoryId,
  VisualStyle,
} from '../domain/types.ts';

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

  constructor(db: Queryable, storyId: StoryId, imagesDir = 'data/images') {
    this.db = db;
    this.storyId = storyId;
    this.imagesDir = imagesDir;
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
    const id: IllustrationId = `illus:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const kind = input.subject.kind;
    const turnId = kind === 'scene' ? input.subject.turnId : null;
    const entityId = kind === 'portrait' ? input.subject.entityId : null;
    const locationId = kind === 'scene' ? input.subject.locationId : null;
    await this.db.query(
      `INSERT INTO illustrations
         (id, story_id, kind, turn_id, entity_id, location_id, visual_style, prompt, negative_prompt, seed, provider, status, path, error, created_scene, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',NULL,NULL,$12,$13)`,
      [
        id,
        this.storyId,
        kind,
        turnId,
        entityId,
        locationId,
        input.visualStyle,
        input.prompt,
        input.negativePrompt,
        input.seed,
        input.provider,
        input.createdScene,
        createdAt,
      ],
    );
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
    mkdirSync(this.imagesDir, { recursive: true });
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const relPath = `${id.replace(/^illus:/, '')}.${ext}`;
    writeFileSync(join(this.imagesDir, relPath), bytes);
    await this.db.query(
      `UPDATE illustrations SET status = 'done', path = $1, seed = $2 WHERE id = $3 AND story_id = $4`,
      [relPath, seed, id, this.storyId],
    );
    return this.get(id);
  }

  async fail(id: IllustrationId, error: string): Promise<Illustration | undefined> {
    await this.db.query(
      `UPDATE illustrations SET status = 'failed', error = $1 WHERE id = $2 AND story_id = $3`,
      [error, id, this.storyId],
    );
    return this.get(id);
  }

  async get(id: IllustrationId): Promise<Illustration | undefined> {
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE id = $1 AND story_id = $2`,
      [id, this.storyId],
    );
    return rows[0] ? toIllustration(rows[0]) : undefined;
  }

  /** Absolute path to the image bytes on disk, or null if there are none (yet, or ever). */
  absolutePath(illustration: Illustration): string | null {
    return illustration.path ? join(this.imagesDir, illustration.path) : null;
  }

  async forTurn(turnId: string): Promise<Illustration[]> {
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE story_id = $1 AND kind = 'scene' AND turn_id = $2 ORDER BY created_at`,
      [this.storyId, turnId],
    );
    return rows.map(toIllustration);
  }

  /** Every portrait for this entity, newest first — the gallery a regenerate flow picks from. */
  async forEntity(entityId: EntityId): Promise<Illustration[]> {
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations WHERE story_id = $1 AND kind = 'portrait' AND entity_id = $2 ORDER BY created_at DESC`,
      [this.storyId, entityId],
    );
    return rows.map(toIllustration);
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
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations
         WHERE story_id = $1 AND kind = 'portrait' AND entity_id = $2 AND status = 'done'
         ORDER BY created_at DESC LIMIT 1`,
      [this.storyId, entityId],
    );
    return rows[0] ? toIllustration(rows[0]) : undefined;
  }

  /**
   * A location's most recent scene image, for place consistency — the same
   * treatment `latestPortrait` gives a character, applied to `locationId` across
   * every turn's scene row rather than one entity's portrait rows.
   */
  async latestLocationReference(locationId: EntityId): Promise<Illustration | undefined> {
    const { rows } = await this.db.query<IllustrationRow>(
      `SELECT ${COLS} FROM illustrations
         WHERE story_id = $1 AND kind = 'scene' AND location_id = $2 AND status = 'done'
         ORDER BY created_at DESC LIMIT 1`,
      [this.storyId, locationId],
    );
    return rows[0] ? toIllustration(rows[0]) : undefined;
  }

  /** Deletes the row and its bytes together, so a retried generation cannot leak an orphaned file. */
  async delete(id: IllustrationId): Promise<void> {
    const illus = await this.get(id);
    if (illus?.path) {
      const abs = this.absolutePath(illus);
      if (abs && existsSync(abs)) unlinkSync(abs);
    }
    await this.db.query(`DELETE FROM illustrations WHERE id = $1 AND story_id = $2`, [id, this.storyId]);
  }
}
