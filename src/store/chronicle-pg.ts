/**
 * Chronicle store, Postgres: events, turns, scenes, facts, and the divergence
 * ledger. Epistemic state lives here because "who knows what" is
 * chronicle-scoped. See DESIGN.md §2 and §6.3.
 *
 * Everything here is story-scoped — this is the store with no canon layer at
 * all, so nothing in it needs the overlay. That is why it converts to Postgres
 * almost mechanically: only the dialect changes.
 *
 * ## Two behavioural notes worth keeping
 *
 * **`meta` moved and changed meaning.** The SQLite version's `getMeta`/`setMeta`
 * wrote a file-global `meta` table, which held `worldTitle` and `ingestContext`.
 * That was wrong the moment one story could compose two fandoms, and
 * `.design/DBFIXES.md` asked for the decision to be recorded: world identity now
 * lives on `worlds.title`/`worlds.ingest_context`, and anything else a world
 * needs to remember goes in `world_meta` keyed by `world_id`. So these methods
 * take a world id, and a story with several sources must say which world it
 * means rather than writing to a global key that would silently belong to
 * whichever world was ingested last.
 *
 * **`participants` membership is a jsonb containment test.** Under SQLite this
 * had to be `json_each`, after `LIKE '%id%'` was found matching any id the
 * target was a prefix of — searching `char:tem` also returned events whose only
 * participant was `char:tem-the-elder`. That was reproduced directly rather than
 * inferred, and it mattered because this is the POV mask: a false positive hands
 * the Narrator an event the player never saw. Here `participants @> $2::jsonb`
 * is both correct and served by a GIN index.
 */
import { randomUUID } from 'node:crypto';
import { jsonGet, type Queryable } from '../db/pg.ts';
import type {
  Delta,
  EntityId,
  Fact,
  FactId,
  FactKnowledge,
  KnowledgeLevel,
  StoryEvent,
  StoryId,
  Turn,
  TurnMeta,
  Visibility,
} from '../domain/types.ts';

interface EventRow {
  id: string;
  scene: number;
  turn: number;
  text: string;
  participants: unknown;
  location_id: string | null;
  significance: number;
  visibility: Visibility;
  from_consequence_id: string | null;
}

interface TurnRow {
  id: string;
  scene: number;
  turn: number;
  raw_input: string;
  intent: unknown;
  delta: unknown;
  book_prose: string;
  pinned: boolean;
  meta: unknown;
  created_at: Date | string;
}

function toEvent(r: EventRow): StoryEvent {
  return {
    id: r.id,
    scene: r.scene,
    turn: r.turn,
    text: r.text,
    participants: jsonGet<EntityId[]>(r.participants, []),
    locationId: r.location_id,
    significance: r.significance,
    visibility: r.visibility,
    fromConsequenceId: r.from_consequence_id,
  };
}

/**
 * `TIMESTAMPTZ` comes back as a Date. Callers (the API, the book view, MCP)
 * expect the ISO string the SQLite version stored, so it is normalised here
 * rather than at each of them.
 */
function isoOf(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function toTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    scene: r.scene,
    turn: r.turn,
    rawInput: r.raw_input,
    intent: r.intent ? jsonGet(r.intent, null) : null,
    delta: r.delta ? jsonGet<Delta | null>(r.delta, null) : null,
    bookProse: r.book_prose,
    pinned: r.pinned,
    meta: jsonGet<TurnMeta>(r.meta, {
      integrity: null,
      referee: null,
      move: null,
      frameLog: null,
      lint: null,
      providerCalls: [],
    }),
    createdAt: isoOf(r.created_at),
  };
}

const EVENT_COLS = 'id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id';
const TURN_COLS = 'id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at';

export interface ChronicleStoreOptions {
  db: Queryable;
  storyId: StoryId;
  /** For `getMeta`/`setMeta`, which are world-level rather than story-level. */
  worldId?: number;
}

export class ChronicleStore {
  private db: Queryable;
  private storyId: StoryId;
  private worldId: number | undefined;

  constructor(opts: ChronicleStoreOptions) {
    this.db = opts.db;
    this.storyId = opts.storyId;
    this.worldId = opts.worldId;
  }

  // --------------------------------------------------------------- events

