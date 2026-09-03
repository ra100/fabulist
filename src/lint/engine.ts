/**
 * Prose lint engine: runs the rule set for a profile over a text and reduces
 * the findings to a `LintReport`. See `rules.ts` for the rules themselves and
 * for the design rationale behind having two separate profiles.
 */
import type { LintFinding, LintReport } from '../domain/types.ts';
import { RULES, trimExcerpt, type LintRule, type Profile } from './rules.ts';

export interface LintOptions {
  profile?: 'fiction' | 'prose-doc';
  /** Score above which `tripped` becomes true. Default 10. */
  threshold?: number;
  /** The user's own growing list of banned phrases, matched as case-insensitive substrings. */
  blocklist?: string[];
}

const DEFAULT_THRESHOLD = 10;

function rulesForProfile(profile: Profile): LintRule[] {
  return RULES.filter((r) => r.profiles.includes(profile));
}

/**
 * The user's personal blocklist is a dynamic rule rather than a static entry in
 * `RULES`: it has no fixed id per phrase, it is supplied at call time, and it grows
 * without bound as the user curates it. Per the design notes, this file — the words
 * *this* writer has personally decided read wrong in *their* voice — becomes more
 * valuable over time than any generic checklist, because it is calibrated to one
 * person's ear instead of an average, so it is kept editable and open-ended, not
 * baked into the static rule registry.
 */
function blocklistFindings(text: string, blocklist: string[] | undefined): LintFinding[] {
  if (!blocklist || blocklist.length === 0) return [];
  const findings: LintFinding[] = [];
  const lower = text.toLowerCase();
  for (const phraseRaw of blocklist) {
    const phrase = phraseRaw.trim();
    if (!phrase) continue;
    const needle = phrase.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      findings.push({
        rule: 'user-blocklist',
        severity: 'warn',
        message: `"${phrase}" is on your personal blocklist.`,
        excerpt: trimExcerpt(text.slice(idx, idx + phrase.length)),
        offset: idx,
      });
      from = idx + Math.max(needle.length, 1);
    }
  }
  return findings;
}

function countWords(text: string): number {
  const m = text.match(/[A-Za-z0-9''-]+/g);
  return m ? m.length : 0;
}

/**
 * SCORE FORMULA
 * -------------
 * raw = sum over every finding of that finding's rule weight (the user blocklist
 * uses a fixed weight of 4 — a personally-curated phrase is a strong, deliberate
 * signal, comparable to the heavier built-in rules).
 *
 * score = raw * (1000 / max(wordCount, 1))
 *
 * i.e. the score is "weighted findings per 1000 words". A 200-word snippet with one
 * weight-3 finding and a 5000-word chapter with five equivalent findings land on
 * comparable scores (15 vs 3), which is the point: a handful of tells in a full
 * chapter is a much smaller problem than the same handful crammed into a paragraph,
 * and the score should reflect density of the problem, not its raw count.
 */
function computeScore(findings: LintFinding[], blocklistFindingCount: number, wordCount: number, ruleWeights: Map<string, number>): number {
  let raw = 0;
  for (const f of findings) {
    if (f.rule === 'user-blocklist') {
      raw += 4;
    } else {
      raw += ruleWeights.get(f.rule) ?? 1;
    }
  }
  const denom = Math.max(wordCount, 1);
  return Math.round(((raw * 1000) / denom) * 100) / 100;
}

export function lintProse(text: string, opts: LintOptions = {}): LintReport {
  const profile: 'fiction' | 'prose-doc' = opts.profile ?? 'fiction';
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const rules = rulesForProfile(profile);
  const ruleWeights = new Map(rules.map((r) => [r.id, r.weight] as const));

  const findings: LintFinding[] = [];
  for (const rule of rules) {
    findings.push(...rule.check(text));
  }
  const blocklistHits = blocklistFindings(text, opts.blocklist);
  findings.push(...blocklistHits);

  findings.sort((a, b) => a.offset - b.offset);

  const wordCount = countWords(text);
  const score = computeScore(findings, blocklistHits.length, wordCount, ruleWeights);

  return {
    profile,
    findings,
    score,
    tripped: score > threshold,
  };
}

