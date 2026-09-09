/**
 * Consequence propagation, Postgres. See DESIGN.md §6.
 *
 * The core move: do not simulate the world, simulate the consequences of what
 * the player touched. Each committed delta seeds pending consequences that
 * mature on their own schedule; firing one seeds more at depth+1. Cost stays
 * bounded because only the disturbed neighbourhood is ever processed.
 *
 * Most of this is deterministic graph work rather than model calls.
 *
 * ## What the port had to change, and one thing it had to fix
 *
 * This file read the store more than any other — 42 call sites — and several of
 * them sat inside loops that were free in-process and are not free over a
 * connection. Three patterns were addressed rather than transliterated:
 *
 *   - **`session.get()` was called in six different helpers**, each of them per
 *     invocation, inside loops. It is now read once per operation and passed down
 *     as `PropagationContext`, which also makes the code honest: every helper was
 *     already assuming the session did not change mid-tick.
 *
 *   - **`world.cast.get(actorId)` and `cast.get(player)` per candidate reactor.**
 *     `pickVisibility` and `pickTrigger` each fetched both sheets, so seeding one
 *     event's consequences fetched the player's sheet once per reactor. The
 *     context carries the player's sheet, and candidate sheets are batched.
 *
 *   - **`transmitRumours` re-queried `knowersOf(fact.id)` inside its innermost
 *     loop**, once per neighbour, to test whether that neighbour already knew.
 *     That is O(knowers x neighbours) queries for a single fact and would have
 *     been the slowest thing in the turn loop. It now reads the knower set once
 *     per fact and maintains it in memory as news moves — which is also more
 *     correct, because the SQLite version could transmit the same fact to the same
 *     recipient twice within one tick if two knowers reached them before the
 *     re-query caught up.
 */
import type {
  CharacterSheet,
  Consequence,
  Delta,
  EntityId,
  Maturity,
  StoryEvent,
  Trigger,
  Visibility,
} from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
import { commitOffscreenEvent } from '../loop/commit-pg.ts';
// The predicate vocabulary lives with the packs because that is where it is
// authored against, but it is *enforced* here — an edge whose predicate has no
// stance summons no reactor at all. See `packs/predicates.ts` for why that is
// worth a shared table rather than a local regex ladder.
import { FACTION_PREDICATES, type PropagationStance, stanceForPredicate } from '../packs/predicates.ts';

/**
 * The per-operation snapshot every helper needs.
 *
 * Replaces six independent `world.session.get()` calls and the repeated fetch of
 * the player's sheet. Built once at the top of each exported entry point; the
 * helpers below take it rather than reaching for the world, which is what keeps
 * the query count proportional to the work rather than to the loop nesting.
 */
interface PropagationContext {
  scene: number;
  playerId: EntityId;
  playerSheet: CharacterSheet | undefined;
  currentLocationId: string | null;
  ignoranceBudget: number;
  propagationDepth: number;
  npcAgency: number;
}

async function contextFor(world: World): Promise<PropagationContext> {
  const session = await world.session.get();
  return {
    scene: session.scene,
    playerId: session.playerCharacterId,
    playerSheet: session.playerCharacterId ? await world.cast.get(session.playerCharacterId) : undefined,
    currentLocationId: session.currentLocationId,
    ignoranceBudget: session.knobs.ignoranceBudget,
    propagationDepth: session.knobs.propagationDepth,
    npcAgency: session.knobs.npcAgency,
  };
}
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

