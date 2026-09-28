import type { CompletionRequest, CompletionResult, Provider, ProviderCapabilities } from '../src/providers/provider.ts';

export const jevTestCapabilities: ProviderCapabilities = {
  contextWindow: 32_000,
  structuredOutput: 'native-schema',
  systemRole: true,
  streaming: false,
  costTier: 'cheap',
  charsPerToken: 4,
  proseQuality: 0,
  steerability: 1,
};

export class ScriptedJevProvider implements Provider {
  readonly id = 'jev-test';
  readonly model = 'typesafe/jev-1.13';
  readonly capabilities = jevTestCapabilities;
  readonly requests: CompletionRequest[] = [];
  private answer: unknown | Error;

  constructor(answer: unknown | Error) {
    this.answer = answer;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (this.answer instanceof Error) throw this.answer;
    const text = typeof this.answer === 'string' ? this.answer : JSON.stringify(this.answer);
    return {
      text,
      tokensIn: 120,
      tokensOut: 12,
      model: this.model,
      schemaEnforced: true,
    };
  }
}

export function clearAnswers(overrides: {
  integrityProbability?: number;
  refereeProbability?: number;
  integrityChoice?: string;
  refereeChoice?: string;
} = {}) {
  return {
    answers: {
      integrity: {
        choice: overrides.integrityChoice ?? 'clear_in_character',
        probabilities: { clear_in_character: overrides.integrityProbability ?? 0.999 },
      },
      referee: {
        choice: overrides.refereeChoice ?? 'clear_no_cost_allow',
        probabilities: { clear_no_cost_allow: overrides.refereeProbability ?? 0.995 },
      },
    },
  };
}
