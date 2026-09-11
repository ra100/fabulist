/**
 * Graph store, Postgres. Implements the canon/chronicle overlay (DESIGN §2): a
 * read resolves `chronicle ?? canon`, so canon stays pristine while the
 * playthrough shadows it copy-on-write.
 *
 * ## What changed from the SQLite version
 *
 * The behaviour is the same; where the rows live is not. There, canon and
 * chronicle shared one `entities` table discriminated by a `layer` column, and
 * every read carried `(story_id = ? OR layer = 'canon')`. Here they are
 * `canon_entities` (keyed by `world_id`) and `chron_entities` (keyed by
 * `story_id`), and the overlay is a UNION with an explicit precedence column —
 * see `src/db/overlay.ts`, which owns those queries and the measurements that
 * justify their shape.
 *
 * Three consequences worth stating, because they are why the split was worth
 * doing rather than incidental to it:
 *
 *   - **A store reads N worlds, not one.** `sources` is the ordered list from
 *     `story_sources`, so a crossover (Harry Potter x LotR) is the ordinary
 *     case of the same code rather than a feature bolted on. A plain story has
 *     one source and behaves exactly as before.
 *   - **Canon writes need a target world.** `upsert(e, 'canon')` used to be
 *     unambiguous because a file held one world's canon. It now writes to
 *     `canonWorldId` — the primary source unless told otherwise — because
 *     "which of this story's worlds does this belong to" has a real answer that
 *     cannot be guessed.
 *   - **The play role cannot write canon at all.** `schema-pg-roles.sql` denies
 *     it, so a canon write from a play connection raises `permission denied for
 *     table canon_entities` instead of corrupting 33,332 ingested rows. Ingest
 *     connects as `fabulist_ingest`; that is the only path that may.
 *
 * `layer` survives on the `Entity` domain type and is derived from which table a
 * row came from, so nothing downstream had to change.
 *
 * Depth (`setDepth`/`belowDepth`) still targets canon and stays story-agnostic
 * on purpose: it records how much of the *source material* has been read, which
 * is a property of the ingest, not of any one story. The exception is an
 * emergent entity (player-invented, no wiki page and never will have one):
 * those exist only in chronicle, so `setDepth` falls back to whichever table
 * actually holds the id rather than silently updating nothing.
 */
import { jsonGet, type Queryable } from '../db/pg.ts';
import { overlayEdges, overlayEntities, overlayEntity, type OverlaySource } from '../db/overlay.ts';
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

/**
 * Rows per statement for the bulk writers.
 *
 * Bounded by Postgres' 65,535-parameter ceiling: the widest table here binds 11
 * parameters per row, so 500 rows is 5,500 — comfortably clear, and large enough
 * that a 60,000-page ingest is ~120 statements rather than 60,000.
 */
const BULK_ROWS = 500;

/** A row as either table returns it; `pri` tells the overlay which won. */
interface EntityRow {
  id: string;
  type: EntityType;
  name: string;
  summary: string;
  provenance: string;
  confidence: number;
  salience: number;
  depth_level: number;
  props: unknown;
  created_scene: number;
  pri?: number;
}

/**
 * `pri === 0` means the row came from `chron_entities`, anything else from a
 * canon source. Defaulting an absent `pri` to canon is correct: the only reads
 * that omit it are the canon-only ones.
 */
function toEntity(r: EntityRow, layer: Layer = r.pri === 0 ? 'chronicle' : 'canon'): Entity {
  return {
    id: r.id,
    layer,
    type: r.type,
    name: r.name,
    summary: r.summary,
    provenance: r.provenance,
    confidence: r.confidence,
    salience: r.salience,
    depthLevel: r.depth_level as DepthLevelValue,
    // jsonb arrives parsed; jsonGet tolerates a legacy text value or a
    // hand-edited row rather than throwing on it.
    props: jsonGet<Record<string, unknown>>(r.props, {}),
    createdScene: r.created_scene,
  };
}

interface EdgeRow {
  eid?: string | number;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
  weight: number;
  provenance: string;
  confidence: number;
  evidence: string | null;
  pri?: number;
}

function toEdge(r: EdgeRow, layer: Layer = r.pri === 0 ? 'chronicle' : 'canon'): Edge {
  return {
    id: r.eid === undefined ? 0 : Number(r.eid),
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    layer,
    validFrom: r.valid_from ?? 0,
    validTo: r.valid_to ?? null,
    weight: r.weight,
    provenance: r.provenance,
    confidence: r.confidence,
    evidence: r.evidence ?? null,
  };
}

