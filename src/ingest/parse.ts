/**
 * Wikitext parsers. See DESIGN.md §3 (Pass A).
 *
 * Pure functions, no network, no LLM. This is the cheap pass that does most of
 * the useful work: infoboxes are effectively pre-made character sheets, and
 * categories are a free type system.
 */
import type { EntityType } from '../domain/types.ts';

/** Strips wiki link syntax, keeping the display text. */
function unlink(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/\S+\]/g, '');
}

/**
 * Drops bracket links whose target carries no display text a reader would
 * want at all — interlanguage links (`[[de:Personen]]`) and the housekeeping
 * namespaces (`[[Category:...]]`, `[[File:...]]`, etc). `unlink` unwraps a
 * normal `[[a|b]]` link to its display text, which is right for content links
 * but wrong here: unwrapping `[[de:Personen]]` surfaces `de:Personen` as prose.
 * On a wiki's `Characters` index page — real prose, mostly interlanguage tags
 * and category links, near-zero actual content — that residue became the
 * entire entity summary. Must run before `unlink`, which would otherwise
 * unwrap these first and leave nothing distinctive left to match.
 */
function stripNonContentLinks(s: string): string {
  return s
    .replace(/\[\[[a-z]{2,3}(-[a-z0-9]+)?:[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:File|Image|Category|Template|Help|Portal|Special|Media|Talk|User)\s*:[^\]]*\]\]/gi, '');
}

/**
 * Finds the body of the first template whose name matches `namePattern`,
 * tracking brace depth so nested templates do not terminate the match early.
 * Regex alone cannot do this, and nested templates are extremely common.
 */
function templateBody(text: string, namePattern: RegExp): string | null {
  const open = text.search(/\{\{/);
  if (open < 0) return null;

  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '{' || text[i + 1] !== '{') continue;
    const nameMatch = /^\{\{\s*([^|}\n]+)/.exec(text.slice(i));
    if (!nameMatch?.[1] || !namePattern.test(nameMatch[1].trim())) continue;

    let depth = 0;
    for (let j = i; j < text.length - 1; j++) {
      if (text[j] === '{' && text[j + 1] === '{') {
        depth++;
        j++;
      } else if (text[j] === '}' && text[j + 1] === '}') {
        depth--;
        j++;
        if (depth === 0) return text.slice(i + 2, j - 1);
      }
    }
    // Unterminated template: take the rest rather than losing the page.
    return text.slice(i + 2);
  }
  return null;
}

/**
 * Splits template parameters on top-level pipes only, so `[[a|b]]` and nested
 * `{{x|y}}` values survive intact.
 */
function splitParams(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let bracket = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    const next = body[i + 1];
    if (ch === '{' && next === '{') {
      depth++;
      current += '{{';
      i++;
      continue;
    }
    if (ch === '}' && next === '}') {
      depth--;
      current += '}}';
      i++;
      continue;
    }
    if (ch === '[' && next === '[') {
      bracket++;
      current += '[[';
      i++;
      continue;
    }
    if (ch === ']' && next === ']') {
      bracket--;
      current += ']]';
      i++;
      continue;
    }
    if (ch === '|' && depth === 0 && bracket === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export interface Infobox {
  template: string;
  fields: Record<string, string>;
}

/**
 * Unwraps nested templates by keeping their arguments and dropping the template
 * name. `{{nowrap|Ilsa Crowe}}` becomes `Ilsa Crowe` and `{{Date|412|AV}}`
 * becomes `412 AV`. Deleting the whole template instead would silently discard
 * the value, which is how formatting wrappers like nowrap and formatnum end up
 * eating real relations.
 */
function unwrapTemplates(s: string): string {
  let prev = '';
  let out = s;
  while (prev !== out) {
    prev = out;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_all, inner: string) => {
      const parts = inner.split('|');
      // `{{formatnum:12000}}` has no pipe; keep whatever follows the colon.
      if (parts.length === 1) {
        const colon = parts[0]!.indexOf(':');
        return colon >= 0 ? parts[0]!.slice(colon + 1).trim() : '';
      }
      return parts
        .slice(1)
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.includes('='))
        .join(' ');
    });
  }
  return out;
}

