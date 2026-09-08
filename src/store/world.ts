/**
 * Threads, consequences, directives, and story state.
 *
 * Threads exist instead of a plot: a plot breaks when the player deviates, a
 * thread just gets re-aimed (DESIGN §2). Consequences are a propagation queue
 * rather than a world simulation (DESIGN §6.1).
 *
 * Every table here is story-scoped: two stories in the same world never share
 * a thread, a consequence, a directive, or session state, even when they
 * diverge from the same canon.
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
  type Story,
  type StoryId,
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
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  create(t: Omit<Thread, 'id'> & { id?: ThreadId }): Thread {
    const id = t.id ?? `thread:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO threads (id, story_id, title, stakes, tension, parties, resolutions, status, created_scene)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, this.storyId, t.title, t.stakes, t.tension, JSON.stringify(t.parties), JSON.stringify(t.resolutions), t.status, t.createdScene);
    return { ...t, id };
  }

  get(id: ThreadId): Thread | undefined {
    const r = row<ThreadRow>(this.db.prepare(`SELECT * FROM threads WHERE id = ? AND story_id = ?`).get(id, this.storyId));
    return r ? toThread(r) : undefined;
  }

  /** Open threads ranked by tension: the Director's menu. */
  open(limit = 12): Thread[] {
    return rows<ThreadRow>(
      this.db
        .prepare(`SELECT * FROM threads WHERE story_id = ? AND status = 'open' ORDER BY tension DESC LIMIT ?`)
        .all(this.storyId, limit),
    ).map(toThread);
  }

  all(): Thread[] {
    return rows<ThreadRow>(
      this.db.prepare(`SELECT * FROM threads WHERE story_id = ? ORDER BY tension DESC`).all(this.storyId),
    ).map(toThread);
  }

  update(id: ThreadId, patch: Partial<Omit<Thread, 'id'>>): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE threads SET title=?, stakes=?, tension=?, parties=?, resolutions=?, status=? WHERE id=? AND story_id=?`,
      )
      .run(
        next.title,
        next.stakes,
        Math.max(0, Math.min(1, next.tension)),
        JSON.stringify(next.parties),
        JSON.stringify(next.resolutions),
        next.status,
        id,
        this.storyId,
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
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  enqueue(c: Omit<Consequence, 'id' | 'firedScene' | 'supersededBy'> & { id?: string }): Consequence {
    const id = c.id ?? `cons:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO consequences
           (id, story_id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene, fired_scene, superseded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id,
        this.storyId,
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
    const r = row<ConsequenceRow>(
      this.db.prepare(`SELECT * FROM consequences WHERE id = ? AND story_id = ?`).get(id, this.storyId),
    );
    return r ? toConsequence(r) : undefined;
  }

  pending(): Consequence[] {
    return rows<ConsequenceRow>(
      this.db
        .prepare(`SELECT * FROM consequences WHERE story_id = ? AND maturity IN ('pending','ripening') ORDER BY created_scene`)
        .all(this.storyId),
    ).map(toConsequence);
  }

  all(limit = 500): Consequence[] {
    return rows<ConsequenceRow>(
      this.db
        .prepare(`SELECT * FROM consequences WHERE story_id = ? ORDER BY created_scene DESC LIMIT ?`)
        .all(this.storyId, limit),
    ).map(toConsequence);
  }

  byCause(eventId: string): Consequence[] {
    return rows<ConsequenceRow>(
      this.db.prepare(`SELECT * FROM consequences WHERE cause_event_id = ? AND story_id = ?`).all(eventId, this.storyId),
    ).map(toConsequence);
  }

  setMaturity(id: ConsequenceId, maturity: Maturity, scene?: number): void {
    if (maturity === 'fired') {
      this.db
        .prepare(`UPDATE consequences SET maturity = ?, fired_scene = ? WHERE id = ? AND story_id = ?`)
        .run(maturity, scene ?? null, id, this.storyId);
    } else {
      this.db.prepare(`UPDATE consequences SET maturity = ? WHERE id = ? AND story_id = ?`).run(maturity, id, this.storyId);
    }
  }

  supersede(id: ConsequenceId, by: string): void {
    this.db
      .prepare(`UPDATE consequences SET maturity = 'superseded', superseded_by = ? WHERE id = ? AND story_id = ?`)
      .run(by, id, this.storyId);
  }

  retime(id: ConsequenceId, trigger: Trigger): void {
    this.db
      .prepare(`UPDATE consequences SET trigger = ? WHERE id = ? AND story_id = ?`)
      .run(JSON.stringify(trigger), id, this.storyId);
  }

  /** How much has matured unseen; drives the ignorance budget (DESIGN §6.5). */
  hiddenFiredCount(): number {
    return Number(
      row<{ n: number }>(
        this.db
          .prepare(`SELECT COUNT(*) n FROM consequences WHERE story_id = ? AND maturity = 'fired' AND visibility != 'onscreen'`)
          .get(this.storyId),
      )?.n ?? 0,
    );
  }
}

