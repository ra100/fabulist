/**
 * Prose lint rules. See DESIGN.md's style/lint section and `src/domain/types.ts`.
 *
 * WHY TWO PROFILES:
 * The popular "signs of AI writing" checklists (inflated significance, em dash
 * overuse, curly quotes, rule-of-three, passive voice...) were compiled by
 * reading marketing copy and encyclopedia articles. Several of those tells are
 * simply correct craft in fiction: curly quotes are proper book typography, an
 * em dash mid-sentence is how English renders an interruption, three items in
 * a sentence is a rhetorical device with a name (tricolon), and third-person
 * narration is often *supposed* to hold the reader at a distance via passive
 * constructions. A linter that flags those in a novel is flagging good prose.
 *
 * So `prose-doc` keeps the classic checklist (it is right for expository/
 * marketing text), and `fiction` throws most of it out and replaces it with
 * the tells that actually give away AI-written scenes: somatic clichés doing
 * the emotional work instead of specific detail, named-not-shown feelings,
 * suspiciously uniform dialogue and paragraph shapes, dialogue tags dressed up
 * with adverbs instead of stronger verbs or plain "said", and portentous
 * one-line paragraph closers repeated scene after scene.
 *
 * Every rule is deterministic regex/statistics over the raw text — no model
 * calls, no network, no external packages.
 */
import type { LintFinding, LintSeverity } from '../domain/types.ts';

export type Profile = 'fiction' | 'prose-doc';

export interface LintRule {
  id: string;
  profiles: Profile[];
  severity: LintSeverity;
  /** Contribution to the raw score for each finding this rule produces. */
  weight: number;
  description: string;
  check: (text: string) => LintFinding[];
}

// ------------------------------------------------------------------- helpers

