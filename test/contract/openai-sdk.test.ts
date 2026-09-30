/**
 * Phase 1: the same parity contract, run against the AI SDK adapter.
 *
 * Nothing here is bespoke. If these assertions pass, the SDK transport is
 * behaviourally interchangeable with the hand-rolled one for everything
 * `Provider.complete()` exposes.
 */
import { describe } from 'node:test';
import { OpenAISdkProvider } from '../../src/providers/openai-sdk.ts';
import type { ProviderContract } from './provider-contract.ts';
import { runProviderContract } from './provider-contract.ts';

const MODEL = 'contract-model';

/** Deliberately identical to the OpenAI-compat baseline contract, key for key. */
const openaiSdk: ProviderContract = {
  label: 'openai-compat (ai sdk)',
  model: MODEL,
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new OpenAISdkProvider({
      id: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: MODEL,
      capabilities: {
        contextWindow: 64_000,
        structuredOutput: 'native-schema',
        systemRole: true,
        streaming: true,
        costTier: 'cheap',
        charsPerToken: 4,
        proseQuality: 0.5,
        steerability: 0.5,
        ...(capabilities as object),
      } as never,
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    id: 'chatcmpl-contract',
    model: MODEL,
    choices: [{ message: { content: over.text ?? 'a plain answer' }, finish_reason: over.finishReason ?? 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  }),
  frames: (over = {}) => [
    { id: 'chatcmpl-contract', model: MODEL, choices: [{ delta: { content: 'Once ' } }] },
    { id: 'chatcmpl-contract', model: MODEL, choices: [{ delta: { content: 'upon ' } }] },
    {
      id: 'chatcmpl-contract',
      model: MODEL,
      // Always present, as a real server sends it: this provider rejects a
      // stream that ends without one.
      choices: [{ delta: { content: 'a time' }, finish_reason: over.finishReason ?? 'stop' }],
      usage: { prompt_tokens: over.tokensIn ?? 11, completion_tokens: over.tokensOut ?? 4 },
    },
  ].map((event) => JSON.stringify(event)),
};

describe('phase 1: ai sdk adapter', () => {
  runProviderContract(openaiSdk);
});