/**
 * Domain types. See DESIGN.md §2.
 *
 * The central invariant: prose is a view of state. Every narrated turn must emit a
 * `Delta`; anything the prose implies but the delta omits did not happen.
 */

// ---------------------------------------------------------------- identifiers

/** Deterministic slug for canon (`char:brother-anselm`), uuid for emergent rows. */
export type EntityId = string;
export type FactId = string;
export type ThreadId = string;
export type ConsequenceId = string;
export type EventId = string;

/**
 * Canon is ingested and immutable at play time. Chronicle overlays it copy-on-write,
 * so a read is always `chronicle ?? canon` (DESIGN §2).
 */
export type Layer = 'canon' | 'chronicle';

export type EntityType =
  | 'Character'
  | 'Location'
  | 'Faction'
  | 'Item'
  | 'Concept'
  | 'Event';

/** Ingest depth (DESIGN §3.1). Depth is per-node, not global. */
export const DepthLevel = { none: 0, skim: 1, mid: 2, deep: 3 } as const;
export type DepthLevelValue = 0 | 1 | 2 | 3;

// --------------------------------------------------------------------- graph

export interface Entity {
  id: EntityId;
  type: EntityType;
  layer: Layer;
  name: string;
  /** One-line description used in thumbnail rendering (DESIGN §9.2). */
  summary: string;
  /** `wiki:<page>#<rev>` | `authored` | `emergent:<scene>` */
  provenance: string;
  /** Extraction certainty, surfaced in the UI. */
  confidence: number;
  /** Decays unless touched; drives what stays hot in the frame. */
  salience: number;
  depthLevel: DepthLevelValue;
  props: Record<string, unknown>;
  createdScene: number;
}

/**
 * Edges are temporally scoped: nothing is deleted, relations expire.
 * `validTo === null` means still in force (DESIGN §2).
 */
export interface Edge {
  id: number;
  subject: EntityId;
  predicate: string;
  object: EntityId;
  layer: Layer;
  validFrom: number;
  validTo: number | null;
  /** Strength, drives consequence propagation reach (DESIGN §6.2). */
  weight: number;
  provenance: string;
  confidence: number;
  /** Evidence span from the source page, so every edge is traceable. */
  evidence: string | null;
}

export interface EdgeAssert {
  subject: EntityId;
  predicate: string;
  object: EntityId;
  weight?: number;
  evidence?: string;
}

// ------------------------------------------------------------ character sheet

/** Ranked hard line. Checked against player actions, not just context (DESIGN §5.3). */
export interface Vow {
  id: string;
  text: string;
  /** 1 = most inviolable. Drives integrity-gate severity. */
  rank: number;
  broken: boolean;
  brokenScene: number | null;
}

export interface Identity {
  goals: string[];
  wounds: string[];
  fears: string[];
  allegiances: string[];
  competencies: string[];
  secrets: string[];
  arc: string;
}

export interface Contract {
  vows: Vow[];
  drives: string[];
  breakingPoint: string;
  costOfBreak: string;
}

/** Highest-leverage artifact for fandom fidelity (DESIGN §2). */
export interface VoiceCard {
  diction: string;
  tics: string[];
  samples: string[];
  never: string[];
}

export interface Condition {
  locationId: EntityId | null;
  mood: string;
  injuries: string[];
  inventory: string[];
  intent: string;
  presentWith: EntityId[];
}

/**
 * Visual identity, slow like `Identity` and `VoiceCard` — it describes what
 * stays true across every illustration of this entity, not what changed this
 * scene. This is the character-consistency anchor (§ illustration): every
 * generation prompt is built by appending scene-specific detail to this text,
 * never by replacing it, and by conditioning on `referenceImagePath` when the
 * active image provider supports image input. See `.design/ILLUSTRATIONS.md`.
 */
export interface Appearance {
  /** Durable visual description: build, face, colouring, bearing. Not clothing-of-the-day. */
  description: string;
  /** What they wear by default. A `conditionUpdates` change to inventory does not touch this. */
  attire: string;
  /** Distinguishing marks — scars, tattoos, a missing hand — that must recur in every image. */
  markers: string[];
  /** First image generated for this entity. Every later prompt is conditioned on it when the provider allows. */
  referenceImagePath: string | null;
  /** The seed used for the reference image. Reusing it is the cheapest consistency lever a seed-based model offers. */
  seed: number | null;
}

