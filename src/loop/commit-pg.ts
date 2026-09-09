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
import type { Delta, EntityId, StoryEvent, Visibility } from '../domain/types.ts';
import type { Db } from '../db/pg.ts';
import { World } from '../store/index-pg.ts';

export interface CommitResult {
  events: StoryEvent[];
  touchedIds: EntityId[];
  brokenVows: Array<{ entityId: EntityId; vowId: string; text: string }>;
  newThreadIds: string[];
  factIds: string[];
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
  const session = await world.session.get();
  const scene = session.scene;
  const turn = session.turn;

  return db.tx(async (client) => {
    // Same story, same canon sources, but every statement now rides the
    // transaction. See the header for why this is not optional.
    const w = new World({
      db: client,
      storyId: world.storyId,
      sources: world.sources,
      imagesDir: world.illustrations.imagesDir,
    });

    const result: CommitResult = { events: [], touchedIds: [], brokenVows: [], newThreadIds: [], factIds: [] };
    const touched = new Set<EntityId>();

    for (const u of delta.entityUpserts) {
      await w.graph.upsert({ ...u, provenance: `emergent:${scene}`, createdScene: scene, salience: 0.6 }, 'chronicle');
      touched.add(u.id);
    }

    for (const ev of delta.events) {
      const stored = await w.chronicle.addEvent({
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
      await w.graph.assertEdge(a, scene, 'chronicle', `scene:${scene}`);
      touched.add(a.subject);
      touched.add(a.object);
    }

    for (const r of delta.edgeRetires) {
      await w.graph.retireEdge(r.subject, r.predicate, r.object, scene);
      touched.add(r.subject);
      touched.add(r.object);
    }

    for (const c of delta.conditionUpdates) {
      await w.cast.updateCondition(c.entityId, c.patch);
      touched.add(c.entityId);
    }

    for (const r of delta.relationshipUpdates) {
      await w.cast.adjustRelationship(r.fromId, r.toId, {
        trust: r.trustDelta,
        affection: r.affectionDelta,
        respect: r.respectDelta,
        note: r.note,
      });
      touched.add(r.fromId);
      touched.add(r.toId);
    }

    // Facts default to being known only by the characters the prose showed
    // learning them. Anyone else has to find out through transmission.
    for (const f of delta.factsLearned) {
      const fact = await w.chronicle.addFact(f.text, scene);
      result.factIds.push(fact.id);
      for (const id of f.knownBy) await w.chronicle.setKnowledge(fact.id, id, 'knows', scene);
      for (const id of f.suspectedBy) await w.chronicle.setKnowledge(fact.id, id, 'suspects', scene);
    }

    for (const t of delta.threadUpdates) {
      // One read instead of the SQLite version's two `get(t.id)` calls: it called
      // the same query twice to test existence and then to read the row, which
      // was free in-process and is a wasted round trip here.
      const cur = t.id ? await w.threads.get(t.id) : undefined;
      if (t.id && cur) {
        await w.threads.update(t.id, {
          title: t.title ?? cur.title,
          stakes: t.stakes ?? cur.stakes,
          tension: cur.tension + (t.tensionDelta ?? 0),
          parties: t.parties ?? cur.parties,
          resolutions: t.resolutions ?? cur.resolutions,
          status: t.status ?? cur.status,
        });
      } else if (t.title) {
        const created = await w.threads.create({
          title: t.title,
          stakes: t.stakes ?? '',
          tension: Math.max(0, Math.min(1, 0.4 + (t.tensionDelta ?? 0))),
          parties: t.parties ?? [],
          // Never one resolution: a single path is a plot, which breaks on deviation.
          resolutions: t.resolutions?.length ? t.resolutions : ['unresolved', 'escalates', 'fades'],
          status: t.status ?? 'open',
          createdScene: scene,
        });
        result.newThreadIds.push(created.id);
      }
    }

    // A broken vow is the most consequential thing that can happen to a sheet:
    // it spawns a thread and becomes a divergence, because the fallout is the story.
    for (const v of delta.vowBreaks) {
      const vow = await w.cast.breakVow(v.entityId, v.vowId, scene);
      if (!vow) continue;
      result.brokenVows.push({ entityId: v.entityId, vowId: v.vowId, text: vow.text });
      const name = (await w.graph.get(v.entityId))?.name ?? v.entityId;
      const thread = await w.threads.create({
        title: `${name} broke a vow: ${vow.text}`,
        stakes: 'who they are now, and who learns of it',
        tension: 0.9,
        parties: [v.entityId],
        resolutions: ['penance', 'concealment', 'a second break', 'exposure'],
        status: 'open',
        createdScene: scene,
      });
      result.newThreadIds.push(thread.id);
      await w.chronicle.addDivergence(scene, 'vow-break', `${name} broke "${vow.text}"`);
    }

    // Salience: everything cools, then what this turn touched gets hot again.
    // Order matters — bumping before decaying would cool what just happened.
    await w.graph.decaySalience(0.04);
    await w.graph.bumpSalience([...touched], 0.4);
    result.touchedIds = [...touched];

    if (delta.sceneAdvance) {
      await w.session.set({ scene: scene + 1, turn: 0 });
      await w.chronicle.upsertScene(scene + 1, {});
    }

    return result;
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