/** Rule ids registered for a given profile, for tooling/UI that wants to list them. */
export function availableRules(profile: 'fiction' | 'prose-doc'): string[] {
  return rulesForProfile(profile).map((r) => r.id);
}

// ------------------------------------------------------------- cross-scene

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'as', 'is', 'was', 'were', 'are', 'be', 'been', 'it', 'its', 'his', 'her', 'their',
  'he', 'she', 'they', 'that', 'this', 'had', 'have', 'has', 'not', 'so', 'into',
]);

function tokenizeWords(text: string): Array<{ word: string; index: number }> {
  const out: Array<{ word: string; index: number }> = [];
  for (const m of text.matchAll(/[A-Za-z''-]+/g)) {
    out.push({ word: m[0].toLowerCase(), index: m.index });
  }
  return out;
}

function ngrams(tokens: Array<{ word: string; index: number }>, n: number): Array<{ phrase: string; index: number }> {
  const out: Array<{ phrase: string; index: number }> = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    const slice = tokens.slice(i, i + n);
    // Skip n-grams that are entirely stopwords/function words — those repeat across
    // any two pieces of English and would drown the real signal.
    if (slice.every((t) => STOPWORDS.has(t.word))) continue;
    out.push({ phrase: slice.map((t) => t.word).join(' '), index: slice[0]!.index });
  }
  return out;
}

/**
 * A single linter pass over one text cannot see the failure mode this exists for:
 * a character "letting out a breath she didn't know she was holding" once is fine —
 * the same gesture recurring, verbatim, across nine separate scenes is a sign the
 * writing (human or model) has fallen into a small closed set of moves it repeats
 * without noticing, because nothing in-scene forces variation. That's a corpus-level
 * property, so it needs multiple texts (chapters/scenes) passed in together.
 *
 * Finds 3+ word n-grams that occur in at least 3 distinct texts (not just 3 times
 * total in one text — that's what `somaticCliches` etc. are for within one scene).
 */
export function crossSceneTells(texts: string[], opts: { minWords?: number; minTexts?: number } = {}): LintFinding[] {
  const minWords = opts.minWords ?? 3;
  const minTexts = opts.minTexts ?? 3;
  if (texts.length < minTexts) return [];

  // phrase -> set of text indices it appears in, plus one representative (text, offset)
  const occurrences = new Map<string, { textIndices: Set<number>; sample: { textIndex: number; index: number } }>();

  texts.forEach((text, textIndex) => {
    const tokens = tokenizeWords(text);
    const seenInThisText = new Set<string>();
    for (const { phrase, index } of ngrams(tokens, minWords)) {
      if (seenInThisText.has(phrase)) continue; // count each text once per phrase
      seenInThisText.add(phrase);
      const existing = occurrences.get(phrase);
      if (existing) {
        existing.textIndices.add(textIndex);
      } else {
        occurrences.set(phrase, { textIndices: new Set([textIndex]), sample: { textIndex, index } });
      }
    }
  });

  const findings: LintFinding[] = [];
  for (const [phrase, data] of occurrences) {
    if (data.textIndices.size < minTexts) continue;
    findings.push({
      rule: 'cross-scene-repetition',
      severity: 'warn',
      message: `"${phrase}" recurs across ${data.textIndices.size} separate texts — a gesture used once is fine, used everywhere is a tic.`,
      excerpt: trimExcerpt(phrase),
      offset: data.sample.index,
    });
  }
  findings.sort((a, b) => b.message.length - a.message.length || a.offset - b.offset);
  return findings;
}

export type { Profile, LintRule } from './rules.ts';