export interface GraphStoreOptions {
  db: Queryable;
  storyId: StoryId;
  /** Canon worlds this story reads, in precedence order. */
  sources: OverlaySource[];
  /**
   * Where `upsert(e, 'canon')` writes. Defaults to the primary source, which
   * is the only sensible answer for a single-world story and an explicit
   * decision for a crossover.
   */
  canonWorldId?: number;
}

export class GraphStore {
  private db: Queryable;
  private storyId: StoryId;
  readonly sources: OverlaySource[];
  private canonWorldId: number | undefined;

  constructor(opts: GraphStoreOptions) {
    this.db = opts.db;
    this.storyId = opts.storyId;
    this.sources = opts.sources;
    this.canonWorldId = opts.canonWorldId ?? opts.sources[0]?.worldId;
  }

  /**
   * Thrown rather than defaulted: a canon write with no world to write to is a
   * programming error (a story with no sources, or an ingest that forgot its
   * target), and silently picking one would put ingested rows in a world nobody
   * asked for — the kind of mistake that is invisible until a refresh deletes
   * the wrong thing.
   */
  private requireCanonWorld(): number {
    if (this.canonWorldId === undefined) {
      throw new Error(
        `no canon world for story ${this.storyId}: a canon write needs a target world (story_sources is empty, or pass canonWorldId)`,
      );
    }
    return this.canonWorldId;
  }

  // ------------------------------------------------------------- entities

  /** Overlay read: this story's chronicle wins over canon, then source order. */
  async get(id: EntityId): Promise<Entity | undefined> {
    const r = await overlayEntity<EntityRow>(this.db, this.storyId, this.sources, id);
    return r ? toEntity(r) : undefined;
  }

  /**
   * Many entities by id, in one query.
   *
   * Exists because the frame builders resolve tens of ids per turn and this is
   * the hot path of the whole application. Under SQLite `get()` in a loop cost
   * microseconds per call; over a connection each one is a round trip, so
   * `presentCastBlock` alone would have gone from one in-process burst to ~20
   * sequential awaits before the narrator sees a token. Measured on the real
   * corpora, resolving 40 ids one-at-a-time versus batched is the difference
   * between ~40 round trips and one.
   *
   * Returns a Map so a caller can preserve its own ordering and detect misses;
   * an id that resolves to nothing is simply absent, matching `get()`.
   */
  async getMany(ids: EntityId[]): Promise<Map<EntityId, Entity>> {
    const out = new Map<EntityId, Entity>();
    const unique = [...new Set(ids)].filter((id) => id);
    if (!unique.length) return out;

    const cols = 'id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene';
    const params: unknown[] = [this.storyId, unique];
    const arms = [`SELECT ${cols}, 0 AS pri FROM chron_entities WHERE story_id = $1 AND id = ANY($2)`];
    for (const s of this.sources) {
      params.push(s.worldId, s.ordinal);
      arms.push(
        `SELECT ${cols}, $${params.length} AS pri FROM canon_entities
           WHERE world_id = $${params.length - 1} AND id = ANY($2) AND retired_at_revision IS NULL`,
      );
    }
    // DISTINCT ON with pri as the second sort key is the same precedence rule
    // `overlayEntity` applies, applied to a set instead of one id.
    const { rows } = await this.db.query<EntityRow>(
      `SELECT DISTINCT ON (id) * FROM (${arms.join(' UNION ALL ')}) q ORDER BY id, pri`,
      params,
    );
    for (const r of rows) out.set(r.id, toEntity(r));
    return out;
  }

