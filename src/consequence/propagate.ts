/**
 * Consequence propagation. See DESIGN.md §6.
 *
 * The core move: do not simulate the world, simulate the consequences of what
 * the player touched. Each committed delta seeds pending consequences that
 * mature on their own schedule; firing one seeds more at depth+1. Cost stays
 * bounded because only the disturbed neighbourhood is ever processed.
 *
 * Most of this is deterministic graph work rather than model calls.
 */
import type {
  Consequence,
  Delta,
  EntityId,
  Maturity,
  StoryEvent,
  Trigger,
  Visibility,
} from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { commitOffscreenEvent } from '../loop/commit.ts';
// The predicate vocabulary lives with the packs because that is where it is
// authored against, but it is *enforced* here — an edge whose predicate has no
// stance summons no reactor at all. See `packs/predicates.ts` for why that is
// worth a shared table rather than a local regex ladder.
import { FACTION_PREDICATES, type PropagationStance, stanceForPredicate } from '../packs/predicates.ts';

/** Reactions available to a consequence actor. Constrained, like the GM moves. */
export const REACTIONS = [
  'seeks the truth of it',
  'moves against the responsible party',
  'withdraws support',
  'offers help unasked',
  'reports it to someone with power',
  'demands recompense',
  'protects someone from the fallout',
  'uses it for their own advantage',
  'spreads word of it',
] as const;

export interface SeedOptions {
  /** Cap on hops from the original act. Beyond this, chains die. */
  maxDepth: number;
  /** Below this significance, a consequence is not worth queueing. */
  minSignificance: number;
  /** Bias toward discoverable rather than hidden, so the machinery is felt. */
  discoverableBias: number;
}

export function defaultSeedOptions(): SeedOptions {
  return { maxDepth: 3, minSignificance: 0.18, discoverableBias: 0.7 };
}

/**
 * Derives pending consequences from a committed delta.
 *
 * Propagation travels the typed edges and the relationship table, which is what
 * those relations are *for* beyond flavour: the consistency graph doubles as the
 * causality substrate. Reaction strength scales with edge weight and relationship
 * intensity, and decays with hops.
 */
export function seedConsequences(
  world: World,
  delta: Delta,
  events: StoryEvent[],
  opts: SeedOptions = defaultSeedOptions(),
): Consequence[] {
  const session = world.session.get();
  const scene = session.scene;
  const maxDepth = Math.min(opts.maxDepth, session.knobs.propagationDepth);
  const seeded: Consequence[] = [];

  for (const event of events) {
    // Only consequential acts ripple. Most turns should produce nothing.
    if (event.significance < opts.minSignificance) continue;

    for (const subjectId of event.participants) {
      const reactors = findReactors(world, subjectId, scene);

      for (const r of reactors) {
        const significance = event.significance * r.strength;
        if (significance < opts.minSignificance) continue;

        const visibility = pickVisibility(world, r.entityId, opts.discoverableBias, significance);
        const trigger = pickTrigger(world, r.entityId, event, r.strength);

        seeded.push(
          world.consequences.enqueue({
            causeEventId: event.id,
            trigger,
            actorId: r.entityId,
            action: pickReaction(r, event),
            visibility,
            maturity: trigger.kind === 'immediate' ? 'ripening' : 'pending',
            depth: 1,
            significance,
            createdScene: scene,
          }),
        );

        if (seeded.length >= 12) break; // hard cap: consequence spam kills stories
      }
    }
  }

  return seeded.filter((c) => c.depth <= maxDepth);
}

interface Reactor {
  entityId: EntityId;
  strength: number;
  /** Why they care, used to choose a fitting reaction. */
  stance: PropagationStance;
}

/**
 * Who cares that this happened to this entity. Walks social edges and the
 * relationship table, then merges, keeping the strongest signal per actor.
 *
 * The player character is never a reactor: the queue drives NPCs and the world,
 * while the protagonist acts through their own turns. Queueing a consequence the
 * player performs offscreen would take their agency away.
 */
