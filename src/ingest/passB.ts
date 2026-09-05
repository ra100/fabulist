/**
 * Pass B: LLM extraction over pages that survived scoping. See DESIGN.md §3.
 *
 * This is where fandom *feel* arrives. Pass A gives a correct but flat graph —
 * infobox facts and untyped links. Pass B adds the things only prose contains:
 * why two characters are at odds, when something happened, and how a character
 * actually talks.
 *
 * Two constraints shape the whole file:
 *
 * Every claim must carry an evidence span. A graph full of confidently wrong
 * edges is worse than no graph, because it makes the Referee wrong with
 * conviction. Requiring a verbatim quote makes a hallucinated relation cheap to
 * spot and cheap to drop, and it is the reason `minEvidence` exists below.
 *
 * Relations may only point at entities that already exist. Pass B runs after
 * Pass A precisely so the id space is closed; inventing nodes here would let one
 * bad extraction seed a whole subgraph of fiction.
 */
import type { Entity } from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { HeuristicTokenizer } from '../frame/tokenizer.ts';
import { adaptRequest, extractJson, type JsonSchema, type Provider } from '../providers/provider.ts';
import type { WikiPage } from './client.ts';
import type { PassBExtractor, PassBOutput } from './depth.ts';
import { firstParagraph, parseSections, stripMarkup } from './parse.ts';

export const passBSchema: JsonSchema = {
  name: 'passb',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['relations', 'events'],
    properties: {
      relations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['predicate', 'object', 'evidence'],
          properties: {
            predicate: { type: 'string' },
            object: { type: 'string' },
            evidence: { type: 'string' },
            weight: { type: 'number' },
          },
        },
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string' },
            inWorldDate: { type: ['string', 'null'] },
            participants: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      voice: {
        type: 'object',
        additionalProperties: false,
        properties: {
          diction: { type: 'string' },
          tics: { type: 'array', items: { type: 'string' } },
          samples: { type: 'array', items: { type: 'string' } },
          never: { type: 'array', items: { type: 'string' } },
        },
      },
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'conflictsWith'],
          properties: {
            claim: { type: 'string' },
            conflictsWith: { type: 'string' },
          },
        },
      },
    },
  },
};

/**
 * A closed predicate vocabulary. Free-form predicates produce a graph nobody can
 * query: `DISLIKES`, `IS_HOSTILE_TO` and `HATES` become three unrelated edge
 * types describing one relationship, and every later traversal has to guess.
 */
export const PASSB_PREDICATES = [
  'ALLIED_WITH',
  'HOSTILE_TO',
  'KIN_OF',
  'MEMBER_OF',
  'LEADS',
  'SERVES',
  'MENTORS',
  'BETRAYED',
  'KILLED',
  'LOVES',
  'DISTRUSTS',
  'RIVAL_OF',
  'LOCATED_IN',
  'PART_OF',
  'CARRIES',
  'CREATED',
  'GUARDS',
  'SEEKS',
  'INVOLVED_IN',
] as const;

const SYSTEM = `You extract structured facts about one subject from an encyclopedia page
about a fictional universe.

Rules that matter more than completeness:

1. Every relation needs an "evidence" field containing a VERBATIM quote from the
   page that states it. If you cannot quote it, do not report it. Never
   paraphrase into the evidence field.
2. Use only these predicates: ${PASSB_PREDICATES.join(', ')}.
3. The "object" of a relation must be the name of another entity, written as the
   page writes it. Do not invent entities.
4. Events are things that happened, with an in-world date if the page states one.
   Do not turn descriptions of ongoing states into events.
5. Voice is only for characters, and only from quoted dialogue actually on the
   page. "samples" must be verbatim lines the character speaks. Leave voice out
   entirely rather than inventing it.
6. Report a contradiction only when the page states something that conflicts with
   the supplied existing facts. Different wording is not a contradiction.

Prefer three well-evidenced relations to twelve guesses. Reply with JSON only.`;

export interface LlmPassBOptions {
  provider: Provider;
  world: World;
  /** Token ceiling for the page excerpt handed to the model. */
  pageBudget?: number;
  /** Drop any relation whose evidence is shorter than this; near-empty quotes are guesses. */
  minEvidence?: number;
  /** Verify the evidence quote actually occurs on the page. */
  verifyEvidence?: boolean;
  /**
   * Word ceiling for any single stored verbatim quote — evidence spans and
   * voice samples alike. See `clipQuote`.
   */
  maxQuoteWords?: number;
  onError?: (title: string, err: unknown) => void;
}

