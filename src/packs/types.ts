/**
 * World packs: original, first-party settings shipped with the engine.
 *
 * Why this exists at all. Every other route into a world either reads someone
 * else's wiki (third-party IP, and `docs/legal-briefing-fandom-ingest.md` §3-4
 * is unambiguous about what distributing that costs) or asks a model to invent
 * one on the spot (fine, but unrepeatable and unreviewable). A pack is the
 * third thing: content we own, hand-tuned, identical on every machine, safe to
 * screenshot, ship, and illustrate.
 *
 * The shape below is not a new idea bolted on. It is the split the storage
 * layer already enforces, written down:
 *
 *   - **Pack level is canon.** Entities, edges, and the *slow* half of a sheet
 *     (identity, contract, voice, appearance). Canon rows carry no `story_id`
 *     and are shared by every story in the file (`store/graph.ts` §multi-story),
 *     so anything that must be true in all scenarios belongs here.
 *   - **Scenario level is chronicle.** Conditions, relationships, facts and who
 *     believes them, threads, the opening scene, the style contract. Every one
 *     of those tables is story-scoped — relationships do not even *have* a canon
 *     layer (`store/cast.ts:13`) — so per-scenario values are the natural grain,
 *     not a workaround.
 *
 * That split is what lets one 70-entity world carry three genuinely different
 * openings without duplicating a single entity.
 */
import type {
  Appearance,
  Condition,
  Contract,
  EntityType,
  Identity,
  KnowledgeLevel,
  StyleContract,
  ThreadStatus,
  VoiceCard,
} from '../domain/types.ts';

/**
 * Salience tiers, named rather than numeric at the authoring surface.
 *
 * This is the field most likely to be left at a default and least likely to be
 * noticed, so it gets names instead of magic numbers. It matters more than it
 * looks: `frame/builders.ts` fills its `cast-thumbnails` slot from
 * `list({ limit: 40, minSalience: 0.2 })` and then `.slice(0, 12)`, and
 * `store/graph.ts` orders that by `salience DESC` — so **at most twelve
 * entities reach the Narrator per turn**, chosen by this number. A pack that
 * leaves everything flat hands the model whichever dozen sort first
 * alphabetically. That is not hypothetical: it is what the ingested wiki save
 * in this repository does today, where 3,636 of 3,643 entities sit at exactly
 * 0.3 and the Narrator's window is "2175 Aeia, 2181 Arion, A Batarian Army".
 *
 * `background` is deliberately below the 0.2 floor. Those entities exist so the
 * Referee can say yes when a player wanders somewhere unplanned, and are meant
 * never to spend frame budget until something touches them.
 */
export const SALIENCE = {
  /** The handful this scenario is actually about. */
  focal: 0.9,
  /** Named, present, will plausibly speak this session. */
  principal: 0.7,
  /** Real and reachable, but offstage until sought. */
  supporting: 0.45,
  /** Texture. Below the frame's minSalience floor by design. */
  background: 0.15,
} as const;

export type SalienceTier = keyof typeof SALIENCE;

/**
 * The tiers a pack may set as a *baseline*, which is every tier except `focal`.
 *
 * `focal` is excluded on purpose, and the type is the enforcement. "What this
 * story is about" is inherently scenario-scoped: a pack that marks thirty
 * entities focal leaves them all tied at the top salience in *every* scenario,
 * contesting a twelve-slot frame window that then falls through to
 * `graph.list`'s `name ASC` tie-break — so which of them the Narrator sees is
 * decided alphabetically. That is precisely the failure this tier system exists
 * to prevent, and it is easy to reintroduce by accident, so `focal` lives only
 * on `PackScenario.focus` where it means something.
 */
export type BaselineTier = Exclude<SalienceTier, 'focal'>;

export interface PackEntity {
  /** `char:` `loc:` `fac:` `item:` `concept:` `event:` + kebab slug. Validated. */
  id: string;
  type: EntityType;
  name: string;
  /** One line. This is what a thumbnail renders, so it must carry weight alone. */
  summary: string;
  /**
   * World-level baseline, applied in every scenario. Cannot be `focal` — see
   * `BaselineTier`. The honest default is low: `supporting` for anything no
   * scenario has explicitly asked for.
   */
  tier?: BaselineTier;
  props?: Record<string, unknown>;
}