function findReactors(world: World, subjectId: EntityId, scene: number): Reactor[] {
  const byId = new Map<EntityId, Reactor>();
  const keep = (r: Reactor) => {
    const cur = byId.get(r.entityId);
    if (!cur || r.strength > cur.strength) byId.set(r.entityId, r);
  };

  // Anyone holding a strong directional feeling about the subject.
  for (const rel of world.cast.relationshipsToward(subjectId)) {
    const intensity = Math.max(Math.abs(rel.trust), Math.abs(rel.affection), Math.abs(rel.respect));
    if (intensity < 0.25) continue;
    const hostile = rel.trust < -0.2 || rel.affection < -0.2;
    keep({ entityId: rel.fromId, strength: intensity * 0.9, stance: hostile ? 'hostile' : 'loyal' });
  }

  // Typed edges pointing at the subject: kinship, loyalty, obligation, enmity.
  for (const edge of world.graph.edgesTo(subjectId, scene)) {
    const stance = stanceForPredicate(edge.predicate);
    if (!stance) continue;
    keep({ entityId: edge.subject, strength: edge.weight * 0.8, stance });
  }

  // Factions the subject belongs to respond per their agenda, not sentiment.
  const factional: readonly string[] = FACTION_PREDICATES;
  for (const edge of world.graph.edgesFrom(subjectId, scene)) {
    if (!factional.includes(edge.predicate)) continue;
    for (const member of world.graph.edgesTo(edge.object, scene)) {
      if (member.subject === subjectId) continue;
      if (!factional.includes(member.predicate)) continue;
      keep({ entityId: member.subject, strength: edge.weight * member.weight * 0.5, stance: 'factional' });
    }
  }

  byId.delete(subjectId);
  byId.delete(world.session.get().playerCharacterId);
  return [...byId.values()].sort((a, b) => b.strength - a.strength).slice(0, 5);
}

function pickReaction(r: Reactor, event: StoryEvent): string {
  const high = event.significance > 0.6;
  switch (r.stance) {
    case 'hostile':
      return high ? 'moves against the responsible party' : 'uses it for their own advantage';
    case 'kin':
      return high ? 'demands recompense' : 'seeks the truth of it';
    case 'loyal':
      return high ? 'protects someone from the fallout' : 'offers help unasked';
    case 'observer':
      return 'reports it to someone with power';
    default:
      return high ? 'reports it to someone with power' : 'spreads word of it';
  }
}

/**
 * Visibility class. Most consequences should be discoverable: a world of pure
 * hidden machinery is indistinguishable from no machinery at all.
 */
function pickVisibility(
  world: World,
  actorId: EntityId,
  discoverableBias: number,
  significance: number,
): Visibility {
  const player = world.session.get().playerCharacterId;
  const sheet = world.cast.get(actorId);
  const playerSheet = world.cast.get(player);

  // Same room means the player simply sees it.
  if (sheet && playerSheet && sheet.condition.locationId && sheet.condition.locationId === playerSheet.condition.locationId) {
    return 'onscreen';
  }

  // The ignorance budget: if too much has already matured unseen, start
  // steering traces toward the player rather than hiding more.
  const hidden = world.consequences.hiddenFiredCount();
  const budget = world.session.get().knobs.ignoranceBudget;
  if (hidden >= budget) return 'offscreen-discoverable';

  const bias = discoverableBias * (0.5 + significance / 2);
  return bias > 0.45 ? 'offscreen-discoverable' : 'offscreen-hidden';
}

/**
 * When it matures. Gating on knowledge is what makes offscreen chains feel real
 * rather than magical: nobody can react to what they have not learned.
 */
function pickTrigger(world: World, actorId: EntityId, event: StoryEvent, strength: number): Trigger {
  const player = world.session.get().playerCharacterId;
  const sheet = world.cast.get(actorId);
  const playerSheet = world.cast.get(player);

  if (sheet?.condition.locationId && sheet.condition.locationId === playerSheet?.condition.locationId) {
    return { kind: 'immediate' };
  }
  if (event.locationId && sheet?.condition.locationId === event.locationId) {
    return { kind: 'immediate' };
  }
  // Stronger ties hear sooner. Distance in the social graph becomes latency.
  const delay = Math.max(1, Math.round(4 - strength * 3));
  return { kind: 'after-scenes', scenes: delay };
}