  /**
   * Neighbourhoods for many subjects at once — the other half of what the frame
   * builders need, and the reason `neighbourhood()` could otherwise issue two
   * queries per id per hop.
   */
  async neighboursMany(
    ids: EntityId[],
    scene?: number,
  ): Promise<Map<EntityId, Array<{ edge: Edge; otherId: EntityId }>>> {
    const out = new Map<EntityId, Array<{ edge: Edge; otherId: EntityId }>>();
    const unique = [...new Set(ids)].filter((id) => id);
    if (!unique.length) return out;
    for (const id of unique) out.set(id, []);

    const params: unknown[] = [this.storyId, unique];
    const live = (t: string) =>
      scene === undefined
        ? `${t}.valid_to IS NULL`
        : `${t}.valid_from <= $${params.push(scene)} AND (${t}.valid_to IS NULL OR ${t}.valid_to > $${params.length})`;

    const cols = 'subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence';
    // Both directions in one pass: a neighbourhood is undirected, and asking
    // twice would double the round trips this method exists to avoid.
    const arms = [
      `SELECT ${cols}, 0 AS pri FROM chron_edges c
         WHERE c.story_id = $1 AND (c.subject = ANY($2) OR c.object = ANY($2)) AND ${live('c')}`,
    ];
    for (const s of this.sources) {
      params.push(s.worldId);
      arms.push(
        `SELECT ${cols}, 1 AS pri FROM canon_edges e
           WHERE e.world_id = $${params.length} AND (e.subject = ANY($2) OR e.object = ANY($2)) AND ${live('e')}
             AND NOT EXISTS (
               SELECT 1 FROM chron_edges m WHERE m.story_id = $1
                 AND m.subject = e.subject AND m.predicate = e.predicate AND m.object = e.object
             )`,
      );
    }
    const { rows } = await this.db.query<EdgeRow>(`${arms.join(' UNION ALL ')}`, params);

    const wanted = new Set(unique);
    for (const r of rows) {
      const edge = toEdge(r);
      if (wanted.has(edge.subject)) out.get(edge.subject)!.push({ edge, otherId: edge.object });
      if (wanted.has(edge.object)) out.get(edge.object)!.push({ edge, otherId: edge.subject });
    }
    return out;
  }

  /**
   * Canon as the source material stated it, ignoring every story's
   * playthrough. Searched in source order so a crossover answers with the same
   * precedence the overlay would, minus the chronicle layer.
   */
  async getCanon(id: EntityId): Promise<Entity | undefined> {
    for (const s of this.sources) {
      const { rows } = await this.db.query<EntityRow>(
        `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene
           FROM canon_entities WHERE world_id = $1 AND id = $2 AND retired_at_revision IS NULL`,
        [s.worldId, id],
      );
      if (rows[0]) return toEntity(rows[0], 'canon');
    }
    return undefined;
  }

  async has(id: EntityId): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  /**
   * `layer` defaults to `'chronicle'`, which is what every play-time write
   * wants (copy-on-write over canon, scoped to this story). Ingest and
   * custom-world authoring pass `'canon'` explicitly — that path writes the
   * shared baseline every story reading this world will see, and requires the
   * ingest role.
   *
   * `ON CONFLICT` on the real primary key now, rather than on the
   * `COALESCE(story_id, '')` expression index the nullable-column design forced.
   */
  async upsert(
    e: Partial<Entity> & { id: EntityId; type: EntityType; name: string },
    layer: Layer = 'chronicle',
  ): Promise<void> {
    const table = layer === 'canon' ? 'canon_entities' : 'chron_entities';
    const scopeCol = layer === 'canon' ? 'world_id' : 'story_id';
    const scope: string | number = layer === 'canon' ? this.requireCanonWorld() : this.storyId;
    await this.db.query(
      `INSERT INTO ${table}
         (${scopeCol}, id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (${scopeCol}, id) DO UPDATE SET
         type = EXCLUDED.type,
         name = EXCLUDED.name,
         summary = EXCLUDED.summary,
         provenance = EXCLUDED.provenance,
         confidence = EXCLUDED.confidence,
         salience = EXCLUDED.salience,
         depth_level = EXCLUDED.depth_level,
         props = EXCLUDED.props,
         created_scene = EXCLUDED.created_scene`,
      [
        scope,
        e.id,
        e.type,
        e.name,
        e.summary ?? '',
        e.provenance ?? 'authored',
        e.confidence ?? 1,
        e.salience ?? 0.5,
        e.depthLevel ?? 0,
        JSON.stringify(e.props ?? {}),
        e.createdScene ?? 0,
      ],
    );
  }