export function emptyAppearance(): Appearance {
  return { description: '', attire: '', markers: [], referenceImagePath: null, seed: null };
}

export interface CharacterSheet {
  entityId: EntityId;
  identity: Identity;
  contract: Contract;
  voice: VoiceCard;
  condition: Condition;
  appearance: Appearance;
  /** Dot-paths the player locked; the AI must treat these as ground truth. */
  locks: string[];
  isPlayer: boolean;
}

/** Directional and asymmetric by design (DESIGN §2). */
export interface Relationship {
  fromId: EntityId;
  toId: EntityId;
  trust: number;
  affection: number;
  respect: number;
  note: string;
}

// ---------------------------------------------------------------- epistemics

export type KnowledgeLevel = 'knows' | 'suspects' | 'wrong';

export interface Fact {
  id: FactId;
  text: string;
  /** True in the world regardless of who believes it. */
  scene: number;
  layer: Layer;
}

export interface FactKnowledge {
  factId: FactId;
  entityId: EntityId;
  level: KnowledgeLevel;
  sinceScene: number;
  /** How garbled their version is; rises with transmission hops (DESIGN §6.3). */
  distortion: number;
}

// ------------------------------------------------------------------- threads

export type ThreadStatus = 'open' | 'resolved' | 'abandoned';

/** Store threads, never a plot: a plot breaks when the player deviates. */
export interface Thread {
  id: ThreadId;
  title: string;
  stakes: string;
  tension: number;
  parties: EntityId[];
  /** Several possible resolutions, never one. */
  resolutions: string[];
  status: ThreadStatus;
  createdScene: number;
}

// -------------------------------------------------------------- consequences

export type Visibility = 'onscreen' | 'offscreen-discoverable' | 'offscreen-hidden';
export type Maturity = 'pending' | 'ripening' | 'fired' | 'expired' | 'superseded';

export type Trigger =
  | { kind: 'after-scenes'; scenes: number }
  | { kind: 'on-learn'; entityId: EntityId; factId: FactId }
  | { kind: 'on-enter'; locationId: EntityId }
  | { kind: 'immediate' };

/** DESIGN §6.1. Simulate the consequences of what was touched, not the world. */
export interface Consequence {
  id: ConsequenceId;
  causeEventId: EventId;
  trigger: Trigger;
  actorId: EntityId;
  action: string;
  visibility: Visibility;
  maturity: Maturity;
  /** Hops from the original player act; capped to keep cost bounded. */
  depth: number;
  significance: number;
  createdScene: number;
  firedScene: number | null;
  /** Set when a directive supersedes it (DESIGN §7.3). */
  supersededBy: string | null;
}

// -------------------------------------------------------------- illustration

export type IllustrationId = string;
export type IllustrationSubject =
  | { kind: 'scene'; turnId: string; locationId: EntityId | null }
  | { kind: 'portrait'; entityId: EntityId };

export type IllustrationStatus = 'pending' | 'done' | 'failed';

/**
 * One generated image. The scene/portrait split matters because the two are
 * conditioned differently: a portrait is conditioned on the entity's own
 * `Appearance` and reused as a reference forever after; a scene is conditioned
 * on the location card plus every present character's appearance, and is not
 * itself reused as a reference — it is disposable in a way a portrait is not.
 */
export interface Illustration {
  id: IllustrationId;
  subject: IllustrationSubject;
  visualStyle: VisualStyle;
  prompt: string;
  negativePrompt: string;
  seed: number | null;
  provider: string;
  status: IllustrationStatus;
  /** Relative path under the world's image store, or null while pending/failed. */
  path: string | null;
  error: string | null;
  createdScene: number;
  createdAt: string;
}

// -------------------------------------------------------------------- events

export interface StoryEvent {
  id: EventId;
  scene: number;
  turn: number;
  text: string;
  participants: EntityId[];
  locationId: EntityId | null;
  significance: number;
  visibility: Visibility;
  /** Set when this event was produced by a consequence firing. */
  fromConsequenceId: ConsequenceId | null;
}

// --------------------------------------------------------------------- delta

