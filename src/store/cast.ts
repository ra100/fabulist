/**
 * Cast store: character sheets, contracts, and directional relationships.
 * See DESIGN.md §2.
 *
 * Sheets get the same canon/chronicle overlay as entities/edges: ingest (or
 * custom-world authoring) writes a canon baseline sheet once — identity,
 * voice samples, base condition, all pulled from the source material — and
 * every story in this world reads that baseline until its own play mutates
 * it. Play-time mutation (a vow breaking, condition changing, a lock toggled,
 * who is the player) copies the sheet forward into a chronicle row scoped to
 * that story, mirroring `graph.upsert`.
 *
 * Relationships have no canon layer — they are only ever written at play
 * time — so they are story-scoped outright, with no overlay to resolve.
 */
import type { Db } from '../db/db.ts';
import { jsonGet, row, rows } from '../db/db.ts';
import type {
  CharacterSheet,
  Condition,
  Contract,
  EntityId,
  Identity,
  Layer,
  Relationship,
  StoryId,
  VoiceCard,
  Vow,
} from '../domain/types.ts';

interface SheetRow {
  entity_id: string;
  layer: Layer;
  story_id: string | null;
  identity: string;
  contract: string;
  voice: string;
  condition: string;
  locks: string;
  is_player: number;
}

export function emptyIdentity(): Identity {
  return { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' };
}
export function emptyContract(): Contract {
  return { vows: [], drives: [], breakingPoint: '', costOfBreak: '' };
}
export function emptyVoice(): VoiceCard {
  return { diction: '', tics: [], samples: [], never: [] };
}
export function emptyCondition(): Condition {
  return { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] };
}

function toSheet(r: SheetRow): CharacterSheet {
  return {
    entityId: r.entity_id,
    identity: { ...emptyIdentity(), ...jsonGet<Partial<Identity>>(r.identity, {}) },
    contract: { ...emptyContract(), ...jsonGet<Partial<Contract>>(r.contract, {}) },
    voice: { ...emptyVoice(), ...jsonGet<Partial<VoiceCard>>(r.voice, {}) },
    condition: { ...emptyCondition(), ...jsonGet<Partial<Condition>>(r.condition, {}) },
    locks: jsonGet<string[]>(r.locks, []),
    isPlayer: r.is_player === 1,
  };
}