/** Findings carry the matched text itself, trimmed to ~60 chars, not surrounding context. */
export function trimExcerpt(matched: string, max = 60): string {
  const flat = matched.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 3).trimEnd()}...`;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wraps a literal phrase with word boundaries only where the phrase edge is
 * itself a word character. Phrases like "Certainly!" end in punctuation, and
 * a trailing `\b` there would never match, silently disabling the rule.
 */
function phrasePattern(phrase: string): string {
  const esc = escapeRegExp(phrase);
  const startsWord = /^\w/.test(phrase);
  const endsWord = /\w$/.test(phrase);
  return `${startsWord ? '\\b' : ''}${esc}${endsWord ? '\\b' : ''}`;
}

function combinedPattern(phrases: string[]): RegExp {
  return new RegExp(phrases.map(phrasePattern).join('|'), 'gi');
}

function makeFinding(
  ruleId: string,
  severity: LintSeverity,
  message: string,
  matched: string,
  offset: number,
): LintFinding {
  return { rule: ruleId, severity, message, excerpt: trimExcerpt(matched), offset };
}

/** Iterates every match of a (forced-global) regex without the caller managing lastIndex. */
function* iterMatches(text: string, re: RegExp): Generator<RegExpExecArray> {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const scoped = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = scoped.exec(text))) {
    yield m;
    if (m[0].length === 0) scoped.lastIndex += 1;
  }
}

function countWords(text: string): number {
  const m = text.match(/[A-Za-z0-9''-]+/g);
  return m ? m.length : 0;
}

/** One or more non-empty lines separated from the next block by a blank line. */
function splitParagraphs(text: string): Array<{ text: string; offset: number }> {
  const paras: Array<{ text: string; offset: number }> = [];
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) paras.push({ text: m[0], offset: m.index });
  return paras;
}

function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  return (matches ?? []).map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------ rule factories

/** A flat list of banned/suspect phrases, each an independent finding. */
function phraseListRule(opts: {
  id: string;
  profiles: Profile[];
  severity: LintSeverity;
  weight: number;
  description: string;
  phrases: string[];
  message: (phrase: string) => string;
}): LintRule {
  const pattern = combinedPattern(opts.phrases);
  return {
    id: opts.id,
    profiles: opts.profiles,
    severity: opts.severity,
    weight: opts.weight,
    description: opts.description,
    check(text) {
      const findings: LintFinding[] = [];
      for (const m of iterMatches(text, pattern)) {
        findings.push(makeFinding(opts.id, opts.severity, opts.message(m[0]), m[0], m.index));
      }
      return findings;
    },
  };
}

/** Like phraseListRule, but only fires once the phrases occur at least `minCount` times
 * across the whole text — for tells that are fine in isolation and only damning en masse
 * (a hyphenated compound, a rule-of-three, an em dash) versus tells that are damning the
 * instant they appear (a sycophancy stock phrase). */
function repeatedPatternRule(opts: {
  id: string;
  profiles: Profile[];
  severity: LintSeverity;
  weight: number;
  description: string;
  pattern: RegExp;
  minCount: number;
  message: (matched: string, total: number) => string;
}): LintRule {
  return {
    id: opts.id,
    profiles: opts.profiles,
    severity: opts.severity,
    weight: opts.weight,
    description: opts.description,
    check(text) {
      const all = [...iterMatches(text, opts.pattern)];
      if (all.length < opts.minCount) return [];
      return all.map((m) =>
        makeFinding(opts.id, opts.severity, opts.message(m[0], all.length), m[0], m.index),
      );
    },
  };
}

/** Removes matches that lie entirely inside an already-accepted, longer match — so a
 * broad cliché regex and a narrower one covering the same words don't double-count
 * the same sentence. */
function dedupeOverlaps(
  matches: Array<{ index: number; text: string }>,
): Array<{ index: number; text: string }> {
  const sorted = [...matches].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const accepted: Array<{ index: number; text: string }> = [];
  for (const m of sorted) {
    const end = m.index + m.text.length;
    const overlapped = accepted.some((a) => m.index >= a.index && end <= a.index + a.text.length);
    if (!overlapped) accepted.push(m);
  }
  return accepted.sort((a, b) => a.index - b.index);
}

/** Runs several regexes over the text and merges/dedupes their matches into one rule. */
function multiPatternRule(opts: {
  id: string;
  profiles: Profile[];
  severity: LintSeverity;
  weight: number;
  description: string;
  patterns: RegExp[];
  message: (matched: string) => string;
}): LintRule {
  return {
    id: opts.id,
    profiles: opts.profiles,
    severity: opts.severity,
    weight: opts.weight,
    description: opts.description,
    check(text) {
      const raw = opts.patterns.flatMap((re) =>
        [...iterMatches(text, re)].map((m) => ({ index: m.index, text: m[0] })),
      );
      const deduped = dedupeOverlaps(raw);
      return deduped.map((m) => makeFinding(opts.id, opts.severity, opts.message(m.text), m.text, m.index));
    },
  };
}

// ============================================================== prose-doc

const significanceInflation = phraseListRule({
  id: 'significance-inflation',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 3,
  description: 'Inflates the importance of an ordinary fact instead of stating it plainly.',
  phrases: [
    'is a testament to',
    'pivotal moment',
    'marks a shift',
    'underscores the importance',
    'evolving landscape',
    'indelible mark',
    'deeply rooted',
  ],
  message: (p) => `"${p}" inflates significance — say what happened instead of how important it was.`,
});

const promotionalLanguage = phraseListRule({
  id: 'promotional-language',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 3,
  description: 'Travel-brochure adjectives that assert appeal rather than describing it.',
  phrases: [
    'boasts a',
    'vibrant',
    'nestled',
    'in the heart of',
    'breathtaking',
    'must-visit',
    'renowned',
    'groundbreaking',
    'stunning',
  ],
  message: (p) => `"${p}" is promotional filler — replace with a concrete, checkable detail.`,
});

const aiVocabularyProseDoc = phraseListRule({
  id: 'ai-vocabulary-prose-doc',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Words disproportionately over-represented in LLM output vs. human baselines.',
  phrases: [
    'delve',
    'tapestry',
    'testament',
    'underscore',
    'intricate',
    'pivotal',
    'showcase',
    'garner',
    'interplay',
    'crucial',
    'enduring',
    'foster',
    'landscape',
    'realm',
    'myriad',
  ],
  message: (p) => `"${p}" is a high-frequency AI tell word in expository text.`,
});

// Sentence-final participial clauses that gesture at analysis without doing any:
// ", highlighting the growing importance of X" reads as insight but states nothing
// falsifiable. This is the single highest-value prose-doc catch in practice.
const superficialIngAnalysis: LintRule = {
  id: 'superficial-ing-analysis',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 4,
  description: 'Trailing "-ing" clause that gestures at significance instead of asserting one.',
  check(text) {
    const pattern =
      /,\s*(?:highlighting|underscoring|reflecting|showcasing|emphasizing|illustrating|demonstrating|signaling|underlining)\s+[^.!?]*[.!?]/gi;
    const findings: LintFinding[] = [];
    for (const m of iterMatches(text, pattern)) {
      findings.push(
        makeFinding(
          'superficial-ing-analysis',
          'warn',
          'Trailing "-ing" clause asserts significance without evidence — cut it or replace it with a fact.',
          m[0],
          m.index,
        ),
      );
    }
    return findings;
  },
};

const negativeParallelism = multiPatternRule({
  id: 'negative-parallelism',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 3,
  description: '"Not just X, it\'s Y" and "not only... but also" rhetorical scaffolding.',
  patterns: [
    /not just [^,]+,\s*(?:it'?s|it is)\s+[^.!?]+[.!?]/gi,
    /\bnot only\b[^.!?]*\bbut also\b[^.!?]*[.!?]/gi,
    /\bit'?s not merely\b[^.!?]*[.!?]/gi,
  ],
  message: (m) => `"${trimExcerpt(m, 40)}" is negative-parallelism scaffolding — say the positive claim directly.`,
});

// "Serves as" / "stands as" avoid a plain copula ("is") because "is" reads as too
// blunt to a model trained to sound analytical. In documentation the blunt verb
// is almost always clearer.
const copulaAvoidance = phraseListRule({
  id: 'copula-avoidance',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Dresses up a plain "is" as something more analytical-sounding.',
  phrases: ['serves as', 'stands as', 'functions as', 'represents a', 'boasts'],
  message: (p) => `"${p}" avoids a plain "is" — consider stating the fact directly.`,
});

function ruleOfThreeMatcher(text: string): RegExpExecArray[] {
  const pattern =
    /\b([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}),\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}),\s+(?:and|or)\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2})\b/g;
  return [...iterMatches(text, pattern)];
}

// Rule-of-three (tricolon) is a real, deliberate rhetorical device — Caesar used it.
// One instance is craft. Prose-doc, though, gets these from models padding a sentence
// with adjectives to sound thorough, and it shows up again and again in a single piece
// far sooner than a human writer would repeat the trick, so the doc threshold is low.
const ruleOfThreeProseDoc = repeatedPatternRule({
  id: 'rule-of-three-repeated',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Exactly-three comma lists, flagged once they recur across the document.',
  pattern: /\b([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}),\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2}),\s+(?:and|or)\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2})\b/g,
  minCount: 2,
  message: (m, total) => `Rule-of-three list recurs (${total} in this document): "${trimExcerpt(m, 40)}".`,
});

// Em dashes are real English punctuation; a doc with a couple is unremarkable. Density
// this high in exposition (as opposed to dialogue, see the fiction profile) reads as a
// model reaching for a dash whenever a comma or period would do.
const emDashDensityProseDoc: LintRule = {
  id: 'em-dash-density-prose-doc',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 3,
  description: 'Em dash density above what expository prose normally needs.',
  check(text) {
    const matches = [...iterMatches(text, /—/g)];
    const words = Math.max(countWords(text), 1);
    const per100 = (matches.length / words) * 100;
    if (matches.length === 0 || per100 <= 1.5) return [];
    const first = matches[0]!;
    return [
      makeFinding(
        'em-dash-density-prose-doc',
        'info',
        `Em dash density is ${per100.toFixed(1)} per 100 words — high for exposition; prefer commas or periods.`,
        text.slice(Math.max(0, first.index - 20), first.index + 20),
        first.index,
      ),
    ];
  },
};

// Curly quotes are WRONG here on purpose: this profile is for docs/markdown/expository
// text, where straight quotes are the plain-text convention and curly ones usually mean
// a rich-text editor or a model silently "prettified" punctuation nobody asked for.
const curlyQuotes: LintRule = {
  id: 'curly-quotes',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 1,
  description: 'Typographic quotes in a plain-text/doc profile, where straight quotes are the convention.',
  check(text) {
    const findings: LintFinding[] = [];
    for (const m of iterMatches(text, /[\u2018\u2019\u201C\u201D]/g)) {
      findings.push(
        makeFinding('curly-quotes', 'info', 'Curly quote in a doc profile — use straight quotes.', m[0], m.index),
      );
    }
    return findings;
  },
};

const emojiInHeadingsBullets: LintRule = {
  id: 'emoji-in-headings-bullets',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Emoji decorating a heading or bullet, a habit docs rarely had before LLM drafting.',
  check(text) {
    const findings: LintFinding[] = [];
    const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
    let cursor = 0;
    for (const line of text.split('\n')) {
      const lineOffset = cursor;
      cursor += line.length + 1;
      if (!/^\s{0,3}(#{1,6}\s|[-*]\s)/.test(line)) continue;
      for (const m of iterMatches(line, emojiPattern)) {
        findings.push(
          makeFinding(
            'emoji-in-headings-bullets',
            'info',
            'Emoji in a heading/bullet reads as AI-drafted formatting flourish.',
            m[0],
            lineOffset + m.index,
          ),
        );
      }
    }
    return findings;
  },
};

const fillerPhrases = phraseListRule({
  id: 'filler-phrases',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Padding that adds length without adding meaning.',
  phrases: [
    'in order to',
    'due to the fact that',
    'at this point in time',
    'it is important to note that',
    'has the ability to',
  ],
  message: (p) => `"${p}" is filler — shorten (e.g. "to", "because", "now", "can").`,
});

const hedgingStack: LintRule = {
  id: 'excessive-hedging',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 3,
  description: 'Two or more stacked qualifiers hedging the same claim.',
  check(text) {
    const pattern =
      /\b(?:could|might|may|possibly|potentially|perhaps|arguably|seemingly)\s+(?:possibly|potentially|perhaps|arguably|conceivably|maybe)\b/gi;
    const findings: LintFinding[] = [];
    for (const m of iterMatches(text, pattern)) {
      findings.push(
        makeFinding(
          'excessive-hedging',
          'warn',
          'Stacked hedges weaken the claim to nothing — pick one level of confidence.',
          m[0],
          m.index,
        ),
      );
    }
    return findings;
  },
};

const vagueAttribution = multiPatternRule({
  id: 'vague-attribution',
  profiles: ['prose-doc'],
  severity: 'warn',
  weight: 3,
  description: 'Cites an unnamed authority instead of a checkable source.',
  patterns: [
    /\bexperts argue\b/gi,
    /\bobservers have noted\b/gi,
    /\bindustry reports\b/gi,
    /\bsome critics say\b/gi,
    /\b(?:experts|analysts|observers|critics)\s+(?:argue|say|note|noted|claim|suggest|believe)\b/gi,
  ],
  message: (m) => `"${m}" is a vague attribution — name the actual source or drop the claim.`,
});

const authorityTropes = phraseListRule({
  id: 'authority-tropes',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Rhetorical throat-clearing that asserts profundity instead of earning it.',
  phrases: [
    'the real question is',
    'at its core',
    'what really matters',
    'fundamentally',
    'the heart of the matter',
  ],
  message: (p) => `"${p}" asserts profundity rather than demonstrating it.`,
});

const signposting = phraseListRule({
  id: 'signposting',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Tutorial-video narration voice, not written-doc voice.',
  phrases: ["let's dive in", "let's explore", "here's what you need to know", "let's break this down"],
  message: (p) => `"${p}" is spoken-tutorial signposting — cut it and start the content.`,
});

const chatArtifacts = phraseListRule({
  id: 'chat-artifacts',
  profiles: ['prose-doc'],
  severity: 'error',
  weight: 5,
  description: 'Chat-assistant sycophancy/etiquette that leaked into a document.',
  phrases: ['great question', 'i hope this helps', 'certainly!', "you're absolutely right", 'let me know if'],
  message: (p) => `"${p}" is a chat artifact left in the document — this was never addressed to a reader.`,
});

const genericPositiveConclusion = phraseListRule({
  id: 'generic-positive-conclusion',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Content-free upbeat closer that could end any document about anything.',
  phrases: ['the future looks bright', 'exciting times ahead', 'step in the right direction'],
  message: (p) => `"${p}" is a generic upbeat closer — end on an actual conclusion instead.`,
});

// A single "real-time" or "data-driven" is unremarkable, ordinary business English.
// It becomes a tell only once several of these compounds pile up in one piece — the
// verbal equivalent of a stock photo folder.
const hyphenatedPairOveruse = repeatedPatternRule({
  id: 'hyphenated-pair-overuse',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 1,
  description: 'Buzzword hyphenated compounds, flagged once they pile up.',
  pattern:
    /\b(?:data-driven|cross-functional|client-facing|decision-making|end-to-end|real-time|long-term)\b/gi,
  minCount: 3,
  message: (m, total) => `"${m}" is one of ${total} buzzword compounds in this document.`,
});

const titleCaseHeadings: LintRule = {
  id: 'title-case-headings',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 1,
  description: 'Markdown headings capitalized as if for a marketing landing page.',
  check(text) {
    const findings: LintFinding[] = [];
    const SMALL = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'it', 'or']);
    let cursor = 0;
    for (const line of text.split('\n')) {
      const lineOffset = cursor;
      cursor += line.length + 1;
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!m) continue;
      const headingText = m[2]!;
      const words = headingText.split(/\s+/).filter(Boolean);
      if (words.length < 4) continue;
      const capitalized = words.filter((w) => {
        const bare = w.replace(/[^A-Za-z]/g, '');
        if (bare.length === 0) return false;
        if (SMALL.has(bare.toLowerCase())) return false;
        return /^[A-Z]/.test(bare);
      });
      const ratio = capitalized.length / words.length;
      if (ratio >= 0.85) {
        const headingOffset = lineOffset + line.indexOf(headingText);
        findings.push(
          makeFinding(
            'title-case-headings',
            'info',
            'Heading is Title Cased like a landing page rather than sentence case.',
            headingText,
            headingOffset,
          ),
        );
      }
    }
    return findings;
  },
};

const inlineHeaderBullets: LintRule = {
  id: 'inline-header-bullets',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 2,
  description: 'Bullet list where each item opens with a bolded fake sub-heading.',
  check(text) {
    const findings: LintFinding[] = [];
    const pattern = /^[-*]\s+\*\*[^*\n]{1,80}\*\*:/gm;
    for (const m of iterMatches(text, pattern)) {
      findings.push(
        makeFinding(
          'inline-header-bullets',
          'info',
          'Bullet opens with a bolded pseudo-heading — a very LLM-flavored list shape.',
          m[0],
          m.index,
        ),
      );
    }
    return findings;
  },
};

const passiveSubjectlessFragments = multiPatternRule({
  id: 'passive-subjectless-fragments',
  profiles: ['prose-doc'],
  severity: 'info',
  weight: 1,
  description: 'Clipped passive fragments used as faux-confident feature bullets.',
  patterns: [/\bNo [a-z][\w\s]{1,60} needed\./gim, /\b(?:is|are|was|were)\s+\w+ed\s+automatically\b/gi],
  message: (m) => `"${trimExcerpt(m, 40)}" is a subjectless passive fragment — name who/what does the action.`,
});

// ================================================================= fiction

// The single highest-value fiction rule: physical-sensation shorthand for emotion that
// shows up so often in generated fiction it has become a genre unto itself. Each of
// these reads fine in isolation once; the tell is that models reach for the SAME ten
// or so of them constantly instead of writing a body doing something specific to this
// character in this scene.
const somaticCliches: LintRule = {
  id: 'somatic-cliches',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 4,
  description: 'Stock physical-sensation shorthand standing in for a specific, shown emotion.',
  check(text) {
    const patterns = [
      /let out (?:a|the) breath (?:he|she|they|\w+) didn'?t (?:even )?know (?:he|she|they|\w+) (?:was|were) holding/gi,
      /\bbreath hitched\b/gi,
      /\bjaw (?:clenched|tightened)\b/gi,
      /\bstomach dropped\b/gi,
      /\bshiver(?:ed)? (?:ran |went )?down (?:his|her|their) spine\b/gi,
      /\bblood ran cold\b/gi,
      /\bheart (?:hammered|pounded)\b/gi,
      /\bthroat tightened\b/gi,
      /\beyes narrowed\b/gi,
      /\blet out a breath\b/gi,
      /\breleased a breath\b/gi,
      /\bswallowed hard\b/gi,
      /\bclenched (?:his|her|their) fists\b/gi,
      /\ba lump in (?:his|her|their) throat\b/gi,
      /\bwent rigid\b/gi,
      /\bstiffened\b/gi,
      /\bexhaled sharply\b/gi,
      /\bsucked in a breath\b/gi,
    ];
    const raw = patterns.flatMap((re) => [...iterMatches(text, re)].map((m) => ({ index: m.index, text: m[0] })));
    const deduped = dedupeOverlaps(raw);
    return deduped.map((m) =>
      makeFinding(
        'somatic-cliches',
        'warn',
        `"${trimExcerpt(m.text, 40)}" is stock body-language shorthand — show what this character specifically does.`,
        m.text,
        m.index,
      ),
    );
  },
};

const namedEmotionTelling = multiPatternRule({
  id: 'named-emotion-telling',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'Names the emotion abstractly instead of dramatizing it.',
  patterns: [
    /felt (?:a|an) (?:profound|deep|strange|overwhelming|sudden|quiet) (?:sadness|joy|unease|anger|fear|dread|grief|longing|emptiness|happiness)\b/gi,
    /\bwas overcome with\b/gi,
    /\ba wave of \w+ washed over\b/gi,
    /\bfelt a pang of\b/gi,
  ],
  message: (m) => `"${trimExcerpt(m, 40)}" tells the reader the emotion instead of showing it.`,
});

const sensoryTriads = multiPatternRule({
  id: 'sensory-triads',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Three-item sensory lists, especially the "and something faintly X" construction.',
  patterns: [
    /\b(?:the\s+)?(?:smell|scent|sound|taste)\s+of\s+[^,.;\n]+,\s*[^,.;\n]+,\s*and\s+[^,.;\n]+/gi,
    /\band something (?:faintly|vaguely|oddly|strangely)\s+\w+/gi,
  ],
  message: (m) => `"${trimExcerpt(m, 40)}" is a formulaic sensory triad.`,
});

const nonEvents = phraseListRule({
  id: 'non-events',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'A beat that names tension or meaning without anything actually happening.',
  phrases: [
    'something unspoken passed between them',
    'the air was thick with',
    'a silence stretched between them',
    'the silence stretched',
    'the moment hung',
    'words hung in the air',
    'the tension was palpable',
  ],
  message: (p) => `"${p}" asserts a charged moment without an event to carry it.`,
});

// These specific stock closers are damning on sight — unlike the structural rule below,
// a single instance of "Everything changed." is already a cliché, not merely a pattern.
const portentousStockClosers = phraseListRule({
  id: 'portentous-stock-closers',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'Stock portentous one-line scene closers.',
  phrases: ['Everything changed', 'Nothing would ever be the same', 'And then it began', 'It was already too late'],
  message: (p) => `"${p}." is a stock portentous closer.`,
});

// A short, dialogue-free, declarative final line closing a paragraph is a legitimate
// technique used once or twice for a real beat. The tell is doing it as a REFLEX at the
// end of nearly every paragraph, which flattens the technique into a tic. Hence: only
// fires once the shape repeats across the piece, not on a single instance.
const portentousOneLinerPattern: LintRule = {
  id: 'portentous-one-liner-pattern',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'Short, dialogue-free, declarative paragraph-ending one-liners used as a reflexive tic.',
  check(text) {
    const paragraphs = splitParagraphs(text);
    const hits: Array<{ offset: number; excerpt: string }> = [];
    for (const para of paragraphs) {
      const sentences = splitSentences(para.text);
      if (sentences.length === 0) continue;
      const last = sentences[sentences.length - 1]!;
      const wordCount = last.split(/\s+/).filter(Boolean).length;
      const hasDialogue = /["'\u201C\u201D\u2018\u2019]/.test(last);
      if (wordCount > 0 && wordCount < 8 && /^[A-Z]/.test(last) && !hasDialogue) {
        const idx = para.text.lastIndexOf(last);
        hits.push({ offset: para.offset + (idx >= 0 ? idx : 0), excerpt: last });
      }
    }
    if (hits.length < 3) return [];
    return hits.map((h) =>
      makeFinding(
        'portentous-one-liner-pattern',
        'warn',
        `Short declarative closer recurs ${hits.length} times across the piece — it reads as a tic, not a choice.`,
        h.excerpt,
        h.offset,
      ),
    );
  },
};

const eyesWeatherEmotionalLabour = multiPatternRule({
  id: 'eyes-weather-emotional-labour',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Eyes or weather made to narrate emotion the character never actually expresses.',
  patterns: [
    /\beyes betrayed\b/gi,
    /\beyes spoke\b/gi,
    /\b(?:his|her|their)\s+eyes\s+said\b/gi,
    /\bthe sky mirrored\b/gi,
    /\bthe rain seemed to\b/gi,
    /\bas if the weather knew\b/gi,
  ],
  message: (m) => `"${trimExcerpt(m, 40)}" makes eyes/weather do emotional narration for the character.`,
});

/** A dialogue "line" is the contents of one quoted span, straight or curly double quotes. */
function extractDialogueLines(text: string): Array<{ index: number; content: string; wordCount: number }> {
  const pattern = /["\u201C]([^"\u201D]{1,400})["\u201D]/g;
  const lines: Array<{ index: number; content: string; wordCount: number }> = [];
  for (const m of iterMatches(text, pattern)) {
    const content = m[1] ?? '';
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    lines.push({ index: m.index, content, wordCount });
  }
  return lines;
}

// Real dialogue is uneven: people interrupt, ramble, snap out one word, trail off. A
// cast where every line lands within a word or two of the same length is a giveaway
// that the lines were generated to a template rather than spoken by different people
// under different pressures.
const uniformDialogueLength: LintRule = {
  id: 'uniform-dialogue-length',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'Suspiciously low variance in dialogue-line length across many lines.',
  check(text) {
    const lines = extractDialogueLines(text);
    if (lines.length < 4) return [];
    const mean = lines.reduce((s, l) => s + l.wordCount, 0) / lines.length;
    if (mean === 0) return [];
    const variance = lines.reduce((s, l) => s + (l.wordCount - mean) ** 2, 0) / lines.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean;
    if (cv >= 0.2) return [];
    const first = lines[0]!;
    return [
      makeFinding(
        'uniform-dialogue-length',
        'warn',
        `${lines.length} dialogue lines average ${mean.toFixed(1)} words with coefficient of variation ${cv.toFixed(2)} — nobody interrupts, rambles, or clips a line short.`,
        first.content,
        first.index,
      ),
    ];
  },
};

// Sentence-count-per-paragraph is a structural fingerprint humans vary without thinking
// about it. Four or more paragraphs in a row landing on the exact same count — three is
// the classic case, since it's also the model's favorite rule-of-three at the paragraph
// level — means the shape was templated rather than felt out scene by scene.
const symmetricalParagraphArchitecture: LintRule = {
  id: 'symmetrical-paragraph-architecture',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Four or more consecutive paragraphs sharing the exact same sentence count.',
  check(text) {
    const paragraphs = splitParagraphs(text).map((p) => ({ ...p, count: splitSentences(p.text).length }));
    const findings: LintFinding[] = [];
    let runStart = 0;
    for (let i = 1; i <= paragraphs.length; i++) {
      const sameAsPrev = i < paragraphs.length && paragraphs[i]!.count === paragraphs[runStart]!.count;
      if (!sameAsPrev) {
        const runLen = i - runStart;
        if (runLen >= 4 && paragraphs[runStart]!.count > 0) {
          const count = paragraphs[runStart]!.count;
          const first = paragraphs[runStart]!;
          findings.push(
            makeFinding(
              'symmetrical-paragraph-architecture',
              'info',
              `${runLen} consecutive paragraphs each contain exactly ${count} sentence${count === 1 ? '' : 's'}${
                count === 3 ? ' — the paragraph-level rule-of-three' : ''
              }, a templated shape.`,
              first.text,
              first.offset,
            ),
          );
        }
        runStart = i;
      }
    }
    return findings;
  },
};

interface DialogueTag {
  index: number;
  verb: string;
  hasAdverb: boolean;
}

/** Finds `"...," <name> <verb>[ <adverb>]` immediately after a closing quote. */
function extractDialogueTags(text: string): DialogueTag[] {
  const pattern =
    /["\u201D],?\s+[A-Za-z][\w'-]*\s+(said|asked|replied|whispered|shouted|snapped|breathed|murmured|intoned|gritted out|bit out)\b(?:\s+([a-z]+ly)\b)?/gi;
  const tags: DialogueTag[] = [];
  for (const m of iterMatches(text, pattern)) {
    tags.push({ index: m.index, verb: (m[1] ?? '').toLowerCase(), hasAdverb: Boolean(m[2]) });
  }
  return tags;
}

const FLASHY_TAG_VERBS = new Set(['breathed', 'murmured', 'intoned', 'gritted out', 'bit out']);

// "Said" is close to invisible to a reader and that is a feature, not a limitation —
// it lets the dialogue itself carry the scene. Reaching for "breathed"/"murmured"/
// "intoned" repeatedly (or dressing every single "said" with an adverb, "said softly")
// is the writer distrusting their own dialogue and narrating the delivery instead.
const dialogueTagMonotony: LintRule = {
  id: 'dialogue-tag-monotony',
  profiles: ['fiction'],
  severity: 'warn',
  weight: 3,
  description: 'Overuse of flashy "said"-replacement verbs, or every tag pairing "said" with an adverb.',
  check(text) {
    const tags = extractDialogueTags(text);
    const findings: LintFinding[] = [];
    const flashy = tags.filter((t) => FLASHY_TAG_VERBS.has(t.verb));
    if (flashy.length >= 3) {
      for (const t of flashy) {
        findings.push(
          makeFinding(
            'dialogue-tag-monotony',
            'warn',
            `Flashy dialogue-tag verb "${t.verb}" recurs (${flashy.length} times) — "said" disappears for the reader; this doesn't.`,
            t.verb,
            t.index,
          ),
        );
      }
    }
    if (tags.length >= 3 && tags.every((t) => t.verb === 'said' && t.hasAdverb)) {
      const first = tags[0]!;
      findings.push(
        makeFinding(
          'dialogue-tag-monotony',
          'warn',
          `Every one of ${tags.length} dialogue tags pairs "said" with an adverb — vary delivery through the dialogue itself.`,
          'said',
          first.index,
        ),
      );
    }
    return findings;
  },
};