/** The contract between prose and state (DESIGN §1). */
export interface Delta {
  events: Array<{
    text: string;
    participants: EntityId[];
    locationId: EntityId | null;
    significance: number;
  }>;
  entityUpserts: Array<{
    id: EntityId;
    type: EntityType;
    name: string;
    summary: string;
    props?: Record<string, unknown>;
  }>;
  edgeAsserts: EdgeAssert[];
  edgeRetires: Array<{ subject: EntityId; predicate: string; object: EntityId }>;
  conditionUpdates: Array<{ entityId: EntityId; patch: Partial<Condition> }>;
  relationshipUpdates: Array<{
    fromId: EntityId;
    toId: EntityId;
    trustDelta?: number;
    affectionDelta?: number;
    respectDelta?: number;
    note?: string;
  }>;
  factsLearned: Array<{
    text: string;
    knownBy: EntityId[];
    suspectedBy: EntityId[];
  }>;
  threadUpdates: Array<{
    id?: ThreadId;
    title?: string;
    stakes?: string;
    tensionDelta?: number;
    parties?: EntityId[];
    resolutions?: string[];
    status?: ThreadStatus;
  }>;
  vowBreaks: Array<{ entityId: EntityId; vowId: string }>;
  sceneAdvance: boolean;
}

export function emptyDelta(): Delta {
  return {
    events: [],
    entityUpserts: [],
    edgeAsserts: [],
    edgeRetires: [],
    conditionUpdates: [],
    relationshipUpdates: [],
    factsLearned: [],
    threadUpdates: [],
    vowBreaks: [],
    sceneAdvance: false,
  };
}

// ---------------------------------------------------------------- turn / regs

/** DESIGN §7.1: four registers, all retained. */
export interface Turn {
  id: string;
  scene: number;
  turn: number;
  /** Verbatim player input, kept forever as the record of intent. */
  rawInput: string;
  intent: Intent | null;
  /** Canonical record of what happened. */
  delta: Delta | null;
  /** Rendered narrative. Regenerable from the delta unless pinned (DESIGN §7.2). */
  bookProse: string;
  pinned: boolean;
  meta: TurnMeta;
  createdAt: string;
}

export type InputClass = 'action' | 'dialogue' | 'ooc-directive' | 'meta-query';

export interface Intent {
  class: InputClass;
  actorId: EntityId;
  action: string;
  targetIds: EntityId[];
  manner: string;
  dialogueGist: string | null;
  /** True when the player wrote polished prose that should survive verbatim. */
  verbatim: boolean;
}

export interface TurnMeta {
  integrity: IntegrityVerdict | null;
  referee: RefereeVerdict | null;
  move: string | null;
  frameLog: FrameLog | null;
  lint: LintReport | null;
  providerCalls: Array<{ role: string; provider: string; model: string; tokensIn: number; tokensOut: number }>;
}

// ------------------------------------------------------------------- verdicts

/** DESIGN §5.3. Ordered by increasing distance from the character's contract. */
export type CoherenceDistance =
  | 'in-character'
  | 'stretch'
  | 'off-key'
  | 'contract-breach'
  | 'incoherent';

export interface IntegrityVerdict {
  distance: CoherenceDistance;
  /** Vow ids the action would violate. */
  violatedVows: string[];
  reasoning: string;
  /** Populated for breach/incoherent: the OOC interrupt shown to the player. */
  interrupt: Interrupt | null;
}

export interface Interrupt {
  message: string;
  options: Array<{ key: string; label: string; effect: InterruptEffect }>;
}

export type InterruptEffect =
  | 'revise'
  | 'establish-break'
  | 'switch-character'
  | 'override';

/** DESIGN §5.2. World-fact adjudication, default permissive. */
export type RefereeRuling =
  | 'allow'
  | 'allow-with-cost'
  | 'reinterpret'
  | 'friction'
  | 'contradiction';

export interface RefereeVerdict {
  ruling: RefereeRuling;
  reasoning: string;
  cost: string | null;
  /** Entities to spawn as emergent canon (DESIGN §5.1). */
  spawn: Array<{ type: EntityType; name: string; summary: string }>;
}

// ------------------------------------------------------------- style / lint

/**
 * The rendering treatment for illustration, independent of the prose register.
 * Kept on the style contract because both answer "how is this told", and both
 * are meant to be changed mid-campaign without touching what happened — the
 * same regenerable-projection argument as §7.2, extended to images. The five
 * options are deliberately the ones asked for directly — realistic, drawing,
 * sketch, draft, animation — rather than a longer taste-driven list; each
 * maps to a concrete prompt fragment and negative-prompt pairing in
 * `illustration/composer.ts`, not just an adjective.
 */