export interface PackEdge {
  subject: string;
  predicate: string;
  object: string;
  /** Drives consequence reach (`consequence/propagate.ts`). Defaults to 0.6. */
  weight?: number;
}

/**
 * The slow half of a character sheet: what stays true across every scenario in
 * the pack. Condition is absent on purpose — it lives on the scenario.
 */
export interface PackSheet {
  entityId: string;
  identity?: Partial<Identity>;
  contract?: Partial<Contract>;
  voice?: Partial<VoiceCard>;
  appearance?: Partial<Appearance>;
}

export interface PackRelationship {
  from: string;
  to: string;
  /** All three default to 0. Asymmetry is the point: author both directions. */
  trust?: number;
  affection?: number;
  respect?: number;
  note?: string;
}

export interface PackFact {
  text: string;
  knows?: string[];
  suspects?: string[];
  /** Confidently wrong, which is more useful than ignorant. */
  wrong?: string[];
}

export interface PackThread {
  title: string;
  stakes: string;
  tension: number;
  parties: string[];
  /** Several, never one. A thread with one resolution is a plot. */
  resolutions: string[];
  status?: ThreadStatus;
}

/**
 * One playable opening onto the pack's canon. Becomes a `Story` row plus a
 * chronicle overlay.
 */
export interface PackScenario {
  /** Stable slug, unique within the pack. */
  id: string;
  title: string;
  /** Shown in the picker. What is about to go wrong, in a sentence or two. */
  premise: string;
  playerCharacterId: string;
  openingLocationId: string;
  /** Scene 1's title. */
  openingScene: string;
  /**
   * Promotions over the pack baseline, by entity id. This is where a scenario
   * says "these are the twelve that matter now".
   */
  focus?: Record<string, SalienceTier>;
  /** Starting positions, moods and intents. Absent means the entity is offstage. */
  conditions?: Array<{ entityId: string } & Partial<Condition>>;
  relationships?: PackRelationship[];
  facts?: PackFact[];
  threads?: PackThread[];
  style?: Partial<StyleContract>;
  /** A texture sample for the Narrator before the player has liked anything. */
  anchor?: { text: string; note?: string };
  /** Optional first line of prose, offered rather than committed. */
  opening?: string;
}

export interface WorldPack {
  /** Slug. Also the world-file directory name when a pack is installed. */
  id: string;
  title: string;
  genre: 'science-fiction' | 'fantasy' | 'historical' | 'contemporary';
  /** One line for the gallery card. */
  blurb: string;
  /**
   * Two or three paragraphs: what the place is, what is under strain, what kind
   * of story it wants. Shown when a pack is selected, and used as the world's
   * own description.
   */
  premise: string;
  /**
   * Ours, stated explicitly. Every pack in this directory is original work
   * written for this engine — no third-party characters, settings or names —
   * which is the entire point of the format.
   */
  license: string;
  entities: PackEntity[];
  edges: PackEdge[];
  sheets: PackSheet[];
  /** At least one. Two or three is the intended shape. */
  scenarios: PackScenario[];
}

export const ENTITY_ID_RE = /^(char|loc|fac|item|concept|event):[a-z0-9][a-z0-9-]*$/;

/** Prefix each type is expected to use, so a typo shows up as a validation error. */
export const TYPE_PREFIX: Record<EntityType, string> = {
  Character: 'char',
  Location: 'loc',
  Faction: 'fac',
  Item: 'item',
  Concept: 'concept',
  Event: 'event',
};

export function knowledgeLevels(f: PackFact): Array<[string, KnowledgeLevel]> {
  const out: Array<[string, KnowledgeLevel]> = [];
  for (const id of f.knows ?? []) out.push([id, 'knows']);
  for (const id of f.suspects ?? []) out.push([id, 'suspects']);
  for (const id of f.wrong ?? []) out.push([id, 'wrong']);
  return out;
}

/**
 * Terse edge authoring: `['char:a', 'TRUSTS', 'char:b', 0.8]`.
 *
 * Packs are mostly edge lists, and an object literal per edge triples the line
 * count without adding information. Tuples keep a seventy-entity relation graph
 * scannable in a way that matters when you are checking it by eye for the
 * asymmetries you meant to author.
 */
export function packEdges(rows: Array<[string, string, string, number?]>): PackEdge[] {
  return rows.map(([subject, predicate, object, weight]) => ({
    subject,
    predicate,
    object,
    ...(weight === undefined ? {} : { weight }),
  }));
}
