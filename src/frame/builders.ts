/**
 * Role-specific frame builders. See DESIGN.md §9.1.
 *
 * The point of the Referee/Director/Narrator split is that no single call needs
 * the whole picture. A monolithic prompt would not fit in 64k; split, every call
 * is comfortable and each prompt is cleaner as a side effect.
 *
 * Two rendering densities per entity (full sheet vs thumbnail) saves more than
 * any other optimisation here.
 */
import type {
  CharacterSheet,
  Entity,
  EntityId,
  Frame,
  SessionState,
  Thread,
} from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { assembleFrame, Priority, type SlotSpec } from './budget.ts';
import type { Tokenizer } from './tokenizer.ts';

export interface FrameContext {
  world: World;
  session: SessionState;
  tokenizer: Tokenizer;
  budget: number;
  /** Player's raw input for this turn, when relevant to the role. */
  rawInput?: string;
  /** Agreed facts handed from Referee/Director to the Narrator. */
  agreedBeat?: string;
}

// --------------------------------------------------------------- renderers

/** Cheap one-liner. Most of the cast never needs more than this. */
export function thumbnail(e: Entity): string {
  const s = e.summary ? ` — ${e.summary}` : '';
  return `id=${e.id} name=${e.name} (${e.type})${s}`;
}

/** Full sheet, for characters actually on stage. */
export function renderSheet(e: Entity, sheet: CharacterSheet): string {
  const L: string[] = [`id=${e.id} name=${e.name}`];
  if (e.summary) L.push(`summary: ${e.summary}`);
  const id = sheet.identity;
  if (id.goals.length) L.push(`goals: ${id.goals.join('; ')}`);
  if (id.wounds.length) L.push(`wounds: ${id.wounds.join('; ')}`);
  if (id.fears.length) L.push(`fears: ${id.fears.join('; ')}`);
  if (id.allegiances.length) L.push(`allegiances: ${id.allegiances.join('; ')}`);
  if (id.competencies.length) L.push(`competencies: ${id.competencies.join('; ')}`);
  if (id.arc) L.push(`arc: ${id.arc}`);
  const v = sheet.voice;
  if (v.diction) L.push(`voice: ${v.diction}`);
  if (v.tics.length) L.push(`verbal tics: ${v.tics.join('; ')}`);
  if (v.samples.length) L.push(`sample lines: ${v.samples.map((s) => `"${s}"`).join(' ')}`);
  if (v.never.length) L.push(`never says: ${v.never.join('; ')}`);
  const c = sheet.condition;
  const cond = [
    c.mood && `mood ${c.mood}`,
    c.injuries.length && `injuries ${c.injuries.join(', ')}`,
    c.inventory.length && `carrying ${c.inventory.join(', ')}`,
    c.intent && `intent ${c.intent}`,
  ].filter(Boolean);
  if (cond.length) L.push(`condition: ${cond.join(' | ')}`);
  if (sheet.locks.length) L.push(`LOCKED (treat as ground truth): ${sheet.locks.join(', ')}`);
  return L.join('\n');
}

/** Vows are rendered with ids so the integrity gate can name what it blocked. */
export function renderVows(sheet: CharacterSheet): string {
  if (!sheet.contract.vows.length) return '';
  const vows = [...sheet.contract.vows].sort((a, b) => a.rank - b.rank);
  const lines = vows.map(
    (v) => `id=${v.id} rank=${v.rank} ${v.broken ? '[BROKEN]' : '[held]'} ${v.text}`,
  );
  const c = sheet.contract;
  if (c.drives.length) lines.push(`drives: ${c.drives.join('; ')}`);
  if (c.breakingPoint) lines.push(`breaking point: ${c.breakingPoint}`);
  if (c.costOfBreak) lines.push(`cost of breaking: ${c.costOfBreak}`);
  return lines.join('\n');
}

function renderThreads(threads: Thread[]): string {
  return threads
    .map(
      (t) =>
        `id=${t.id} tension=${t.tension.toFixed(2)} ${t.title} | stakes: ${t.stakes} | possible: ${t.resolutions.join(' / ')}`,
    )
    .join('\n');
}

function renderStyle(session: SessionState): string {
  const s = session.style;
  const lines = [
    `pov: ${s.pov}`,
    `tense: ${s.tense}`,
    `register: ${s.register}`,
    `density: ${s.density}`,
    `genre: ${s.genreLens}`,
    `humor: ${s.humor}`,
    `pacing: ${s.pacing}`,
    `dialogue ratio: ~${Math.round(s.dialogueRatio * 100)}%`,
    `target length: ~${s.sceneTarget} words`,
  ];
  if (s.comparables.length) lines.push(`echo the register of: ${s.comparables.join(', ')}`);
  if (s.forbidden.length) lines.push(`never write: ${s.forbidden.join('; ')}`);
  if (s.contentBounds.length) lines.push(`content bounds: ${s.contentBounds.join('; ')}`);
  return lines.join('\n');
}

