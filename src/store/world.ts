/**
 * Threads, consequences, directives, and session state.
 *
 * Threads exist instead of a plot: a plot breaks when the player deviates, a
 * thread just gets re-aimed (DESIGN §2). Consequences are a propagation queue
 * rather than a world simulation (DESIGN §6.1).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';
import { jsonGet, row, rows } from '../db/db.ts';
import {
  defaultKnobs,
  defaultStyleContract,
  type Consequence,
  type ConsequenceId,
  type Directive,
  type EntityId,
  type Knobs,
  type Maturity,
  type SessionState,
  type StyleContract,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type Trigger,
  type Visibility,
} from '../domain/types.ts';

interface ThreadRow {
  id: string;
  title: string;
  stakes: string;
  tension: number;
  parties: string;
  resolutions: string;
  status: ThreadStatus;
  created_scene: number;
}

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    title: r.title,
    stakes: r.stakes,
    tension: r.tension,
    parties: jsonGet<EntityId[]>(r.parties, []),
    resolutions: jsonGet<string[]>(r.resolutions, []),
    status: r.status,
    createdScene: r.created_scene,
  };
}

export class ThreadStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(t: Omit<Thread, 'id'> & { id?: ThreadId }): Thread {
    const id = t.id ?? `thread:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO threads (id, title, stakes, tension, parties, resolutions, status, created_scene)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, t.title, t.stakes, t.tension, JSON.stringify(t.parties), JSON.stringify(t.resolutions), t.status, t.createdScene);
    return { ...t, id };
  }

  get(id: ThreadId): Thread | undefined {
    const r = row<ThreadRow>(this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id));
    return r ? toThread(r) : undefined;
  }

  /** Open threads ranked by tension: the Director's menu. */
  open(limit = 12): Thread[] {
    return rows<ThreadRow>(
      this.db.prepare(`SELECT * FROM threads WHERE status = 'open' ORDER BY tension DESC LIMIT ?`).all(limit),
    ).map(toThread);
  }

  all(): Thread[] {
    return rows<ThreadRow>(this.db.prepare(`SELECT * FROM threads ORDER BY tension DESC`).all()).map(toThread);
  }

  update(id: ThreadId, patch: Partial<Omit<Thread, 'id'>>): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE threads SET title=?, stakes=?, tension=?, parties=?, resolutions=?, status=? WHERE id=?`,
      )
      .run(
        next.title,
        next.stakes,
        Math.max(0, Math.min(1, next.tension)),
        JSON.stringify(next.parties),
        JSON.stringify(next.resolutions),
        next.status,
        id,
      );
  }

  adjustTension(id: ThreadId, delta: number): void {
    const cur = this.get(id);
    if (!cur) return;
    this.update(id, { tension: cur.tension + delta });
  }
}

// ------------------------------------------------------------ consequences

interface ConsequenceRow {
  id: string;
  cause_event_id: string;
  trigger: string;
  actor_id: string;
  action: string;
  visibility: Visibility;
  maturity: Maturity;
  depth: number;
  significance: number;
  created_scene: number;
  fired_scene: number | null;
  superseded_by: string | null;
}

function toConsequence(r: ConsequenceRow): Consequence {
  return {
    id: r.id,
    causeEventId: r.cause_event_id,
    trigger: jsonGet<Trigger>(r.trigger, { kind: 'immediate' }),
    actorId: r.actor_id,
    action: r.action,
    visibility: r.visibility,
    maturity: r.maturity,
    depth: r.depth,
    significance: r.significance,
    createdScene: r.created_scene,
    firedScene: r.fired_scene,
    supersededBy: r.superseded_by,
  };
}

export class ConsequenceStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  enqueue(c: Omit<Consequence, 'id' | 'firedScene' | 'supersededBy'> & { id?: string }): Consequence {
    const id = c.id ?? `cons:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO consequences
           (id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene, fired_scene, superseded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id,
        c.causeEventId,
        JSON.stringify(c.trigger),
        c.actorId,
        c.action,
        c.visibility,
        c.maturity,
        c.depth,
        c.significance,
        c.createdScene,
      );
    return { ...c, id, firedScene: null, supersededBy: null };
  }

  get(id: ConsequenceId): Consequence | undefined {
    const r = row<ConsequenceRow>(this.db.prepare(`SELECT * FROM consequences WHERE id = ?`).get(id));
    return r ? toConsequence(r) : undefined;
  }

  pending(): Consequence[] {
    return rows<ConsequenceRow>(
      this.db
        .prepare(`SELECT * FROM consequences WHERE maturity IN ('pending','ripening') ORDER BY created_scene`)
        .all(),
    ).map(toConsequence);
  }

  all(limit = 500): Consequence[] {
    return rows<ConsequenceRow>(
      this.db.prepare(`SELECT * FROM consequences ORDER BY created_scene DESC LIMIT ?`).all(limit),
    ).map(toConsequence);
  }

  byCause(eventId: string): Consequence[] {
    return rows<ConsequenceRow>(
      this.db.prepare(`SELECT * FROM consequences WHERE cause_event_id = ?`).all(eventId),
    ).map(toConsequence);
  }

  setMaturity(id: ConsequenceId, maturity: Maturity, scene?: number): void {
    if (maturity === 'fired') {
      this.db.prepare(`UPDATE consequences SET maturity = ?, fired_scene = ? WHERE id = ?`).run(maturity, scene ?? null, id);
    } else {
      this.db.prepare(`UPDATE consequences SET maturity = ? WHERE id = ?`).run(maturity, id);
    }
  }

  supersede(id: ConsequenceId, by: string): void {
    this.db
      .prepare(`UPDATE consequences SET maturity = 'superseded', superseded_by = ? WHERE id = ?`)
      .run(by, id);
  }

  retime(id: ConsequenceId, trigger: Trigger): void {
    this.db.prepare(`UPDATE consequences SET trigger = ? WHERE id = ?`).run(JSON.stringify(trigger), id);
  }

  /** How much has matured unseen; drives the ignorance budget (DESIGN §6.5). */
  hiddenFiredCount(): number {
    return Number(
      row<{ n: number }>(
        this.db
          .prepare(`SELECT COUNT(*) n FROM consequences WHERE maturity = 'fired' AND visibility != 'onscreen'`)
          .get(),
      )?.n ?? 0,
    );
  }
}

