/**
 * Cast store, Postgres: character sheets, contracts, and directional
 * relationships. See DESIGN.md §2.
 *
 * Sheets get the same canon/chronicle overlay as entities and edges: ingest (or
 * custom-world authoring) writes a canon baseline once — identity, voice
 * samples, base condition, all pulled from the source material — and every story
 * reading that world sees the baseline until its own play mutates it. Play-time
 * mutation (a vow breaking, condition changing, a lock toggled, who is the
 * player) copies the sheet forward into a chronicle row scoped to that story,
 * mirroring `GraphStore.upsert`.
 *
 * Relationships have no canon layer — they are only ever written at play time —
 * so they stay story-scoped outright with no overlay to resolve.
 *
 * ## What changed from SQLite
 *
 * `sheets` split into `canon_sheets` (keyed by `world_id`) and `chron_sheets`
 * (keyed by `story_id`), so the `ON CONFLICT (entity_id, layer, COALESCE(story_id,
 * ''))` expression index becomes an ordinary primary key.
 *
 * One asymmetry is now explicit in the schema rather than implied: `is_player`
 * exists only on `chron_sheets`. Who the protagonist is, is a property of a
 * playthrough, not of the source material — two stories in one world have
 * different players. The SQLite table carried the column on canon rows too,
 * where it was always 0; reads here default it to false for a canon row.
 */
