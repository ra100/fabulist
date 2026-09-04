/**
 * Chronicle store: events, turns, scenes, facts, and the divergence ledger.
 * Epistemic state lives here because "who knows what" is chronicle-scoped.
 * See DESIGN.md §2 and §6.3.
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

  constructor(db: Db) {
    this.db = db;
  }

  // --------------------------------------------------------------- events

  addEvent(e: Omit<StoryEvent, 'id'> & { id?: string }): StoryEvent {
    const id = e.id ?? `ev:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO events (id, scene, turn, text, participants, location_id, significance, visibility, from_consequence_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
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
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceScene !== undefined) {
      where.push('scene >= ?');
      args.push(opts.sinceScene);
    }
    if (opts.visibility?.length) {
      where.push(`visibility IN (${opts.visibility.map(() => '?').join(',')})`);
      args.push(...opts.visibility);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(opts.limit ?? 100);
    return rows<EventRow>(
      this.db.prepare(`SELECT * FROM events ${clause} ORDER BY scene, turn LIMIT ?`).all(...(args as never[])),
    ).map(toEvent);
  }

  /** Events the player character actually witnessed, for POV-safe recall. */
  witnessedEvents(playerId: EntityId, limit = 40): StoryEvent[] {
    return rows<EventRow>(
      this.db
        .prepare(
          `SELECT * FROM events
           WHERE visibility = 'onscreen' AND participants LIKE ?
           ORDER BY scene DESC, turn DESC LIMIT ?`,
        )
        .all(`%${playerId}%`, limit),
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
        `INSERT INTO turns (id, scene, turn, raw_input, intent, delta, book_prose, pinned, meta, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
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
        this.db.prepare(`SELECT * FROM turns WHERE scene = ? ORDER BY turn`).all(opts.scene),
      ).map(toTurn);
    }
    return rows<TurnRow>(
      this.db.prepare(`SELECT * FROM turns ORDER BY scene, turn LIMIT ?`).all(opts.limit ?? 500),
    ).map(toTurn);
  }

  recentTurns(n: number): Turn[] {
    return rows<TurnRow>(
      this.db.prepare(`SELECT * FROM turns ORDER BY scene DESC, turn DESC LIMIT ?`).all(n),
    )
      .map(toTurn)
      .reverse();
  }

  getTurn(id: string): Turn | undefined {
    const r = row<TurnRow>(this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id));
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
    const metas = rows<{ meta: string }>(this.db.prepare(`SELECT meta FROM turns`).all());
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
    this.db.prepare(`UPDATE turns SET book_prose = ? WHERE id = ? AND pinned = 0`).run(prose, id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.prepare(`UPDATE turns SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id);
  }

  // --------------------------------------------------------------- scenes

  upsertScene(scene: number, patch: { title?: string; summary?: string; locationId?: string | null; chapter?: number }): void {
    this.db
      .prepare(
        `INSERT INTO scenes (scene, title, summary, location_id, chapter) VALUES (?,?,?,?,?)
         ON CONFLICT(scene) DO UPDATE SET
           title = COALESCE(NULLIF(excluded.title,''), scenes.title),
           summary = COALESCE(NULLIF(excluded.summary,''), scenes.summary),
           location_id = COALESCE(excluded.location_id, scenes.location_id),
           chapter = excluded.chapter`,
      )
      .run(scene, patch.title ?? '', patch.summary ?? '', patch.locationId ?? null, patch.chapter ?? 1);
  }

  scenes(): Array<{ scene: number; title: string; summary: string; locationId: string | null; chapter: number }> {
    return rows<{ scene: number; title: string; summary: string; location_id: string | null; chapter: number }>(
      this.db.prepare(`SELECT * FROM scenes ORDER BY scene`).all(),
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
        `INSERT INTO chapters (chapter, title, summary) VALUES (?,?,?)
         ON CONFLICT(chapter) DO UPDATE SET
           title = COALESCE(NULLIF(excluded.title,''), chapters.title),
           summary = COALESCE(NULLIF(excluded.summary,''), chapters.summary)`,
      )
      .run(chapter, patch.title ?? '', patch.summary ?? '');
  }

  chapter(chapter: number): { chapter: number; title: string; summary: string } | undefined {
    return row(this.db.prepare(`SELECT * FROM chapters WHERE chapter = ?`).get(chapter));
  }

  chapters(): Array<{ chapter: number; title: string; summary: string }> {
    return rows(this.db.prepare(`SELECT * FROM chapters ORDER BY chapter`).all());
  }

  // ----------------------------------------------------------------- meta

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
    this.db.prepare(`INSERT INTO facts (id, text, scene, layer) VALUES (?,?,?,'chronicle')`).run(id, text, scene);
    return { id, text, scene, layer: 'chronicle' };
  }

  facts(limit = 200): Fact[] {
    return rows<Fact>(this.db.prepare(`SELECT * FROM facts ORDER BY scene DESC LIMIT ?`).all(limit));
  }

  /**
   * Records that an entity knows, suspects, or holds a distorted version of a
   * fact. Distortion rises with transmission hops (DESIGN §6.3).
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
           JOIN facts f ON f.id = k.fact_id WHERE k.entity_id = ?
           ORDER BY k.since_scene DESC`,
        )
        .all(entityId),
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
    return rows<Fact>(
      this.db
        .prepare(
          `SELECT f.* FROM facts f
           WHERE NOT EXISTS (
             SELECT 1 FROM fact_knowledge k
             WHERE k.fact_id = f.id AND k.entity_id = ? AND k.level = 'knows')
           ORDER BY f.scene DESC LIMIT ?`,
        )
        .all(entityId, limit),
    );
  }

  // ----------------------------------------------------------- divergences

  addDivergence(scene: number, kind: string, detail: string, canon = ''): void {
    this.db.prepare(`INSERT INTO divergences (scene, kind, detail, canon) VALUES (?,?,?,?)`).run(scene, kind, detail, canon);
  }

  divergences(): Array<{ id: number; scene: number; kind: string; detail: string; canon: string }> {
    return rows(this.db.prepare(`SELECT * FROM divergences ORDER BY scene`).all());
  }

  // --------------------------------------------------------- style anchors

  addAnchor(text: string, note = '', scene = 0): void {
    this.db.prepare(`INSERT INTO style_anchors (text, note, scene) VALUES (?,?,?)`).run(text, note, scene);
  }

  anchors(limit = 5): Array<{ id: number; text: string; note: string; scene: number }> {
    return rows(this.db.prepare(`SELECT * FROM style_anchors ORDER BY id DESC LIMIT ?`).all(limit));
  }
}
