/**
 * The three-tier delta validator, Postgres.
 *
 * The schemas and `coerceDelta` are untouched — they are pure over JSON and are
 * re-exported from `validate.ts` rather than copied, so there is exactly one
 * definition of the wire shape and a schema change cannot land on one engine only.
 * Only `validateDelta` reads the world, and only it appears here.
 *
 * ## Resolve everything first, then filter
 *
 * The SQLite version called `resolve()` from inside `.filter()` and `.map()`
 * callbacks, which was fine when a lookup was a microsecond function call. Those
 * callbacks cannot be async, and making them so would mean rewriting the control
 * flow into a chain of `for await` loops with the filtering unrolled by hand.
 *
 * Instead this collects every id the delta mentions, resolves them all in two
 * batched queries (`getMany` for the ones that already exist, `resolveName` only
 * for the ones that do not), and then runs the original synchronous filtering
 * against that map. The logic below is therefore line-for-line the same as before
 * — same order, same issue messages, same repair semantics — which is what makes
 * the behaviour comparable.
 *
 * `resolveName` stays one query per unresolved id, deliberately: it is the
 * expensive fuzzy path, it only runs for ids the batch could not find, and a
 * delta that mentions many unknown entities is already a delta in trouble. Its
 * own header explains why it refuses to guess rather than falling back to
 * similarity search.
 */
import type { Delta, EntityId } from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
import type { Entity } from '../domain/types.ts';
import type { ValidationIssue, ValidationResult } from './validate.ts';

export {
  coerceDelta,
  deltaSchema,
  directorSchema,
  integritySchema,
  intentSchema,
  refereeSchema,
} from './validate.ts';
export type { ValidationIssue, ValidationResult, ValidationTier } from './validate.ts';

