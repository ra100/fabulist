/**
 * Role-specific frame builders. See DESIGN.md §9.1.
 *
 * The point of the Referee/Director/Narrator split is that no single call needs
 * the whole picture. A monolithic prompt would not fit in 64k; split, every call
 * is comfortable and each prompt is cleaner as a side effect.
 *
 * Two rendering densities per entity (full sheet vs thumbnail) saves more than
 * any other optimisation here.
 *
 * ## Prefetch, then render
 *
 * This file is the hot path: it runs three to five times per turn while the
 * player waits. Under SQLite every `world.graph.get(id)` was a microsecond
 * in-process call, so the builders read whatever they needed wherever they needed
 * it — `presentCastBlock` alone called `get` and `getOrBlank` once per present
 * character, and `neighbourhood` called `neighbours` plus `get` per node per hop.
 *
 * Over a connection each of those is a round trip, and converting them
 * one-for-one to `await` would have turned one burst into ~40 sequential hops
 * before the narrator sees a token. So the shape changed: `loadFrameData` issues
 * a fixed, small number of batched queries (`getMany`, `neighboursMany`,
 * `getManyOrBlank`), and every renderer below stays a *synchronous* pure function
 * over that snapshot.
 *
 * That is also why the render helpers in this file are byte-identical to the
 * SQLite version. They never touched the database; only the code that fed them
 * did.
 */
import type {
  CharacterSheet,
  Consequence,
  Directive,
  Edge,
  Entity,
  EntityId,
  Fact,
  Frame,
  SessionState,
  Thread,
  Turn,
} from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
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

/**
 * Everything the builders read, fetched once.
 *
 * A snapshot rather than a live handle, deliberately: a frame is a description of
 * the world at one instant, and letting different slots observe different states
 * mid-assembly would make a frame that never actually existed. It also means the
 * renderers cannot accidentally reintroduce a per-entity query.
 */
export interface FrameData {
  presentIds: EntityId[];
  entities: Map<EntityId, Entity>;
  sheets: Map<EntityId, CharacterSheet>;
  neighbours: Map<EntityId, Array<{ edge: Edge; otherId: EntityId }>>;
  recentTurns: Turn[];
  scenes: Array<{ scene: number; title: string; summary: string; locationId: string | null; chapter: number }>;
  knowledge: Array<{ level: string; distortion: number; text: string }>;
  hiddenFacts: Fact[];
  divergences: Array<{ kind: string; detail: string }>;
  anchors: Array<{ text: string }>;
  threads: Thread[];
  directives: Directive[];
  ripening: Consequence[];
  /** Salient entities not already on stage, for the narrator's thumbnail tail. */
  others: Entity[];
}

// --------------------------------------------------------------- renderers

/**
 * Infobox fields worth spending frame tokens on, in render order.
 *
 * Pass A writes *every* infobox field onto `entity.props` (`ingest/passA.ts`),
 * which for a real wiki is dozens of keys per page — image filenames, template
 * bookkeeping, appearance counts, voice actors. Rendering all of it would spend
 * the budget on noise and, worse, hand the Narrator real-world production
 * trivia as if it were in-world fact.
 *
 * So: a whitelist, not a dump. These are the keys that answer questions the
 * prose actually asks — who is this, whose side are they on, are they alive —
 * and they are the ones Fandom character/location/faction infoboxes agree on
 * most often. Deliberately excluded even though they are common: `image`,
 * `appearances`, `voice`/`actor`, `first`/`last` (real-world publication
 * order, not in-world time — see `.design/DBFIXES.md` C3 for why in-world
 * dates need their own treatment rather than being smuggled in here).
 *
 * `props.categories` is excluded too: it is an array of wiki taxonomy that
 * already drove `inferEntityType`, and re-rendering it tells the model how the
 * wiki is filed rather than what is true in the world.
 */
const PROP_KEYS = [
  'species',
  'race',
  'gender',
  'age',
  'born',
  'died',
  'status',
  'occupation',
  'title',
  'titles',
  'rank',
  'affiliation',
  'allegiance',
  'faction',
  'leader',
  'ruler',
  'members',
  'headquarters',
  'region',
  'location',
  'terrain',
  'population',
  'founded',
  'relatives',
  'family',
  'spouse',
  'allies',
  'enemies',
] as const;

