/**
 * Token estimation. See DESIGN.md §9.2.
 *
 * A real BPE tokenizer per provider is a dependency and a maintenance burden,
 * and exactness is not what budget enforcement needs — conservatism is. We
 * over-estimate slightly and keep a safety margin, so the failure mode is a
 * slightly under-filled frame rather than a provider-side truncation, which
 * would silently drop the end of the prompt.
 */

export interface Tokenizer {
  count(text: string): number;
  /** Trim to at most `maxTokens`, on a sentence boundary where possible. */
  truncate(text: string, maxTokens: number): string;
}

export interface HeuristicOptions {
  charsPerToken?: number;
  /** Multiplier applied on top; >1 over-estimates on purpose. */
  safety?: number;
}

/**
 * Content class changes the ratio measurably: dense JSON and id-heavy text
 * tokenize far worse than flowing prose, and a frame is a mix of both.
 */
export class HeuristicTokenizer implements Tokenizer {
  private cpt: number;
  private safety: number;

  constructor(opts: HeuristicOptions = {}) {
    this.cpt = opts.charsPerToken ?? 4;
    this.safety = opts.safety ?? 1.1;
  }

  count(text: string): number {
    if (!text) return 0;
    // Punctuation and digits fragment into more tokens than letters do.
    const symbols = (text.match(/[^\w\s]/g) ?? []).length;
    const digits = (text.match(/\d/g) ?? []).length;
    const base = text.length / this.cpt;
    const penalty = (symbols * 0.35 + digits * 0.2) / this.cpt;
    return Math.ceil((base + penalty) * this.safety);
  }

  truncate(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    if (this.count(text) <= maxTokens) return text;

    // Binary search the character length that fits, then back off to a boundary.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this.count(text.slice(0, mid)) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    const cut = text.slice(0, lo);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    // Only honour the boundary if it does not throw away most of the budget.
    return boundary > lo * 0.6 ? cut.slice(0, boundary + 1) : cut;
  }
}

export function tokenizerFor(charsPerToken: number): Tokenizer {
  return new HeuristicTokenizer({ charsPerToken });
}