const adverbDensityInDialogueTags: LintRule = {
  id: 'adverb-density-in-dialogue-tags',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'High proportion of dialogue tags carrying an -ly adverb.',
  check(text) {
    const tags = extractDialogueTags(text);
    if (tags.length < 3) return [];
    const withAdverb = tags.filter((t) => t.hasAdverb);
    const ratio = withAdverb.length / tags.length;
    if (ratio < 0.6) return [];
    const first = withAdverb[0] ?? tags[0]!;
    return [
      makeFinding(
        'adverb-density-in-dialogue-tags',
        'info',
        `${withAdverb.length}/${tags.length} dialogue tags carry an adverb — let the line and the verb do the work.`,
        first.verb,
        first.index,
      ),
    ];
  },
};

// "Like a X of Y" is the most common LLM simile shape (parallel to "a symphony of...",
// "a tapestry of..."). One or two per scene is normal figurative language; a run of them
// is the writer reaching for the same rhetorical crutch on every beat.
const overwroughtMetaphorDensity: LintRule = {
  id: 'overwrought-metaphor-density',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Density of "like a X of Y" similes per 100 words.',
  check(text) {
    const matches = [...iterMatches(text, /\blike a\s+\w+(?:\s+\w+)?\s+of\s+\w+(?:\s+\w+)?\b/gi)];
    const words = Math.max(countWords(text), 1);
    const per100 = (matches.length / words) * 100;
    if (matches.length < 2 || per100 < 1) return [];
    return matches.map((m) =>
      makeFinding(
        'overwrought-metaphor-density',
        'info',
        `"${m[0]}" — simile density is ${per100.toFixed(1)} per 100 words, high for figurative language.`,
        m[0],
        m.index,
      ),
    );
  },
};