// --------------------------------------------------------------------- tick

export interface TickResult {
  fired: Array<{ consequence: Consequence; event: StoryEvent }>;
  ripened: string[];
  expired: string[];
  /** Consequences seeded by the ones that fired: the chain continuing. */
  chained: Consequence[];
  /** Rumours that moved this tick. */
  transmissions: Array<{ factId: string; toId: EntityId; distortion: number }>;
}

/**
 * Advances the queue one step. Runs between scenes rather than per turn, and is
 * mostly deterministic, so it costs nearly nothing.
 */
export function tickConsequences(world: World, opts: SeedOptions = defaultSeedOptions()): TickResult {
  const session = world.session.get();
  const scene = session.scene;
  const result: TickResult = { fired: [], ripened: [], expired: [], chained: [], transmissions: [] };

  for (const c of world.consequences.pending()) {
    const age = scene - c.createdScene;

    if (age > 12 && c.significance < 0.4) {
      world.consequences.setMaturity(c.id, 'expired');
      result.expired.push(c.id);
      continue;
    }

    if (!isReady(world, c, scene)) continue;

    if (c.maturity === 'pending') {
      world.consequences.setMaturity(c.id, 'ripening');
      result.ripened.push(c.id);
      continue;
    }

    // Ripening and ready: fire it.
    const actorName = world.graph.get(c.actorId)?.name ?? c.actorId;
    const text = `${actorName} ${c.action}.`;
    const event = commitOffscreenEvent(world, text, c.actorId, c.visibility, c.id, c.significance);
    world.consequences.setMaturity(c.id, 'fired', scene);
    result.fired.push({ consequence: c, event });

    // Chain onward at depth+1, decaying so chains terminate on their own.
    if (c.depth < Math.min(opts.maxDepth, session.knobs.propagationDepth)) {
      const nextSig = c.significance * 0.55;
      if (nextSig >= opts.minSignificance) {
        for (const r of findReactors(world, c.actorId, scene).slice(0, 2)) {
          const sig = nextSig * r.strength;
          if (sig < opts.minSignificance) continue;
          result.chained.push(
            world.consequences.enqueue({
              causeEventId: event.id,
              trigger: { kind: 'after-scenes', scenes: Math.max(1, Math.round(3 - r.strength * 2)) },
              actorId: r.entityId,
              action: pickReaction(r, event),
              visibility: pickVisibility(world, r.entityId, opts.discoverableBias, sig),
              maturity: 'pending',
              depth: c.depth + 1,
              significance: sig,
              createdScene: scene,
            }),
          );
        }
      }
    }
  }

  result.transmissions = transmitRumours(world);
  return result;
}

function isReady(world: World, c: Consequence, scene: number): boolean {
  const t = c.trigger;
  switch (t.kind) {
    case 'immediate':
      return true;
    case 'after-scenes':
      return scene - c.createdScene >= t.scenes;
    case 'on-learn':
      return world.chronicle.knows(t.entityId, t.factId);
    case 'on-enter':
      return world.session.get().currentLocationId === t.locationId;
    default:
      return false;
  }
}

/**
 * News propagates along social edges with latency and distortion. By the third
 * hop the story is wrong, and the distorted version is what people act on —
 * which is free drama, and the reason suppression is a playable tactic: killing
 * a witness or buying silence cuts an edge in this graph.
 */