export class CastStore {
  private db: Db;
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  /** Overlay read: this story's chronicle sheet wins over the canon baseline. */
  get(entityId: EntityId): CharacterSheet | undefined {
    const r = row<SheetRow>(
      this.db
        .prepare(
          `SELECT * FROM sheets WHERE entity_id = ? AND (story_id = ? OR layer = 'canon')
           ORDER BY CASE layer WHEN 'chronicle' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(entityId, this.storyId),
    );
    return r ? toSheet(r) : undefined;
  }

  /** The canon baseline, ignoring every story's playthrough. */
  getCanon(entityId: EntityId): CharacterSheet | undefined {
    const r = row<SheetRow>(
      this.db.prepare(`SELECT * FROM sheets WHERE entity_id = ? AND layer = 'canon'`).get(entityId),
    );
    return r ? toSheet(r) : undefined;
  }

  /** Sheet or a blank one, so callers never branch on existence. */
  getOrBlank(entityId: EntityId): CharacterSheet {
    return (
      this.get(entityId) ?? {
        entityId,
        identity: emptyIdentity(),
        contract: emptyContract(),
        voice: emptyVoice(),
        condition: emptyCondition(),
        locks: [],
        isPlayer: false,
      }
    );
  }

  /**
   * `layer` defaults to `'chronicle'` (this story's copy-on-write). Ingest and
   * custom-world authoring pass `'canon'` explicitly, exactly like
   * `graph.upsert`. Same expression-index upsert target as entities, for the
   * same reason: a composite key on the nullable story_id column would not
   * enforce "one canon sheet per entity" — checked directly, not assumed.
   */
  put(sheet: CharacterSheet, layer: Layer = 'chronicle'): void {
    const storyId = layer === 'canon' ? null : this.storyId;
    this.db
      .prepare(
        `INSERT INTO sheets (entity_id, layer, story_id, identity, contract, voice, condition, locks, is_player)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(entity_id, layer, COALESCE(story_id, '')) DO UPDATE SET
           identity = excluded.identity, contract = excluded.contract,
           voice = excluded.voice, condition = excluded.condition,
           locks = excluded.locks, is_player = excluded.is_player`,
      )
      .run(
        sheet.entityId,
        layer,
        storyId,
        JSON.stringify(sheet.identity),
        JSON.stringify(sheet.contract),
        JSON.stringify(sheet.voice),
        JSON.stringify(sheet.condition),
        JSON.stringify(sheet.locks),
        sheet.isPlayer ? 1 : 0,
      );
  }

  /**
   * See `GraphStore.overlayCte` for why this is a window function rather
   * than `GROUP BY ... HAVING`: confirmed directly against node:sqlite that
   * the latter can silently return the wrong layer's row.
   */
  list(): CharacterSheet[] {
    const sql = `
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY entity_id ORDER BY CASE layer WHEN 'chronicle' THEN 0 ELSE 1 END
        ) AS rnk
        FROM sheets WHERE story_id = ? OR layer = 'canon'
      )
      SELECT * FROM ranked WHERE rnk = 1`;
    return rows<SheetRow>(this.db.prepare(sql).all(this.storyId)).map(toSheet);
  }

  /** This story's protagonist. Every story has exactly one. */
  player(): CharacterSheet | undefined {
    return this.list().find((s) => s.isPlayer);
  }

  /**
   * Condition is the fast-moving half of a sheet. Locked fields are player
   * ground truth and must survive an AI update (DESIGN §2).
   */
  updateCondition(entityId: EntityId, patch: Partial<Condition>): void {
    const sheet = this.getOrBlank(entityId);
    const next = { ...sheet.condition } as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (sheet.locks.includes(`condition.${k}`)) continue;
      next[k] = v;
    }
    sheet.condition = next as unknown as Condition;
    this.put(sheet);
  }

  lock(entityId: EntityId, path: string): void {
    const sheet = this.getOrBlank(entityId);
    if (!sheet.locks.includes(path)) sheet.locks.push(path);
    this.put(sheet);
  }

  unlock(entityId: EntityId, path: string): void {
    const sheet = this.getOrBlank(entityId);
    sheet.locks = sheet.locks.filter((p) => p !== path);
    this.put(sheet);
  }

  /** Marks a vow broken. The break is the story, not a blocked action (DESIGN §5.3). */
  breakVow(entityId: EntityId, vowId: string, scene: number): Vow | undefined {
    const sheet = this.get(entityId);
    if (!sheet) return undefined;
    const vow = sheet.contract.vows.find((v) => v.id === vowId);
    if (!vow) return undefined;
    vow.broken = true;
    vow.brokenScene = scene;
    this.put(sheet);
    return vow;
  }

  // ------------------------------------------------------- relationships
  // No canon layer to overlay: only ever written at play time, so plain
  // story scoping is all that is needed.

  relationship(fromId: EntityId, toId: EntityId): Relationship {
    const r = row<{ from_id: string; to_id: string; trust: number; affection: number; respect: number; note: string }>(
      this.db.prepare(`SELECT * FROM relationships WHERE story_id = ? AND from_id = ? AND to_id = ?`).get(this.storyId, fromId, toId),
    );
    return r
      ? { fromId: r.from_id, toId: r.to_id, trust: r.trust, affection: r.affection, respect: r.respect, note: r.note }
      : { fromId, toId, trust: 0, affection: 0, respect: 0, note: '' };
  }

  relationshipsOf(fromId: EntityId): Relationship[] {
    return rows<{ from_id: string; to_id: string; trust: number; affection: number; respect: number; note: string }>(
      this.db.prepare(`SELECT * FROM relationships WHERE story_id = ? AND from_id = ?`).all(this.storyId, fromId),
    ).map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      trust: r.trust,
      affection: r.affection,
      respect: r.respect,
      note: r.note,
    }));
  }

  /** Anyone who holds a strong feeling about this entity: the propagation frontier. */
  relationshipsToward(toId: EntityId): Relationship[] {
    return rows<{ from_id: string; to_id: string; trust: number; affection: number; respect: number; note: string }>(
      this.db.prepare(`SELECT * FROM relationships WHERE story_id = ? AND to_id = ?`).all(this.storyId, toId),
    ).map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      trust: r.trust,
      affection: r.affection,
      respect: r.respect,
      note: r.note,
    }));
  }

  adjustRelationship(
    fromId: EntityId,
    toId: EntityId,
    deltas: { trust?: number; affection?: number; respect?: number; note?: string },
  ): Relationship {
    const cur = this.relationship(fromId, toId);
    const clamp = (n: number) => Math.max(-1, Math.min(1, n));
    const next: Relationship = {
      fromId,
      toId,
      trust: clamp(cur.trust + (deltas.trust ?? 0)),
      affection: clamp(cur.affection + (deltas.affection ?? 0)),
      respect: clamp(cur.respect + (deltas.respect ?? 0)),
      note: deltas.note ?? cur.note,
    };
    this.db
      .prepare(
        `INSERT INTO relationships (story_id, from_id, to_id, trust, affection, respect, note)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(story_id, from_id, to_id) DO UPDATE SET
           trust = excluded.trust, affection = excluded.affection,
           respect = excluded.respect, note = excluded.note`,
      )
      .run(this.storyId, fromId, toId, next.trust, next.affection, next.respect, next.note);
    return next;
  }
}