interface Reactor {
  entityId: EntityId;
  strength: number;
  /** Why they care, used to choose a fitting reaction. */
  stance: PropagationStance;
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
 * Derives pending consequences from a committed delta.
 *
 * Propagation travels the typed edges and the relationship table, which is what
 * those relations are *for* beyond flavour: the consistency graph doubles as the
 * causality substrate. Reaction strength scales with edge weight and relationship
 * intensity, and decays with hops.
 */
export async function seedConsequences(
  world: World,
  delta: Delta,
  events: StoryEvent[],
  opts: SeedOptions = defaultSeedOptions(),
): Promise<Consequence[]> {
  const ctx = await contextFor(world);
  const maxDepth = Math.min(opts.maxDepth, ctx.propagationDepth);
  const seeded: Consequence[] = [];

  for (const event of events) {
    // Only consequential acts ripple. Most turns should produce nothing.
    if (event.significance < opts.minSignificance) continue;

    for (const subjectId of event.participants) {
      const reactors = await findReactors(world, ctx, subjectId);
      // Every candidate's sheet in one query, rather than two per reactor across
      // pickVisibility and pickTrigger.
      const sheets = await world.cast.getManyOrBlank(reactors.map((r) => r.entityId));
      const hidden = await world.consequences.hiddenFiredCount();

      for (const r of reactors) {
        const significance = event.significance * r.strength;
        if (significance < opts.minSignificance) continue;

        const sheet = sheets.get(r.entityId);
        const visibility = pickVisibility(ctx, sheet, hidden, opts.discoverableBias, significance);
        const trigger = pickTrigger(ctx, sheet, event, r.strength);

        seeded.push(
          await world.consequences.enqueue({
            causeEventId: event.id,
            trigger,
            actorId: r.entityId,
            action: pickReaction(r, event),
            visibility,
            maturity: trigger.kind === 'immediate' ? 'ripening' : 'pending',
            depth: 1,
            significance,
            createdScene: ctx.scene,
          }),
        );

        if (seeded.length >= 12) break; // hard cap: consequence spam kills stories
      }
    }
  }

  return seeded.filter((c) => c.depth <= maxDepth);
}

/**
 * Who cares that this happened to this entity. Walks social edges and the
 * relationship table, then merges, keeping the strongest signal per actor.
 *
 * The player character is never a reactor: the queue drives NPCs and the world,
 * while the protagonist acts through their own turns. Queueing a consequence the
 * player performs offscreen would take their agency away.
 */
async function findReactors(world: World, ctx: PropagationContext, subjectId: EntityId): Promise<Reactor[]> {
  const byId = new Map<EntityId, Reactor>();
  const keep = (r: Reactor) => {
    const cur = byId.get(r.entityId);
    if (!cur || r.strength > cur.strength) byId.set(r.entityId, r);
  };

  // The three independent reads overlap: they go through the pool, so awaiting
  // them together is one round trip's latency rather than three.
  const [toward, inbound, outbound] = await Promise.all([
    world.cast.relationshipsToward(subjectId),
    world.graph.edgesTo(subjectId, ctx.scene),
    world.graph.edgesFrom(subjectId, ctx.scene),
  ]);

  // Anyone holding a strong directional feeling about the subject.
  for (const rel of toward) {
    const intensity = Math.max(Math.abs(rel.trust), Math.abs(rel.affection), Math.abs(rel.respect));
    if (intensity < 0.25) continue;
    const hostile = rel.trust < -0.2 || rel.affection < -0.2;
    keep({ entityId: rel.fromId, strength: intensity * 0.9, stance: hostile ? 'hostile' : 'loyal' });
  }

  // Typed edges pointing at the subject: kinship, loyalty, obligation, enmity.
  for (const edge of inbound) {
    const stance = stanceForPredicate(edge.predicate);
    if (!stance) continue;
    keep({ entityId: edge.subject, strength: edge.weight * 0.8, stance });
  }

  // Factions the subject belongs to respond per their agenda, not sentiment.
  // The members of every such faction are fetched in one batch rather than one
  // query per faction.
  const factional: readonly string[] = FACTION_PREDICATES;
  const factionEdges = outbound.filter((e) => factional.includes(e.predicate));
  if (factionEdges.length) {
    const members = await world.graph.neighboursMany(
      factionEdges.map((e) => e.object),
      ctx.scene,
    );
    for (const edge of factionEdges) {
      for (const { edge: member } of members.get(edge.object) ?? []) {
        // Only inbound membership edges count: `neighboursMany` returns both
        // directions, and a faction's own outbound edges are not its members.
        if (member.object !== edge.object) continue;
        if (member.subject === subjectId) continue;
        if (!factional.includes(member.predicate)) continue;
        keep({ entityId: member.subject, strength: edge.weight * member.weight * 0.5, stance: 'factional' });
      }
    }
  }

  byId.delete(subjectId);
  byId.delete(ctx.playerId);
  return [...byId.values()].sort((a, b) => b.strength - a.strength).slice(0, 5);
}

/**
 * Visibility class. Most consequences should be discoverable: a world of pure
 * hidden machinery is indistinguishable from no machinery at all.
 *
 * Pure over the context and the actor's sheet, so it costs nothing per reactor.
 */
function pickVisibility(
  ctx: PropagationContext,
  sheet: CharacterSheet | undefined,
  hiddenFired: number,
  discoverableBias: number,
  significance: number,
): Visibility {
  // Same room means the player simply sees it.
  if (
    sheet &&
    ctx.playerSheet &&
    sheet.condition.locationId &&
    sheet.condition.locationId === ctx.playerSheet.condition.locationId
  ) {
    return 'onscreen';
  }

  // The ignorance budget: if too much has already matured unseen, start steering
  // traces toward the player rather than hiding more.
  if (hiddenFired >= ctx.ignoranceBudget) return 'offscreen-discoverable';

  const bias = discoverableBias * (0.5 + significance / 2);
  return bias > 0.45 ? 'offscreen-discoverable' : 'offscreen-hidden';
}

/**
 * When it matures. Gating on knowledge is what makes offscreen chains feel real
 * rather than magical: nobody can react to what they have not learned.
 */
function pickTrigger(
  ctx: PropagationContext,
  sheet: CharacterSheet | undefined,
  event: StoryEvent,
  strength: number,
): Trigger {
  if (sheet?.condition.locationId && sheet.condition.locationId === ctx.playerSheet?.condition.locationId) {
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

/**
 * Advances the queue one step. Runs between scenes rather than per turn, and is
 * mostly deterministic, so it costs nearly nothing.
 */
export async function tickConsequences(
  world: World,
  opts: SeedOptions = defaultSeedOptions(),
): Promise<TickResult> {
  const ctx = await contextFor(world);
  const scene = ctx.scene;
  const result: TickResult = { fired: [], ripened: [], expired: [], chained: [], transmissions: [] };

  const pending = await world.consequences.pending();
  // Actor names for every pending consequence, in one query: the SQLite version
  // called graph.get(c.actorId) per fired consequence.
  const actors = await world.graph.getMany(pending.map((c) => c.actorId));

  for (const c of pending) {
    const age = scene - c.createdScene;

    if (age > 12 && c.significance < 0.4) {
      await world.consequences.setMaturity(c.id, 'expired');
      result.expired.push(c.id);
      continue;
    }

    if (!(await isReady(world, ctx, c))) continue;

    if (c.maturity === 'pending') {
      await world.consequences.setMaturity(c.id, 'ripening');
      result.ripened.push(c.id);
      continue;
    }

    // Ripening and ready: fire it.
    const actorName = actors.get(c.actorId)?.name ?? c.actorId;
    const text = `${actorName} ${c.action}.`;
    const event = await commitOffscreenEvent(world, text, c.actorId, c.visibility, c.id, c.significance);
    await world.consequences.setMaturity(c.id, 'fired', scene);
    result.fired.push({ consequence: c, event });

    // Chain onward at depth+1, decaying so chains terminate on their own.
    if (c.depth < Math.min(opts.maxDepth, ctx.propagationDepth)) {
      const nextSig = c.significance * 0.55;
      if (nextSig >= opts.minSignificance) {
        const reactors = (await findReactors(world, ctx, c.actorId)).slice(0, 2);
        const sheets = await world.cast.getManyOrBlank(reactors.map((r) => r.entityId));
        const hidden = await world.consequences.hiddenFiredCount();
        for (const r of reactors) {
          const sig = nextSig * r.strength;
          if (sig < opts.minSignificance) continue;
          result.chained.push(
            await world.consequences.enqueue({
              causeEventId: event.id,
              trigger: { kind: 'after-scenes', scenes: Math.max(1, Math.round(3 - r.strength * 2)) },
              actorId: r.entityId,
              action: pickReaction(r, event),
              visibility: pickVisibility(ctx, sheets.get(r.entityId), hidden, opts.discoverableBias, sig),
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

  result.transmissions = await transmitRumours(world, 4, ctx);
  return result;
}

async function isReady(world: World, ctx: PropagationContext, c: Consequence): Promise<boolean> {
  const t = c.trigger;
  switch (t.kind) {
    case 'immediate':
      return true;
    case 'after-scenes':
      return ctx.scene - c.createdScene >= t.scenes;
    case 'on-learn':
      return world.chronicle.knows(t.entityId, t.factId);
    case 'on-enter':
      return ctx.currentLocationId === t.locationId;
    default:
      return false;
  }
}

/**
 * News propagates along social edges with latency and distortion. By the third
 * hop the story is wrong, and the distorted version is what people act on —
 * which is free drama, and the reason suppression is a playable tactic: killing
 * a witness or buying silence cuts an edge in this graph.
 *
 * The knower set is read once per fact and then maintained in memory as news
 * moves. The SQLite version re-queried it per neighbour inside the innermost
 * loop, which is O(knowers x neighbours) queries per fact here — and was also
 * subtly wrong, since two knowers reaching the same recipient in one tick could
 * both transmit before the re-query saw the first.
 */
export async function transmitRumours(
  world: World,
  maxPerTick = 4,
  context?: PropagationContext,
): Promise<Array<{ factId: string; toId: EntityId; distortion: number }>> {
  const ctx = context ?? (await contextFor(world));
  const scene = ctx.scene;
  const moved: Array<{ factId: string; toId: EntityId; distortion: number }> = [];

  for (const fact of await world.chronicle.facts(40)) {
    if (moved.length >= maxPerTick) break;
    const allKnowers = await world.chronicle.knowersOf(fact.id);
    const knowers = allKnowers.filter((k) => k.level === 'knows');
    if (!knowers.length) continue;
    // Everyone who already has any opinion about this fact, maintained locally.
    const reached = new Set(allKnowers.map((k) => k.entityId));

    // Hub status and neighbourhoods for every knower, in two batches rather than
    // per knower inside the loop.
    const knowerIds = knowers.map((k) => k.entityId);
    const [knowerEntities, neighbourhoods] = await Promise.all([
      world.graph.getMany(knowerIds),
      world.graph.neighboursMany(knowerIds, scene),
    ]);

    for (const knower of knowers) {
      // Some nodes are hubs: innkeepers, couriers, spies accelerate everything.
      const hubBonus = isHub(knowerEntities.get(knower.entityId), neighbourhoods.get(knower.entityId)?.length ?? 0)
        ? 0.35
        : 0;

      for (const { edge, otherId } of neighbourhoods.get(knower.entityId) ?? []) {
        if (moved.length >= maxPerTick) break;
        if (reached.has(otherId)) continue;

        const chance = edge.weight * 0.5 + hubBonus;
        if (chance < 0.45) continue;

        const distortion = Math.min(1, knower.distortion + 0.25);
        // Past a threshold the recipient believes a version that is simply wrong.
        const level = distortion >= 0.6 ? 'wrong' : 'suspects';
        await world.chronicle.setKnowledge(fact.id, otherId, level, scene, distortion);
        reached.add(otherId);
        moved.push({ factId: fact.id, toId: otherId, distortion });
      }
    }
  }
  return moved;
}

/**
 * Hubs accelerate transmission. Pure now, over an already-fetched entity and its
 * degree, so it costs nothing inside the loop it is called from.
 */
function isHub(e: { name: string; summary: string } | undefined, degree: number): boolean {
  if (!e) return false;
  if (/inn|tavern|courier|spy|market/i.test(`${e.name} ${e.summary}`)) return true;
  return degree >= 6;
}

/**
 * Offscreen world tick: NPCs and factions advance their own agendas one step.
 * The world changing without the player is what makes it a place rather than a
 * backdrop, and it generates unplanned complications for free.
 */
export async function worldTick(world: World): Promise<string[]> {
  const ctx = await contextFor(world);
  const notes: string[] = [];
  if (ctx.npcAgency < 0.2) return notes;

  for (const thread of await world.threads.open(4)) {
    // High-tension threads drift upward on their own; low ones cool.
    const drift = thread.tension > 0.5 ? 0.03 : -0.02;
    await world.threads.adjustTension(thread.id, drift * ctx.npcAgency * 2);
    notes.push(`${thread.title}: tension ${drift > 0 ? 'rising' : 'easing'}`);
  }
  return notes;
}

/**
 * What a directive changes. Committed chronicle is never touched: a directive
 * steers the future only (DESIGN §7.3).
 */
export async function applyDirectiveRecalc(
  world: World,
  directiveId: string,
  directiveText: string,
): Promise<{
  supersededConsequences: string[];
  retimedConsequences: string[];
  raisedThreads: string[];
  loweredThreads: string[];
}> {
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

  for (const thread of await world.threads.open(20)) {
    const score = matches(`${thread.title} ${thread.stakes} ${thread.resolutions.join(' ')}`);
    if (score >= 2) {
      await world.threads.adjustTension(thread.id, 0.2);
      raised.push(thread.id);
    } else if (thread.tension > 0.6) {
      await world.threads.adjustTension(thread.id, -0.1);
      lowered.push(thread.id);
    }
  }

  const pending = await world.consequences.pending();
  const actors = await world.graph.getMany(pending.map((c) => c.actorId));
  for (const c of pending) {
    const actorName = actors.get(c.actorId)?.name ?? c.actorId;
    const score = matches(`${actorName} ${c.action}`);
    if (score >= 2) {
      // Aligned with the directive: bring it forward.
      await world.consequences.retime(c.id, { kind: 'after-scenes', scenes: 1 });
      retimed.push(c.id);
    } else if (c.significance < 0.3) {
      // Low-value and unaligned: the directive has moved past it.
      await world.consequences.supersede(c.id, directiveId);
      superseded.push(c.id);
    }
  }

  return { supersededConsequences: superseded, retimedConsequences: retimed, raisedThreads: raised, loweredThreads: lowered };
}

export type { Maturity };