export function transmitRumours(world: World, maxPerTick = 4): Array<{ factId: string; toId: EntityId; distortion: number }> {
  const session = world.session.get();
  const scene = session.scene;
  const moved: Array<{ factId: string; toId: EntityId; distortion: number }> = [];

  for (const fact of world.chronicle.facts(40)) {
    if (moved.length >= maxPerTick) break;
    const knowers = world.chronicle.knowersOf(fact.id).filter((k) => k.level === 'knows');
    if (!knowers.length) continue;

    for (const knower of knowers) {
      // Some nodes are hubs: innkeepers, couriers, spies accelerate everything.
      const hubBonus = isHub(world, knower.entityId) ? 0.35 : 0;

      for (const { edge, otherId } of world.graph.neighbours(knower.entityId, scene)) {
        if (moved.length >= maxPerTick) break;
        if (world.chronicle.knowersOf(fact.id).some((k) => k.entityId === otherId)) continue;

        const chance = edge.weight * 0.5 + hubBonus;
        if (chance < 0.45) continue;

        const distortion = Math.min(1, knower.distortion + 0.25);
        // Past a threshold the recipient believes a version that is simply wrong.
        const level = distortion >= 0.6 ? 'wrong' : 'suspects';
        world.chronicle.setKnowledge(fact.id, otherId, level, scene, distortion);
        moved.push({ factId: fact.id, toId: otherId, distortion });
      }
    }
  }
  return moved;
}

function isHub(world: World, id: EntityId): boolean {
  const e = world.graph.get(id);
  if (!e) return false;
  if (/inn|tavern|courier|spy|market/i.test(`${e.name} ${e.summary}`)) return true;
  return world.graph.neighbours(id).length >= 6;
}

/**
 * Offscreen world tick: NPCs and factions advance their own agendas one step.
 * The world changing without the player is what makes it a place rather than a
 * backdrop, and it generates unplanned complications for free.
 */
export function worldTick(world: World): string[] {
  const session = world.session.get();
  const notes: string[] = [];
  if (session.knobs.npcAgency < 0.2) return notes;

  const threads = world.threads.open(4);
  for (const thread of threads) {
    // High-tension threads drift upward on their own; low ones cool.
    const drift = thread.tension > 0.5 ? 0.03 : -0.02;
    world.threads.adjustTension(thread.id, drift * session.knobs.npcAgency * 2);
    notes.push(`${thread.title}: tension ${drift > 0 ? 'rising' : 'easing'}`);
  }
  return notes;
}

/**
 * What a directive changes. Committed chronicle is never touched: a directive
 * steers the future only (DESIGN §7.3).
 */
export function applyDirectiveRecalc(
  world: World,
  directiveId: string,
  directiveText: string,
): {
  supersededConsequences: string[];
  retimedConsequences: string[];
  raisedThreads: string[];
  loweredThreads: string[];
} {
  const words = directiveText
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const superseded: string[] = [];
  const retimed: string[] = [];
  const raised: string[] = [];
  const lowered: string[] = [];

  const matches = (text: string) => {
    const t = text.toLowerCase();
    return words.filter((w) => t.includes(w)).length;
  };

  for (const thread of world.threads.open(20)) {
    const score = matches(`${thread.title} ${thread.stakes} ${thread.resolutions.join(' ')}`);
    if (score >= 2) {
      world.threads.adjustTension(thread.id, 0.2);
      raised.push(thread.id);
    } else if (thread.tension > 0.6) {
      world.threads.adjustTension(thread.id, -0.1);
      lowered.push(thread.id);
    }
  }

  for (const c of world.consequences.pending()) {
    const actorName = world.graph.get(c.actorId)?.name ?? c.actorId;
    const score = matches(`${actorName} ${c.action}`);
    if (score >= 2) {
      // Aligned with the directive: bring it forward.
      world.consequences.retime(c.id, { kind: 'after-scenes', scenes: 1 });
      retimed.push(c.id);
    } else if (c.significance < 0.3) {
      // Low-value and unaligned: the directive has moved past it.
      world.consequences.supersede(c.id, directiveId);
      superseded.push(c.id);
    }
  }

  return { supersededConsequences: superseded, retimedConsequences: retimed, raisedThreads: raised, loweredThreads: lowered };
}

export type { Maturity };