/**
 * Parses the first infobox. Multi-value fields separated by `<br/>` or bullet
 * lists are normalised to `; ` so downstream code has one convention.
 */
export function parseInfobox(wikitext: string): Infobox | null {
  const body = templateBody(wikitext, /^infobox/i);
  if (body === null) return null;

  const params = splitParams(body);
  const template = (params.shift() ?? '').trim();
  const fields: Record<string, string> = {};

  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    const raw = param.slice(eq + 1);
    const value = unlink(stripNonContentLinks(unwrapTemplates(raw)))
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
      .replace(/<ref[^>]*\/>/gi, '')
      .replace(/'''?/g, '')
      .split(/\n|^\s*\*\s*/m)
      .map((v) => v.trim())
      .filter(Boolean)
      .join('; ');
    if (value) fields[key] = value;
  }

  return { template, fields };
}

const SKIP_NS = /^(File|Image|Category|Template|Help|Portal|Special|Media|Talk|User)\s*:/i;
/** Interlanguage link prefix, e.g. `de:`, `pt-br:` — never a page in this wiki. */
const INTERLANG = /^[a-z]{2,3}(-[a-z0-9]+)?\s*:/i;

export function parseCategories(wikitext: string): string[] {
  const out = new Set<string>();
  for (const m of wikitext.matchAll(/\[\[Category:\s*([^\]|]+)/gi)) {
    const name = m[1]?.trim();
    if (name) out.add(name);
  }
  return [...out];
}

export function parseLinks(wikitext: string): string[] {
  const out = new Set<string>();
  for (const m of wikitext.matchAll(/\[\[([^\]|#]+)/g)) {
    const target = m[1]?.trim();
    if (!target || SKIP_NS.test(target) || INTERLANG.test(target)) continue;
    out.add(target.replace(/_/g, ' '));
  }
  return [...out];
}

export interface Section {
  level: number;
  title: string;
  body: string;
}

/** Section headers are natural chunk boundaries for later embedding. */
export function parseSections(wikitext: string): Section[] {
  const sections: Section[] = [];
  const re = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  const heads: Array<{ level: number; title: string; start: number; end: number }> = [];
  for (const m of wikitext.matchAll(re)) {
    heads.push({
      level: m[1]!.length,
      title: m[2]!.trim(),
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  for (const [i, h] of heads.entries()) {
    const bodyEnd = heads[i + 1]?.start ?? wikitext.length;
    sections.push({ level: h.level, title: h.title, body: wikitext.slice(h.end, bodyEnd).trim() });
  }
  return sections;
}

/** Quoted dialogue, mined for voice cards. */
export function parseQuotes(wikitext: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /"([^"\n]{12,220})"/g,
    /[\u201C]([^\u201D\n]{12,220})[\u201D]/g,
    /\{\{\s*[Qq]uote\s*\|\s*([^|}]{12,220})/g,
  ];
  for (const re of patterns) {
    for (const m of wikitext.matchAll(re)) {
      const q = unlink(m[1] ?? '').replace(/'''?/g, '').trim();
      // Skip anything that looks like markup or a citation rather than speech.
      if (q.length >= 12 && !/^(https?:|\||=)/.test(q) && !/\{\{|\}\}/.test(q)) out.add(q);
    }
  }
  return [...out];
}