/**
 * Trims a verbatim quote to a word count, on a word boundary.
 *
 * Three reasons this is a hard cap rather than a suggestion:
 *
 * 1. **Legal.** Stored source text is the exposure that matters. `Warner Bros.
 *    & Rowling v. RDR Books` (S.D.N.Y. 2008) turned on the *volume* of verbatim
 *    quotation in a structured reference work derived from a fan wiki — the
 *    closest decided analogue to what an ingest produces. A sentence-length
 *    span supports the same traceability claim as a paragraph at a fraction of
 *    the exposure. See `docs/legal-briefing-fandom-ingest.md`.
 * 2. **Budget.** Evidence and samples are rendered into frames, so a runaway
 *    quote spends tokens that present cast and location should have had.
 * 3. **Quality.** A model that returns a whole section as "evidence" has not
 *    located the claim. Clipping keeps the sentence that carries it.
 *
 * Word-based, not character-based: the previous `slice(0, 300)` cut mid-word
 * and mid-sentence, which reads as corruption in the inspector and teaches the
 * Narrator that broken text is normal.
 */
export function clipQuote(text: string, maxWords: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

export class LlmPassBExtractor implements PassBExtractor {
  private provider: Provider;
  private world: World;
  private pageBudget: number;
  private minEvidence: number;
  private verifyEvidence: boolean;
  private maxQuoteWords: number;
  private onError: ((title: string, err: unknown) => void) | undefined;
  /** Counters, so a run can be judged rather than trusted. */
  readonly stats = { pages: 0, relations: 0, droppedNoEvidence: 0, droppedUnknownObject: 0, droppedBadPredicate: 0, events: 0, voice: 0, clippedQuotes: 0 };

  constructor(opts: LlmPassBOptions) {
    this.provider = opts.provider;
    this.world = opts.world;
    this.pageBudget = opts.pageBudget ?? 6000;
    this.minEvidence = opts.minEvidence ?? 12;
    this.verifyEvidence = opts.verifyEvidence ?? true;
    // 25 words is about one full sentence of encyclopedia prose — enough to
    // carry a claim and locate it on the page, short enough to stay clearly
    // within quotation rather than reproduction.
    this.maxQuoteWords = opts.maxQuoteWords ?? 25;
    this.onError = opts.onError;
  }

  async extract(page: WikiPage, entity: Entity): Promise<PassBOutput> {
    this.stats.pages++;
    const plain = this.pageExcerpt(page);
    const known = this.knownNames(entity);
    const existing = this.existingFacts(entity);

    const user = [
      `<subject>${entity.name} (${entity.type})</subject>`,
      `<known-entities>\n${known.join('\n')}\n</known-entities>`,
      existing ? `<existing-facts>\n${existing}\n</existing-facts>` : '',
      `<page>\n${plain}\n</page>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let raw: unknown;
    try {
      const req = adaptRequest(
        {
          role: 'passb',
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
          schema: passBSchema,
          temperature: 0,
          maxTokens: 1500,
        },
        this.provider.capabilities,
      );
      const res = await this.provider.complete(req);
      raw = extractJson(res.text);
    } catch (err) {
      this.onError?.(page.title, err);
      return { edges: [], events: [], contradictions: [] };
    }

    return this.validate(raw, page, entity);
  }

  /**
   * Trims the page to a budget, preferring the lead section and the narrative
   * sections. Appearance lists and trivia are where extraction quality goes to
   * die: they are dense with names and say nothing about relationships.
   *
   * The *whole* lead is kept, not just its first paragraph. On real wiki pages
   * the lead runs several paragraphs and is where quoted dialogue usually sits,
   * so taking only the opening sentence silently starves voice extraction.
   */
  private pageExcerpt(page: WikiPage): string {
    const tk = new HeuristicTokenizer({ charsPerToken: this.provider.capabilities.charsPerToken });
    const skip = /^(appearances?|references?|external links?|trivia|gallery|behind the scenes|notes|see also|bibliography)$/i;

    // Everything before the first heading is the lead.
    const firstHeading = page.wikitext.search(/^={2,6}\s*.+?\s*={2,6}\s*$/m);
    const leadRaw = firstHeading > 0 ? page.wikitext.slice(0, firstHeading) : page.wikitext;
    const lead = stripMarkup(leadRaw) || firstParagraph(page.wikitext, 900);

    const sections = parseSections(page.wikitext)
      .filter((s) => !skip.test(s.title.trim()))
      .map((s) => `## ${s.title}\n${stripMarkup(s.body)}`.trim())
      .filter((s) => s.length > 40);

    let out = lead;
    for (const section of sections) {
      const candidate = `${out}\n\n${section}`;
      if (tk.count(candidate) > this.pageBudget) break;
      out = candidate;
    }
    return tk.truncate(out, this.pageBudget);
  }

  /** Entity names the model may reference, drawn from the graph neighbourhood. */
  private knownNames(entity: Entity): string[] {
    const names = new Set<string>();
    for (const { otherId } of this.world.graph.neighbours(entity.id)) {
      const other = this.world.graph.get(otherId);
      if (other) names.add(other.name);
    }
    // Fill out with salient entities so cross-arc relations are still nameable.
    for (const e of this.world.graph.list({ limit: 120 })) {
      if (names.size >= 100) break;
      if (e.id !== entity.id) names.add(e.name);
    }
    return [...names];
  }

  /** What the graph already believes, so contradictions can be judged. */
  private existingFacts(entity: Entity): string {
    const lines: string[] = [];
    for (const edge of this.world.graph.edgesFrom(entity.id).slice(0, 20)) {
      if (edge.predicate === 'MENTIONS') continue;
      const other = this.world.graph.get(edge.object);
      lines.push(`${entity.name} ${edge.predicate} ${other?.name ?? edge.object}`);
    }
    const props = entity.props as Record<string, unknown>;
    for (const key of ['status', 'species', 'born', 'died', 'occupation']) {
      if (typeof props[key] === 'string') lines.push(`${key}: ${props[key] as string}`);
    }
    return lines.join('\n');
  }

  /** Clips a stored quote and counts it, so a noisy extractor is visible in stats. */
  private clip(text: string): string {
    const out = clipQuote(text, this.maxQuoteWords);
    if (out.endsWith('…')) this.stats.clippedQuotes++;
    return out;
  }

  /**
   * The gate between the model and the graph. Everything dropped here is counted,
   * because a silent drop rate is how you end up trusting a bad extractor.
   */
  private validate(raw: unknown, page: WikiPage, entity: Entity): PassBOutput {
    const o = (raw ?? {}) as Record<string, unknown>;
    const out: PassBOutput = { edges: [], events: [], contradictions: [] };
    const haystack = normalise(page.wikitext);
    const allowed = new Set<string>(PASSB_PREDICATES);

    for (const r of asArray(o.relations)) {
      const rel = r as Record<string, unknown>;
      const predicate = String(rel.predicate ?? '').toUpperCase().replace(/\s+/g, '_');
      const objectName = String(rel.object ?? '').trim();
      const evidence = String(rel.evidence ?? '').trim();

      if (!allowed.has(predicate)) {
        this.stats.droppedBadPredicate++;
        continue;
      }
      if (evidence.length < this.minEvidence) {
        this.stats.droppedNoEvidence++;
        continue;
      }
      // An evidence quote that is not on the page is the clearest hallucination
      // signal available, and it costs one substring search to catch.
      if (this.verifyEvidence && !haystack.includes(normalise(evidence))) {
        this.stats.droppedNoEvidence++;
        continue;
      }
      const target = this.world.graph.resolveName(objectName);
      if (!target || target.id === entity.id) {
        this.stats.droppedUnknownObject++;
        continue;
      }

      out.edges.push({
        predicate,
        objectName: target.name,
        weight: clamp(typeof rel.weight === 'number' ? rel.weight : 0.6),
        // Clipped *after* the page-verification above, not before: the check
        // needs the model's full quote to confirm it occurs on the page, while
        // only the trimmed span is stored.
        evidence: this.clip(evidence),
      });
      this.stats.relations++;
    }

    for (const e of asArray(o.events)) {
      const ev = e as Record<string, unknown>;
      const text = String(ev.text ?? '').trim();
      if (text.length < 8) continue;
      out.events.push({
        // An event summary is the model's own paraphrase rather than a quote,
        // so it is bounded generously — but still bounded, because a whole
        // section pasted into `text` is a malformed event either way.
        text: clipQuote(text, this.maxQuoteWords * 2),
        ...(typeof ev.inWorldDate === 'string' && ev.inWorldDate ? { inWorldDate: ev.inWorldDate } : {}),
        participants: asArray(ev.participants).map((p) => String(p)),
      });
      this.stats.events++;
    }

    // Voice only for characters, and samples must be quotable from the page.
    if (entity.type === 'Character' && o.voice && typeof o.voice === 'object') {
      const v = o.voice as Record<string, unknown>;
      const samples = asArray(v.samples)
        .map((s) => String(s).trim())
        // Verify first, then clip — same ordering as evidence above. Samples had
        // no length cap at all before this: `slice` bounded evidence but voice
        // samples were stored at whatever length the model returned, which made
        // them the largest verbatim surface in the schema.
        .filter((s) => s.length > 6 && (!this.verifyEvidence || haystack.includes(normalise(s))))
        .map((s) => this.clip(s));
      const card = {
        ...(typeof v.diction === 'string' && v.diction ? { diction: v.diction.slice(0, 240) } : {}),
        tics: asArray(v.tics).map((t) => String(t)).slice(0, 6),
        samples: samples.slice(0, 6),
        never: asArray(v.never).map((n) => String(n)).slice(0, 6),
      };
      if (card.diction || card.samples.length || card.tics.length) {
        out.voiceCard = card;
        this.stats.voice++;
      }
    }

    for (const c of asArray(o.contradictions)) {
      const con = c as Record<string, unknown>;
      const claim = String(con.claim ?? '').trim();
      const conflictsWith = String(con.conflictsWith ?? '').trim();
      if (claim && conflictsWith) out.contradictions!.push({ claim, conflictsWith });
    }

    return out;
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function clamp(n: number): number {
  return Math.max(0.05, Math.min(1, n));
}

/** Loose comparison so quoting differences do not fail an honest evidence span. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\[\[|\]\]|'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
