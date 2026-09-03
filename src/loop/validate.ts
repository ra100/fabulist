/**
 * JSON schemas for structured role output, plus the three-tier validator.
 * See DESIGN.md §4 (steps 7-8) and PLAN.md.
 *
 * Validation is tiered because the tiers deserve different responses:
 *   schema      — wrong shape. Retry with a repair prompt.
 *   referential — references entities that do not exist. Repair locally.
 *   semantic    — contradicts the graph. Surface it; never auto-commit.
 *
 * Silently discarding a delta is how the graph and the prose drift apart, so
 * the validator's job is to report precisely, not to quietly clean up.
 */
import type { Delta, EntityId } from '../domain/types.ts';
import { emptyDelta } from '../domain/types.ts';
import type { JsonSchema } from '../providers/provider.ts';
import type { World } from '../store/index.ts';

// ------------------------------------------------------------------ schemas

export const intentSchema: JsonSchema = {
  name: 'intent',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['class', 'action', 'manner', 'targetNames', 'dialogueGist', 'verbatim'],
    properties: {
      class: { type: 'string', enum: ['action', 'dialogue', 'ooc-directive', 'meta-query'] },
      action: { type: 'string' },
      manner: { type: 'string' },
      targetNames: { type: 'array', items: { type: 'string' } },
      dialogueGist: { type: ['string', 'null'] },
      verbatim: { type: 'boolean' },
    },
  },
};

export const integritySchema: JsonSchema = {
  name: 'integrity',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['distance', 'violatedVowIds', 'reasoning'],
    properties: {
      distance: {
        type: 'string',
        enum: ['in-character', 'stretch', 'off-key', 'contract-breach', 'incoherent'],
      },
      violatedVowIds: { type: 'array', items: { type: 'string' } },
      reasoning: { type: 'string' },
    },
  },
};

export const refereeSchema: JsonSchema = {
  name: 'referee',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ruling', 'reasoning', 'cost', 'spawn'],
    properties: {
      ruling: {
        type: 'string',
        enum: ['allow', 'allow-with-cost', 'reinterpret', 'friction', 'contradiction'],
      },
      reasoning: { type: 'string' },
      cost: { type: ['string', 'null'] },
      spawn: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'name', 'summary'],
          properties: {
            type: { type: 'string' },
            name: { type: 'string' },
            summary: { type: 'string' },
          },
        },
      },
    },
  },
};

export const directorSchema: JsonSchema = {
  name: 'director',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['move', 'threadId', 'beat', 'reasoning'],
    properties: {
      move: { type: 'string' },
      threadId: { type: ['string', 'null'] },
      beat: { type: 'string' },
      reasoning: { type: 'string' },
    },
  },
};

export const deltaSchema: JsonSchema = {
  name: 'delta',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['events', 'sceneAdvance'],
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            participants: { type: 'array', items: { type: 'string' } },
            locationId: { type: ['string', 'null'] },
            significance: { type: 'number' },
          },
        },
      },
      entityUpserts: { type: 'array' },
      edgeAsserts: { type: 'array' },
      edgeRetires: { type: 'array' },
      conditionUpdates: { type: 'array' },
      relationshipUpdates: { type: 'array' },
      factsLearned: { type: 'array' },
      threadUpdates: { type: 'array' },
      vowBreaks: { type: 'array' },
      sceneAdvance: { type: 'boolean' },
    },
  },
};

// ---------------------------------------------------------------- validation

export type ValidationTier = 'schema' | 'referential' | 'semantic';

export interface ValidationIssue {
  tier: ValidationTier;
  path: string;
  message: string;
  /** True when the validator repaired it rather than rejecting. */
  repaired: boolean;
}

export interface ValidationResult {
  ok: boolean;
  /** Repaired delta, safe to commit when `ok`. */
  delta: Delta;
  issues: ValidationIssue[];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback = 0.5): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Tier 1: coerce raw model output into a Delta. Tolerant on purpose — a missing
 * optional array is not worth a retry, but a missing `events` array is, because
 * a turn that narrates something and records no event is exactly the drift the
 * delta contract exists to prevent.
 */