// -------------------------------------------------------------- directives

export class DirectiveStore {
  private db: Db;
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  create(d: Omit<Directive, 'id'> & { id?: string }): Directive {
    const id = d.id ?? `dir:${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO directives (id, story_id, text, scope, strength, lifetime_scenes, status, created_scene)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, this.storyId, d.text, d.scope, d.strength, d.lifetimeScenes, d.status, d.createdScene);
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
    }>(
      this.db
        .prepare(`SELECT * FROM directives WHERE story_id = ? AND status = 'active' ORDER BY created_scene DESC`)
        .all(this.storyId),
    ).map((r) => ({
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
    this.db.prepare(`UPDATE directives SET status = ? WHERE id = ? AND story_id = ?`).run(status, id, this.storyId);
  }

  /** Expire directives whose lifetime has run out, so stale steering decays. */
  expire(scene: number): string[] {
    const stale = rows<{ id: string }>(
      this.db
        .prepare(
          `SELECT id FROM directives WHERE story_id = ? AND status='active' AND lifetime_scenes IS NOT NULL
             AND created_scene + lifetime_scenes <= ?`,
        )
        .all(this.storyId, scene),
    ).map((r) => r.id);
    for (const id of stale) this.setStatus(id, 'retired');
    return stale;
  }
}

// ------------------------------------------------------------------ stories
//
// Replaces the old `session` table, which had exactly one row because a file
// held exactly one story. `StoryStore` is bound to one story (mirroring every
// other store here) and exposes the play-relevant subset (`SessionState`) for
// every existing call site that only ever wanted scene/turn/style/knobs.
// `listStories`/`createStory`/`getStoryMeta` are module-level rather than
// methods on a bound store, because they operate *across* stories — creating
// or listing stories is inherently not scoped to the one this instance is
// bound to.

interface StoryRow {
  id: string;
  title: string;
  scene: number;
  turn: number;
  player_character_id: string;
  current_location_id: string | null;
  style: string;
  knobs: string;
  forked_from: string | null;
  forked_at_scene: number | null;
  created_at: string;
  last_played_at: string;
  owner_user_id: string | null;
}

function toStory(r: StoryRow): Story {
  return {
    id: r.id,
    title: r.title,
    scene: r.scene,
    turn: r.turn,
    playerCharacterId: r.player_character_id,
    currentLocationId: r.current_location_id,
    style: { ...defaultStyleContract(), ...jsonGet<Partial<StyleContract>>(r.style, {}) },
    knobs: { ...defaultKnobs(), ...jsonGet<Partial<Knobs>>(r.knobs, {}) },
    forkedFrom: r.forked_from,
    forkedAtScene: r.forked_at_scene,
    createdAt: r.created_at,
    lastPlayedAt: r.last_played_at,
    ownerUserId: r.owner_user_id,
  };
}

/** Every story in this file, most recently played first. Used by the save browser. */
export function listStories(db: Db): Story[] {
  return rows<StoryRow>(db.prepare(`SELECT * FROM stories ORDER BY last_played_at DESC, created_at DESC`).all()).map(
    toStory,
  );
}

/**
 * Every story owned by one user, most recently played first — the
 * login-on analogue of `listStories`, which stays file-wide (used by
 * `deleteStory`'s "don't delete the last story in the file" check, a
 * property of the file, not of any one user). A story with `owner_user_id
 * IS NULL` (created before this column existed, or during a login-off
 * session) is never returned here: `null` means unowned, not "owned by
 * everyone" — see this file's `owner_user_id` migration comment in `db.ts`.
 */
export function listStoriesForUser(db: Db, ownerUserId: string): Story[] {
  return rows<StoryRow>(
    db.prepare(`SELECT * FROM stories WHERE owner_user_id = ? ORDER BY last_played_at DESC, created_at DESC`).all(ownerUserId),
  ).map(toStory);
}

export function getStory(db: Db, id: StoryId): Story | undefined {
  const r = row<StoryRow>(db.prepare(`SELECT * FROM stories WHERE id = ?`).get(id));
  return r ? toStory(r) : undefined;
}

/**
 * Creates a fresh story against this file's canon — the "non-overlapping new
 * story in an existing world" case. No chronicle is copied; the story starts
 * exactly like a brand-new ingest would, minus re-ingesting.
 *
 * `ownerUserId` omitted (or explicitly `undefined`/absent) writes `NULL` —
 * the login-off path, and any internal caller with no session user in
 * scope. Never inferred or defaulted to "whoever is asking" here; the
 * caller (a route with an already-verified `SessionUser`, or nothing) is
 * the only place that knows who that is.
 */
export function createStory(
  db: Db,
  opts: { title?: string; forkedFrom?: StoryId; forkedAtScene?: number; ownerUserId?: string } = {},
): Story {
  const id = `story:${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO stories
       (id, title, scene, turn, player_character_id, current_location_id, style, knobs,
        forked_from, forked_at_scene, created_at, last_played_at, owner_user_id)
     VALUES (?,?,1,0,'',NULL,'{}','{}',?,?,?,?,?)`,
  ).run(id, opts.title ?? '', opts.forkedFrom ?? null, opts.forkedAtScene ?? null, now, now, opts.ownerUserId ?? null);
  return getStory(db, id)!;
}

/**
 * Deletes one story and everything scoped to it — every table's
 * `FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE` does the
 * actual cleanup (verified directly against node:sqlite in Slice 1, not
 * assumed), so this is a single `DELETE FROM stories`, not a per-table sweep.
 * Canon is never touched: it has no `story_id` to cascade from. Refuses to
 * delete the last story in a file — a world with a save browser still needs
 * at least one story to open into, and "delete everything, including canon"
 * is what `SetupService.reset()` is for, a deliberately different and more
 * destructive operation.
 */
export function deleteStory(db: Db, storyId: StoryId): void {
  const existing = listStories(db);
  if (existing.length <= 1) throw new Error('cannot delete the last story in a world; delete the world file instead');
  if (!existing.some((s) => s.id === storyId)) throw new Error(`no story ${storyId} in this world`);
  db.prepare(`DELETE FROM stories WHERE id = ?`).run(storyId);
}

/**
 * The one-story auto-resolve `World.open` relies on: a fresh file gets its
 * first story created automatically, a file with exactly one story binds to
 * it without the caller needing to know a story concept exists, and a file
 * with more than one refuses to guess — every ~75 existing call sites built
 * before this migration keep working unchanged as long as they only ever
 * touch one-story files, which is every one of them today.
 */
export function resolveDefaultStory(db: Db): StoryId {
  const existing = listStories(db);
  if (existing.length === 1) return existing[0]!.id;
  if (existing.length === 0) return createStory(db, { title: '' }).id;
  throw new Error(
    `this world has ${existing.length} stories; World.open needs an explicit storyId (see listStories)`,
  );
}

/**
 * The same resolution for a *long-lived server's* "which story is currently
 * pointed at" (`CurrentWorld.open`/`switchTo`/`reopen` in `src/store/index.ts`),
 * where refusing to guess is the wrong answer: it is fatal at boot.
 *
 * `resolveDefaultStory` above stays strict on purpose — for a library caller
 * that asked for "the" story of a file, several stories genuinely is
 * ambiguous and worth an error. But that function's own comment assumed
 * multi-story files did not exist yet ("which is every one of them today"),
 * and per-user stories made them ordinary: two accounts playing the same
 * world is two stories in one file. The deployed instance hit exactly that —
 * a world with 2 stories, so `CurrentWorld.open` threw during startup, the
 * container crash-looped under `restart: unless-stopped`, and the reverse
 * proxy served 502s. Boot must not depend on a human disambiguating.
 *
 * Picks the most recently played (`listStories` is ordered
 * `last_played_at DESC, created_at DESC`), matching what
 * `resolveOrCreateStoryForUser` already does per-user rather than inventing a
 * second, differently-guessing rule. Nothing is lost by choosing here: this
 * pointer is only where a session lands by default, and with login on every
 * request resolves its own story through `CurrentStory.worldFor(user)`.
 */
export function resolveCurrentStory(db: Db): StoryId {
  const existing = listStories(db);
  if (existing.length === 0) return createStory(db, { title: '' }).id;
  return existing[0]!.id;
}

/**
 * The per-user analogue of `resolveDefaultStory`, and the resolution
 * `CurrentStory.worldFor` (`src/store/index.ts`) calls on every request once
 * a session user is known. Deliberately not an error when several stories
 * exist for this user — unlike the file-wide version, "this user has
 * several stories" is the ordinary, expected case (anyone who has forked or
 * started a second story), not a configuration problem needing a human to
 * disambiguate. Picks the most recently played one; a caller wanting a
 * *specific* other story passes its id explicitly (see the `?storyId=`
 * override on the story routes in `src/server/api.ts`) rather than this
 * function guessing differently.
 */
export function resolveOrCreateStoryForUser(db: Db, ownerUserId: string): StoryId {
  const existing = listStoriesForUser(db, ownerUserId);
  if (existing.length > 0) return existing[0]!.id;
  return createStory(db, { title: '', ownerUserId }).id;
}

export class StoryStore {
  private db: Db;
  private storyId: StoryId;

  constructor(db: Db, storyId: StoryId) {
    this.db = db;
    this.storyId = storyId;
  }

  id(): StoryId {
    return this.storyId;
  }

  private row(): StoryRow {
    const r = row<StoryRow>(this.db.prepare(`SELECT * FROM stories WHERE id = ?`).get(this.storyId));
    if (!r) throw new Error(`story ${this.storyId} does not exist`);
    return r;
  }

  get(): SessionState {
    return toStory(this.row());
  }

  /** Full record, including identity and lineage — what the save browser wants. */
  info(): Story {
    return toStory(this.row());
  }

  set(patch: Partial<SessionState>): SessionState {
    const cur = this.get();
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE stories SET scene=?, turn=?, player_character_id=?, current_location_id=?, style=?, knobs=?,
           last_played_at=? WHERE id=?`,
      )
      .run(
        next.scene,
        next.turn,
        next.playerCharacterId,
        next.currentLocationId,
        JSON.stringify(next.style),
        JSON.stringify(next.knobs),
        new Date().toISOString(),
        this.storyId,
      );
    return next;
  }

  rename(title: string): void {
    this.db.prepare(`UPDATE stories SET title = ? WHERE id = ?`).run(title, this.storyId);
  }
}

