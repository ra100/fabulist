/**
 * Delta commit. See DESIGN.md §4 step 9.
 *
 * The only place chronicle state is written. Keeping it in one transaction means
 * a half-applied delta cannot leave the graph describing a story the prose does
 * not tell.
 */
import { randomUUID } from 'node:crypto';
import type { Delta, EntityId, StoryEvent, Visibility } from '../domain/types.ts';
import { tx } from '../db/db.ts';
import type { World } from '../store/index.ts';

export interface CommitResult {
  events: StoryEvent[];
  touchedIds: EntityId[];
  brokenVows: Array<{ entityId: EntityId; vowId: string; text: string }>;
  newThreadIds: string[];
  factIds: string[];
}

export function commitDelta(world: World, delta: Delta, visibility: Visibility = 'onscreen'): CommitResult {
  const session = world.session.get();
  const scene = session.scene;
  const turn = session.turn;

  return tx(world.db, () => {
    const result: CommitResult = { events: [], touchedIds: [], brokenVows: [], newThreadIds: [], factIds: [] };
    const touched = new Set<EntityId>();

    for (const u of delta.entityUpserts) {
      world.graph.upsert(
        { ...u, provenance: `emergent:${scene}`, createdScene: scene, salience: 0.6 },
        'chronicle',
      );
      touched.add(u.id);
    }

    for (const ev of delta.events) {
      const stored = world.chronicle.addEvent({
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
      world.graph.assertEdge(a, scene, 'chronicle', `scene:${scene}`);
      touched.add(a.subject);
      touched.add(a.object);
    }

    for (const r of delta.edgeRetires) {
      world.graph.retireEdge(r.subject, r.predicate, r.object, scene);
      touched.add(r.subject);
      touched.add(r.object);
    }

    for (const c of delta.conditionUpdates) {
      world.cast.updateCondition(c.entityId, c.patch);
      touched.add(c.entityId);
    }

    for (const r of delta.relationshipUpdates) {
      world.cast.adjustRelationship(r.fromId, r.toId, {
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
      const fact = world.chronicle.addFact(f.text, scene);
      result.factIds.push(fact.id);
      for (const id of f.knownBy) world.chronicle.setKnowledge(fact.id, id, 'knows', scene);
      for (const id of f.suspectedBy) world.chronicle.setKnowledge(fact.id, id, 'suspects', scene);
    }

    for (const t of delta.threadUpdates) {
      if (t.id && world.threads.get(t.id)) {
        const cur = world.threads.get(t.id)!;
        world.threads.update(t.id, {
          title: t.title ?? cur.title,
          stakes: t.stakes ?? cur.stakes,
          tension: cur.tension + (t.tensionDelta ?? 0),
          parties: t.parties ?? cur.parties,
          resolutions: t.resolutions ?? cur.resolutions,
          status: t.status ?? cur.status,
        });
      } else if (t.title) {
        const created = world.threads.create({
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
      const vow = world.cast.breakVow(v.entityId, v.vowId, scene);
      if (!vow) continue;
      result.brokenVows.push({ entityId: v.entityId, vowId: v.vowId, text: vow.text });
      const name = world.graph.get(v.entityId)?.name ?? v.entityId;
      const thread = world.threads.create({
        title: `${name} broke a vow: ${vow.text}`,
        stakes: 'who they are now, and who learns of it',
        tension: 0.9,
        parties: [v.entityId],
        resolutions: ['penance', 'concealment', 'a second break', 'exposure'],
        status: 'open',
        createdScene: scene,
      });
      result.newThreadIds.push(thread.id);
      world.chronicle.addDivergence(scene, 'vow-break', `${name} broke "${vow.text}"`);
    }

    // Salience: everything cools, then what this turn touched gets hot again.
    world.graph.decaySalience(0.04);
    world.graph.bumpSalience([...touched], 0.4);
    result.touchedIds = [...touched];

    if (delta.sceneAdvance) {
      world.session.set({ scene: scene + 1, turn: 0 });
      world.chronicle.upsertScene(scene + 1, {});
    }

    return result;
  });
}

/** Used by the consequence tick to record something that happened offscreen. */
export function commitOffscreenEvent(
  world: World,
  text: string,
  actorId: EntityId,
  visibility: Visibility,
  consequenceId: string,
  significance = 0.5,
): StoryEvent {
  const session = world.session.get();
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