// An em dash in dialogue is how English spells an interruption or a self-correction —
// "I just—" "Don't." is simply correct craft, and flagging it would punish exactly the
// technique that makes dialogue feel spoken. So this only trips at a density well past
// what any real interruption rate would produce: paragraphs stitched together with
// dashes instead of periods because the model defaults to the dash as connective tissue.
const emDashDensityFiction: LintRule = {
  id: 'em-dash-density-fiction',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Em dash density so extreme it reads as connective-tissue overuse, not interruption.',
  check(text) {
    const matches = [...iterMatches(text, /—/g)];
    const words = Math.max(countWords(text), 1);
    const per100 = (matches.length / words) * 100;
    if (matches.length === 0 || per100 <= 4) return [];
    const first = matches[0]!;
    return [
      makeFinding(
        'em-dash-density-fiction',
        'info',
        `Em dash density is ${per100.toFixed(1)} per 100 words — even for dialogue interruptions, this is extreme.`,
        text.slice(Math.max(0, first.index - 20), first.index + 20),
        first.index,
      ),
    ];
  },
};

const aiVocabularyFiction = phraseListRule({
  id: 'ai-vocabulary-fiction',
  profiles: ['fiction'],
  severity: 'info',
  weight: 2,
  description: 'Narrow AI-tell vocabulary specific to purple-prose fiction (narrower than the doc list).',
  phrases: ['tapestry', 'testament', 'myriad', 'cacophony', 'symphony of', 'dance of', 'ballet of'],
  message: (p) => `"${p}" is over-represented AI-fiction vocabulary.`,
});