// ----------------------------------------------------------------- helpers

function presentIds(ctx: FrameContext): EntityId[] {
  const { world, session } = ctx;
  const ids = new Set<EntityId>();
  if (session.playerCharacterId) ids.add(session.playerCharacterId);
  const player = world.cast.get(session.playerCharacterId);
  for (const id of player?.condition.presentWith ?? []) ids.add(id);
  // Anyone whose condition places them in this location is on stage.
  if (session.currentLocationId) {
    for (const sheet of world.cast.list()) {
      if (sheet.condition.locationId === session.currentLocationId) ids.add(sheet.entityId);
    }
  }
  return [...ids];
}

function neighbourhood(ctx: FrameContext, ids: EntityId[], hops = 1): string {
  const { world, session } = ctx;
  const seen = new Set<EntityId>(ids);
  const lines: string[] = [];
  let frontier = ids;
  for (let h = 0; h < hops; h++) {
    const next: EntityId[] = [];
    for (const id of frontier) {
      for (const { edge, otherId } of world.graph.neighbours(id, session.scene)) {
        const other = world.graph.get(otherId);
        if (!other) continue;
        lines.push(`${edge.subject} -[${edge.predicate} w=${edge.weight.toFixed(2)}]-> ${edge.object}`);
        if (!seen.has(otherId)) {
          seen.add(otherId);
          next.push(otherId);
          lines.push(`  ${thumbnail(other)}`);
        }
      }
    }
    frontier = next;
  }
  return [...new Set(lines)].join('\n');
}

function recentProse(ctx: FrameContext, maxTurns = 8): string {
  return ctx.world.chronicle
    .recentTurns(maxTurns)
    .filter((t) => t.bookProse)
    .map((t) => t.bookProse)
    .join('\n\n');
}

function sceneSummaries(ctx: FrameContext): string {
  return ctx.world.chronicle
    .scenes()
    .filter((s) => s.scene < ctx.session.scene && s.summary)
    .map((s) => `scene ${s.scene}: ${s.summary}`)
    .join('\n');
}

/**
 * What the present characters know and do not. Without this, NPCs react to
 * information they could not possess — the most immersion-breaking failure here.
 */
function epistemicMask(ctx: FrameContext): string {
  const { world, session } = ctx;
  const lines: string[] = [];
  const known = world.chronicle.knowledgeOf(session.playerCharacterId);
  if (known.length) {
    lines.push('player character knows:');
    for (const k of known.slice(0, 12)) {
      lines.push(`  [${k.level}${k.distortion > 0 ? ` distorted=${k.distortion.toFixed(2)}` : ''}] ${k.text}`);
    }
  }
  const hidden = world.chronicle.factsUnknownTo(session.playerCharacterId, 12);
  if (hidden.length) {
    lines.push('TRUE but the player character does NOT know (do not leak these):');
    for (const f of hidden) lines.push(`  ${f.text}`);
  }
  return lines.join('\n');
}

function locationCard(ctx: FrameContext): string {
  const { world, session } = ctx;
  if (!session.currentLocationId) return '';
  const loc = world.graph.get(session.currentLocationId);
  if (!loc) return '';
  const lines = [thumbnail(loc)];
  for (const { edge, otherId } of world.graph.neighbours(loc.id, session.scene).slice(0, 12)) {
    const other = world.graph.get(otherId);
    if (other) lines.push(`  ${edge.predicate}: ${other.name}`);
  }
  return lines.join('\n');
}

function presentCastBlock(ctx: FrameContext, ids: EntityId[]): string {
  const { world } = ctx;
  return ids
    .map((id) => {
      const e = world.graph.get(id);
      if (!e) return '';
      return renderSheet(e, world.cast.getOrBlank(id));
    })
    .filter(Boolean)
    .join('\n\n');
}

function styleAnchors(ctx: FrameContext): string {
  const anchors = ctx.world.chronicle.anchors(3);
  if (!anchors.length) return '';
  return ['Passages the author liked. Match this texture, do not copy the words:', ...anchors.map((a) => `"${a.text}"`)].join(
    '\n',
  );
}

// --------------------------------------------------------------- builders