export function coerceDelta(raw: unknown): { delta: Delta; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const delta = emptyDelta();

  if (typeof raw !== 'object' || raw === null) {
    issues.push({ tier: 'schema', path: '', message: 'response was not an object', repaired: false });
    return { delta, issues };
  }
  const o = raw as Record<string, unknown>;

  const events = asArray(o.events);
  if (events.length === 0) {
    issues.push({ tier: 'schema', path: 'events', message: 'no events recorded for a narrated turn', repaired: false });
  }
  for (const [i, e] of events.entries()) {
    if (typeof e !== 'object' || e === null) {
      issues.push({ tier: 'schema', path: `events[${i}]`, message: 'not an object', repaired: true });
      continue;
    }
    const ev = e as Record<string, unknown>;
    const text = asString(ev.text);
    if (!text) {
      issues.push({ tier: 'schema', path: `events[${i}].text`, message: 'missing text', repaired: true });
      continue;
    }
    delta.events.push({
      text,
      participants: asArray(ev.participants).map((p) => asString(p)).filter(Boolean),
      locationId: typeof ev.locationId === 'string' ? ev.locationId : null,
      significance: Math.max(0, Math.min(1, asNumber(ev.significance))),
    });
  }

  for (const u of asArray(o.entityUpserts)) {
    const e = u as Record<string, unknown>;
    const id = asString(e.id);
    const name = asString(e.name);
    if (!id || !name) {
      issues.push({ tier: 'schema', path: 'entityUpserts', message: 'upsert missing id or name', repaired: true });
      continue;
    }
    delta.entityUpserts.push({
      id,
      type: (asString(e.type, 'Concept') as Delta['entityUpserts'][number]['type']),
      name,
      summary: asString(e.summary),
      props: (e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {}),
    });
  }

  for (const a of asArray(o.edgeAsserts)) {
    const e = a as Record<string, unknown>;
    const subject = asString(e.subject);
    const predicate = asString(e.predicate);
    const object = asString(e.object);
    if (!subject || !predicate || !object) {
      issues.push({ tier: 'schema', path: 'edgeAsserts', message: 'incomplete edge', repaired: true });
      continue;
    }
    delta.edgeAsserts.push({ subject, predicate, object, weight: asNumber(e.weight) });
  }

  for (const r of asArray(o.edgeRetires)) {
    const e = r as Record<string, unknown>;
    const subject = asString(e.subject);
    const predicate = asString(e.predicate);
    const object = asString(e.object);
    if (subject && predicate && object) delta.edgeRetires.push({ subject, predicate, object });
  }

  for (const c of asArray(o.conditionUpdates)) {
    const e = c as Record<string, unknown>;
    const entityId = asString(e.entityId);
    if (!entityId || typeof e.patch !== 'object' || e.patch === null) continue;
    delta.conditionUpdates.push({ entityId, patch: e.patch as Delta['conditionUpdates'][number]['patch'] });
  }

  for (const r of asArray(o.relationshipUpdates)) {
    const e = r as Record<string, unknown>;
    const fromId = asString(e.fromId);
    const toId = asString(e.toId);
    if (!fromId || !toId) continue;
    delta.relationshipUpdates.push({
      fromId,
      toId,
      trustDelta: asNumber(e.trustDelta, 0),
      affectionDelta: asNumber(e.affectionDelta, 0),
      respectDelta: asNumber(e.respectDelta, 0),
      note: asString(e.note),
    });
  }

  for (const f of asArray(o.factsLearned)) {
    const e = f as Record<string, unknown>;
    const text = asString(e.text);
    if (!text) continue;
    delta.factsLearned.push({
      text,
      knownBy: asArray(e.knownBy).map((x) => asString(x)).filter(Boolean),
      suspectedBy: asArray(e.suspectedBy).map((x) => asString(x)).filter(Boolean),
    });
  }

  for (const t of asArray(o.threadUpdates)) {
    const e = t as Record<string, unknown>;
    delta.threadUpdates.push({
      id: e.id ? asString(e.id) : undefined,
      title: e.title ? asString(e.title) : undefined,
      stakes: e.stakes ? asString(e.stakes) : undefined,
      tensionDelta: e.tensionDelta !== undefined ? asNumber(e.tensionDelta, 0) : undefined,
      parties: e.parties ? asArray(e.parties).map((x) => asString(x)) : undefined,
      resolutions: e.resolutions ? asArray(e.resolutions).map((x) => asString(x)) : undefined,
      status: e.status ? (asString(e.status) as 'open' | 'resolved' | 'abandoned') : undefined,
    });
  }

  for (const v of asArray(o.vowBreaks)) {
    const e = v as Record<string, unknown>;
    const entityId = asString(e.entityId);
    const vowId = asString(e.vowId);
    if (entityId && vowId) delta.vowBreaks.push({ entityId, vowId });
  }

  delta.sceneAdvance = o.sceneAdvance === true;
  return { delta, issues };
}

/**
 * Tiers 2 and 3. Unknown entity references are repaired by name resolution when
 * possible and dropped when not, because a dangling edge is worse than a missing
 * one — it makes the Referee confidently wrong later.
 */
export function validateDelta(world: World, delta: Delta): ValidationResult {
  const issues: ValidationIssue[] = [];
  const scene = world.session.get().scene;

  const resolve = (id: EntityId, path: string): EntityId | null => {
    if (!id) return null;
    if (world.graph.has(id)) return id;
    const byName = world.graph.resolveName(id);
    if (byName) {
      issues.push({ tier: 'referential', path, message: `resolved "${id}" to ${byName.id}`, repaired: true });
      return byName.id;
    }
    issues.push({ tier: 'referential', path, message: `unknown entity "${id}"`, repaired: true });
    return null;
  };

  // Entities created by this delta are legitimate references within it.
  for (const u of delta.entityUpserts) {
    if (!world.graph.has(u.id)) {
      world.graph.upsert({ ...u, provenance: `emergent:${scene}`, createdScene: scene }, 'chronicle');
    }
  }

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

  delta.edgeRetires = delta.edgeRetires.filter((r) => {
    const s = resolve(r.subject, 'edgeRetires.subject');
    const o = resolve(r.object, 'edgeRetires.object');
    if (!s || !o) return false;
    r.subject = s;
    r.object = o;
    // Retiring an edge that was never asserted is a semantic contradiction: the
    // model believes a relation existed that the graph never had.
    const live = world.graph.edgesFrom(s).some((e) => e.predicate === r.predicate && e.object === o);
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
  });

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
  delta.vowBreaks = delta.vowBreaks.filter((v) => {
    const sheet = world.cast.get(v.entityId);
    if (!sheet) {
      issues.push({ tier: 'semantic', path: 'vowBreaks', message: `no sheet for ${v.entityId}`, repaired: true });
      return false;
    }
    if (!sheet.contract.vows.some((vow) => vow.id === v.vowId)) {
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

  // Semantic: acting on an entity the chronicle says is gone.
  for (const ev of delta.events) {
    for (const p of ev.participants) {
      const e = world.graph.get(p);
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
