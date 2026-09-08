/**
 * The predicate vocabulary, in one place, because it is load-bearing and was
 * previously implicit.
 *
 * `consequence/propagate.ts` decides who reacts to an event by walking edges
 * that point at the subject and asking each one for a *stance*. A predicate it
 * does not recognise returns null and the edge is skipped entirely — so an
 * authored relation with an unrecognised name is not a weak signal, it is no
 * signal. Nothing warned about that, and the cost was silent: `FRIENDLY_WITH`,
 * `RELIES_ON` and `KEEPS_SECRET_FROM` in the original Saint Verrow seed are all
 * inert, which quietly removes some of the more interesting ties in it from the
 * causal graph.
 *
 * Two things follow, and this module provides both:
 *
 *  1. Authoring needs a list to write against, with the inert ones marked inert
 *     *on purpose* rather than by accident. `PREDICATES` is that list, and the
 *     pack validator warns on anything outside it.
 *  2. The regex fallback has to stay, because wiki ingest invents predicates
 *     from arbitrary infobox field names and cannot be held to a vocabulary.
 *     `stanceForPredicate` therefore checks the table first and falls back to
 *     the original patterns, so no ingested world changes behaviour.
 *
 * One deliberate behaviour change came with the table, worth flagging because it
 * is not a pure refactor: `MEMBER_OF` and `LEADS` now carry a `factional`
 * stance. Previously they matched none of the patterns, so an edge pointing *at*
 * a faction was skipped — meaning when something happened to a faction, neither
 * its members nor its leader reacted. They only ever reacted to things that
 * happened to each other. The full suite passes either way; this direction is
 * the one that matches what the field names plainly mean.
 */

export type PropagationStance = 'loyal' | 'hostile' | 'kin' | 'factional' | 'observer';

export interface PredicateDef {
  predicate: string;
  /** null means "carries no social charge" — structural, spatial or descriptive. */
  stance: PropagationStance | null;
  /** What it means, and which direction it runs. */
  note: string;
}

/**
 * Faction membership is matched by exact string in `propagate.ts`, not by
 * pattern, because it drives a different and more expensive walk: everyone else
 * in the faction reacts too. Authoring `BELONGS_TO` instead of `MEMBER_OF`
 * therefore loses the entire factional cascade with no warning. Exported so
 * that check has a name instead of two inline literals.
 */
export const FACTION_PREDICATES = ['MEMBER_OF', 'LEADS'] as const;

