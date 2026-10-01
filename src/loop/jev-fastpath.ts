import type { CompletionRequest, Provider } from '../providers/provider.ts';
import { extractJson } from '../providers/provider.ts';
import { providerErrorFields, type ProviderCallTelemetry } from './provider-telemetry.ts';

export interface JevFastPathResult {
  integrity?: true;
  referee?: true;
}

export interface JevFastPathDeps {
  optionalProvider?: (role: string) => Provider | undefined;
  log: (role: string, provider: string, model: string, tokensIn: number, tokensOut: number) => void;
  onProviderCall?: (call: ProviderCallTelemetry) => void;
}

interface DecisionAnswer {
  choice?: unknown;
  probabilities?: unknown;
}

// Conservative starting cutoffs; validate each independently on labeled Jev outputs before production use.
const INTEGRITY_SAFE_PROBABILITY = 0.999;
const REFEREE_SAFE_PROBABILITY = 0.995;

const integrityQuestion = {
  instructions:
    'Choose clear_in_character only when this action is unequivocally consistent with the character and violates no active vow. A stretch, off-key action, vow concern, breach, incoherence, or any uncertainty must be sent for full Integrity review.',
  criteria: {
    clear_in_character: 'Clearly in-character, with no active vow concern.',
    full_integrity_review: 'Any other result, including stretch, off-key, vow concern, breach, incoherence, or uncertainty.',
  },
};

const refereeQuestion = {
  instructions:
    'Choose clear_no_cost_allow only when the action is plainly possible in established world facts and can be allowed without cost, spawn, reinterpretation, friction, contradiction, or any other consequence. Any uncertainty or possible consequence must be sent for full Referee review.',
  criteria: {
    clear_no_cost_allow: 'Clearly possible and harmless to allow, with no cost, new entity, reinterpretation, friction, contradiction, or other consequence.',
    full_referee_review: 'Any other result, including a possible cost, spawn, reinterpretation, friction, contradiction, or uncertainty.',
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function clearlyAccepted(answers: Record<string, unknown>, key: string, safeChoice: string, threshold: number): boolean {
  const answer = record(answers[key]) as DecisionAnswer | undefined;
  if (answer?.choice !== safeChoice) return false;
  const probabilities = record(answer.probabilities);
  const probability = probabilities?.[safeChoice];
  return typeof probability === 'number' && Number.isFinite(probability) && probability >= threshold && probability <= 1;
}

/**
 * Ask Jev only through an explicitly routed provider. Its two safe choices are
 * independent: one malformed or uncertain answer does not discard the other.
 */
export async function checkWithJev(
  deps: JevFastPathDeps,
  args: { rawInput: string; refereeState: string; integrityState?: string },
): Promise<JevFastPathResult> {
  const provider = deps.optionalProvider?.('jev-fastpath');
  if (!provider) return {};

  const properties: Record<string, unknown> = {
    referee: refereeQuestion,
    ...(args.integrityState ? { integrity: integrityQuestion } : {}),
  };
  const state = [
    'Player input:\n' + args.rawInput,
    'World and consequence context:\n' + args.refereeState,
    args.integrityState ? 'Character and vow context:\n' + args.integrityState : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const charsPerToken = provider.capabilities.charsPerToken || 4;
  const tokenEstimate = Math.ceil(state.length / charsPerToken);
  if (tokenEstimate > provider.capabilities.contextWindow - 1_024) return {};

  const req: CompletionRequest = {
    role: 'jev-fastpath',
    messages: [{ role: 'user', content: state }],
    temperature: 0,
    schema: { name: 'jev_fast_checks', schema: { type: 'object', properties } },
  };
  const started = Date.now();
  let result;
  try {
    result = await provider.complete(req);
  } catch (error) {
    deps.onProviderCall?.({
      role: 'jev-fastpath',
      provider: provider.id,
      durationMs: Date.now() - started,
      ok: false,
      ...providerErrorFields(error, req),
    });
    return {};
  }

  deps.onProviderCall?.({
    role: 'jev-fastpath',
    provider: provider.id,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    durationMs: Date.now() - started,
    ok: true,
  });
  deps.log('jev-fastpath', provider.id, result.model, result.tokensIn, result.tokensOut);

  try {
    const payload = record(extractJson(result.text));
    const answers = record(payload?.answers);
    if (!answers) return {};
    return {
      ...(args.integrityState &&
      clearlyAccepted(answers, 'integrity', 'clear_in_character', INTEGRITY_SAFE_PROBABILITY)
        ? { integrity: true as const }
        : {}),
      ...(clearlyAccepted(answers, 'referee', 'clear_no_cost_allow', REFEREE_SAFE_PROBABILITY)
        ? { referee: true as const }
        : {}),
    };
  } catch {
    return {};
  }
}