export type VisualStyle = 'realistic' | 'drawing' | 'sketch' | 'draft' | 'animation';

export interface StyleContract {
  pov: 'first' | 'third-limited' | 'third-omniscient' | 'second';
  tense: 'past' | 'present';
  register: 'plain' | 'clipped' | 'lyrical' | 'ornate' | 'archaic';
  density: 'sparse' | 'balanced' | 'rich';
  dialogueRatio: number;
  genreLens: string;
  humor: 'none' | 'dry' | 'absurd';
  pacing: 'languid' | 'steady' | 'breakneck';
  sceneTarget: number;
  /** Naming a work outperforms any stack of adjectives (DESIGN §8.1). */
  comparables: string[];
  forbidden: string[];
  contentBounds: string[];
  visualStyle: VisualStyle;
  /** Master world-visual anchor, appended to every scene and portrait prompt (see illustration §consistency). */
  visualAnchor: string;
}

export function defaultStyleContract(): StyleContract {
  return {
    pov: 'third-limited',
    tense: 'past',
    register: 'plain',
    density: 'balanced',
    dialogueRatio: 0.4,
    genreLens: 'literary',
    humor: 'dry',
    pacing: 'steady',
    sceneTarget: 350,
    comparables: [],
    forbidden: [],
    contentBounds: [],
    visualStyle: 'drawing',
    visualAnchor: '',
  };
}

export type LintSeverity = 'info' | 'warn' | 'error';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  excerpt: string;
  offset: number;
}

export interface LintReport {
  profile: 'fiction' | 'prose-doc';
  findings: LintFinding[];
  score: number;
  tripped: boolean;
}

// ------------------------------------------------------------------ frame

export interface FrameSlot {
  name: string;
  /** Lower evicts first. Style contract, present cast, agreed beat are never evicted. */
  priority: number;
  content: string;
  tokens: number;
  evictable: boolean;
  compressible: boolean;
}

export interface FrameLog {
  budget: number;
  used: number;
  slots: Array<{ name: string; tokens: number }>;
  evicted: string[];
  compressed: string[];
}

export interface Frame {
  slots: FrameSlot[];
  log: FrameLog;
  text: string;
}

// -------------------------------------------------------------- directives

export interface Directive {
  id: string;
  text: string;
  scope: 'scene' | 'chapter' | 'campaign';
  strength: 'hint' | 'push' | 'mandate';
  lifetimeScenes: number | null;
  status: 'active' | 'satisfied' | 'retired';
  createdScene: number;
}

/** Shown after a directive so recalculation is never silent (DESIGN §7.3). */
export interface RecalcDiff {
  supersededConsequences: ConsequenceId[];
  retimedConsequences: ConsequenceId[];
  raisedThreads: ThreadId[];
  loweredThreads: ThreadId[];
  newThreads: ThreadId[];
}

// ----------------------------------------------------------------- session

/**
 * The play-relevant fields, unchanged by the multi-story migration — this is
 * what the turn loop, frame builders and every existing call site already
 * destructure. `Story` adds identity and lineage on top; the split exists so
 * "give me the current scene/turn/style" call sites do not need to change.
 */
export interface SessionState {
  scene: number;
  turn: number;
  playerCharacterId: EntityId;
  currentLocationId: EntityId | null;
  style: StyleContract;
  knobs: Knobs;
}

export type StoryId = string;

/** One playthrough of a world. Replaces the old single-row `session` table. */
export interface Story extends SessionState {
  id: StoryId;
  title: string;
  /** The story this one was forked from, or null if it started fresh against canon. */
  forkedFrom: StoryId | null;
  /** The scene the fork happened at, meaningful only when `forkedFrom` is set. */
  forkedAtScene: number | null;
  createdAt: string;
  lastPlayedAt: string;
}

export interface Knobs {
  canonFidelity: 'strict' | 'flexible' | 'au';
  characterStrictness: 'permissive' | 'coaching' | 'strict' | 'iron';
  pacing: number;

  danger: number;
  npcAgency: number;
  propagationDepth: number;
  ignoranceBudget: number;
  proseDensity: number;
}

export function defaultKnobs(): Knobs {
  return {
    canonFidelity: 'flexible',
    characterStrictness: 'strict',
    pacing: 0.5,
    danger: 0.5,
    npcAgency: 0.6,
    propagationDepth: 3,
    ignoranceBudget: 5,
    proseDensity: 0.5,
  };
}
