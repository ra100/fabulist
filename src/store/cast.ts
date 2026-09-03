/**
 * Cast store: character sheets, contracts, and directional relationships.
 * See DESIGN.md §2.
 */
import type { Db } from '../db/db.ts';
import { jsonGet, row, rows } from '../db/db.ts';
import type {
  CharacterSheet,
  Condition,
  Contract,
  EntityId,
  Identity,
  Relationship,
  VoiceCard,
  Vow,
} from '../domain/types.ts';

interface SheetRow {
  entity_id: string;
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

  constructor(db: Db) {
    this.db = db;
  }

  get(entityId: EntityId): CharacterSheet | undefined {
    const r = row<SheetRow>(this.db.prepare(`SELECT * FROM sheets WHERE entity_id = ?`).get(entityId));
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

  put(sheet: CharacterSheet): void {
    this.db
      .prepare(
        `INSERT INTO sheets (entity_id, identity, contract, voice, condition, locks, is_player)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(entity_id) DO UPDATE SET
           identity = excluded.identity, contract = excluded.contract,
           voice = excluded.voice, condition = excluded.condition,
           locks = excluded.locks, is_player = excluded.is_player`,
      )
      .run(
        sheet.entityId,
        JSON.stringify(sheet.identity),
        JSON.stringify(sheet.contract),
        JSON.stringify(sheet.voice),
        JSON.stringify(sheet.condition),
        JSON.stringify(sheet.locks),
        sheet.isPlayer ? 1 : 0,
      );
  }

  list(): CharacterSheet[] {
    return rows<SheetRow>(this.db.prepare(`SELECT * FROM sheets`).all()).map(toSheet);
  }

  player(): CharacterSheet | undefined {
    const r = row<SheetRow>(this.db.prepare(`SELECT * FROM sheets WHERE is_player = 1 LIMIT 1`).get());
    return r ? toSheet(r) : undefined;
  }

  /**
   * Condition is the fast-moving half of a sheet. Locked fields are player
   * ground truth and must survive an AI update (DESIGN §2).
   */
  updateCondition(entityId: EntityId, patch: Partial<Condition>): void {
    const sheet = this.getOrBlank(entityId);
    const next: Condition = { ...sheet.condition };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (sheet.locks.includes(`condition.${k}`)) continue;
      (next as Record<string, unknown>)[k] = v;
    }
    sheet.condition = next;
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

  relationship(fromId: EntityId, toId: EntityId): Relationship {
    const r = row<{ from_id: string; to_id: string; trust: number; affection: number; respect: number; note: string }>(
      this.db.prepare(`SELECT * FROM relationships WHERE from_id = ? AND to_id = ?`).get(fromId, toId),
    );
    return r
      ? { fromId: r.from_id, toId: r.to_id, trust: r.trust, affection: r.affection, respect: r.respect, note: r.note }
      : { fromId, toId, trust: 0, affection: 0, respect: 0, note: '' };
  }

  relationshipsOf(fromId: EntityId): Relationship[] {
    return rows<{ from_id: string; to_id: string; trust: number; affection: number; respect: number; note: string }>(
      this.db.prepare(`SELECT * FROM relationships WHERE from_id = ?`).all(fromId),
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
      this.db.prepare(`SELECT * FROM relationships WHERE to_id = ?`).all(toId),
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
        `INSERT INTO relationships (from_id, to_id, trust, affection, respect, note)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(from_id, to_id) DO UPDATE SET
           trust = excluded.trust, affection = excluded.affection,
           respect = excluded.respect, note = excluded.note`,
      )
      .run(fromId, toId, next.trust, next.affection, next.respect, next.note);
    return next;
  }
}
