/**
 * Illustration store: metadata for every generated image, keyed to a turn (a
 * scene render) or an entity (a portrait). Image *bytes* live on disk under
 * an images directory next to the save (`IllustrationStore.imagesDir`), not
 * in SQLite — same reasoning `dbPath` already applies to keeping a
 * playthrough one portable directory rather than one oversized file: a
 * generated PNG is tens to hundreds of KB, hundreds of scenes across a long
 * campaign would bloat the `.db` file specifically, and nothing about an
 * image benefits from being inside a transaction the way a delta commit
 * does. The row's `path` column is relative to `imagesDir`, so moving a save
 * directory (the existing "one playthrough is one portable artifact" story)
 * keeps working as long as the images directory travels with it.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/db.ts';
import { row, rows } from '../db/db.ts';
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
  seed: number | null;
  provider: string;
  status: IllustrationStatus;
  path: string | null;
  error: string | null;
  created_scene: number;
  created_at: string;
}

function toIllustration(r: IllustrationRow): Illustration {
  const subject: IllustrationSubject =
    r.kind === 'portrait' ? { kind: 'portrait', entityId: r.entity_id ?? '' } : { kind: 'scene', turnId: r.turn_id ?? '', locationId: r.location_id };
  return {
    id: r.id,
    subject,
    visualStyle: r.visual_style,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    seed: r.seed,
    provider: r.provider,
    status: r.status,
    path: r.path,
    error: r.error,
    createdScene: r.created_scene,
    createdAt: r.created_at,
  };
}

export class IllustrationStore {
  private db: Db;
  private storyId: StoryId;
  readonly imagesDir: string;

  constructor(db: Db, storyId: StoryId, imagesDir = 'data/images') {
    this.db = db;
    this.storyId = storyId;
    this.imagesDir = imagesDir;
  }

  /** Reserves a row before the (slow, fallible) generation call, so a page reload during generation still shows "pending" rather than nothing. */
  reserve(input: {
    subject: IllustrationSubject;
    visualStyle: VisualStyle;
    prompt: string;
    negativePrompt: string;
    seed: number | null;
    provider: string;
    createdScene: number;
  }): Illustration {
    const id: IllustrationId = `illus:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const kind = input.subject.kind;
    const turnId = kind === 'scene' ? input.subject.turnId : null;
    const entityId = kind === 'portrait' ? input.subject.entityId : null;
    const locationId = kind === 'scene' ? input.subject.locationId : null;
    this.db
      .prepare(
        `INSERT INTO illustrations
           (id, story_id, kind, turn_id, entity_id, location_id, visual_style, prompt, negative_prompt, seed, provider, status, path, error, created_scene, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,?,?)`,
      )
      .run(id, this.storyId, kind, turnId, entityId, locationId, input.visualStyle, input.prompt, input.negativePrompt, input.seed, input.provider, input.createdScene, createdAt);
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

  /** Writes bytes to disk and marks the row done. Path is relative, so the save directory can move as a unit. */
  complete(id: IllustrationId, bytes: Uint8Array, mimeType: string, seed: number | null): Illustration | undefined {
    mkdirSync(this.imagesDir, { recursive: true });
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const relPath = `${id.replace(/^illus:/, '')}.${ext}`;
    writeFileSync(join(this.imagesDir, relPath), bytes);
    this.db.prepare(`UPDATE illustrations SET status = 'done', path = ?, seed = ? WHERE id = ? AND story_id = ?`).run(relPath, seed, id, this.storyId);
    return this.get(id);
  }

  fail(id: IllustrationId, error: string): Illustration | undefined {
    this.db.prepare(`UPDATE illustrations SET status = 'failed', error = ? WHERE id = ? AND story_id = ?`).run(error, id, this.storyId);
    return this.get(id);
  }

  get(id: IllustrationId): Illustration | undefined {
    const r = row<IllustrationRow>(this.db.prepare(`SELECT * FROM illustrations WHERE id = ? AND story_id = ?`).get(id, this.storyId));
    return r ? toIllustration(r) : undefined;
  }

  /** Absolute path to the image bytes on disk, or null if there are none (yet, or ever). */
  absolutePath(illustration: Illustration): string | null {
    return illustration.path ? join(this.imagesDir, illustration.path) : null;
  }

  forTurn(turnId: string): Illustration[] {
    return rows<IllustrationRow>(
      this.db.prepare(`SELECT * FROM illustrations WHERE story_id = ? AND kind = 'scene' AND turn_id = ? ORDER BY created_at`).all(this.storyId, turnId),
    ).map(toIllustration);
  }

  /** Every portrait ever generated for this entity, most recent first — the gallery a "regenerate" flow picks from. */
  forEntity(entityId: EntityId): Illustration[] {
    return rows<IllustrationRow>(
      this.db.prepare(`SELECT * FROM illustrations WHERE story_id = ? AND kind = 'portrait' AND entity_id = ? ORDER BY created_at DESC`).all(this.storyId, entityId),
    ).map(toIllustration);
  }

  /** The current reference for an entity: latest done portrait. What `Appearance.referenceImagePath` gets set to. */
  latestPortrait(entityId: EntityId): Illustration | undefined {
    return this.forEntity(entityId).find((i) => i.status === 'done');
  }

  /**
   * A location's most recent scene image, for place consistency — the same
   * treatment `latestPortrait` gives a character, applied to `locationId`
   * across every turn's scene row rather than one entity's portrait rows.
   * Read by the composer via the API layer and offered back as the
   * conditioning reference the next time a scene is set at the same place.
   */
  latestLocationReference(locationId: EntityId): Illustration | undefined {
    return rows<IllustrationRow>(
      this.db
        .prepare(
          `SELECT * FROM illustrations WHERE story_id = ? AND kind = 'scene' AND location_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
        )
        .all(this.storyId, locationId),
    )
      .map(toIllustration)[0];
  }

  /** Deletes the row and its bytes together, so a retried generation cannot leak an orphaned file. */
  delete(id: IllustrationId): void {
    const illus = this.get(id);
    if (illus?.path) {
      const abs = this.absolutePath(illus);
      if (abs && existsSync(abs)) unlinkSync(abs);
    }
    this.db.prepare(`DELETE FROM illustrations WHERE id = ? AND story_id = ?`).run(id, this.storyId);
  }
}