export const PREDICATES: PredicateDef[] = [
  // --- kinship
  { predicate: 'KIN_OF', stance: 'kin', note: 'blood or chosen family; author both directions' },
  { predicate: 'PARENT_OF', stance: 'kin', note: 'subject is parent of object' },
  { predicate: 'CHILD_OF', stance: 'kin', note: 'subject is child of object' },
  { predicate: 'SIBLING_OF', stance: 'kin', note: 'symmetric; author both directions' },
  { predicate: 'MARRIED_TO', stance: 'kin', note: 'current spouse; symmetric' },

  // --- loyalty and obligation
  { predicate: 'LOYAL_TO', stance: 'loyal', note: 'would take a cost for the object' },
  { predicate: 'SERVES', stance: 'loyal', note: 'formal subordination, not necessarily affection' },
  { predicate: 'MENTORS', stance: 'loyal', note: 'subject teaches object' },
  { predicate: 'TRUSTS', stance: 'loyal', note: 'directional; being trusted is not trusting' },
  { predicate: 'PROTECTS', stance: 'loyal', note: 'subject shields object, possibly unasked' },
  { predicate: 'OWES', stance: 'loyal', note: 'a debt, money or otherwise' },
  { predicate: 'OWES_MONEY_TO', stance: 'loyal', note: 'the concrete kind; matches OWES' },

  // --- enmity and suspicion
  { predicate: 'HOSTILE_TO', stance: 'hostile', note: 'active enmity' },
  { predicate: 'RIVAL_OF', stance: 'hostile', note: 'competes with; not necessarily hatred' },
  { predicate: 'HATES', stance: 'hostile', note: 'personal, not political' },
  { predicate: 'HUNTS', stance: 'hostile', note: 'actively pursuing the object' },
  { predicate: 'SUSPECTS', stance: 'hostile', note: 'believes the object guilty of something' },

  // --- observation
  { predicate: 'WATCHES', stance: 'observer', note: 'surveillance, official or personal' },
  { predicate: 'INFORMS', stance: 'observer', note: 'subject reports to object about others' },
  {
    predicate: 'KEEPS_SECRET_FROM',
    stance: 'observer',
    note: 'subject hides something from object; they watch them closely because of it',
  },
  { predicate: 'CORRESPONDS_WITH', stance: 'observer', note: 'letters; the pre-telephone information channel' },

  // --- regard that is neither loyalty nor kinship
  { predicate: 'FRIENDLY_WITH', stance: 'loyal', note: 'mutual warmth without obligation; author both directions' },
  { predicate: 'RELIES_ON', stance: 'loyal', note: 'subject depends on object, possibly resentfully' },
  { predicate: 'LOVES', stance: 'loyal', note: 'directional and frequently unreturned' },
  { predicate: 'DESIRES', stance: 'loyal', note: 'wants, which is not the same as loves' },
  { predicate: 'COURTS', stance: 'loyal', note: 'actively pursuing the object' },
  { predicate: 'EX_OF', stance: 'kin', note: 'former partner; charged, and reacts like family' },
  { predicate: 'CO_PARENT_WITH', stance: 'kin', note: 'shares a child, whatever else is true' },

  // --- command, service, patronage
  { predicate: 'COMMANDS', stance: 'loyal', note: 'military or shipboard authority over the object' },
  { predicate: 'VASSAL_OF', stance: 'loyal', note: 'feudal obligation upward' },
  { predicate: 'GUARDS', stance: 'loyal', note: "charged with the object's safety" },
  { predicate: 'APPRENTICE_OF', stance: 'loyal', note: 'the inverse of MENTORS; author whichever reads better' },
  { predicate: 'PATRON_OF', stance: 'loyal', note: 'funds or shelters the object' },
  { predicate: 'TENANT_OF', stance: 'factional', note: 'holds land or rooms from the object' },
  { predicate: 'WORSHIPS', stance: 'loyal', note: 'devotion to a person or a named power' },

  // --- sharper enmity
  { predicate: 'BLACKMAILS', stance: 'hostile', note: 'holds something over the object' },
  { predicate: 'BETRAYED', stance: 'hostile', note: 'already done, and still live' },
  { predicate: 'SWORN_ENEMY_OF', stance: 'hostile', note: 'declared and lasting' },

  // --- transaction and faction
  { predicate: 'MEMBER_OF', stance: 'factional', note: 'drives the factional cascade; exact match required' },
  { predicate: 'LEADS', stance: 'factional', note: 'drives the factional cascade; exact match required' },
  { predicate: 'DEALS_WITH', stance: 'factional', note: 'ongoing trade or arrangement' },
  { predicate: 'TRADES', stance: 'factional', note: 'commercial counterparty' },
  { predicate: 'EMPLOYS', stance: 'factional', note: 'subject pays object to work' },
  { predicate: 'PAYS', stance: 'factional', note: 'one-directional money' },
  { predicate: 'SUPPLIES', stance: 'factional', note: 'subject provides goods to object' },
  { predicate: 'SMUGGLES', stance: 'factional', note: 'moves contraband, for or with the object' },
  { predicate: 'CREW_OF', stance: 'factional', note: 'matches nothing by pattern; here so ships work' },

  // --- deliberately inert: structural, spatial, custodial
  //
  // These carry no social charge and should not summon reactors. Listed so that
  // "no stance" reads as a decision rather than an oversight.
  { predicate: 'PART_OF', stance: null, note: 'containment: room in a ship, district in a city' },
  { predicate: 'HOLDS', stance: null, note: 'a faction controls a place' },
  { predicate: 'OCCUPIES', stance: null, note: 'a faction is physically in a place, perhaps unwelcome' },
  { predicate: 'KEPT_IN', stance: null, note: 'an item is stored in a place' },
  { predicate: 'KEEPS', stance: null, note: 'a character has custody of an item' },
  { predicate: 'CARRIES', stance: null, note: 'a character has an item on them' },
  { predicate: 'SWORN_TO', stance: null, note: 'bound to a concept or vow, not to a person' },
  { predicate: 'MEETS_AT', stance: null, note: 'habitual location for a character' },
  { predicate: 'WORKS_AT', stance: null, note: 'habitual workplace' },
  { predicate: 'LIVES_AT', stance: null, note: 'habitual residence' },
  { predicate: 'FOUND_AT', stance: null, note: 'where a character can be encountered; reference only' },
  { predicate: 'FROM_WORLD', stance: null, note: 'origin, a species or cultural property, not a position' },
  { predicate: 'CONNECTS_TO', stance: null, note: 'route between two places' },
  { predicate: 'GOVERNED_BY', stance: null, note: 'a place answers to a faction' },
  { predicate: 'MENTIONS', stance: null, note: 'weak wiki-derived association' },
];

const BY_NAME = new Map(PREDICATES.map((p) => [p.predicate, p]));

/** True when the predicate is in the authored vocabulary. Used by pack validation. */
export function isKnownPredicate(predicate: string): boolean {
  return BY_NAME.has(predicate.toUpperCase());
}

export function predicateDef(predicate: string): PredicateDef | undefined {
  return BY_NAME.get(predicate.toUpperCase());
}

/**
 * Stance for a predicate, table first and patterns second.
 *
 * The patterns are the original behaviour, kept verbatim so that ingested
 * worlds — whose predicates come from infobox field names and cannot be
 * enumerated — resolve exactly as they did before this table existed.
 */
export function stanceForPredicate(predicate: string): PropagationStance | null {
  const up = predicate.toUpperCase();
  const known = BY_NAME.get(up);
  if (known) return known.stance;

  if (/KIN|PARENT|CHILD|SIBLING|MARRIED/.test(up)) return 'kin';
  if (/LOYAL|SERVES|MENTORS|TRUSTS|PROTECTS|OWES/.test(up)) return 'loyal';
  if (/HOSTILE|RIVAL|HATES|HUNTS|SUSPECTS/.test(up)) return 'hostile';
  if (/INFORMS|WATCHES/.test(up)) return 'observer';
  if (/DEALS_WITH|TRADES|EMPLOYS|PAYS|SUPPLIES|SMUGGLES/.test(up)) return 'factional';
  return null;
}