import { jsonGet, type Queryable } from '../db/pg.ts';
import { overlaySheet, type OverlaySource } from '../db/overlay.ts';
import type {
  Appearance,
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
  identity: unknown;
  contract: unknown;
  voice: unknown;
  condition: unknown;
  appearance: unknown;
  locks: unknown;
  is_player?: boolean;
  pri?: number;
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
export function emptyAppearance(): Appearance {
  return { description: '', attire: '', markers: [], referenceImagePath: null, seed: null };
}

/**
 * Spread over the empty shapes rather than trusting the stored JSON: a sheet
 * written before a field existed would otherwise arrive with it missing, and
 * every caller would have to guard. jsonb arrives parsed, so `jsonGet` is here
 * only to tolerate a legacy text value or a hand-edited row.
 */
function toSheet(r: SheetRow): CharacterSheet {
  return {
    entityId: r.entity_id,
    identity: { ...emptyIdentity(), ...jsonGet<Partial<Identity>>(r.identity, {}) },
    contract: { ...emptyContract(), ...jsonGet<Partial<Contract>>(r.contract, {}) },
    voice: { ...emptyVoice(), ...jsonGet<Partial<VoiceCard>>(r.voice, {}) },
    condition: { ...emptyCondition(), ...jsonGet<Partial<Condition>>(r.condition, {}) },
    appearance: { ...emptyAppearance(), ...jsonGet<Partial<Appearance>>(r.appearance, {}) },
    locks: jsonGet<string[]>(r.locks, []),
    isPlayer: r.is_player === true,
  };
}

/**
 * Rows per statement for `putMany`. Nine parameters per row against Postgres'
 * 65,535-parameter ceiling, so 500 is 4,500 — the same headroom `BULK_ROWS` in
 * `graph-pg.ts` keeps.
 */
const BULK_SHEET_ROWS = 500;

/** An absent sheet, rendered so callers never branch on existence. */
function blankSheet(entityId: EntityId): CharacterSheet {
  return {
    entityId,
    identity: emptyIdentity(),
    contract: emptyContract(),
    voice: emptyVoice(),
    condition: emptyCondition(),
    appearance: emptyAppearance(),
    locks: [],
    isPlayer: false,
  };
}

export interface CastStoreOptions {
  db: Queryable;
  storyId: StoryId;
  sources: OverlaySource[];
  /** Where `put(sheet, 'canon')` writes; defaults to the primary source. */
  canonWorldId?: number;
}

export class CastStore {
  private db: Queryable;
  private storyId: StoryId;
  readonly sources: OverlaySource[];
  private canonWorldId: number | undefined;

  constructor(opts: CastStoreOptions) {
    this.db = opts.db;
    this.storyId = opts.storyId;
    this.sources = opts.sources;
    this.canonWorldId = opts.canonWorldId ?? opts.sources[0]?.worldId;
  }

  /** Same reasoning as `GraphStore.requireCanonWorld`: never guess a target. */
  private requireCanonWorld(): number {
    if (this.canonWorldId === undefined) {
      throw new Error(
        `no canon world for story ${this.storyId}: a canon sheet write needs a target world (story_sources is empty, or pass canonWorldId)`,
      );
    }
    return this.canonWorldId;
  }

  /** Overlay read: this story's chronicle sheet wins over the canon baseline. */
  async get(entityId: EntityId): Promise<CharacterSheet | undefined> {
    const r = await overlaySheet<SheetRow>(this.db, this.storyId, this.sources, entityId);
    return r ? toSheet(r) : undefined;
  }

  /** The canon baseline, ignoring every story's playthrough. In source order. */
  async getCanon(entityId: EntityId): Promise<CharacterSheet | undefined> {
    for (const s of this.sources) {
      const { rows } = await this.db.query<SheetRow>(
        `SELECT entity_id, identity, contract, voice, condition, appearance, locks
           FROM canon_sheets WHERE world_id = $1 AND entity_id = $2`,
        [s.worldId, entityId],
      );
      if (rows[0]) return toSheet(rows[0]);
    }
    return undefined;
  }

  /** Sheet or a blank one, so callers never branch on existence. */
  async getOrBlank(entityId: EntityId): Promise<CharacterSheet> {
    return (await this.get(entityId)) ?? blankSheet(entityId);
  }

  /**
   * Many sheets by entity id, in one query, blanks included.
   *
   * The frame builders render a sheet per present character every turn, so this
   * is the same round-trip problem `GraphStore.getMany` solves: `getOrBlank` in a
   * loop was free in-process and is one network hop per character here.
   *
   * Every requested id is present in the result — missing ones as blanks — so a
   * caller can render without branching, which is what `getOrBlank` promised.
   */
  async getManyOrBlank(entityIds: EntityId[]): Promise<Map<EntityId, CharacterSheet>> {
    const out = new Map<EntityId, CharacterSheet>();
    const unique = [...new Set(entityIds)].filter((id) => id);
    if (!unique.length) return out;

    const cols = 'entity_id, identity, contract, voice, condition, appearance, locks';
    const params: unknown[] = [this.storyId, unique];
    const arms = [
      `SELECT ${cols}, is_player, 0 AS pri FROM chron_sheets WHERE story_id = $1 AND entity_id = ANY($2)`,
    ];
    for (const s of this.sources) {
      params.push(s.worldId, s.ordinal);
      arms.push(
        `SELECT ${cols}, false AS is_player, $${params.length} AS pri FROM canon_sheets
           WHERE world_id = $${params.length - 1} AND entity_id = ANY($2)`,
      );
    }
    const { rows } = await this.db.query<SheetRow>(
      `SELECT DISTINCT ON (entity_id) * FROM (${arms.join(' UNION ALL ')}) q ORDER BY entity_id, pri`,
      params,
    );
    for (const r of rows) out.set(r.entity_id, toSheet(r));
    for (const id of unique) if (!out.has(id)) out.set(id, blankSheet(id));
    return out;
  }

  /**
   * `layer` defaults to `'chronicle'` (this story's copy-on-write). Ingest and
   * custom-world authoring pass `'canon'` explicitly, exactly like
   * `GraphStore.upsert`, and need the ingest role to do it.
   *
   * `is_player` is only written on the chronicle side — see the header note.
   */
  async put(sheet: CharacterSheet, layer: Layer = 'chronicle'): Promise<void> {
    const json = [
      JSON.stringify(sheet.identity),
      JSON.stringify(sheet.contract),
      JSON.stringify(sheet.voice),
      JSON.stringify(sheet.condition),
      JSON.stringify(sheet.appearance),
      JSON.stringify(sheet.locks),
    ];
    if (layer === 'canon') {
      await this.db.query(
        `INSERT INTO canon_sheets (world_id, entity_id, identity, contract, voice, condition, appearance, locks)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
         ON CONFLICT (world_id, entity_id) DO UPDATE SET
           identity = EXCLUDED.identity, contract = EXCLUDED.contract,
           voice = EXCLUDED.voice, condition = EXCLUDED.condition,
           appearance = EXCLUDED.appearance, locks = EXCLUDED.locks`,
        [this.requireCanonWorld(), sheet.entityId, ...json],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO chron_sheets (story_id, entity_id, identity, contract, voice, condition, appearance, locks, is_player)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)
       ON CONFLICT (story_id, entity_id) DO UPDATE SET
         identity = EXCLUDED.identity, contract = EXCLUDED.contract,
         voice = EXCLUDED.voice, condition = EXCLUDED.condition,
         appearance = EXCLUDED.appearance, locks = EXCLUDED.locks,
         is_player = EXCLUDED.is_player`,
      [this.storyId, sheet.entityId, ...json, sheet.isPlayer],
    );
  }

  /**
   * Many sheets in one statement — the ingest path's sheet writer.
   *
   * Pass A seeds a sheet from every character infobox (1,091 of them in the real
   * Star Trek ingest), so this has the same round-trip problem as the entity and
   * edge writers.
   *
   * `is_player` is only written on the chronicle side, as `put` does: the
   * protagonist belongs to a playthrough, not the source material. A canon batch
   * that tried to carry the flag would drop it silently — the bug that made a
   * seeded world unplayable until a test caught it.
   */
  async putMany(sheets: CharacterSheet[], layer: Layer = 'chronicle'): Promise<number> {
    if (!sheets.length) return 0;
    // Last write wins per entity, matching what sequential `put` calls would leave
    // and avoiding Postgres' "cannot affect row a second time" on a duplicate.
    const unique = new Map<string, CharacterSheet>();
    for (const s of sheets) unique.set(s.entityId, s);
    const rows = [...unique.values()];

    const canon = layer === 'canon';
    const scopeCol = canon ? 'world_id' : 'story_id';
    const scope: string | number = canon ? this.requireCanonWorld() : this.storyId;
    const table = canon ? 'canon_sheets' : 'chron_sheets';
    const cols = canon
      ? `${scopeCol}, entity_id, identity, contract, voice, condition, appearance, locks`
      : `${scopeCol}, entity_id, identity, contract, voice, condition, appearance, locks, is_player`;

    let written = 0;
    for (let i = 0; i < rows.length; i += BULK_SHEET_ROWS) {
      const chunk = rows.slice(i, i + BULK_SHEET_ROWS);
      const params: unknown[] = [];
      const tuples = chunk.map((sheet) => {
        const base = params.length;
        params.push(
          scope,
          sheet.entityId,
          JSON.stringify(sheet.identity),
          JSON.stringify(sheet.contract),
          JSON.stringify(sheet.voice),
          JSON.stringify(sheet.condition),
          JSON.stringify(sheet.appearance),
          JSON.stringify(sheet.locks),
        );
        const json = (n: number) => `$${base + n}::jsonb`;
        const head = `$${base + 1},$${base + 2},${json(3)},${json(4)},${json(5)},${json(6)},${json(7)},${json(8)}`;
        if (canon) return `(${head})`;
        params.push(sheet.isPlayer);
        return `(${head},$${params.length})`;
      });
      const res = await this.db.query(
        `INSERT INTO ${table} (${cols}) VALUES ${tuples.join(',')}
         ON CONFLICT (${scopeCol}, entity_id) DO UPDATE SET
           identity = EXCLUDED.identity, contract = EXCLUDED.contract,
           voice = EXCLUDED.voice, condition = EXCLUDED.condition,
           appearance = EXCLUDED.appearance, locks = EXCLUDED.locks${canon ? '' : ', is_player = EXCLUDED.is_player'}`,
        params,
      );
      written += res.rowCount ?? 0;
    }
    return written;
  }

  /**
   * Every sheet this story sees, chronicle winning per entity.
   *
   * `DISTINCT ON (entity_id) ... ORDER BY entity_id, pri` is the Postgres form of
   * the SQLite version's `ROW_NUMBER() OVER (PARTITION BY entity_id ...)`. Both
   * exist for the same reason: `GROUP BY ... HAVING` over unaggregated columns
   * can silently return the wrong layer's row, which was confirmed directly
   * against node:sqlite rather than assumed.
   */
  async list(): Promise<CharacterSheet[]> {
    const cols = 'entity_id, identity, contract, voice, condition, appearance, locks';
    const params: unknown[] = [this.storyId];
    const arms = [`SELECT ${cols}, is_player, 0 AS pri FROM chron_sheets WHERE story_id = $1`];
    for (const s of this.sources) {
      params.push(s.worldId, s.ordinal);
      arms.push(
        `SELECT ${cols}, false AS is_player, $${params.length} AS pri FROM canon_sheets
           WHERE world_id = $${params.length - 1}`,
      );
    }
    const { rows } = await this.db.query<SheetRow>(
      `SELECT DISTINCT ON (entity_id) * FROM (${arms.join(' UNION ALL ')}) q ORDER BY entity_id, pri`,
      params,
    );
    return rows.map(toSheet);
  }

  /**
   * This story's protagonist.
   *
   * Queried directly rather than by filtering `list()`: `is_player` only exists
   * on chronicle rows, so the answer is always in one table, and scanning every
   * canon sheet in a 33,332-entity world to find it would be absurd.
   */
  async player(): Promise<CharacterSheet | undefined> {
    const { rows } = await this.db.query<SheetRow>(
      `SELECT entity_id, identity, contract, voice, condition, appearance, locks, is_player
         FROM chron_sheets WHERE story_id = $1 AND is_player LIMIT 1`,
      [this.storyId],
    );
    return rows[0] ? toSheet(rows[0]) : undefined;
  }

  /**
   * Condition is the fast-moving half of a sheet. Locked fields are player
   * ground truth and must survive an AI update (DESIGN §2).
   */
  async updateCondition(entityId: EntityId, patch: Partial<Condition>): Promise<void> {
    const sheet = await this.getOrBlank(entityId);
    const next = { ...sheet.condition } as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (sheet.locks.includes(`condition.${k}`)) continue;
      next[k] = v;
    }
    sheet.condition = next as unknown as Condition;
    await this.put(sheet);
  }

  async lock(entityId: EntityId, path: string): Promise<void> {
    const sheet = await this.getOrBlank(entityId);
    if (!sheet.locks.includes(path)) sheet.locks.push(path);
    await this.put(sheet);
  }

  async unlock(entityId: EntityId, path: string): Promise<void> {
    const sheet = await this.getOrBlank(entityId);
    sheet.locks = sheet.locks.filter((p) => p !== path);
    await this.put(sheet);
  }

  /** Marks a vow broken. The break is the story, not a blocked action (DESIGN §5.3). */
  async breakVow(entityId: EntityId, vowId: string, scene: number): Promise<Vow | undefined> {
    const sheet = await this.get(entityId);
    if (!sheet) return undefined;
    const vow = sheet.contract.vows.find((v) => v.id === vowId);
    if (!vow) return undefined;
    vow.broken = true;
    vow.brokenScene = scene;
    // Written to chronicle even when the sheet was read from canon: breaking a
    // vow is this story's event, and canon must keep saying the vow holds for
    // every other story reading the same world.
    await this.put(sheet);
    return vow;
  }

  // ------------------------------------------------------- relationships
  // No canon layer to overlay: only ever written at play time, so plain story
  // scoping is all that is needed.

  async relationship(fromId: EntityId, toId: EntityId): Promise<Relationship> {
    const { rows } = await this.db.query<RelRow>(
      `SELECT from_id, to_id, trust, affection, respect, note FROM relationships
         WHERE story_id = $1 AND from_id = $2 AND to_id = $3`,
      [this.storyId, fromId, toId],
    );
    return rows[0] ? toRel(rows[0]) : { fromId, toId, trust: 0, affection: 0, respect: 0, note: '' };
  }

  async relationshipsOf(fromId: EntityId): Promise<Relationship[]> {
    const { rows } = await this.db.query<RelRow>(
      `SELECT from_id, to_id, trust, affection, respect, note FROM relationships
         WHERE story_id = $1 AND from_id = $2`,
      [this.storyId, fromId],
    );
    return rows.map(toRel);
  }

  /** Anyone who holds a strong feeling about this entity: the propagation frontier. */
  async relationshipsToward(toId: EntityId): Promise<Relationship[]> {
    const { rows } = await this.db.query<RelRow>(
      `SELECT from_id, to_id, trust, affection, respect, note FROM relationships
         WHERE story_id = $1 AND to_id = $2`,
      [this.storyId, toId],
    );
    return rows.map(toRel);
  }

  async adjustRelationship(
    fromId: EntityId,
    toId: EntityId,
    deltas: { trust?: number; affection?: number; respect?: number; note?: string },
  ): Promise<Relationship> {
    const cur = await this.relationship(fromId, toId);
    const clamp = (n: number) => Math.max(-1, Math.min(1, n));
    const next: Relationship = {
      fromId,
      toId,
      trust: clamp(cur.trust + (deltas.trust ?? 0)),
      affection: clamp(cur.affection + (deltas.affection ?? 0)),
      respect: clamp(cur.respect + (deltas.respect ?? 0)),
      note: deltas.note ?? cur.note,
    };
    await this.db.query(
      `INSERT INTO relationships (story_id, from_id, to_id, trust, affection, respect, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (story_id, from_id, to_id) DO UPDATE SET
         trust = EXCLUDED.trust, affection = EXCLUDED.affection,
         respect = EXCLUDED.respect, note = EXCLUDED.note`,
      [this.storyId, fromId, toId, next.trust, next.affection, next.respect, next.note],
    );
    return next;
  }
}

interface RelRow {
  from_id: string;
  to_id: string;
  trust: number;
  affection: number;
  respect: number;
  note: string;
}

function toRel(r: RelRow): Relationship {
  return {
    fromId: r.from_id,
    toId: r.to_id,
    trust: r.trust,
    affection: r.affection,
    respect: r.respect,
    note: r.note,
  };
}
