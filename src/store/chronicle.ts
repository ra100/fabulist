/**
 * Chronicle store: events, turns, scenes, facts, and the divergence ledger.
 * Epistemic state lives here because "who knows what" is chronicle-scoped.
 * See DESIGN.md §2 and §6.3.
 *
 * Everything here is story-scoped except `meta`, which is world-level
 * (shared across every story in this file) — `worldTitle` and similar
 * identity keys describe the file, not any one playthrough of it.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';
import { jsonGet, row, rows } from '../db/db.ts';
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
  participants: string;
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
  intent: string | null;
  delta: string | null;
  book_prose: string;
  pinned: number;
  meta: string;
  created_at: string;
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

function toTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    scene: r.scene,
    turn: r.turn,
    rawInput: r.raw_input,
    intent: r.intent ? jsonGet(r.intent, null) : null,
    delta: r.delta ? jsonGet<Delta | null>(r.delta, null) : null,
    bookProse: r.book_prose,
    pinned: r.pinned === 1,
    meta: jsonGet<TurnMeta>(r.meta, {
      integrity: null,
      referee: null,
      move: null,
      frameLog: null,
      lint: null,
      providerCalls: [],
    }),
    createdAt: r.created_at,
  };
}

export class ChronicleStore {
  private db: Db;
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  // --------------------------------------------------------------- events

  addEvent(e: Omit<StoryEvent, 'id'> & { id?: string }): StoryEvent {
    const id = e.id ?? `ev:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO events (id, story_id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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
      );
    return { ...e, id };
  }

  events(opts: { limit?: number; sinceScene?: number; visibility?: Visibility[] } = {}): StoryEvent[] {
    const where: string[] = ['story_id = ?'];
    const args: unknown[] = [this.storyId];
    if (opts.sinceScene !== undefined) {
      where.push('scene >= ?');
      args.push(opts.sinceScene);
    }
    if (opts.visibility?.length) {
      where.push(`visibility IN (${opts.visibility.map(() => '?').join(',')})`);
      args.push(...opts.visibility);
    }
    args.push(opts.limit ?? 100);
    return rows<EventRow>(
      this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY scene, turn LIMIT ?`).all(...(args as never[])),
    ).map(toEvent);
  }

  /**
   * Events the player character actually witnessed, for POV-safe recall.
   *
   * `participants` is a JSON array, so membership is tested with `json_each`
   * rather than `LIKE '%id%'`. The `LIKE` form was a substring match on the
   * serialised array, which matched any id the target was a *prefix* of:
   * searching `char:tem` also returned events whose only participant was
   * `char:tem-the-elder`. Reproduced directly against node:sqlite before this
   * was rewritten, not inferred from reading the SQL.
   *
   * That mattered more than a wrong row count: this is the POV mask, so a
   * false positive hands the Narrator an event the player character never saw
   * — exactly the immersion break the epistemic layer exists to prevent. Ids
   * being slugs derived from names (`slugId`) makes prefix collisions likely
   * rather than theoretical, since related characters share name stems.
   */
  witnessedEvents(playerId: EntityId, limit = 40): StoryEvent[] {
    return rows<EventRow>(
      this.db
        .prepare(
          `SELECT * FROM events
           WHERE story_id = ? AND visibility = 'onscreen'
             AND EXISTS (SELECT 1 FROM json_each(events.participants) WHERE value = ?)
           ORDER BY scene DESC, turn DESC LIMIT ?`,
        )
        .all(this.storyId, playerId, limit),
    )
      .map(toEvent)
      .reverse();
  }

  // ---------------------------------------------------------------- turns

  addTurn(t: Omit<Turn, 'id' | 'createdAt'> & { id?: string }): Turn {
    const id = t.id ?? `turn:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO turns (id, story_id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.storyId,
        t.scene,
        t.turn,
        t.rawInput,
        t.intent ? JSON.stringify(t.intent) : null,
        t.delta ? JSON.stringify(t.delta) : null,
        t.bookProse,
        t.pinned ? 1 : 0,
        JSON.stringify(t.meta),
        createdAt,
      );
    return { ...t, id, createdAt };
  }

  turns(opts: { scene?: number; limit?: number } = {}): Turn[] {
    if (opts.scene !== undefined) {
      return rows<TurnRow>(
        this.db.prepare(`SELECT * FROM turns WHERE story_id = ? AND scene = ? ORDER BY turn`).all(this.storyId, opts.scene),
      ).map(toTurn);
    }
    return rows<TurnRow>(
      this.db.prepare(`SELECT * FROM turns WHERE story_id = ? ORDER BY scene, turn LIMIT ?`).all(this.storyId, opts.limit ?? 500),
    ).map(toTurn);
  }

  recentTurns(n: number): Turn[] {
    return rows<TurnRow>(
      this.db.prepare(`SELECT * FROM turns WHERE story_id = ? ORDER BY scene DESC, turn DESC LIMIT ?`).all(this.storyId, n),
    )
      .map(toTurn)
      .reverse();
  }

  getTurn(id: string): Turn | undefined {
    const r = row<TurnRow>(this.db.prepare(`SELECT * FROM turns WHERE id = ? AND story_id = ?`).get(id, this.storyId));
    return r ? toTurn(r) : undefined;
  }

  /**
   * Sums every provider call recorded across every turn's meta. Per-turn calls
   * are logged and shown in the why panel; nothing accumulated them, which on a
   * paid provider is exactly the number a player wants without doing the sum
   * themselves.
   */
  usageTotals(): {
    tokensIn: number;
    tokensOut: number;
    calls: number;
    byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }>;
  } {
    const total = { tokensIn: 0, tokensOut: 0, calls: 0 };
    const byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }> = {};
    const metas = rows<{ meta: string }>(this.db.prepare(`SELECT meta FROM turns WHERE story_id = ?`).all(this.storyId));
    for (const row_ of metas) {
      const meta = jsonGet<TurnMeta | null>(row_.meta, null);
      for (const c of meta?.providerCalls ?? []) {
        total.tokensIn += c.tokensIn;
        total.tokensOut += c.tokensOut;
        total.calls += 1;
        const r = (byRole[c.role] ??= { tokensIn: 0, tokensOut: 0, calls: 0 });
        r.tokensIn += c.tokensIn;
        r.tokensOut += c.tokensOut;
        r.calls += 1;
      }
    }
    return { ...total, byRole };
  }

  /** Re-render changes how it is told, never what happened (DESIGN §7.2). */
  setProse(id: string, prose: string): void {
    this.db.prepare(`UPDATE turns SET book_prose = ? WHERE id = ? AND story_id = ? AND pinned = 0`).run(prose, id, this.storyId);
  }

  /**
   * Records a reroll's own provider calls and lint result onto the turn's
   * stored meta, so the why panel reflects the render that is actually on the
   * page rather than the original turn's now-stale one. Guarded by
   * `pinned = 0` for the same reason `setProse` is: a pinned turn's meta is
   * part of the passage the author chose to keep, not something a later
   * reroll attempt (which itself will have already been refused) should touch.
   */
  appendRerollMeta(id: string, patch: { providerCalls: TurnMeta['providerCalls']; lint: TurnMeta['lint'] }): void {
    const turn = this.getTurn(id);
    if (!turn || turn.pinned) return;
    const meta: TurnMeta = {
      ...turn.meta,
      providerCalls: [...turn.meta.providerCalls, ...patch.providerCalls],
      lint: patch.lint,
    };
    this.db.prepare(`UPDATE turns SET meta = ? WHERE id = ? AND story_id = ? AND pinned = 0`).run(JSON.stringify(meta), id, this.storyId);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.prepare(`UPDATE turns SET pinned = ? WHERE id = ? AND story_id = ?`).run(pinned ? 1 : 0, id, this.storyId);
  }

  // --------------------------------------------------------------- scenes

  upsertScene(scene: number, patch: { title?: string; summary?: string; locationId?: string | null; chapter?: number }): void {
    this.db
      .prepare(
        `INSERT INTO scenes (story_id, scene, title, summary, location_id, chapter) VALUES (?,?,?,?,?,?)
         ON CONFLICT(story_id, scene) DO UPDATE SET
           title = COALESCE(NULLIF(excluded.title,''), scenes.title),
           summary = COALESCE(NULLIF(excluded.summary,''), scenes.summary),
           location_id = COALESCE(excluded.location_id, scenes.location_id),
           chapter = excluded.chapter`,
      )
      .run(this.storyId, scene, patch.title ?? '', patch.summary ?? '', patch.locationId ?? null, patch.chapter ?? 1);
  }

  scenes(): Array<{ scene: number; title: string; summary: string; locationId: string | null; chapter: number }> {
    return rows<{ scene: number; title: string; summary: string; location_id: string | null; chapter: number }>(
      this.db.prepare(`SELECT * FROM scenes WHERE story_id = ? ORDER BY scene`).all(this.storyId),
    ).map((r) => ({
      scene: r.scene,
      title: r.title,
      summary: r.summary,
      locationId: r.location_id,
      chapter: r.chapter,
    }));
  }

  upsertChapter(chapter: number, patch: { title?: string; summary?: string }): void {
    this.db
      .prepare(
        `INSERT INTO chapters (story_id, chapter, title, summary) VALUES (?,?,?,?)
         ON CONFLICT(story_id, chapter) DO UPDATE SET
           title = COALESCE(NULLIF(excluded.title,''), chapters.title),
           summary = COALESCE(NULLIF(excluded.summary,''), chapters.summary)`,
      )
      .run(this.storyId, chapter, patch.title ?? '', patch.summary ?? '');
  }

  chapter(chapter: number): { chapter: number; title: string; summary: string } | undefined {
    return row(this.db.prepare(`SELECT chapter, title, summary FROM chapters WHERE story_id = ? AND chapter = ?`).get(this.storyId, chapter));
  }

  chapters(): Array<{ chapter: number; title: string; summary: string }> {
    return rows(this.db.prepare(`SELECT chapter, title, summary FROM chapters WHERE story_id = ? ORDER BY chapter`).all(this.storyId));
  }

  // ----------------------------------------------------------------- meta
  // World-level, unscoped by design: describes the file (e.g. worldTitle),
  // not any one story built on top of it.

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  getMeta(key: string, fallback = ''): string {
    return row<{ value: string }>(this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key))?.value ?? fallback;
  }

  // ---------------------------------------------------------------- facts

  addFact(text: string, scene: number): Fact {
    const id = `fact:${randomUUID()}`;
    this.db.prepare(`INSERT INTO facts (id, story_id, text, scene) VALUES (?,?,?,?)`).run(id, this.storyId, text, scene);
    return { id, text, scene, layer: 'chronicle' };
  }

  facts(limit = 200): Fact[] {
    return rows<{ id: string; text: string; scene: number }>(
      this.db.prepare(`SELECT id, text, scene FROM facts WHERE story_id = ? ORDER BY scene DESC LIMIT ?`).all(this.storyId, limit),
    ).map((r) => ({ ...r, layer: 'chronicle' as const }));
  }

  /**
   * Records that an entity knows, suspects, or holds a distorted version of a
   * fact. Distortion rises with transmission hops (DESIGN §6.3). Not scoped
   * by story_id directly — it inherits scope through `fact_id`, which is
   * already story-scoped via `facts`, and every call site resolves the fact
   * through this store first.
   */
  setKnowledge(
    factId: FactId,
    entityId: EntityId,
    level: KnowledgeLevel,
    scene: number,
    distortion = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO fact_knowledge (fact_id, entity_id, level, since_scene, distortion)
         VALUES (?,?,?,?,?)
         ON CONFLICT(fact_id, entity_id) DO UPDATE SET
           level = excluded.level,
           distortion = MIN(fact_knowledge.distortion, excluded.distortion)`,
      )
      .run(factId, entityId, level, scene, distortion);
  }

  knowledgeOf(entityId: EntityId): Array<FactKnowledge & { text: string }> {
    return rows<{
      fact_id: string;
      entity_id: string;
      level: KnowledgeLevel;
      since_scene: number;
      distortion: number;
      text: string;
    }>(
      this.db
        .prepare(
          `SELECT k.*, f.text FROM fact_knowledge k
           JOIN facts f ON f.id = k.fact_id WHERE f.story_id = ? AND k.entity_id = ?
           ORDER BY k.since_scene DESC`,
        )
        .all(this.storyId, entityId),
    ).map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
      level: r.level,
      sinceScene: r.since_scene,
      distortion: r.distortion,
      text: r.text,
    }));
  }

  knowersOf(factId: FactId): FactKnowledge[] {
    return rows<{ fact_id: string; entity_id: string; level: KnowledgeLevel; since_scene: number; distortion: number }>(
      this.db.prepare(`SELECT * FROM fact_knowledge WHERE fact_id = ?`).all(factId),
    ).map((r) => ({
      factId: r.fact_id,
      entityId: r.entity_id,
      level: r.level,
      sinceScene: r.since_scene,
      distortion: r.distortion,
    }));
  }

  /**
   * The undo of `setKnowledge` — removes the row outright rather than
   * setting a level, so a revoked entity goes back to "never told", not to
   * some fourth level meaning "explicitly does not know". The natural
   * authoring move when the extractor grants knowledge to the wrong NPC
   * (DESIGN §11): before this, the only fix was overwriting with `'wrong'`,
   * which is a different claim (they know something false) than the one
   * usually meant (they were never told at all).
   */
  revokeKnowledge(factId: FactId, entityId: EntityId): void {
    this.db.prepare(`DELETE FROM fact_knowledge WHERE fact_id = ? AND entity_id = ?`).run(factId, entityId);
  }

  knows(entityId: EntityId, factId: FactId): boolean {
    const r = row<{ level: string }>(
      this.db.prepare(`SELECT level FROM fact_knowledge WHERE fact_id = ? AND entity_id = ?`).get(factId, entityId),
    );
    return r?.level === 'knows';
  }

  /**
   * Facts the player character does not know. This is what produces dramatic
   * irony rather than NPCs reacting to information they cannot possess.
   */
  factsUnknownTo(entityId: EntityId, limit = 20): Fact[] {
    return rows<{ id: string; text: string; scene: number }>(
      this.db
        .prepare(
          `SELECT f.id, f.text, f.scene FROM facts f
           WHERE f.story_id = ? AND NOT EXISTS (
             SELECT 1 FROM fact_knowledge k
             WHERE k.fact_id = f.id AND k.entity_id = ? AND k.level = 'knows')
           ORDER BY f.scene DESC LIMIT ?`,
        )
        .all(this.storyId, entityId, limit),
    ).map((r) => ({ ...r, layer: 'chronicle' as const }));
  }

  // ----------------------------------------------------------- divergences

  addDivergence(scene: number, kind: string, detail: string, canon = ''): void {
    this.db
      .prepare(`INSERT INTO divergences (story_id, scene, kind, detail, canon) VALUES (?,?,?,?,?)`)
      .run(this.storyId, scene, kind, detail, canon);
  }

  divergences(): Array<{ id: number; scene: number; kind: string; detail: string; canon: string }> {
    return rows(
      this.db.prepare(`SELECT id, scene, kind, detail, canon FROM divergences WHERE story_id = ? ORDER BY scene`).all(this.storyId),
    );
  }

  // --------------------------------------------------------- style anchors

  addAnchor(text: string, note = '', scene = 0): void {
    this.db.prepare(`INSERT INTO style_anchors (story_id, text, note, scene) VALUES (?,?,?,?)`).run(this.storyId, text, note, scene);
  }

  anchors(limit = 5): Array<{ id: number; text: string; note: string; scene: number }> {
    return rows(
      this.db.prepare(`SELECT id, text, note, scene FROM style_anchors WHERE story_id = ? ORDER BY id DESC LIMIT ?`).all(this.storyId, limit),
    );
  }
}