/** Per-value cap. Long infobox values are usually a leaked list or stray markup. */
const PROP_VALUE_MAX = 120;

/**
 * The whitelisted slice of `props`, rendered deterministically.
 *
 * Order follows `PROP_KEYS` rather than insertion order so the same entity
 * renders identically across turns — a frame that reshuffles between calls
 * makes prompt-level caching useless and diffs unreadable.
 *
 * `maxKeys` bounds the worst case: a wiki that happens to fill every
 * whitelisted field should not quietly cost more than a thumbnail's worth of
 * budget when rendered for a dozen characters at once.
 */
export function renderProps(e: Entity, maxKeys = 8, skip: ReadonlySet<string> = new Set()): string {
  const out: string[] = [];
  for (const key of PROP_KEYS) {
    if (out.length >= maxKeys) break;
    if (skip.has(key)) continue;
    const raw = e.props[key];
    // Only scalars: an object or array here is either wiki bookkeeping or a
    // structure whose stringification would be noise ("[object Object]").
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const value = String(raw).replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const clipped = value.length > PROP_VALUE_MAX ? `${value.slice(0, PROP_VALUE_MAX - 1).trimEnd()}…` : value;
    out.push(`${key}: ${clipped}`);
  }
  return out.join(' | ');
}

/**
 * Props that `ingest/passA.ts` already copies onto the character sheet:
 * `affiliation` → `identity.allegiances`, `occupation` → `competencies`, and
 * the page summary → `arc`. `renderSheet` renders those sheet fields anyway, so
 * including the props copy too prints each fact twice in the same block.
 *
 * Skipped on the sheet path only. A thumbnail has no sheet beside it, so there
 * `affiliation` is the single most useful key available and must not be
 * suppressed. Kept as an explicit list next to the renderer rather than derived
 * at runtime: the duplication comes from a specific mapping in Pass A, and if
 * that mapping changes this should be updated deliberately rather than silently
 * tracking it.
 */
const SHEET_DUPLICATED_PROPS: ReadonlySet<string> = new Set(['affiliation', 'allegiance', 'occupation', 'role']);

/**
 * Cheap one-liner. Most of the cast never needs more than this.
 *
 * Gets a two-key slice of `props` rather than none: for an offstage name the
 * difference between "id=char:x name=Sered (Character)" and the same line plus
 * "status: dead | affiliation: the garrison" is most of what the Director needs
 * to decide whether to reach for them at all.
 */
export function thumbnail(e: Entity): string {
  const s = e.summary ? ` — ${e.summary}` : '';
  const p = renderProps(e, 2);
  return `id=${e.id} name=${e.name} (${e.type})${s}${p ? ` [${p}]` : ''}`;
}

