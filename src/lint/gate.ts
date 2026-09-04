/**
 * The prose gate. See DESIGN.md §8.2.
 *
 * Deterministic lint first, model rewrite only when it trips. Most detection is
 * regex and statistics, so the common case costs nothing — which is the only
 * reason it is affordable to run on every turn.
 *
 * The gate is deliberately weighted toward doing nothing. Anti-AI lint pushes
 * toward the *absence* of tells, which is not the same as the presence of style;
 * over-tuned it produces careful, characterless prose.
 */
import type { LintReport } from '../domain/types.ts';
import type { ProseGate } from '../loop/engine.ts';
import { lintProse } from './engine.ts';
import { adaptRequest, type Provider } from '../providers/provider.ts';

export interface GateOptions {
  threshold?: number;
  blocklist?: string[];
  /**
   * Read instead of `threshold`/`blocklist` when supplied, so both can change
   * during a session and affect the very next turn. A gate that captured them at
   * construction meant editing the blocklist required a restart, which is the
   * opposite of the one-click habit the list depends on to become useful.
   */
  live?: () => { threshold: number; blocklist: string[] };
  /** Supplying a provider enables the rewrite pass; without one the gate is lint-only. */
  provider?: Provider;
  /** Cap on rewrite attempts. One is almost always enough. */
  maxRewrites?: number;
}

const REWRITE_SYSTEM = `You revise fiction to remove the fingerprints of machine writing.

Keep the events, the voice, and the specifics exactly as they are. Change only
the phrasing that gives it away.

What to remove:
- stock somatic beats: breaths nobody knew they were holding, clenching jaws,
  dropping stomachs, shivers down spines
- emotions named instead of shown
- three-item sensory lists, especially "and something faintly X"
- non-events: something unspoken passing between people, air thick with things,
  silences that stretch
- portentous one-line endings
- dialogue where everyone speaks in equally weighted, complete sentences

What to leave alone:
- em dashes in dialogue, where they mark interruption
- curly quotation marks, which are correct for a book
- sentence fragments used deliberately
- passive voice where it creates distance on purpose

Vary the sentence rhythm. Let some sentences be plain. Reply with the revised
prose only, no commentary.`;

/**
 * Two-step revision. Asking the model to name the tells before fixing them
 * outperforms a single "make this better" instruction, so the critique is worth
 * the extra tokens on the rare turns the gate trips.
 */
export function makeProseGate(opts: GateOptions = {}): ProseGate {
  const provider = opts.provider;
  const settings = opts.live ?? (() => ({ threshold: opts.threshold ?? 6, blocklist: opts.blocklist ?? [] }));

  const lint = (text: string): LintReport => {
    const { threshold, blocklist } = settings();
    return lintProse(text, { profile: 'fiction', threshold, blocklist });
  };

  if (!provider) return { lint };

  return {
    lint,
    async rewrite(text: string, report: LintReport): Promise<string> {
      const tells = report.findings
        .slice(0, 12)
        .map((f) => `- ${f.rule}: ${f.message} ("${f.excerpt}")`)
        .join('\n');

      const req = adaptRequest(
        {
          role: 'humanize',
          temperature: 0.7,
          maxTokens: Math.max(600, Math.ceil(text.length / 2)),
          messages: [
            { role: 'system', content: REWRITE_SYSTEM },
            {
              role: 'user',
              content: `A linter flagged these tells:\n${tells}\n\n<draft>\n${text}\n</draft>\n\nFirst name briefly what makes this read as machine-written, then give the revision. Put the revision after a line containing only ---`,
            },
          ],
        },
        provider.capabilities,
      );

      const res = await provider.complete(req);
      const parts = res.text.split(/^---$/m);
      const revised = (parts.length > 1 ? (parts[parts.length - 1] ?? res.text) : res.text).trim();

      // Never accept a rewrite that made things worse or lost most of the text.
      if (!revised || revised.length < text.length * 0.5) return text;
      const after = lint(revised);
      return after.score < report.score ? revised : text;
    },
  };
}

export { lintProse };
