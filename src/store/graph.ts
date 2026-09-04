/**
 * Graph store. Implements the canon/chronicle overlay (DESIGN §2): a read
 * resolves `chronicle ?? canon`, so canon stays pristine while the playthrough
 * shadows it copy-on-write.
 *
 * Multi-story: canon (layer='canon') has no story_id and is shared by every
 * story in this world file. Chronicle (layer='chronicle') carries story_id —
 * this store is bound to one story, and every chronicle read/write is scoped
 * to it. Two stories in the same world overlay the same canon independently;
 * neither sees the other's chronicle rows even for the same entity id.
 *
 * Depth (`setDepth`/`belowDepth`) targets canon by default and stays
 * unscoped there on purpose: it records how much of the *source material*
 * has been read, which is a property of the ingest, not of any one story —
 * two stories should agree on what canon says, including how deeply. The
 * exception is an emergent entity (player-invented, story-authored, no wiki
 * page and never will have one): those live at `layer='chronicle'` from the
 * moment they are created, so `setDepth` follows whichever layer this story
 * actually resolves for the id, rather than assuming canon and silently
 * doing nothing to an entity that was never there.
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
  StoryId,
} from '../domain/types.ts';

interface EntityRow {
  id: string;
  layer: Layer;
  story_id: string | null;
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
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  // ------------------------------------------------------------- entities

  /** Overlay read: this story's chronicle wins over canon for the same id. */
  get(id: EntityId): Entity | undefined {
    const r = row<EntityRow>(
      this.db
        .prepare(
          `SELECT * FROM entities WHERE id = ? AND (story_id = ? OR layer = 'canon')
           ORDER BY CASE layer WHEN 'chronicle' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(id, this.storyId),
    );
    return r ? toEntity(r) : undefined;
  }

  /** Canon as the source material stated it, ignoring every story's playthrough. */
  getCanon(id: EntityId): Entity | undefined {
    const r = row<EntityRow>(
      this.db.prepare(`SELECT * FROM entities WHERE id = ? AND layer = 'canon'`).get(id),
    );
    return r ? toEntity(r) : undefined;
  }

  has(id: EntityId): boolean {
    return this.get(id) !== undefined;
  }

  /**
   * `layer` defaults to `'chronicle'`, which is what every play-time write
   * wants (copy-on-write over canon, scoped to this story). Ingest and
   * custom-world authoring pass `'canon'` explicitly — that path writes the
   * shared baseline every story in this file will read.
   *
   * The upsert target is an expression index (`COALESCE(story_id, '')`), not
   * the visible columns, because a composite key including a nullable column
   * would not actually enforce "one canon row per id" — checked directly
   * against node:sqlite before relying on it, not assumed from the SQL
   * standard. `layer='canon'` writes always pass NULL for story_id here,
   * matching the CHECK constraint in the schema.
   */
  upsert(e: Partial<Entity> & { id: EntityId; type: EntityType; name: string }, layer: Layer = 'chronicle'): void {
    const storyId = layer === 'canon' ? null : this.storyId;
    this.db
      .prepare(
        `INSERT INTO entities
           (id, layer, story_id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id, layer, COALESCE(story_id, '')) DO UPDATE SET
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
        storyId,
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

  /**
   * The deduped overlay view, shared by every read that must resolve
   * "chronicle wins over canon" across a set of rows rather than one id.
   *
   * Not `GROUP BY id ... HAVING layer = MIN(...)`: SQLite's bare-column
   * selection under `GROUP BY` picks an arbitrary row's value for columns not
   * wrapped in an aggregate — including the ones the `HAVING` clause matched
   * against — so a `SELECT *` can return the *wrong* row's data while still
   * seeming to satisfy the `HAVING` condition. Confirmed directly against
   * node:sqlite (a canon/chronicle pair for one id, `list()`'s old query
   * silently returned canon's row even though chronicle should have won) —
   * this was a latent bug already, not something the story migration
   * introduced. `ROW_NUMBER() OVER (PARTITION BY id ...)` picks a specific
   * row deterministically, which a `HAVING` over unaggregated columns cannot.
   */
  private overlayCte(extraWhere: string): string {
    return `
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY id ORDER BY CASE layer WHEN 'chronicle' THEN 0 ELSE 1 END
        ) AS rnk
        FROM entities WHERE (story_id = ? OR layer = 'canon')${extraWhere ? ` AND ${extraWhere}` : ''}
      )
      SELECT * FROM ranked WHERE rnk = 1`;
  }

  list(opts: { type?: EntityType; layer?: Layer; limit?: number; minSalience?: number } = {}): Entity[] {
    const where: string[] = [];
    const args: unknown[] = [this.storyId];
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
    const limit = opts.limit ?? 500;
    const sql = `${this.overlayCte(where.join(' AND '))} ORDER BY salience DESC, name ASC LIMIT ?`;
    args.push(limit);
    return rows<EntityRow>(this.db.prepare(sql).all(...(args as never[]))).map(toEntity);
  }

  search(q: string, limit = 20): Entity[] {
    const like = `%${q.toLowerCase()}%`;
    const sql = `${this.overlayCte(`(lower(name) LIKE ? OR lower(id) LIKE ? OR lower(summary) LIKE ?)`)} ORDER BY salience DESC LIMIT ?`;
    return rows<EntityRow>(this.db.prepare(sql).all(this.storyId, like, like, like, limit)).map(toEntity);
  }

  /** Resolve a loose name to an entity id. Used when extraction returns prose names. */
  resolveName(name: string): Entity | undefined {
    const sql = `${this.overlayCte(`lower(name) = ?`)} LIMIT 1`;
    const exact = row<EntityRow>(this.db.prepare(sql).get(this.storyId, name.toLowerCase()));
    if (exact) return toEntity(exact);
    const hits = this.search(name, 1);
    return hits[0];
  }

  /**
   * Salience is play-time and per-story: bumping it copy-on-writes a
   * chronicle row over canon (mirroring `upsert`), so one story's attention
   * never brightens or dims what another story, reading the same canon,
   * sees.
   */
  setSalience(id: EntityId, salience: number): void {
    const clamped = Math.max(0, Math.min(1, salience));
    const cur = this.get(id);
    if (!cur) return;
    this.upsert({ ...cur, salience: clamped }, 'chronicle');
  }

  /** Entities cool unless touched, so the frame does not fill with people who left. */
  decaySalience(rate = 0.06, floor = 0.05): void {
    // Only this story's own chronicle rows decay. An untouched canon entity
    // sits at its ingested baseline until this story's play actually raises
    // it (via bumpSalience, which creates the chronicle row) — there is
    // nothing to cool until then.
    this.db
      .prepare(`UPDATE entities SET salience = MAX(?, salience - ?) WHERE layer = 'chronicle' AND story_id = ?`)
      .run(floor, rate, this.storyId);
  }

  bumpSalience(ids: EntityId[], amount = 0.35): void {
    for (const id of ids) {
      const cur = this.get(id);
      if (!cur) continue;
      this.upsert({ ...cur, salience: Math.min(1, cur.salience + amount) }, 'chronicle');
    }
  }

  /**
   * Canon by default, unscoped. Falls back to this story's own chronicle row
   * when that is what the id actually resolves to (an emergent entity, or
   * one this story has already diverged) — otherwise a `setDepth` on an
   * emergent entity would silently match zero rows.
   */
  setDepth(id: EntityId, depth: DepthLevelValue): void {
    const canonRes = this.db
      .prepare(`UPDATE entities SET depth_level = MAX(depth_level, ?) WHERE id = ? AND layer = 'canon'`)
      .run(depth, id);
    if (Number(canonRes.changes) > 0) return;
    this.db
      .prepare(`UPDATE entities SET depth_level = MAX(depth_level, ?) WHERE id = ? AND layer = 'chronicle' AND story_id = ?`)
      .run(depth, id, this.storyId);
  }

  belowDepth(target: DepthLevelValue, limit = 200): Entity[] {
    return rows<EntityRow>(
      this.db
        .prepare(
          `SELECT * FROM entities WHERE layer = 'canon' AND depth_level < ?
           ORDER BY salience DESC LIMIT ?`,
        )
        .all(target, limit),
    ).map(toEntity);
  }

  // ---------------------------------------------------------------- edges

  /**
   * The overlay clause shared by every edge read: once this story has
   * touched a (subject,predicate,object) identity at all — asserted it,
   * retired it, whatever — that identity is masked from canon entirely and
   * only this story's own chronicle rows (however many, live or expired)
   * answer for it. Without the mask, a canon edge this story retired would
   * still show up live, because canon's row is untouched and still exists;
   * checked directly against node:sqlite (an edge retired in a discarded
   * future, restored by truncateToScene, kept reading as still-retired
   * afterward) before writing this, not assumed.
   */
  private static readonly EDGE_OVERLAY = `
    (story_id = ? AND layer = 'chronicle')
    OR (layer = 'canon' AND NOT EXISTS (
      SELECT 1 FROM edges m WHERE m.layer = 'chronicle' AND m.story_id = ?
        AND m.subject = edges.subject AND m.predicate = edges.predicate AND m.object = edges.object
    ))`;

  /**
   * Live edges at a point in story time. `valid_to IS NULL OR valid_to > scene`
   * is what makes "who is their ally *now*" a time-filtered traversal.
   */
  edgesFrom(subject: EntityId, scene?: number): Edge[] {
    const sql =
      scene === undefined
        ? `SELECT * FROM edges WHERE subject = ? AND (${GraphStore.EDGE_OVERLAY}) AND valid_to IS NULL`
        : `SELECT * FROM edges WHERE subject = ? AND (${GraphStore.EDGE_OVERLAY}) AND valid_from <= ?
             AND (valid_to IS NULL OR valid_to > ?)`;
    const args =
      scene === undefined
        ? [subject, this.storyId, this.storyId]
        : [subject, this.storyId, this.storyId, scene, scene];
    return rows<Edge & { valid_from: number; valid_to: number | null }>(
      this.db.prepare(sql).all(...(args as never[])),
    ).map(normEdge);
  }

  edgesTo(object: EntityId, scene?: number): Edge[] {
    const sql =
      scene === undefined
        ? `SELECT * FROM edges WHERE object = ? AND (${GraphStore.EDGE_OVERLAY}) AND valid_to IS NULL`
        : `SELECT * FROM edges WHERE object = ? AND (${GraphStore.EDGE_OVERLAY}) AND valid_from <= ?
             AND (valid_to IS NULL OR valid_to > ?)`;
    const args =
      scene === undefined
        ? [object, this.storyId, this.storyId]
        : [object, this.storyId, this.storyId, scene, scene];
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

  /**
   * `layer` defaults to `'chronicle'` (this story's assertion). Canon edges
   * (ingest, custom-world authoring) pass `'canon'` explicitly and are
   * unscoped, exactly like entities.
   */
  assertEdge(a: EdgeAssert, scene: number, layer: Layer = 'chronicle', provenance = 'authored'): void {
    const storyId = layer === 'canon' ? null : this.storyId;
    const existing = row<{ id: number }>(
      this.db
        .prepare(
          `SELECT id FROM edges WHERE subject = ? AND predicate = ? AND object = ?
             AND layer = ? AND COALESCE(story_id, '') = COALESCE(?, '') AND valid_to IS NULL`,
        )
        .get(a.subject, a.predicate, a.object, layer, storyId),
    );
    if (existing) {
      this.db
        .prepare(`UPDATE edges SET weight = ?, evidence = COALESCE(?, evidence) WHERE id = ?`)
        .run(a.weight ?? 0.5, a.evidence ?? null, existing.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO edges (subject, predicate, object, layer, story_id, valid_from, valid_to, weight, provenance, confidence, evidence)
         VALUES (?,?,?,?,?,?,NULL,?,?,?,?)`,
      )
      .run(a.subject, a.predicate, a.object, layer, storyId, scene, a.weight ?? 0.5, provenance, 1, a.evidence ?? null);
  }

  /**
   * Expire rather than delete: history is kept for free. Retiring a live
   * canon edge is a per-story act (this story's chronicle now disagrees with
   * canon about it) — it copies the edge into this story's chronicle as
   * already-expired, rather than mutating the shared canon row, so other
   * stories keep seeing it live.
   */
  retireEdge(subject: EntityId, predicate: string, object: EntityId, scene: number): boolean {
    const ownRes = this.db
      .prepare(
        `UPDATE edges SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ?
           AND layer = 'chronicle' AND story_id = ? AND valid_to IS NULL`,
      )
      .run(scene, subject, predicate, object, this.storyId);
    if (Number(ownRes.changes) > 0) return true;

    const canonLive = row<{ weight: number; provenance: string; confidence: number; evidence: string | null; valid_from: number }>(
      this.db
        .prepare(
          `SELECT weight, provenance, confidence, evidence, valid_from FROM edges
             WHERE subject = ? AND predicate = ? AND object = ? AND layer = 'canon' AND valid_to IS NULL`,
        )
        .get(subject, predicate, object),
    );
    if (!canonLive) return false;

    this.db
      .prepare(
        `INSERT INTO edges (subject, predicate, object, layer, story_id, valid_from, valid_to, weight, provenance, confidence, evidence)
         VALUES (?,?,?,'chronicle',?,?,?,?,?,?,?)`,
      )
      .run(
        subject,
        predicate,
        object,
        this.storyId,
        canonLive.valid_from,
        scene,
        canonLive.weight,
        canonLive.provenance,
        canonLive.confidence,
        canonLive.evidence,
      );
    return true;
  }

  allEdges(limit = 2000): Edge[] {
    return rows<Edge & { valid_from: number; valid_to: number | null }>(
      this.db
        .prepare(`SELECT * FROM edges WHERE ${GraphStore.EDGE_OVERLAY} ORDER BY id LIMIT ?`)
        .all(this.storyId, this.storyId, limit),
    ).map(normEdge);
  }

  counts(): { entities: number; edges: number; canon: number; chronicle: number } {
    const q = (sql: string, ...a: unknown[]) =>
      Number((row<{ n: number }>(this.db.prepare(sql).get(...(a as never[])))?.n ?? 0));
    return {
      entities: q(`SELECT COUNT(DISTINCT id) n FROM entities WHERE story_id = ? OR layer = 'canon'`, this.storyId),
      edges: q(`SELECT COUNT(*) n FROM edges WHERE story_id = ? OR layer = 'canon'`, this.storyId),
      canon: q(`SELECT COUNT(*) n FROM entities WHERE layer = 'canon'`),
      chronicle: q(`SELECT COUNT(*) n FROM entities WHERE layer = 'chronicle' AND story_id = ?`, this.storyId),
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