/** Integrity only needs the acting character and their contract. ~4k. */
export function buildIntegrityFrame(ctx: FrameContext, actorId: EntityId): Frame {
  const { world } = ctx;
  const actor = world.graph.get(actorId);
  const sheet = world.cast.getOrBlank(actorId);
  const specs: SlotSpec[] = [
    { name: 'vows', priority: Priority.styleContract, content: renderVows(sheet), evictable: false },
    {
      name: 'actor',
      priority: Priority.presentCast,
      content: actor ? renderSheet(actor, sheet) : `id=${actorId}`,
      evictable: false,
      maxTokens: 900,
    },
    { name: 'recent-behaviour', priority: Priority.recentProse, content: recentProse(ctx, 3), maxTokens: 600 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Referee needs facts and constraints, not prose style. ~12k. */
export function buildRefereeFrame(ctx: FrameContext): Frame {
  const ids = presentIds(ctx);
  const specs: SlotSpec[] = [
    { name: 'location', priority: Priority.locationCard, content: locationCard(ctx), maxTokens: 500 },
    { name: 'present-cast', priority: Priority.presentCast, content: presentCastBlock(ctx, ids), evictable: false, maxTokens: 2000 },
    { name: 'neighbourhood', priority: Priority.neighbourhood, content: neighbourhood(ctx, ids, 1), maxTokens: 1400 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(ctx), maxTokens: 700 },
    { name: 'divergences', priority: Priority.sceneSummaries, content: ctx.world.chronicle.divergences().slice(-6).map((d) => `${d.kind}: ${d.detail}`).join('\n'), maxTokens: 300 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Director needs threads and agendas, not prose or deep lore. ~10k. */
export function buildDirectorFrame(ctx: FrameContext): Frame {
  const ids = presentIds(ctx);
  const { world, session } = ctx;
  const arrivals = world.consequences
    .pending()
    .filter((c) => c.maturity === 'ripening')
    .map((c) => `id=${c.id} actor=${c.actorId} action=${c.action} visibility=${c.visibility}`)
    .join('\n');
  const specs: SlotSpec[] = [
    { name: 'threads', priority: Priority.openThreads, content: renderThreads(world.threads.open()), evictable: false, maxTokens: 1200 },
    { name: 'directives', priority: Priority.styleContract, content: world.directives.active().map((d) => `[${d.strength}] ${d.text}`).join('\n'), evictable: false, maxTokens: 300 },
    { name: 'present-cast', priority: Priority.presentCast, content: ids.map((id) => { const e = world.graph.get(id); return e ? thumbnail(e) : ''; }).filter(Boolean).join('\n'), maxTokens: 600 },
    { name: 'pending-arrivals', priority: Priority.pendingArrivals, content: arrivals, maxTokens: 500 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(ctx), maxTokens: 600 },
    { name: 'scene-summaries', priority: Priority.sceneSummaries, content: sceneSummaries(ctx), maxTokens: 800 },
    { name: 'knobs', priority: Priority.styleContract, content: `danger=${session.knobs.danger} pacing=${session.knobs.pacing} npcAgency=${session.knobs.npcAgency}`, evictable: false },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Narrator needs the agreed beat, present cast, style, and recent prose. ~28k. */
export function buildNarratorFrame(ctx: FrameContext): Frame {
  const ids = presentIds(ctx);
  const { world } = ctx;
  const others = world.graph
    .list({ limit: 40, minSalience: 0.2 })
    .filter((e) => !ids.includes(e.id))
    .slice(0, 12);
  const specs: SlotSpec[] = [
    { name: 'style-contract', priority: Priority.styleContract, content: renderStyle(ctx.session), evictable: false },
    { name: 'style-anchors', priority: Priority.styleContract - 1, content: styleAnchors(ctx), evictable: false, maxTokens: 500 },
    { name: 'agreed-beat', priority: Priority.agreedBeat, content: ctx.agreedBeat ?? '', evictable: false },
    { name: 'present-cast', priority: Priority.presentCast, content: presentCastBlock(ctx, ids), evictable: false, maxTokens: 2600 },
    { name: 'location', priority: Priority.locationCard, content: locationCard(ctx), maxTokens: 600 },
    { name: 'recent-prose', priority: Priority.recentProse, content: recentProse(ctx, 6), maxTokens: 2200 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(ctx), maxTokens: 700 },
    { name: 'scene-summaries', priority: Priority.sceneSummaries, content: sceneSummaries(ctx), maxTokens: 900 },
    { name: 'cast-thumbnails', priority: Priority.castThumbnails, content: others.map(thumbnail).join('\n'), maxTokens: 500 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Extraction sees the prose it must convert, plus ids it may reference. */
export function buildExtractFrame(ctx: FrameContext, prose: string): Frame {
  const ids = presentIds(ctx);
  const { world, session } = ctx;
  const specs: SlotSpec[] = [
    { name: 'actor', priority: Priority.agreedBeat, content: session.playerCharacterId, evictable: false },
    { name: 'location', priority: Priority.locationCard, content: session.currentLocationId ?? '', evictable: false },
    { name: 'known-ids', priority: Priority.presentCast, content: ids.map((id) => { const e = world.graph.get(id); return e ? `${e.id} = ${e.name}` : id; }).join('\n'), evictable: false, maxTokens: 800 },
    { name: 'threads', priority: Priority.openThreads, content: world.threads.open(6).map((t) => `id=${t.id} ${t.title}`).join('\n'), maxTokens: 400 },
    { name: 'prose', priority: Priority.agreedBeat, content: prose, evictable: false },
    { name: 'player-input', priority: Priority.recentProse, content: ctx.rawInput ?? '', maxTokens: 300 },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

export { presentIds };