/** Full sheet, for characters actually on stage. */
export function renderSheet(e: Entity, sheet: CharacterSheet): string {
  const L: string[] = [`id=${e.id} name=${e.name}`];
  if (e.summary) L.push(`summary: ${e.summary}`);
  // Canon attributes before authored ones: species/status/born are what the
  // source material asserts, and a sheet's goals and wounds read against that
  // background rather than instead of it. Fields Pass A already mirrored onto
  // the sheet are skipped here so each fact appears once per block.
  const props = renderProps(e, 8, SHEET_DUPLICATED_PROPS);
  if (props) L.push(props);
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

// ----------------------------------------------------------------- loading

/**
 * Who is on stage.
 *
 * Two sources, both cheap: the player's own `presentWith` list, and anyone whose
 * condition places them in the current location. The second needs every sheet in
 * the story, which is why it reads `cast.list()` — chronicle-only, so it is one
 * indexed query rather than a scan of canon.
 */
async function resolvePresentIds(world: World, session: SessionState): Promise<EntityId[]> {
  const ids = new Set<EntityId>();
  if (session.playerCharacterId) ids.add(session.playerCharacterId);
  const player = await world.cast.get(session.playerCharacterId);
  for (const id of player?.condition.presentWith ?? []) ids.add(id);
  if (session.currentLocationId) {
    for (const sheet of await world.cast.list()) {
      if (sheet.condition.locationId === session.currentLocationId) ids.add(sheet.entityId);
    }
  }
  return [...ids];
}

/**
 * Fetches everything the builders read, in a bounded number of batched queries.
 *
 * The independent reads run under one `Promise.all` — they go through the pool, so
 * they genuinely overlap rather than queueing behind each other. The dependent
 * ones are sequenced only where they must be: present ids decide which entities
 * and neighbourhoods to fetch, and the neighbourhood's second hop needs the first.
 *
 * `hops` is 1 for every current caller. It is a parameter because the Referee
 * frame is the one that would plausibly want 2, and the batching makes that a
 * fixed extra query rather than a per-node fan-out.
 */
export async function loadFrameData(
  world: World,
  session: SessionState,
  opts: { hops?: number; recentTurns?: number; otherLimit?: number } = {},
): Promise<FrameData> {
  const presentIds = await resolvePresentIds(world, session);

  // The location is on stage too: `locationCard` renders it and its neighbours.
  const seedIds = [...presentIds];
  if (session.currentLocationId) seedIds.push(session.currentLocationId);

  const [neighbours, recentTurns, scenes, knowledgeRaw, hiddenFacts, divergencesRaw, anchorsRaw, threads, directives, pending, othersRaw] =
    await Promise.all([
      world.graph.neighboursMany(seedIds, session.scene),
      world.chronicle.recentTurns(opts.recentTurns ?? 8),
      world.chronicle.scenes(),
      session.playerCharacterId ? world.chronicle.knowledgeOf(session.playerCharacterId) : Promise.resolve([]),
      session.playerCharacterId ? world.chronicle.factsUnknownTo(session.playerCharacterId, 12) : Promise.resolve([]),
      world.chronicle.divergences(),
      world.chronicle.anchors(3),
      world.threads.open(),
      world.directives.active(),
      world.consequences.pending(),
      world.graph.list({ limit: opts.otherLimit ?? 40, minSalience: 0.2 }),
    ]);

  // Every id any renderer might name: the stage, the location, and one hop out.
  const neighbourIds = [...neighbours.values()].flat().map((n) => n.otherId);
  const entities = await world.graph.getMany([...seedIds, ...neighbourIds, ...othersRaw.map((e) => e.id)]);

  // A second hop, when asked for. Fetched as one more batch rather than by
  // walking, so hops cost queries linear in depth instead of in node count.
  if ((opts.hops ?? 1) > 1) {
    const secondHop = await world.graph.neighboursMany(neighbourIds, session.scene);
    for (const [id, list] of secondHop) neighbours.set(id, list);
    const extra = [...secondHop.values()].flat().map((n) => n.otherId);
    for (const [id, e] of await world.graph.getMany(extra)) entities.set(id, e);
  }

  const sheets = await world.cast.getManyOrBlank(presentIds);

  return {
    presentIds,
    entities,
    sheets,
    neighbours,
    recentTurns,
    scenes,
    knowledge: knowledgeRaw.map((k) => ({ level: k.level, distortion: k.distortion, text: k.text })),
    hiddenFacts,
    divergences: divergencesRaw.map((d) => ({ kind: d.kind, detail: d.detail })),
    anchors: anchorsRaw.map((a) => ({ text: a.text })),
    threads,
    directives,
    ripening: pending.filter((c) => c.maturity === 'ripening'),
    others: othersRaw.filter((e) => !presentIds.includes(e.id)).slice(0, 12),
  };
}

// ----------------------------------------------------------------- helpers
// Every function below is synchronous and pure over `FrameData`. That is the
// invariant this file's header describes: if one of these ever needs to await,
// the fetch belongs in `loadFrameData` instead.

function neighbourhood(data: FrameData, ids: EntityId[], hops = 1): string {
  const seen = new Set<EntityId>(ids);
  const lines: string[] = [];
  let frontier = ids;
  for (let h = 0; h < hops; h++) {
    const next: EntityId[] = [];
    for (const id of frontier) {
      for (const { edge, otherId } of data.neighbours.get(id) ?? []) {
        const other = data.entities.get(otherId);
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

function recentProse(data: FrameData, maxTurns = 8): string {
  return data.recentTurns
    .slice(-maxTurns)
    .filter((t) => t.bookProse)
    .map((t) => t.bookProse)
    .join('\n\n');
}

function sceneSummaries(data: FrameData, currentScene: number): string {
  return data.scenes
    .filter((s) => s.scene < currentScene && s.summary)
    .map((s) => `scene ${s.scene}: ${s.summary}`)
    .join('\n');
}

/**
 * What the present characters know and do not. Without this, NPCs react to
 * information they could not possess — the most immersion-breaking failure here.
 */
function epistemicMask(data: FrameData): string {
  const lines: string[] = [];
  if (data.knowledge.length) {
    lines.push('player character knows:');
    for (const k of data.knowledge.slice(0, 12)) {
      lines.push(`  [${k.level}${k.distortion > 0 ? ` distorted=${k.distortion.toFixed(2)}` : ''}] ${k.text}`);
    }
  }
  if (data.hiddenFacts.length) {
    lines.push('TRUE but the player character does NOT know (do not leak these):');
    for (const f of data.hiddenFacts) lines.push(`  ${f.text}`);
  }
  return lines.join('\n');
}

function locationCard(data: FrameData, session: SessionState): string {
  if (!session.currentLocationId) return '';
  const loc = data.entities.get(session.currentLocationId);
  if (!loc) return '';
  // The full whitelist here, not `thumbnail`'s two-key slice: this is the place
  // the scene is actually happening in, so terrain, region and ruler are worth
  // the tokens in a way they are not for a name merely mentioned in passing.
  const lines = [`id=${loc.id} name=${loc.name} (${loc.type})${loc.summary ? ` — ${loc.summary}` : ''}`];
  const props = renderProps(loc);
  if (props) lines.push(`  ${props}`);
  for (const { edge, otherId } of (data.neighbours.get(loc.id) ?? []).slice(0, 12)) {
    const other = data.entities.get(otherId);
    if (other) lines.push(`  ${edge.predicate}: ${other.name}`);
  }
  return lines.join('\n');
}

function presentCastBlock(data: FrameData, ids: EntityId[]): string {
  return ids
    .map((id) => {
      const e = data.entities.get(id);
      if (!e) return '';
      return renderSheet(e, data.sheets.get(id) ?? blankSheetFor(id));
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A sheet for an id `loadFrameData` did not prefetch.
 *
 * Should not happen — `getManyOrBlank` returns an entry for every requested id —
 * but a renderer must not throw mid-frame if a caller passes an id outside
 * `presentIds`, so this degrades to an empty sheet the way `getOrBlank` did.
 */
function blankSheetFor(entityId: EntityId): CharacterSheet {
  return {
    entityId,
    identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
    contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: '', tics: [], samples: [], never: [] },
    condition: { locationId: null, mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: '', attire: '', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: false,
  };
}

function styleAnchors(data: FrameData): string {
  if (!data.anchors.length) return '';
  return [
    'Passages the author liked. Match this texture, do not copy the words:',
    ...data.anchors.map((a) => `"${a.text}"`),
  ].join('\n');
}

// --------------------------------------------------------------- builders
// Synchronous, over a snapshot. `loadFrameData` is the only awaiting step, so a
// caller that builds several frames for one turn pays for the data once.

/** Integrity only needs the acting character and their contract. ~4k. */
export function buildIntegrityFrame(ctx: FrameContext, data: FrameData, actorId: EntityId): Frame {
  const actor = data.entities.get(actorId);
  const sheet = data.sheets.get(actorId) ?? blankSheetFor(actorId);
  const specs: SlotSpec[] = [
    { name: 'vows', priority: Priority.styleContract, content: renderVows(sheet), evictable: false },
    {
      name: 'actor',
      priority: Priority.presentCast,
      content: actor ? renderSheet(actor, sheet) : `id=${actorId}`,
      evictable: false,
      maxTokens: 900,
    },
    { name: 'recent-behaviour', priority: Priority.recentProse, content: recentProse(data, 3), maxTokens: 600 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Referee needs facts and constraints, not prose style. ~12k. */
export function buildRefereeFrame(ctx: FrameContext, data: FrameData): Frame {
  const ids = data.presentIds;
  const specs: SlotSpec[] = [
    { name: 'location', priority: Priority.locationCard, content: locationCard(data, ctx.session), maxTokens: 500 },
    { name: 'present-cast', priority: Priority.presentCast, content: presentCastBlock(data, ids), evictable: false, maxTokens: 2000 },
    { name: 'neighbourhood', priority: Priority.neighbourhood, content: neighbourhood(data, ids, 1), maxTokens: 1400 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(data), maxTokens: 700 },
    { name: 'divergences', priority: Priority.sceneSummaries, content: data.divergences.slice(-6).map((d) => `${d.kind}: ${d.detail}`).join('\n'), maxTokens: 300 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Director needs threads and agendas, not prose or deep lore. ~10k. */
export function buildDirectorFrame(ctx: FrameContext, data: FrameData): Frame {
  const ids = data.presentIds;
  const { session } = ctx;
  const arrivals = data.ripening
    .map((c) => `id=${c.id} actor=${c.actorId} action=${c.action} visibility=${c.visibility}`)
    .join('\n');
  const specs: SlotSpec[] = [
    { name: 'threads', priority: Priority.openThreads, content: renderThreads(data.threads), evictable: false, maxTokens: 1200 },
    { name: 'directives', priority: Priority.styleContract, content: data.directives.map((d) => `[${d.strength}] ${d.text}`).join('\n'), evictable: false, maxTokens: 300 },
    { name: 'present-cast', priority: Priority.presentCast, content: ids.map((id) => { const e = data.entities.get(id); return e ? thumbnail(e) : ''; }).filter(Boolean).join('\n'), maxTokens: 600 },
    { name: 'pending-arrivals', priority: Priority.pendingArrivals, content: arrivals, maxTokens: 500 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(data), maxTokens: 600 },
    { name: 'scene-summaries', priority: Priority.sceneSummaries, content: sceneSummaries(data, session.scene), maxTokens: 800 },
    { name: 'knobs', priority: Priority.styleContract, content: `danger=${session.knobs.danger} pacing=${session.knobs.pacing} npcAgency=${session.knobs.npcAgency}`, evictable: false },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Narrator needs the agreed beat, present cast, style, and recent prose. ~28k. */
export function buildNarratorFrame(ctx: FrameContext, data: FrameData): Frame {
  const ids = data.presentIds;
  const specs: SlotSpec[] = [
    { name: 'style-contract', priority: Priority.styleContract, content: renderStyle(ctx.session), evictable: false },
    { name: 'style-anchors', priority: Priority.styleContract - 1, content: styleAnchors(data), evictable: false, maxTokens: 500 },
    { name: 'agreed-beat', priority: Priority.agreedBeat, content: ctx.agreedBeat ?? '', evictable: false },
    { name: 'present-cast', priority: Priority.presentCast, content: presentCastBlock(data, ids), evictable: false, maxTokens: 2600 },
    { name: 'location', priority: Priority.locationCard, content: locationCard(data, ctx.session), maxTokens: 600 },
    { name: 'recent-prose', priority: Priority.recentProse, content: recentProse(data, 6), maxTokens: 2200 },
    { name: 'epistemic-mask', priority: Priority.epistemicMask, content: epistemicMask(data), maxTokens: 700 },
    { name: 'scene-summaries', priority: Priority.sceneSummaries, content: sceneSummaries(data, ctx.session.scene), maxTokens: 900 },
    { name: 'cast-thumbnails', priority: Priority.castThumbnails, content: data.others.map(thumbnail).join('\n'), maxTokens: 500 },
    { name: 'player-input', priority: Priority.agreedBeat, content: ctx.rawInput ?? '', evictable: false },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}

/** Extraction sees the prose it must convert, plus ids it may reference. */
export function buildExtractFrame(ctx: FrameContext, data: FrameData, prose: string): Frame {
  const ids = data.presentIds;
  const { session } = ctx;
  const specs: SlotSpec[] = [
    { name: 'actor', priority: Priority.agreedBeat, content: session.playerCharacterId, evictable: false },
    { name: 'location', priority: Priority.locationCard, content: session.currentLocationId ?? '', evictable: false },
    { name: 'known-ids', priority: Priority.presentCast, content: ids.map((id) => { const e = data.entities.get(id); return e ? `${e.id} = ${e.name}` : id; }).join('\n'), evictable: false, maxTokens: 800 },
    { name: 'threads', priority: Priority.openThreads, content: data.threads.slice(0, 6).map((t) => `id=${t.id} ${t.title}`).join('\n'), maxTokens: 400 },
    { name: 'prose', priority: Priority.agreedBeat, content: prose, evictable: false },
    { name: 'player-input', priority: Priority.recentProse, content: ctx.rawInput ?? '', maxTokens: 300 },
  ];
  return assembleFrame(specs, { budget: ctx.budget, tokenizer: ctx.tokenizer });
}