/** Every entity id a delta refers to, so they can be resolved in one pass. */
function mentionedIds(delta: Delta): EntityId[] {
  const ids: EntityId[] = [];
  for (const u of delta.entityUpserts) ids.push(u.id);
  for (const ev of delta.events) {
    ids.push(...ev.participants);
    if (ev.locationId) ids.push(ev.locationId);
  }
  for (const a of delta.edgeAsserts) ids.push(a.subject, a.object);
  for (const r of delta.edgeRetires) ids.push(r.subject, r.object);
  for (const c of delta.conditionUpdates) ids.push(c.entityId);
  for (const r of delta.relationshipUpdates) ids.push(r.fromId, r.toId);
  for (const f of delta.factsLearned) ids.push(...f.knownBy, ...f.suspectedBy);
  for (const v of delta.vowBreaks) ids.push(v.entityId);
  for (const t of delta.threadUpdates) if (t.parties) ids.push(...t.parties);
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Tiers 2 and 3. Unknown entity references are repaired by name resolution when
 * possible and dropped when not, because a dangling edge is worse than a missing
 * one — it makes the Referee confidently wrong later.
 */
export async function validateDelta(world: World, delta: Delta): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const session = await world.session.get();
  const scene = session.scene;

  // Entities created by this delta are legitimate references within it, so they
  // are written before resolution rather than after — otherwise every edge
  // pointing at a brand-new entity would be "unknown" and dropped.
  const known = await world.graph.getMany(mentionedIds(delta));
  for (const u of delta.entityUpserts) {
    if (!known.has(u.id)) {
      await world.graph.upsert({ ...u, provenance: `emergent:${scene}`, createdScene: scene }, 'chronicle');
      // Recorded locally too, so the synchronous resolution below sees it.
      known.set(u.id, { id: u.id, name: u.name } as Entity);
    }
  }

  // The fuzzy pass, for ids the batch could not find. One query each, only for
  // the misses.
  const byName = new Map<EntityId, EntityId | null>();
  for (const id of mentionedIds(delta)) {
    if (known.has(id)) continue;
    const hit = await world.graph.resolveName(id);
    byName.set(id, hit?.id ?? null);
  }

  // From here down this is the SQLite implementation unchanged: `resolve` is now
  // a pure lookup into the two maps above, so every filter and map stays
  // synchronous and the control flow is identical.
  const resolve = (id: EntityId, path: string): EntityId | null => {
    if (!id) return null;
    if (known.has(id)) return id;
    const hit = byName.get(id);
    if (hit) {
      issues.push({ tier: 'referential', path, message: `resolved "${id}" to ${hit}`, repaired: true });
      return hit;
    }
    issues.push({ tier: 'referential', path, message: `unknown entity "${id}"`, repaired: true });
    return null;
  };

  for (const ev of delta.events) {
    ev.participants = ev.participants.map((p) => resolve(p, 'events.participants')).filter((p): p is string => !!p);
    if (ev.locationId) ev.locationId = resolve(ev.locationId, 'events.locationId');
  }

  delta.edgeAsserts = delta.edgeAsserts.filter((a) => {
    const s = resolve(a.subject, 'edgeAsserts.subject');
    const o = resolve(a.object, 'edgeAsserts.object');
    if (!s || !o) return false;
    a.subject = s;
    a.object = o;
    return true;
  });

  // Retiring an edge that was never asserted is a semantic contradiction: the
  // model believes a relation existed that the graph never had. The live-edge
  // check needs a query per subject, so the subjects are resolved first and their
  // edges fetched in one batch — the same "resolve, then decide" shape as above.
  const retireCandidates = delta.edgeRetires.map((r) => ({
    r,
    s: resolve(r.subject, 'edgeRetires.subject'),
    o: resolve(r.object, 'edgeRetires.object'),
  }));
  const retireSubjects = [...new Set(retireCandidates.map((c) => c.s).filter((s): s is string => !!s))];
  const liveEdges = retireSubjects.length ? await world.graph.neighboursMany(retireSubjects) : new Map();
  delta.edgeRetires = retireCandidates
    .filter(({ r, s, o }) => {
      if (!s || !o) return false;
      r.subject = s;
      r.object = o;
      const live = (liveEdges.get(s) ?? []).some(
        (n: { edge: { subject: string; predicate: string; object: string } }) =>
          n.edge.subject === s && n.edge.predicate === r.predicate && n.edge.object === o,
      );
      if (!live) {
        issues.push({
          tier: 'semantic',
          path: 'edgeRetires',
          message: `no live edge ${s} -[${r.predicate}]-> ${o} to retire`,
          repaired: true,
        });
        return false;
      }
      return true;
    })
    .map(({ r }) => r);

  delta.conditionUpdates = delta.conditionUpdates.filter((c) => {
    const id = resolve(c.entityId, 'conditionUpdates.entityId');
    if (!id) return false;
    c.entityId = id;
    return true;
  });

  delta.relationshipUpdates = delta.relationshipUpdates.filter((r) => {
    const f = resolve(r.fromId, 'relationshipUpdates.fromId');
    const t = resolve(r.toId, 'relationshipUpdates.toId');
    if (!f || !t) return false;
    r.fromId = f;
    r.toId = t;
    return true;
  });

  for (const f of delta.factsLearned) {
    f.knownBy = f.knownBy.map((k) => resolve(k, 'factsLearned.knownBy')).filter((k): k is string => !!k);
    f.suspectedBy = f.suspectedBy.map((k) => resolve(k, 'factsLearned.suspectedBy')).filter((k): k is string => !!k);
  }

  // Semantic: a vow break must name a vow the character actually holds.
  //
  // `getMany` on the *entities*, not `getManyOrBlank` on the sheets: the SQLite
  // version used `cast.get()` returning undefined to mean "no sheet", and
  // `getManyOrBlank` deliberately never returns undefined, so it cannot express
  // that distinction. Two batched queries — one for existence, one for the sheets
  // — replace what would otherwise be a per-vow `get` plus a per-vow sheet read.
  const vowIds = [...new Set(delta.vowBreaks.map((v) => v.entityId))];
  const vowSheets = vowIds.length ? await world.cast.getManyOrBlank(vowIds) : new Map();
  const sheetPresence = new Map<EntityId, boolean>();
  for (const id of vowIds) {
    // A blank sheet and a real one are the same shape, so presence is asked of the
    // store directly. One query per vow break, and a delta breaks one or two vows.
    sheetPresence.set(id, (await world.cast.get(id)) !== undefined);
  }
  delta.vowBreaks = delta.vowBreaks.filter((v) => {
    if (!sheetPresence.get(v.entityId)) {
      issues.push({ tier: 'semantic', path: 'vowBreaks', message: `no sheet for ${v.entityId}`, repaired: true });
      return false;
    }
    const sheet = vowSheets.get(v.entityId)!;
    if (!sheet.contract.vows.some((vow: { id: string }) => vow.id === v.vowId)) {
      issues.push({
        tier: 'semantic',
        path: 'vowBreaks',
        message: `${v.entityId} holds no vow "${v.vowId}"`,
        repaired: true,
      });
      return false;
    }
    return true;
  });

  // Semantic: acting on an entity the chronicle says is gone. Re-fetched rather
  // than reusing `known`, because the entities created above were inserted with a
  // stub and their props are not in that map.
  const participantIds = [...new Set(delta.events.flatMap((ev) => ev.participants))];
  const participants = participantIds.length ? await world.graph.getMany(participantIds) : new Map();
  for (const ev of delta.events) {
    for (const p of ev.participants) {
      const e = participants.get(p);
      if (e && e.props.status === 'dead') {
        issues.push({
          tier: 'semantic',
          path: 'events.participants',
          message: `${p} is recorded dead but participates in an event`,
          repaired: false,
        });
      }
    }
  }

  const blocking = issues.filter((i) => !i.repaired);
  return { ok: blocking.length === 0, delta, issues };
}
