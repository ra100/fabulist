/**
 * Graph store. Implements the canon/chronicle overlay (DESIGN §2): a read
 * resolves `chronicle ?? canon`, so canon stays pristine while the playthrough
 * shadows it copy-on-write.
 */
import type { Db } from '../db/db.ts';
import { jsonGet, row, rows } from '../db/db.ts';
import type {
  DepthLevelValue,
  Edge,
  EdgeAssert,
  Entity,
  EntityId,
  EntityType,
  Layer,
} from '../domain/types.ts';

interface EntityRow {
  id: string;
  layer: Layer;
  type: EntityType;
  name: string;
  summary: string;
  provenance: string;
  confidence: number;
  salience: number;
  depth_level: number;
  props: string;
  created_scene: number;
}

function toEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    layer: r.layer,
    type: r.type,
    name: r.name,
    summary: r.summary,
    provenance: r.provenance,
    confidence: r.confidence,
    salience: r.salience,
    depthLevel: r.depth_level as DepthLevelValue,
    props: jsonGet<Record<string, unknown>>(r.props, {}),
    createdScene: r.created_scene,
  };
}

export class GraphStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ------------------------------------------------------------- entities

  /** Overlay read: chronicle wins over canon for the same id. */
  get(id: EntityId): Entity | undefined {
    const r = row<EntityRow>(
      this.db
        .prepare(
          `SELECT * FROM entities WHERE id = ?
           ORDER BY CASE layer WHEN 'chronicle' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(id),
    );
    return r ? toEntity(r) : undefined;
  }

  /** Canon as the source material stated it, ignoring the playthrough. */
  getCanon(id: EntityId): Entity | undefined {
    const r = row<EntityRow>(
      this.db.prepare(`SELECT * FROM entities WHERE id = ? AND layer = 'canon'`).get(id),
    );
    return r ? toEntity(r) : undefined;
  }

  has(id: EntityId): boolean {
    return this.get(id) !== undefined;
  }

  upsert(e: Partial<Entity> & { id: EntityId; type: EntityType; name: string }, layer: Layer = 'chronicle'): void {
    this.db
      .prepare(
        `INSERT INTO entities
           (id, layer, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id, layer) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE entities.summary END,
           provenance = excluded.provenance,
           confidence = excluded.confidence,
           salience = excluded.salience,
           depth_level = MAX(excluded.depth_level, entities.depth_level),
           props = excluded.props`,
      )
      .run(
        e.id,
        layer,
        e.type,
        e.name,
        e.summary ?? '',
        e.provenance ?? 'authored',
        e.confidence ?? 1,
        e.salience ?? 0.5,
        e.depthLevel ?? 0,
        JSON.stringify(e.props ?? {}),
        e.createdScene ?? 0,
      );
  }

  list(opts: { type?: EntityType; layer?: Layer; limit?: number; minSalience?: number } = {}): Entity[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type) {
      where.push('type = ?');
      args.push(opts.type);
    }
    if (opts.layer) {
      where.push('layer = ?');
      args.push(opts.layer);
    }
    if (opts.minSalience !== undefined) {
      where.push('salience >= ?');
      args.push(opts.minSalience);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 500;
    // Dedupe by id, preferring chronicle, without losing the salience ordering.
    const sql = `
      SELECT * FROM entities ${clause}
      GROUP BY id
      HAVING layer = MIN(CASE layer WHEN 'chronicle' THEN 'a' ELSE 'b' END)
          OR COUNT(*) = 1
      ORDER BY salience DESC, name ASC
      LIMIT ?`;
    args.push(limit);
    return rows<EntityRow>(this.db.prepare(sql).all(...(args as never[]))).map(toEntity);
  }

  search(q: string, limit = 20): Entity[] {
    const like = `%${q.toLowerCase()}%`;
    return rows<EntityRow>(
      this.db
        .prepare(
          `SELECT * FROM entities
           WHERE lower(name) LIKE ? OR lower(id) LIKE ? OR lower(summary) LIKE ?
           GROUP BY id ORDER BY salience DESC LIMIT ?`,
        )
        .all(like, like, like, limit),
    ).map(toEntity);
  }

  /** Resolve a loose name to an entity id. Used when extraction returns prose names. */
  resolveName(name: string): Entity | undefined {
    const exact = row<EntityRow>(
      this.db
        .prepare(`SELECT * FROM entities WHERE lower(name) = ? GROUP BY id LIMIT 1`)
        .get(name.toLowerCase()),
    );
    if (exact) return toEntity(exact);
    const hits = this.search(name, 1);
    return hits[0];
  }

  setSalience(id: EntityId, salience: number): void {
    this.db
      .prepare(`UPDATE entities SET salience = ? WHERE id = ?`)
      .run(Math.max(0, Math.min(1, salience)), id);
  }

  /** Entities cool unless touched, so the frame does not fill with people who left. */
  decaySalience(rate = 0.06, floor = 0.05): void {
    this.db
      .prepare(`UPDATE entities SET salience = MAX(?, salience - ?)`)
      .run(floor, rate);
  }

  bumpSalience(ids: EntityId[], amount = 0.35): void {
    if (!ids.length) return;
    const stmt = this.db.prepare(
      `UPDATE entities SET salience = MIN(1.0, salience + ?) WHERE id = ?`,
    );
    for (const id of ids) stmt.run(amount, id);
  }

  setDepth(id: EntityId, depth: DepthLevelValue): void {
    this.db
      .prepare(`UPDATE entities SET depth_level = MAX(depth_level, ?) WHERE id = ?`)
      .run(depth, id);
  }

  belowDepth(target: DepthLevelValue, limit = 200): Entity[] {
    return rows<EntityRow>(
      this.db
        .prepare(
          `SELECT * FROM entities WHERE depth_level < ? GROUP BY id
           ORDER BY salience DESC LIMIT ?`,
        )
        .all(target, limit),
    ).map(toEntity);
  }

  // ---------------------------------------------------------------- edges

  /**
   * Live edges at a point in story time. `valid_to IS NULL OR valid_to > scene`
   * is what makes "who is their ally *now*" a time-filtered traversal.
   */
  edgesFrom(subject: EntityId, scene?: number): Edge[] {
    const sql =
      scene === undefined
        ? `SELECT * FROM edges WHERE subject = ? AND valid_to IS NULL`
        : `SELECT * FROM edges WHERE subject = ? AND valid_from <= ?
             AND (valid_to IS NULL OR valid_to > ?)`;
    const args = scene === undefined ? [subject] : [subject, scene, scene];
    return rows<Edge & { valid_from: number; valid_to: number | null }>(
      this.db.prepare(sql).all(...(args as never[])),
    ).map(normEdge);
  }

  edgesTo(object: EntityId, scene?: number): Edge[] {
    const sql =
      scene === undefined
        ? `SELECT * FROM edges WHERE object = ? AND valid_to IS NULL`
        : `SELECT * FROM edges WHERE object = ? AND valid_from <= ?
             AND (valid_to IS NULL OR valid_to > ?)`;
    const args = scene === undefined ? [object] : [object, scene, scene];
    return rows<Edge & { valid_from: number; valid_to: number | null }>(
      this.db.prepare(sql).all(...(args as never[])),
    ).map(normEdge);
  }

  /** Undirected adjacency, for propagation and frame neighbourhoods. */
  neighbours(id: EntityId, scene?: number): Array<{ edge: Edge; otherId: EntityId }> {
    const out = this.edgesFrom(id, scene).map((edge) => ({ edge, otherId: edge.object }));
    const inn = this.edgesTo(id, scene).map((edge) => ({ edge, otherId: edge.subject }));
    return [...out, ...inn];
  }

  assertEdge(a: EdgeAssert, scene: number, layer: Layer = 'chronicle', provenance = 'authored'): void {
    const existing = row<{ id: number }>(
      this.db
        .prepare(
          `SELECT id FROM edges WHERE subject = ? AND predicate = ? AND object = ?
             AND layer = ? AND valid_to IS NULL`,
        )
        .get(a.subject, a.predicate, a.object, layer),
    );
    if (existing) {
      this.db
        .prepare(`UPDATE edges SET weight = ?, evidence = COALESCE(?, evidence) WHERE id = ?`)
        .run(a.weight ?? 0.5, a.evidence ?? null, existing.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO edges (subject, predicate, object, layer, valid_from, valid_to, weight, provenance, confidence, evidence)
         VALUES (?,?,?,?,?,NULL,?,?,?,?)`,
      )
      .run(a.subject, a.predicate, a.object, layer, scene, a.weight ?? 0.5, provenance, 1, a.evidence ?? null);
  }

  /** Expire rather than delete: history is kept for free. */
  retireEdge(subject: EntityId, predicate: string, object: EntityId, scene: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE edges SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL`,
      )
      .run(scene, subject, predicate, object);
    return Number(res.changes) > 0;
  }

  allEdges(limit = 2000): Edge[] {
    return rows<Edge & { valid_from: number; valid_to: number | null }>(
      this.db.prepare(`SELECT * FROM edges ORDER BY id LIMIT ?`).all(limit),
    ).map(normEdge);
  }

  counts(): { entities: number; edges: number; canon: number; chronicle: number } {
    const q = (sql: string, ...a: unknown[]) =>
      Number((row<{ n: number }>(this.db.prepare(sql).get(...(a as never[])))?.n ?? 0));
    return {
      entities: q(`SELECT COUNT(DISTINCT id) n FROM entities`),
      edges: q(`SELECT COUNT(*) n FROM edges`),
      canon: q(`SELECT COUNT(*) n FROM entities WHERE layer = 'canon'`),
      chronicle: q(`SELECT COUNT(*) n FROM entities WHERE layer = 'chronicle'`),
    };
  }
}

function normEdge(r: Edge & { valid_from?: number; valid_to?: number | null }): Edge {
  return {
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    layer: r.layer,
    validFrom: (r as { valid_from: number }).valid_from ?? 0,
    validTo: (r as { valid_to: number | null }).valid_to ?? null,
    weight: r.weight,
    provenance: r.provenance,
    confidence: r.confidence,
    evidence: r.evidence ?? null,
  };
}
