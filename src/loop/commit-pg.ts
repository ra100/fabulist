/**
 * Delta commit. See DESIGN.md §4 step 9.
 *
 * The only place chronicle state is written. Keeping it in one transaction means
 * a half-applied delta cannot leave the graph describing a story the prose does
 * not tell.
 *
 * ## The transaction is the whole point, and it constrains how this is written
 *
 * `Db.tx` hands out a single checked-out client, and every statement in the
 * transaction has to go through *that* client. A store built over the pool would
 * silently run its writes on other connections — outside the transaction — so a
 * rollback would leave some of the delta applied. That is not a hypothetical
 * risk: `pool.query` is documented to hand each call whichever connection is
 * free.
 *
 * So `commitDelta` builds a second `World` bound to the transaction client and
 * does all its work through that. The stores accept `Queryable` precisely so this
 * is possible without a parallel "…InTransaction" variant of every method.
 *
 * ## Why the writes stay sequential
 *
 * Everything here is sequential `await`s rather than `Promise.all`, and that is
 * deliberate twice over. A single Postgres connection processes one statement at
 * a time, so parallelising against it buys nothing; and the operations are
 * genuinely ordered — a vow break reads the sheet it is about to write, salience
 * decay must precede the bump, and `sceneAdvance` must be last.
 */
import { randomUUID } from 'node:crypto';
import type { Delta, EntityId, StoryEvent, Turn, Visibility } from '../domain/types.ts';
import type { Db } from '../db/pg.ts';
import { World } from '../store/index-pg.ts';

export interface CommitResult {
  events: StoryEvent[];
  touchedIds: EntityId[];
  brokenVows: Array<{ entityId: EntityId; vowId: string; text: string }>;
  newThreadIds: string[];
  factIds: string[];
}

export interface CommitTurnInput {
  rawInput: string;
  intent: Turn['intent'];
  delta: Delta;
  bookProse: string;
  meta: Turn['meta'];
  threadId?: string | null;
}

export interface CommitTurnResult {
  commit: CommitResult;
  turn: Turn;
}

async function applyDelta(
  world: World,
  delta: Delta,
  scene: number,
  turn: number,
  visibility: Visibility,
): Promise<CommitResult> {
  const result: CommitResult = { events: [], touchedIds: [], brokenVows: [], newThreadIds: [], factIds: [] };
  const touched = new Set<EntityId>();

  for (const u of delta.entityUpserts) {
    await world.graph.upsert({ ...u, provenance: `emergent:${scene}`, createdScene: scene, salience: 0.6 }, 'chronicle');
    touched.add(u.id);
  }

  for (const ev of delta.events) {
    const stored = await world.chronicle.addEvent({
      scene,
      turn,
      text: ev.text,
      participants: ev.participants,
      locationId: ev.locationId,
      significance: ev.significance,
      visibility,
      fromConsequenceId: null,
    });
    result.events.push(stored);
    for (const p of ev.participants) touched.add(p);
    if (ev.locationId) touched.add(ev.locationId);
  }

  for (const a of delta.edgeAsserts) {
    await world.graph.assertEdge(a, scene, 'chronicle', `scene:${scene}`);
    touched.add(a.subject);
    touched.add(a.object);
  }

  for (const r of delta.edgeRetires) {
    await world.graph.retireEdge(r.subject, r.predicate, r.object, scene);
    touched.add(r.subject);
    touched.add(r.object);
  }

  for (const c of delta.conditionUpdates) {
    await world.cast.updateCondition(c.entityId, c.patch);
    touched.add(c.entityId);
  }

  for (const r of delta.relationshipUpdates) {
    await world.cast.adjustRelationship(r.fromId, r.toId, {
      trust: r.trustDelta,
      affection: r.affectionDelta,
      respect: r.respectDelta,
      note: r.note,
    });
    touched.add(r.fromId);
    touched.add(r.toId);
  }

  for (const f of delta.factsLearned) {
    const fact = await world.chronicle.addFact(f.text, scene);
    result.factIds.push(fact.id);
    for (const id of f.knownBy) await world.chronicle.setKnowledge(fact.id, id, 'knows', scene);
    for (const id of f.suspectedBy) await world.chronicle.setKnowledge(fact.id, id, 'suspects', scene);
  }

  for (const t of delta.threadUpdates) {
    const cur = t.id ? await world.threads.get(t.id) : undefined;
    if (t.id && cur) {
      await world.threads.update(t.id, {
        title: t.title ?? cur.title,
        stakes: t.stakes ?? cur.stakes,
        tension: cur.tension + (t.tensionDelta ?? 0),
        parties: t.parties ?? cur.parties,
        resolutions: t.resolutions ?? cur.resolutions,
        status: t.status ?? cur.status,
      });
    } else if (t.title) {
      const created = await world.threads.create({
        title: t.title,
        stakes: t.stakes ?? '',
        tension: Math.max(0, Math.min(1, 0.4 + (t.tensionDelta ?? 0))),
        parties: t.parties ?? [],
        resolutions: t.resolutions?.length ? t.resolutions : ['unresolved', 'escalates', 'fades'],
        status: t.status ?? 'open',
        createdScene: scene,
      });
      result.newThreadIds.push(created.id);
    }
  }

  for (const v of delta.vowBreaks) {
    const vow = await world.cast.breakVow(v.entityId, v.vowId, scene);
    if (!vow) continue;
    result.brokenVows.push({ entityId: v.entityId, vowId: v.vowId, text: vow.text });
    const name = (await world.graph.get(v.entityId))?.name ?? v.entityId;
    const thread = await world.threads.create({
      title: `${name} broke a vow: ${vow.text}`,
      stakes: 'who they are now, and who learns of it',
      tension: 0.9,
      parties: [v.entityId],
      resolutions: ['penance', 'concealment', 'a second break', 'exposure'],
      status: 'open',
      createdScene: scene,
    });
    result.newThreadIds.push(thread.id);
    await world.chronicle.addDivergence(scene, 'vow-break', `${name} broke "${vow.text}"`);
  }

  await world.graph.decaySalience(0.04);
  await world.graph.bumpSalience([...touched], 0.4);
  result.touchedIds = [...touched];
  return result;
}