  async addEvent(e: Omit<StoryEvent, 'id'> & { id?: string }): Promise<StoryEvent> {
    const id = e.id ?? `ev:${randomUUID()}`;
    await this.db.query(
      `INSERT INTO events (id, story_id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        id,
        this.storyId,
        e.scene,
        e.turn,
        e.text,
        JSON.stringify(e.participants),
        e.locationId,
        e.significance,
        e.visibility,
        e.fromConsequenceId,
      ],
    );
    return { ...e, id };
  }

  async events(
    opts: { limit?: number; sinceScene?: number; visibility?: Visibility[] } = {},
  ): Promise<StoryEvent[]> {
    const where: string[] = ['story_id = $1'];
    const args: unknown[] = [this.storyId];
    if (opts.sinceScene !== undefined) {
      args.push(opts.sinceScene);
      where.push(`scene >= $${args.length}`);
    }
    if (opts.visibility?.length) {
      // `= ANY($n)` rather than an IN list built from placeholders: one
      // parameter regardless of how many values, so the statement text is stable
      // and Postgres can reuse its plan.
      args.push(opts.visibility);
      where.push(`visibility = ANY($${args.length})`);
    }
    args.push(opts.limit ?? 100);
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY scene, turn LIMIT $${args.length}`,
      args,
    );
    return rows.map(toEvent);
  }