// -------------------------------------------------------------- directives

export class DirectiveStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(d: Omit<Directive, 'id'> & { id?: string }): Directive {
    const id = d.id ?? `dir:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO directives (id, text, scope, strength, lifetime_scenes, status, created_scene)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, d.text, d.scope, d.strength, d.lifetimeScenes, d.status, d.createdScene);
    return { ...d, id };
  }

  active(): Directive[] {
    return rows<{
      id: string;
      text: string;
      scope: Directive['scope'];
      strength: Directive['strength'];
      lifetime_scenes: number | null;
      status: Directive['status'];
      created_scene: number;
    }>(this.db.prepare(`SELECT * FROM directives WHERE status = 'active' ORDER BY created_scene DESC`).all()).map((r) => ({
      id: r.id,
      text: r.text,
      scope: r.scope,
      strength: r.strength,
      lifetimeScenes: r.lifetime_scenes,
      status: r.status,
      createdScene: r.created_scene,
    }));
  }

  setStatus(id: string, status: Directive['status']): void {
    this.db.prepare(`UPDATE directives SET status = ? WHERE id = ?`).run(status, id);
  }

  /** Expire directives whose lifetime has run out, so stale steering decays. */
  expire(scene: number): string[] {
    const stale = rows<{ id: string }>(
      this.db
        .prepare(
          `SELECT id FROM directives WHERE status='active' AND lifetime_scenes IS NOT NULL
             AND created_scene + lifetime_scenes <= ?`,
        )
        .all(scene),
    ).map((r) => r.id);
    for (const id of stale) this.setStatus(id, 'retired');
    return stale;
  }
}

// ----------------------------------------------------------------- session

export class SessionStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(): SessionState {
    const r = row<{
      scene: number;
      turn: number;
      player_character_id: string;
      current_location_id: string | null;
      style: string;
      knobs: string;
    }>(this.db.prepare(`SELECT * FROM session WHERE id = 1`).get());
    return {
      scene: r?.scene ?? 1,
      turn: r?.turn ?? 0,
      playerCharacterId: r?.player_character_id ?? '',
      currentLocationId: r?.current_location_id ?? null,
      style: { ...defaultStyleContract(), ...jsonGet<Partial<StyleContract>>(r?.style, {}) },
      knobs: { ...defaultKnobs(), ...jsonGet<Partial<Knobs>>(r?.knobs, {}) },
    };
  }

  set(patch: Partial<SessionState>): SessionState {
    const cur = this.get();
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE session SET scene=?, turn=?, player_character_id=?, current_location_id=?, style=?, knobs=? WHERE id=1`,
      )
      .run(
        next.scene,
        next.turn,
        next.playerCharacterId,
        next.currentLocationId,
        JSON.stringify(next.style),
        JSON.stringify(next.knobs),
      );
    return next;
  }
}