/**
 * Applies a delta atomically.
 *
 * Takes the pool (`Db`) rather than a `World`, because it needs to *start* a
 * transaction — a `World` holds a `Queryable`, which may already be a transaction
 * client and cannot begin another. The world to write to is identified by story
 * id, and rebuilt over the transaction client inside.
 */
export async function commitDelta(
  db: Db,
  world: World,
  delta: Delta,
  visibility: Visibility = 'onscreen',
): Promise<CommitResult> {
  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
    // Same story, same canon sources, but every statement now rides the
    // transaction. See the header for why this is not optional.
    const w = new World({
      db: client,
      storyId: world.storyId,
      sources: world.sources,
      imagesDir: world.illustrations.imagesDir,
      crypto: world.crypto,
    });
    const session = await w.session.get();
    const result = await applyDelta(w, delta, session.scene, session.turn, visibility);
    if (delta.sceneAdvance) {
      await w.session.set({ scene: session.scene + 1, turn: 0 });
      await w.chronicle.upsertScene(session.scene + 1, {});
    }
    return result;
  });
}

/**
 * Commits the authoritative prose record and every state change from it as one
 * story-serialised transaction.
 */
export async function commitTurn(db: Db, world: World, input: CommitTurnInput): Promise<CommitTurnResult> {
  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
    const w = new World({
      db: client,
      storyId: world.storyId,
      sources: world.sources,
      imagesDir: world.illustrations.imagesDir,
      crypto: world.crypto,
    });
    const session = await w.session.get();
    const turnNo = session.turn + 1;
    const commit = await applyDelta(w, input.delta, session.scene, turnNo, 'onscreen');
    const turn = await w.chronicle.addTurn({
      scene: session.scene,
      turn: turnNo,
      rawInput: input.rawInput,
      intent: input.intent,
      delta: input.delta,
      bookProse: input.bookProse,
      pinned: false,
      meta: input.meta,
    });
    if (input.threadId) await w.threads.adjustTension(input.threadId, 0.05);
    if (input.delta.sceneAdvance) {
      await w.session.set({ scene: session.scene + 1, turn: 0 });
      await w.chronicle.upsertScene(session.scene + 1, {});
    } else {
      await w.session.set({ turn: turnNo });
    }
    return { commit, turn };
  });
}

/** Used by the consequence tick to record something that happened offscreen. */
export async function commitOffscreenEvent(
  world: World,
  text: string,
  actorId: EntityId,
  visibility: Visibility,
  consequenceId: string,
  significance = 0.5,
): Promise<StoryEvent> {
  const session = await world.session.get();
  return world.chronicle.addEvent({
    id: `ev:${randomUUID()}`,
    scene: session.scene,
    turn: session.turn,
    text,
    participants: [actorId],
    locationId: null,
    significance,
    visibility,
    fromConsequenceId: consequenceId,
  });
}