// ---------------------------------------------------------------- registry

export const RULES: LintRule[] = [
  // prose-doc
  significanceInflation,
  promotionalLanguage,
  aiVocabularyProseDoc,
  superficialIngAnalysis,
  negativeParallelism,
  copulaAvoidance,
  ruleOfThreeProseDoc,
  emDashDensityProseDoc,
  curlyQuotes,
  emojiInHeadingsBullets,
  fillerPhrases,
  hedgingStack,
  vagueAttribution,
  authorityTropes,
  signposting,
  chatArtifacts,
  genericPositiveConclusion,
  hyphenatedPairOveruse,
  titleCaseHeadings,
  inlineHeaderBullets,
  passiveSubjectlessFragments,
  // fiction
  somaticCliches,
  namedEmotionTelling,
  sensoryTriads,
  nonEvents,
  portentousStockClosers,
  portentousOneLinerPattern,
  eyesWeatherEmotionalLabour,
  uniformDialogueLength,
  symmetricalParagraphArchitecture,
  dialogueTagMonotony,
  adverbDensityInDialogueTags,
  overwroughtMetaphorDensity,
  aiVocabularyFiction,
];

// Exposed for the fiction em-dash rule, which needs different thresholds than prose-doc
// (see engine.ts comment on why em dash density is deliberately NOT a shared rule).
export { countWords, dedupeOverlaps, iterMatches, ruleOfThreeMatcher };