  /**
   * Events the player character actually witnessed, for POV-safe recall.
   *
   * See this file's header for why membership is a containment test rather than
   * a substring match, and why that distinction is a correctness issue in the
   * epistemic layer rather than a tidiness one.
   */
  async witnessedEvents(playerId: EntityId, limit = 40): Promise<StoryEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM events
         WHERE story_id = $1 AND visibility = 'onscreen' AND participants @> $2::jsonb
         ORDER BY scene DESC, turn DESC LIMIT $3`,
      [this.storyId, JSON.stringify([playerId]), limit],
    );
    return rows.map(toEvent).reverse();
  }

  // ---------------------------------------------------------------- turns

  async addTurn(t: Omit<Turn, 'id' | 'createdAt'> & { id?: string }): Promise<Turn> {
    const id = t.id ?? `turn:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    await this.db.query(
      `INSERT INTO turns (id, story_id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11)`,
      [
        id,
        this.storyId,
        t.scene,
        t.turn,
        t.rawInput,
        t.intent ? JSON.stringify(t.intent) : null,
        t.delta ? JSON.stringify(t.delta) : null,
        t.bookProse,
        t.pinned,
        JSON.stringify(t.meta),
        createdAt,
      ],
    );
    return { ...t, id, createdAt };
  }

  async turns(opts: { scene?: number; limit?: number } = {}): Promise<Turn[]> {
    if (opts.scene !== undefined) {
      const { rows } = await this.db.query<TurnRow>(
        `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 AND scene = $2 ORDER BY turn`,
        [this.storyId, opts.scene],
      );
      return rows.map(toTurn);
    }
    const { rows } = await this.db.query<TurnRow>(
      `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 ORDER BY scene, turn LIMIT $2`,
      [this.storyId, opts.limit ?? 500],
    );
    return rows.map(toTurn);
  }

  async recentTurns(n: number): Promise<Turn[]> {
    const { rows } = await this.db.query<TurnRow>(
      `SELECT ${TURN_COLS} FROM turns WHERE story_id = $1 ORDER BY scene DESC, turn DESC LIMIT $2`,
      [this.storyId, n],
    );
    return rows.map(toTurn).reverse();
  }

  async getTurn(id: string): Promise<Turn | undefined> {
    const { rows } = await this.db.query<TurnRow>(
      `SELECT ${TURN_COLS} FROM turns WHERE id = $1 AND story_id = $2`,
      [id, this.storyId],
    );
    return rows[0] ? toTurn(rows[0]) : undefined;
  }

  /**
   * Sums every provider call recorded across every turn's meta. Per-turn calls
   * are logged and shown in the why panel; nothing accumulated them, which on a
   * paid provider is exactly the number a player wants without doing the sum
   * themselves.
   *
   * Still summed in JS rather than pushed into SQL. It could be a
   * `jsonb_array_elements` aggregate, but the shape of `providerCalls` is a
   * TypeScript type that has changed twice; keeping the traversal here means the
   * types stay the single source of truth and a shape change cannot silently
   * produce wrong totals from a stale SQL projection.
   */
  async usageTotals(): Promise<{
    tokensIn: number;
    tokensOut: number;
    calls: number;
    byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }>;
  }> {
    const total = { tokensIn: 0, tokensOut: 0, calls: 0 };
    const byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }> = {};
    const { rows } = await this.db.query<{ meta: unknown }>(`SELECT meta FROM turns WHERE story_id = $1`, [
      this.storyId,
    ]);
    for (const r of rows) {
      const meta = jsonGet<TurnMeta | null>(r.meta, null);
      for (const c of meta?.providerCalls ?? []) {
        total.tokensIn += c.tokensIn;
        total.tokensOut += c.tokensOut;
        total.calls += 1;
        const acc = (byRole[c.role] ??= { tokensIn: 0, tokensOut: 0, calls: 0 });
        acc.tokensIn += c.tokensIn;
        acc.tokensOut += c.tokensOut;
        acc.calls += 1;
      }
    }
    return { ...total, byRole };
  }

  /** Re-render changes how it is told, never what happened (DESIGN §7.2). */
  async setProse(id: string, prose: string): Promise<void> {
    await this.db.query(`UPDATE turns SET book_prose = $1 WHERE id = $2 AND story_id = $3 AND NOT pinned`, [
      prose,
      id,
      this.storyId,
    ]);
  }

  /**
   * Records a reroll's own provider calls and lint result onto the turn's stored
   * meta, so the why panel reflects the render actually on the page rather than
   * the original turn's now-stale one. Guarded by `NOT pinned` for the same
   * reason `setProse` is: a pinned turn's meta is part of the passage the author
   * chose to keep.
   */
  async appendRerollMeta(
    id: string,
    patch: { providerCalls: TurnMeta['providerCalls']; lint: TurnMeta['lint'] },
  ): Promise<void> {
    const turn = await this.getTurn(id);
    if (!turn || turn.pinned) return;
    const meta: TurnMeta = {
      ...turn.meta,
      providerCalls: [...turn.meta.providerCalls, ...patch.providerCalls],
      lint: patch.lint,
    };
    await this.db.query(`UPDATE turns SET meta = $1::jsonb WHERE id = $2 AND story_id = $3 AND NOT pinned`, [
      JSON.stringify(meta),
      id,
      this.storyId,
    ]);
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.query(`UPDATE turns SET pinned = $1 WHERE id = $2 AND story_id = $3`, [
      pinned,
      id,
      this.storyId,
    ]);
  }

  // --------------------------------------------------------------- scenes

  async upsertScene(
    scene: number,
    patch: { title?: string; summary?: string; locationId?: string | null; chapter?: number },
  ): Promise<void> {
    // `NULLIF(..., '')` keeps a blank patch from erasing an existing title or
    // summary: the compactor writes summaries and the wizard writes titles, and
    // either may upsert the same scene without knowing the other's field.
    await this.db.query(
      `INSERT INTO scenes (story_id, scene, title, summary, location_id, chapter) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (story_id, scene) DO UPDATE SET
         title = COALESCE(NULLIF(EXCLUDED.title,''), scenes.title),
         summary = COALESCE(NULLIF(EXCLUDED.summary,''), scenes.summary),
         location_id = COALESCE(EXCLUDED.location_id, scenes.location_id),
         chapter = EXCLUDED.chapter`,
      [this.storyId, scene, patch.title ?? '', patch.summary ?? '', patch.locationId ?? null, patch.chapter ?? 1],
    );
  }

  async scenes(): Promise<
    Array<{ scene: number; title: string; summary: string; locationId: string | null; chapter: number }>
  > {
    const { rows } = await this.db.query<{
      scene: number;
      title: string;
      summary: string;
      location_id: string | null;
      chapter: number;
    }>(`SELECT scene, title, summary, location_id, chapter FROM scenes WHERE story_id = $1 ORDER BY scene`, [
      this.storyId,
    ]);
    return rows.map((r) => ({
      scene: r.scene,
      title: r.title,
      summary: r.summary,
      locationId: r.location_id,
      chapter: r.chapter,
    }));
  }

  async upsertChapter(chapter: number, patch: { title?: string; summary?: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO chapters (story_id, chapter, title, summary) VALUES ($1,$2,$3,$4)
       ON CONFLICT (story_id, chapter) DO UPDATE SET
         title = COALESCE(NULLIF(EXCLUDED.title,''), chapters.title),
         summary = COALESCE(NULLIF(EXCLUDED.summary,''), chapters.summary)`,
      [this.storyId, chapter, patch.title ?? '', patch.summary ?? ''],
    );
  }

  async chapter(chapter: number): Promise<{ chapter: number; title: string; summary: string } | undefined> {
    const { rows } = await this.db.query<{ chapter: number; title: string; summary: string }>(
      `SELECT chapter, title, summary FROM chapters WHERE story_id = $1 AND chapter = $2`,
      [this.storyId, chapter],
    );
    return rows[0];
  }

  async chapters(): Promise<Array<{ chapter: number; title: string; summary: string }>> {
    const { rows } = await this.db.query<{ chapter: number; title: string; summary: string }>(
      `SELECT chapter, title, summary FROM chapters WHERE story_id = $1 ORDER BY chapter`,
      [this.storyId],
    );
    return rows;
  }

  // ----------------------------------------------------------------- meta
  // World-level, and now explicitly per world rather than per file — see this
  // file's header for why a global key was wrong once a story could read two
  // worlds.

  /**
   * The world these keys belong to: the one passed in, else this story's
   * primary source read from `story_sources`.
   *
   * The fallback is the same one `GraphStore`/`CastStore` apply to
   * `canonWorldId`, just resolved later. It is needed because `World` reads
   * `story_sources` *once*, when it builds the stores, so a store built before
   * the story was bound to a world held `undefined` while the answer sat in the
   * table — and this was the only store that turned that into a throw. Setting
   * up a fresh story died on it: an ingest at its very first
   * `setMeta('worldTitle')`, an authored world at its very last, after the whole
   * world had been invented and written.
   *
   * Still never a *guess*. Resolving means reading the binding the story
   * already has; with no binding this throws exactly as before, because writing
   * world identity to an arbitrary world is how `worldTitle` ended up
   * describing the wrong one in the SQLite data (`star-trek-alpha-beta` carries
   * the title "Saint Verrow" to this day). Choosing a world when there is none
   * is `ensureCanonWorldFor`'s job, one layer up.
   */
  private async resolveWorld(): Promise<number | undefined> {
    if (this.worldId !== undefined) return this.worldId;
    const { rows } = await this.db.query<{ world_id: string }>(
      `SELECT world_id FROM story_sources WHERE story_id = $1 ORDER BY ordinal LIMIT 1`,
      [this.storyId],
    );
    if (rows[0]) this.worldId = Number(rows[0].world_id);
    return this.worldId;
  }

  private async requireWorld(): Promise<number> {
    const worldId = await this.resolveWorld();
    if (worldId === undefined) {
      throw new Error(
        `no world for story ${this.storyId}: world-level meta needs a target world (story_sources is empty, or pass worldId)`,
      );
    }
    return worldId;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO world_meta (world_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (world_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [await this.requireWorld(), key, value],
    );
  }

  async getMeta(key: string, fallback = ''): Promise<string> {
    const worldId = await this.resolveWorld();
    if (worldId === undefined) return fallback;
    const { rows } = await this.db.query<{ value: string }>(
      `SELECT value FROM world_meta WHERE world_id = $1 AND key = $2`,
      [worldId, key],
    );
    return rows[0]?.value ?? fallback;
  }

  // ---------------------------------------------------------------- facts

  async addFact(text: string, scene: number): Promise<Fact> {
    const id = `fact:${randomUUID()}`;
    await this.db.query(`INSERT INTO facts (id, story_id, text, scene) VALUES ($1,$2,$3,$4)`, [
      id,
      this.storyId,
      text,
      scene,
    ]);
    return { id, text, scene, layer: 'chronicle' };
  }

  async facts(limit = 200): Promise<Fact[]> {
    const { rows } = await this.db.query<{ id: string; text: string; scene: number }>(
      `SELECT id, text, scene FROM facts WHERE story_id = $1 ORDER BY scene DESC LIMIT $2`,
      [this.storyId, limit],
    );
    return rows.map((r) => ({ ...r, layer: 'chronicle' as const }));
  }

  /**
   * Records that an entity knows, suspects, or holds a distorted version of a
   * fact. Distortion rises with transmission hops (DESIGN §6.3).
   *
   * Not scoped by story_id directly — it inherits scope through `fact_id`, which
   * is already story-scoped via `facts`, and now enforced by a real foreign key
   * rather than by convention.
   *
   * `LEAST` on conflict, so learning a fact more directly can only *reduce*
   * distortion: hearing something first-hand after a rumour corrects the rumour,
   * it does not re-muddy it.
   */
  async setKnowledge(
    factId: FactId,
    entityId: EntityId,
    level: KnowledgeLevel,
    scene: number,
    distortion = 0,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fact_id, entity_id) DO UPDATE SET
         level = EXCLUDED.level,
         distortion = LEAST(fact_knowledge.distortion, EXCLUDED.distortion)`,
      [factId, entityId, level, scene, distortion],
    );
  }

  async knowledgeOf(entityId: EntityId): Promise<Array<FactKnowledge & { text: string }>> {
    const { rows } = await this.db.query<{
      fact_id: string;
      entity_id: string;
      level: KnowledgeLevel;
      since_scene: number;
      distortion: number;
      text: string;
    }>(
      `SELECT k.fact_id, k.entity_id, k.level, k.since_scene, k.distortion, f.text
         FROM fact_knowledge k JOIN facts f ON f.id = k.fact_id
         WHERE f.story_id = $1 AND k.entity_id = $2
         ORDER BY k.since_scene DESC`,
      [this.storyId, entityId],
    );
    return rows.map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
      level: r.level,
      sinceScene: r.since_scene,
      distortion: r.distortion,
      text: r.text,
    }));
  }

  async knowersOf(factId: FactId): Promise<FactKnowledge[]> {
    const { rows } = await this.db.query<{
      fact_id: string;
      entity_id: string;
      level: KnowledgeLevel;
      since_scene: number;
      distortion: number;
    }>(
      `SELECT fact_id, entity_id, level, since_scene, distortion FROM fact_knowledge WHERE fact_id = $1`,
      [factId],
    );
    return rows.map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
      level: r.level,
      sinceScene: r.since_scene,
      distortion: r.distortion,
    }));
  }

  /**
   * The undo of `setKnowledge` — removes the row outright rather than setting a
   * level, so a revoked entity goes back to "never told", not to some fourth
   * level meaning "explicitly does not know". The natural authoring move when
   * the extractor grants knowledge to the wrong NPC (DESIGN §11).
   */
  async revokeKnowledge(factId: FactId, entityId: EntityId): Promise<void> {
    await this.db.query(`DELETE FROM fact_knowledge WHERE fact_id = $1 AND entity_id = $2`, [factId, entityId]);
  }

  async knows(entityId: EntityId, factId: FactId): Promise<boolean> {
    const { rows } = await this.db.query<{ level: string }>(
      `SELECT level FROM fact_knowledge WHERE fact_id = $1 AND entity_id = $2`,
      [factId, entityId],
    );
    return rows[0]?.level === 'knows';
  }

  /**
   * Facts the player character does not know. This is what produces dramatic
   * irony rather than NPCs reacting to information they cannot possess.
   */
  async factsUnknownTo(entityId: EntityId, limit = 20): Promise<Fact[]> {
    const { rows } = await this.db.query<{ id: string; text: string; scene: number }>(
      `SELECT f.id, f.text, f.scene FROM facts f
         WHERE f.story_id = $1 AND NOT EXISTS (
           SELECT 1 FROM fact_knowledge k
            WHERE k.fact_id = f.id AND k.entity_id = $2 AND k.level = 'knows')
         ORDER BY f.scene DESC LIMIT $3`,
      [this.storyId, entityId, limit],
    );
    return rows.map((r) => ({ ...r, layer: 'chronicle' as const }));
  }

  // ----------------------------------------------------------- divergences

  async addDivergence(scene: number, kind: string, detail: string, canon = ''): Promise<void> {
    await this.db.query(
      `INSERT INTO divergences (story_id, scene, kind, detail, canon) VALUES ($1,$2,$3,$4,$5)`,
      [this.storyId, scene, kind, detail, canon],
    );
  }

  async divergences(): Promise<Array<{ id: number; scene: number; kind: string; detail: string; canon: string }>> {
    const { rows } = await this.db.query<{
      id: string;
      scene: number;
      kind: string;
      detail: string;
      canon: string;
    }>(`SELECT id, scene, kind, detail, canon FROM divergences WHERE story_id = $1 ORDER BY scene`, [
      this.storyId,
    ]);
    // BIGSERIAL arrives as a string; callers treat divergence ids as numbers.
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  // --------------------------------------------------------- style anchors

  async addAnchor(text: string, note = '', scene = 0): Promise<void> {
    await this.db.query(`INSERT INTO style_anchors (story_id, text, note, scene) VALUES ($1,$2,$3,$4)`, [
      this.storyId,
      text,
      note,
      scene,
    ]);
  }

  async anchors(limit = 5): Promise<Array<{ id: number; text: string; note: string; scene: number }>> {
    const { rows } = await this.db.query<{ id: string; text: string; note: string; scene: number }>(
      `SELECT id, text, note, scene FROM style_anchors WHERE story_id = $1 ORDER BY id DESC LIMIT $2`,
      [this.storyId, limit],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }
}