export function stripMarkup(wikitext: string): string {
  let t = wikitext;
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref[^>]*\/>/gi, '');
  t = t.replace(/\{\|[\s\S]*?\|\}/g, ''); // tables
  // Templates, innermost first, so nesting unwinds.
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(/\{\{[^{}]*\}\}/g, '');
  }
  t = t.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '');
  t = stripNonContentLinks(t);
  t = unlink(t);
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/'''?/g, '');
  t = t.replace(/^[*#:;]+\s*/gm, '');
  t = t.replace(/^={2,6}.*?={2,6}\s*$/gm, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Lead sentences, used as the entity summary. */
export function firstParagraph(wikitext: string, maxChars = 320): string {
  const plain = stripMarkup(wikitext);
  const para = plain.split(/\n\s*\n/).find((p) => p.trim().length > 40) ?? plain;
  const trimmed = para.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const stop = cut.lastIndexOf('. ');
  return stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

// ------------------------------------------------------------- type inference

const TYPE_HINTS: Array<{ type: EntityType; patterns: RegExp }> = [
  { type: 'Character', patterns: /\b(characters?|people|persons?|individuals?|humans?|monks?|knights?|wizards?|deaths?|births?|villains?|protagonists?)\b/i },
  { type: 'Location', patterns: /\b(locations?|places?|planets?|cities|towns?|villages?|buildings?|regions?|realms?|countries|continents?|rooms?|districts?|settlements?)\b/i },
  { type: 'Faction', patterns: /\b(organi[sz]ations?|factions?|groups?|orders?|guilds?|houses?|clans?|armies|militaries|governments?|companies|cults?)\b/i },
  { type: 'Item', patterns: /\b(items?|weapons?|artifacts?|artefacts?|objects?|equipment|technology|vehicles?|books?|relics?|substances?)\b/i },
  { type: 'Event', patterns: /\b(events?|battles?|wars?|conflicts?|incidents?|ceremonies|festivals?|treaties)\b/i },
];

/**
 * Categories are the strongest signal, then the infobox template name, then the
 * lead sentence. Concept is the fallback because it constrains nothing later.
 */
export function inferEntityType(title: string, categories: string[], infobox: Infobox | null, lead = ''): EntityType {
  const catText = categories.join(' ');
  for (const hint of TYPE_HINTS) {
    if (hint.patterns.test(catText)) return hint.type;
  }
  if (infobox) {
    const t = infobox.template.replace(/^infobox\s*/i, '');
    for (const hint of TYPE_HINTS) {
      if (hint.patterns.test(t)) return hint.type;
    }
    // Field shape is diagnostic when the template name is generic.
    const f = infobox.fields;
    if (f.species || f.born || f.died || f.occupation || f.gender || f.affiliation) return 'Character';
    if (f.population || f.capital || f.terrain || f.climate || f.region) return 'Location';
    if (f.leader || f.headquarters || f.founded || f.members) return 'Faction';
  }
  for (const hint of TYPE_HINTS) {
    if (hint.patterns.test(lead.slice(0, 200))) return hint.type;
  }
  return 'Concept';
}

const PREFIX: Record<EntityType, string> = {
  Character: 'char',
  Location: 'loc',
  Faction: 'fac',
  Item: 'item',
  Concept: 'concept',
  Event: 'event',
};

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Deterministic id, which is what makes re-ingest idempotent: the same page
 * always resolves to the same node, so a second run updates rather than
 * duplicates.
 */
export function slugId(type: EntityType, title: string): string {
  return `${PREFIX[type]}:${slugify(title)}`;
}

/**
 * Infobox fields that imply a typed relation. Everything else stays an
 * attribute; guessing predicates from arbitrary field names produces a graph
 * full of wrong edges, which is worse than no graph at all.
 *
 * `inverse` matters as much as the predicate. A field can point either way: a
 * character's `homeworld` means *subject* is in that place, while a cluster's
 * `planets` means each of those places is in the *subject*. Emitting the same
 * direction for both would reverse half the geography, which is precisely the
 * class of confident-but-wrong edge the paragraph above is about. So the
 * direction is declared per field rather than assumed.
 *
 * The list was widened against real evidence rather than intuition: 1,591
 * infobox-bearing pages of the Mass Effect dump, 109 distinct field names, of
 * which the original nine patterns matched four (`faction`, `capital`,
 * `location`, `weapons`) and produced only 336 edges across the whole world.
 * The additions below are the frequent ones whose direction is unambiguous —
 * `race`/`species` (942 uses), `armament`/`armor` (404), `cluster`/`system`
 * (236), `locations`/`planets` (450, inverse). Fields that are real-world
 * metadata (`voiceactor`), pure attributes (`health`, `mass`), or ambiguous in
 * direction are deliberately still left as attributes.
 */
export interface RelationField {
  field: RegExp;
  predicate: string;
  weight: number;
  /** True when the field lists entities the *subject contains*, so the edge runs target → subject. */
  inverse?: true;
}

export const RELATION_FIELDS: RelationField[] = [
  { field: /^(affiliation|affiliations|allegiance|organization|organisation|faction|factions|member of)$/i, predicate: 'MEMBER_OF', weight: 0.8 },
  // A species is a group a character belongs to; the wiki files it as a field
  // like any other, and it is the single most common relation-bearing field on
  // this kind of wiki (839 `race` + 103 `species`).
  { field: /^(race|species)$/i, predicate: 'MEMBER_OF', weight: 0.75 },
  { field: /^(relatives|family|parents?|children|siblings?|spouse|father|mother)$/i, predicate: 'KIN_OF', weight: 0.85 },
  // A numbered suffix is a second field of the same kind, which these wikis use
  // routinely (`location2` appears 42 times in the Mass Effect dump alone).
  { field: /^(location|locale|home|homeworld|residence|based in|birthplace|capital|station)\d?$/i, predicate: 'LOCATED_IN', weight: 0.7 },
  { field: /^(allies|ally|allied)$/i, predicate: 'ALLIED_WITH', weight: 0.7 },
  { field: /^(enemies|enemy|rivals?|foes?)$/i, predicate: 'HOSTILE_TO', weight: 0.7 },
  { field: /^(leader|led by|commander|head)$/i, predicate: 'LED_BY', weight: 0.8 },
  { field: /^(members|notable members)$/i, predicate: 'HAS_MEMBER', weight: 0.7 },
  { field: /^(weapons?|equipment|wields?|armament|armaments|armor|armour|loadout)$/i, predicate: 'CARRIES', weight: 0.6 },
  { field: /^(part of|region|located in|within|cluster|system|sector|nebula|galaxy)$/i, predicate: 'PART_OF', weight: 0.75 },
  // Inverse: these list what is inside the subject, not what contains it.
  { field: /^(locations|planets|moons|colonies|settlements|worlds)$/i, predicate: 'LOCATED_IN', weight: 0.65, inverse: true },
  { field: /^(asteroidbelts|asteroid belts|stations|relays|systems|clusters)$/i, predicate: 'PART_OF', weight: 0.6, inverse: true },
];

/**
 * Field names that *look* like they carry a relation but match no rule.
 *
 * Reported by Pass A rather than silently ignored: the original nine patterns
 * matched four of this wiki's 109 field names and nothing said so, so the
 * cheapest and most reliable half of the extraction was quietly doing almost
 * nothing. A name here is a candidate for `RELATION_FIELDS`, not a bug.
 */
export function looksRelational(field: string): boolean {
  // `weaponname`, `armourbonus`, `tech_type` and friends contain a relational
  // word but describe a value, not another entity. Excluded so the report stays
  // a list of candidates worth adding rather than mostly false positives.
  if (/(name|class|type|bonus|cost|rating|damage|value|level|count|size|mass|weight)\d?$/i.test(field)) return false;
  return /(faction|ally|allies|enem|rival|member|leader|kin|family|relative|parent|child|sibling|spouse|home|location|planet|moon|colony|region|cluster|system|sector|weapon|armor|armour|equipment|species|race|creator|owner|crew|captain|founder)/i.test(
    field,
  );
}

/**
 * Splits a normalised multi-value field back into its individual values.
 *
 * Trailing parentheticals are stripped because wikis annotate relations inline —
 * `relatives = Bram the Lesser (brother)` — and the annotation is not part of the
 * page title, so leaving it attached makes every such relation fail to resolve.
 */
export function fieldValues(value: string): string[] {
  return value
    .split(/;|,(?![^(]*\))/)
    .map((v) => v.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter((v) => v.length > 1 && v.length < 80);
}