  /**
   * Many entities in one statement — the ingest path's writer.
   *
   * Pass A processes up to 60,000 pages in a run, and `upsert` per row would be
   * 60,000 round trips. This batches into multi-row INSERTs of `BULK_ROWS`, which
   * turns a wiki ingest from "hours of latency" into a handful of statements per
   * thousand pages.
   *
   * Deliberately still an INSERT with ON CONFLICT rather than COPY: it goes through
   * the same constraint and type checking as any other write, so a malformed
   * extraction is rejected here instead of corrupting canon. Same tradeoff the
   * SQLite importer makes, and for the same reason.
   *
   * Same subtlety as `assertEdgesMany`: a batch can name the same entity id twice —
   * two wiki pages that normalise to one id (a redirect, a disambiguation variant,
   * a retitled article) are the common case — and Postgres refuses to
   * `ON CONFLICT DO UPDATE` the same row twice in one statement ("cannot affect row
   * a second time"). Duplicates are collapsed here, keeping the last occurrence,
   * which is what sequential `upsert` calls would have left behind.
   */
  async upsertMany(
    entities: Array<Partial<Entity> & { id: EntityId; type: EntityType; name: string }>,
    layer: Layer = 'chronicle',
  ): Promise<number> {
    if (!entities.length) return 0;
    const table = layer === 'canon' ? 'canon_entities' : 'chron_entities';
    const scopeCol = layer === 'canon' ? 'world_id' : 'story_id';
    const scope: string | number = layer === 'canon' ? this.requireCanonWorld() : this.storyId;
    const cols = `${scopeCol}, id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene`;

    // Collapse to one row per id, last write winning. `scope` is constant for the
    // whole call, so the id alone is the conflict identity.
    const unique = new Map<EntityId, (typeof entities)[number]>();
    for (const e of entities) unique.set(e.id, e);
    const rows = [...unique.values()];

    let written = 0;
    for (let i = 0; i < rows.length; i += BULK_ROWS) {
      const chunk = rows.slice(i, i + BULK_ROWS);
      const params: unknown[] = [];
      const tuples = chunk.map((e) => {
        const base = params.length;
        params.push(
          scope,
          e.id,
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
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10}::jsonb,$${base + 11})`;
      });
      const res = await this.db.query(
        `INSERT INTO ${table} (${cols}) VALUES ${tuples.join(',')}
         ON CONFLICT (${scopeCol}, id) DO UPDATE SET
           type = EXCLUDED.type,
           name = EXCLUDED.name,
           summary = EXCLUDED.summary,
           provenance = EXCLUDED.provenance,
           confidence = EXCLUDED.confidence,
           salience = EXCLUDED.salience,
           depth_level = EXCLUDED.depth_level,
           props = EXCLUDED.props,
           created_scene = EXCLUDED.created_scene`,
        params,
      );
      written += res.rowCount ?? 0;
    }
    return written;
  }

  async list(
    opts: { type?: EntityType; layer?: Layer; limit?: number; minSalience?: number } = {},
  ): Promise<Entity[]> {
    // A layer filter bypasses the overlay entirely: the caller is asking about
    // one layer specifically ("what does canon say", "what has this story
    // changed"), which is a different question from "what does this story see".
    if (opts.layer === 'chronicle') {
      const { rows } = await this.db.query<EntityRow>(
        `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene
           FROM chron_entities WHERE story_id = $1
           ${opts.type ? 'AND type = $3' : ''}
           ${opts.minSalience !== undefined ? `AND salience >= $${opts.type ? 4 : 3}` : ''}
           ORDER BY salience DESC, name LIMIT $2`,
        [
          this.storyId,
          opts.limit ?? 500,
          ...(opts.type ? [opts.type] : []),
          ...(opts.minSalience !== undefined ? [opts.minSalience] : []),
        ],
      );
      return rows.map((r) => toEntity(r, 'chronicle'));
    }
    if (opts.layer === 'canon') {
      const out: Entity[] = [];
      for (const s of this.sources) {
        const { rows } = await this.db.query<EntityRow>(
          `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene
             FROM canon_entities WHERE world_id = $1 AND retired_at_revision IS NULL
             ${opts.type ? 'AND type = $3' : ''}
             ${opts.minSalience !== undefined ? `AND salience >= $${opts.type ? 4 : 3}` : ''}
             ORDER BY salience DESC, name LIMIT $2`,
          [
            s.worldId,
            opts.limit ?? 500,
            ...(opts.type ? [opts.type] : []),
            ...(opts.minSalience !== undefined ? [opts.minSalience] : []),
          ],
        );
        out.push(...rows.map((r) => toEntity(r, 'canon')));
      }
      return out
        .sort((a, b) => b.salience - a.salience || a.name.localeCompare(b.name))
        .slice(0, opts.limit ?? 500);
    }

    const rows = await overlayEntities<EntityRow>(this.db, this.storyId, this.sources, {
      limit: opts.limit ?? 500,
      type: opts.type,
      minSalience: opts.minSalience,
    });
    return rows.map((r) => toEntity(r));
  }

  /**
   * Substring search over name, id and summary. Unchanged in behaviour from the
   * SQLite version, including that it *does* match `summary` — which is why
   * `resolveName` below deliberately does not use it.
   */
  async search(q: string, limit = 20): Promise<Entity[]> {
    const like = `%${q.toLowerCase()}%`;
    const arms: string[] = [
      `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene, 0 AS pri
         FROM chron_entities WHERE story_id = $1
           AND (lower(name) LIKE $2 OR lower(id) LIKE $2 OR lower(summary) LIKE $2)`,
    ];
    const params: unknown[] = [this.storyId, like];
    for (const s of this.sources) {
      params.push(s.worldId, s.ordinal);
      arms.push(
        `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene, $${params.length} AS pri
           FROM canon_entities WHERE world_id = $${params.length - 1} AND retired_at_revision IS NULL
             AND (lower(name) LIKE $2 OR lower(id) LIKE $2 OR lower(summary) LIKE $2)`,
      );
    }
    params.push(limit);
    const { rows } = await this.db.query<EntityRow>(
      `SELECT DISTINCT ON (id) * FROM (${arms.join(' UNION ALL ')}) q
         ORDER BY id, pri`,
      params.slice(0, -1),
    );
    return rows
      .map((r) => toEntity(r))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit);
  }

  /**
   * Resolves a name from prose or a wikilink to the entity it refers to, or
   * nothing.
   *
   * Two steps, both exact: the name as written, then the name normalised
   * (case, punctuation, a leading article, a trailing "(disambiguator)").
   * There is deliberately no similarity fallback.
   *
   * There used to be one — `search(name, 1)`, top hit, no score threshold —
   * and it was actively harmful, because `search` also matches `summary`.
   * Pass B mints Event nodes whose `name` is the first 70 characters of an
   * event sentence and whose summary is the whole thing, so those nodes matched
   * almost any common proper noun and outranked the real article by salience.
   * Measured on one wiki ingest: ~15,700 edges, 14,205 of them wikilink
   * `MENTIONS`, had been attached to synthetic event nodes instead of the
   * entities they name — wrong edges, and they poison the relevance signal that
   * decides what the Narrator is shown.
   *
   * So an unresolvable name resolves to nothing and the caller drops the edge.
   * Pass B counts and reports that (`droppedUnknownObject`), which is a far
   * better outcome than a confident wrong target: a missing edge is visible, an
   * incorrect one is not.
   */
  async resolveName(name: string): Promise<Entity | undefined> {
    const raw = name.trim();
    if (!raw) return undefined;

    const exact = await this.byNamePredicate(`lower(name) = $2`, raw.toLowerCase(), 1);
    if (exact[0]) return exact[0];

    const norm = normaliseName(raw);
    if (!norm) return undefined;

    // Candidates by substring on `name` only — never `summary` — and never an
    // Event: a synthetic event's name is a sentence fragment, so it can only
    // match a referent by accident. A page-derived Event with a real title
    // ("Battle of the Citadel") still resolves through the exact match above.
    const candidates = await this.byNamePredicate(`lower(name) LIKE $2 AND type <> 'Event'`, `%${norm}%`, 25);
    for (const c of candidates) {
      if (normaliseName(c.name) === norm) return c;
    }
    return undefined;
  }

  /** Shared by `resolveName`'s two passes: one predicate, overlay precedence. */
  private async byNamePredicate(predicate: string, value: string, limit: number): Promise<Entity[]> {
    const cols = 'id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene';
    const params: unknown[] = [this.storyId, value];
    const arms = [`SELECT ${cols}, 0 AS pri FROM chron_entities WHERE story_id = $1 AND ${predicate}`];
    for (const s of this.sources) {
      params.push(s.worldId, s.ordinal);
      arms.push(
        `SELECT ${cols}, $${params.length} AS pri FROM canon_entities
           WHERE world_id = $${params.length - 1} AND retired_at_revision IS NULL AND ${predicate}`,
      );
    }
    const { rows } = await this.db.query<EntityRow>(
      `SELECT DISTINCT ON (id) * FROM (${arms.join(' UNION ALL ')}) q ORDER BY id, pri`,
      params,
    );
    return rows
      .map((r) => toEntity(r))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit);
  }

  /**
   * Salience is play-time and per-story: bumping it copy-on-writes a chronicle
   * row over canon (mirroring `upsert`), so one story's attention never
   * brightens or dims what another story reading the same canon sees.
   */
  async setSalience(id: EntityId, salience: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, salience));
    const cur = await this.get(id);
    if (!cur) return;
    await this.upsert({ ...cur, salience: clamped }, 'chronicle');
  }

  /** Entities cool unless touched, so the frame does not fill with people who left. */
  async decaySalience(rate = 0.06, floor = 0.05): Promise<void> {
    // Only this story's own chronicle rows decay. An untouched canon entity
    // sits at its ingested baseline until this story's play actually raises it
    // (via bumpSalience, which creates the chronicle row) — there is nothing to
    // cool until then. It is also the only table this role may write.
    await this.db.query(
      `UPDATE chron_entities SET salience = GREATEST($1, salience - $2) WHERE story_id = $3`,
      [floor, rate, this.storyId],
    );
  }

  async bumpSalience(ids: EntityId[], amount = 0.35): Promise<void> {
    for (const id of ids) {
      const cur = await this.get(id);
      if (!cur) continue;
      await this.upsert({ ...cur, salience: Math.min(1, cur.salience + amount) }, 'chronicle');
    }
  }

  /**
   * Canon first, across every source, then this story's chronicle.
   *
   * A canon write, so it needs the ingest role — `deepenOnDemand` reaches this
   * during play, which the split reclassifies as a system-data write rather
   * than a play-time one. That is the correct reading: how deeply the source
   * material has been read is a property of the ingest.
   */
  async setDepth(id: EntityId, depth: DepthLevelValue): Promise<void> {
    for (const s of this.sources) {
      const res = await this.db.query(
        `UPDATE canon_entities SET depth_level = GREATEST(depth_level, $1) WHERE world_id = $2 AND id = $3`,
        [depth, s.worldId, id],
      );
      if ((res.rowCount ?? 0) > 0) return;
    }
    // Emergent: exists only in this story, so canon matched nothing.
    await this.db.query(
      `UPDATE chron_entities SET depth_level = GREATEST(depth_level, $1) WHERE story_id = $2 AND id = $3`,
      [depth, this.storyId, id],
    );
  }

  async belowDepth(target: DepthLevelValue, limit = 200): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const s of this.sources) {
      const { rows } = await this.db.query<EntityRow>(
        `SELECT id, type, name, summary, provenance, confidence, salience, depth_level, props, created_scene
           FROM canon_entities WHERE world_id = $1 AND depth_level < $2 AND retired_at_revision IS NULL
           ORDER BY salience DESC LIMIT $3`,
        [s.worldId, target, limit],
      );
      out.push(...rows.map((r) => toEntity(r, 'canon')));
    }
    return out.sort((a, b) => b.salience - a.salience).slice(0, limit);
  }

  // ---------------------------------------------------------------- edges

  /**
   * Live edges at a point in story time. `valid_to IS NULL OR valid_to > scene`
   * is what makes "who is their ally *now*" a time-filtered traversal.
   */
  async edgesFrom(subject: EntityId, scene?: number): Promise<Edge[]> {
    const rows = await overlayEdges<EdgeRow>(this.db, this.storyId, this.sources, { subject, scene });
    return rows.map((r) => toEdge(r));
  }

  async edgesTo(object: EntityId, scene?: number): Promise<Edge[]> {
    const rows = await overlayEdges<EdgeRow>(this.db, this.storyId, this.sources, { object, scene });
    return rows.map((r) => toEdge(r));
  }

  /** Undirected adjacency, for propagation and frame neighbourhoods. */
  async neighbours(id: EntityId, scene?: number): Promise<Array<{ edge: Edge; otherId: EntityId }>> {
    const out = (await this.edgesFrom(id, scene)).map((edge) => ({ edge, otherId: edge.object }));
    const inn = (await this.edgesTo(id, scene)).map((edge) => ({ edge, otherId: edge.subject }));
    return [...out, ...inn];
  }

  /**
   * `layer` defaults to `'chronicle'` (this story's assertion). Canon edges
   * (ingest, custom-world authoring) pass `'canon'` explicitly.
   *
   * `ON CONFLICT` against the partial unique index on live edges, which is what
   * the schema uses to express "one live edge per identity" — so re-asserting an
   * existing live edge updates its weight rather than duplicating it, in one
   * statement instead of the select-then-branch the SQLite version needed.
   */
  async assertEdge(
    a: EdgeAssert,
    scene: number,
    layer: Layer = 'chronicle',
    provenance = 'authored',
  ): Promise<void> {
    const table = layer === 'canon' ? 'canon_edges' : 'chron_edges';
    const scopeCol = layer === 'canon' ? 'world_id' : 'story_id';
    const scope: string | number = layer === 'canon' ? this.requireCanonWorld() : this.storyId;
    await this.db.query(
      `INSERT INTO ${table}
         (${scopeCol}, subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,1,$8)
       ON CONFLICT (${scopeCol}, subject, predicate, object) WHERE valid_to IS NULL
       DO UPDATE SET weight = EXCLUDED.weight, evidence = COALESCE(EXCLUDED.evidence, ${table}.evidence)`,
      [scope, a.subject, a.predicate, a.object, scene, a.weight ?? 0.5, provenance, a.evidence ?? null],
    );
  }

  /**
   * Many edges in one statement — the ingest path's edge writer.
   *
   * Pass A emits far more edges than entities (the real Star Trek ingest produced
   * 152,456 canon edges from 33,332 entities), so this is the single hottest write
   * in the system and one query per edge would dominate an ingest completely.
   *
   * One subtlety: a batch can contain the same (subject, predicate, object) twice —
   * two infobox fields on one page can imply the same relation — and Postgres
   * refuses to `ON CONFLICT DO UPDATE` the same row twice in one statement
   * ("cannot affect row a second time"). Duplicates are therefore collapsed here,
   * keeping the last occurrence, which matches what sequential `assertEdge` calls
   * would have left behind.
   */
  async assertEdgesMany(
    edges: EdgeAssert[],
    scene: number,
    layer: Layer = 'chronicle',
    provenance = 'authored',
  ): Promise<number> {
    if (!edges.length) return 0;
    const table = layer === 'canon' ? 'canon_edges' : 'chron_edges';
    const scopeCol = layer === 'canon' ? 'world_id' : 'story_id';
    const scope: string | number = layer === 'canon' ? this.requireCanonWorld() : this.storyId;

    // Collapse to one row per identity, last write winning.
    const unique = new Map<string, EdgeAssert>();
    for (const e of edges) unique.set(`${e.subject}\u0000${e.predicate}\u0000${e.object}`, e);
    const rows = [...unique.values()];

    let written = 0;
    for (let i = 0; i < rows.length; i += BULK_ROWS) {
      const chunk = rows.slice(i, i + BULK_ROWS);
      const params: unknown[] = [];
      const tuples = chunk.map((a) => {
        const base = params.length;
        params.push(scope, a.subject, a.predicate, a.object, scene, a.weight ?? 0.5, provenance, a.evidence ?? null);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},NULL,$${base + 6},$${base + 7},1,$${base + 8})`;
      });
      const res = await this.db.query(
        `INSERT INTO ${table}
           (${scopeCol}, subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence)
         VALUES ${tuples.join(',')}
         ON CONFLICT (${scopeCol}, subject, predicate, object) WHERE valid_to IS NULL
         DO UPDATE SET weight = EXCLUDED.weight, evidence = COALESCE(EXCLUDED.evidence, ${table}.evidence)`,
        params,
      );
      written += res.rowCount ?? 0;
    }
    return written;
  }

  /**
   * Expire rather than delete: history is kept for free. Retiring a live canon
   * edge is a per-story act (this story's chronicle now disagrees with canon
   * about it), so it copies the edge into this story's chronicle as
   * already-expired rather than mutating the shared canon row — which the play
   * role could not do anyway. Other stories keep seeing it live.
   */
  async retireEdge(subject: EntityId, predicate: string, object: EntityId, scene: number): Promise<boolean> {
    const own = await this.db.query(
      `UPDATE chron_edges SET valid_to = $1
         WHERE story_id = $2 AND subject = $3 AND predicate = $4 AND object = $5 AND valid_to IS NULL`,
      [scene, this.storyId, subject, predicate, object],
    );
    if ((own.rowCount ?? 0) > 0) return true;

    for (const s of this.sources) {
      const { rows } = await this.db.query<{
        weight: number;
        provenance: string;
        confidence: number;
        evidence: string | null;
        valid_from: number;
      }>(
        `SELECT weight, provenance, confidence, evidence, valid_from FROM canon_edges
           WHERE world_id = $1 AND subject = $2 AND predicate = $3 AND object = $4 AND valid_to IS NULL`,
        [s.worldId, subject, predicate, object],
      );
      const canonLive = rows[0];
      if (!canonLive) continue;
      await this.db.query(
        `INSERT INTO chron_edges
           (story_id, subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          this.storyId,
          subject,
          predicate,
          object,
          canonLive.valid_from,
          scene,
          canonLive.weight,
          canonLive.provenance,
          canonLive.confidence,
          canonLive.evidence,
        ],
      );
      return true;
    }
    return false;
  }

  /** Every edge this story sees, for the graph view. */
  async allEdges(limit = 2000): Promise<Edge[]> {
    const cols = 'subject, predicate, object, valid_from, valid_to, weight, provenance, confidence, evidence';
    const params: unknown[] = [this.storyId];
    const arms = [`SELECT ${cols}, 0 AS pri FROM chron_edges WHERE story_id = $1`];
    for (const s of this.sources) {
      params.push(s.worldId);
      arms.push(
        `SELECT ${cols}, 1 AS pri FROM canon_edges e WHERE e.world_id = $${params.length}
           AND NOT EXISTS (
             SELECT 1 FROM chron_edges m WHERE m.story_id = $1
               AND m.subject = e.subject AND m.predicate = e.predicate AND m.object = e.object
           )`,
      );
    }
    params.push(limit);
    const { rows } = await this.db.query<EdgeRow>(
      `SELECT * FROM (${arms.join(' UNION ALL ')}) q LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => toEdge(r));
  }

  /**
   * Whether this story sees any entity at all — the "is this world fresh?"
   * question the setup gate needs.
   *
   * Existence, not a count. Under SQLite the predicate was
   * `story_id = ? OR layer = 'canon'`, which no index could serve, so counting
   * it was a full table scan measured at 141 ms cold on a 30 MB world and paid
   * on every UI refresh. Here both arms are indexed primary-key lookups, but
   * `EXISTS` is still the right question to ask.
   */
  async isEmpty(): Promise<boolean> {
    // Each arm is its own EXISTS, OR-ed together, rather than
    // `SELECT 1 ... LIMIT 1 UNION ALL SELECT 1 ... LIMIT 1`: a bare LIMIT inside
    // a UNION arm is a syntax error in Postgres (`syntax error at or near
    // "UNION"`), which is how this was caught. EXISTS also short-circuits per
    // arm, which is the actual intent.
    const params: unknown[] = [this.storyId];
    const arms = [`EXISTS (SELECT 1 FROM chron_entities WHERE story_id = $1)`];
    for (const s of this.sources) {
      params.push(s.worldId);
      arms.push(
        `EXISTS (SELECT 1 FROM canon_entities WHERE world_id = $${params.length} AND retired_at_revision IS NULL)`,
      );
    }
    const { rows } = await this.db.query<{ any_rows: boolean }>(
      `SELECT (${arms.join(' OR ')}) AS any_rows`,
      params,
    );
    return !rows[0]?.any_rows;
  }

  async counts(): Promise<{ entities: number; edges: number; canon: number; chronicle: number }> {
    const worldIds = this.sources.map((s) => s.worldId);
    const { rows } = await this.db.query<{ canon: string; canon_edges: string; chron: string; chron_edges: string }>(
      `SELECT
         (SELECT count(*) FROM canon_entities WHERE world_id = ANY($1) AND retired_at_revision IS NULL) canon,
         (SELECT count(*) FROM canon_edges    WHERE world_id = ANY($1)) canon_edges,
         (SELECT count(*) FROM chron_entities WHERE story_id = $2) chron,
         (SELECT count(*) FROM chron_edges    WHERE story_id = $2) chron_edges`,
      [worldIds, this.storyId],
    );
    const r = rows[0]!;
    const canon = Number(r.canon);
    const chronicle = Number(r.chron);
    // `entities` counts distinct ids across the overlay, so a diverged entity is
    // one entity, not two. Computed rather than summed for that reason.
    const distinct = await this.db.query<{ n: string }>(
      `SELECT count(*) n FROM (
         SELECT id FROM chron_entities WHERE story_id = $2
         UNION
         SELECT id FROM canon_entities WHERE world_id = ANY($1) AND retired_at_revision IS NULL
       ) q`,
      [worldIds, this.storyId],
    );
    return {
      entities: Number(distinct.rows[0]!.n),
      edges: Number(r.canon_edges) + Number(r.chron_edges),
      canon,
      chronicle,
    };
  }
}

/**
 * The only latitude `resolveName` allows: case, surrounding punctuation, a
 * leading article, and a wiki-style "(disambiguator)" suffix. Two names that
 * normalise to the same string are the same referent; anything else is a guess
 * and is refused.
 */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\u2019']s\b/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/, '');
}
