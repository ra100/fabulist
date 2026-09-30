/**
 * Phase 3: the phase 0 contract, run against the Anthropic SDK adapter.
 *
 * Deliberately the same shape as the baseline Anthropic contract, so the two
 * can be compared assertion for assertion.
 */
import { describe } from 'node:test';
import { AnthropicSdkProvider } from '../../src/providers/anthropic-sdk.ts';
import type { ProviderContract } from './provider-contract.ts';
import { runProviderContract } from './provider-contract.ts';

const MODEL = 'contract-model';

const anthropicSdk: ProviderContract = {
  label: 'anthropic messages (ai sdk)',
  model: MODEL,
  nativeSchema: false,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new AnthropicSdkProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.test',
      model: MODEL,
      capabilities: {
        contextWindow: 200_000,
        structuredOutput: 'none',
        systemRole: false,
        streaming: true,
        costTier: 'premium',
        charsPerToken: 4,
        proseQuality: 0.9,
        steerability: 0.9,
        ...(capabilities as object),
      } as never,
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    id: 'msg_contract',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: over.text ?? 'a plain answer' }],
    stop_reason: over.finishReason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 4 },
  }),
  /**
   * A full Anthropic event sequence, because the SDK's parser tracks message
   * state across events: it needs `message_start` to carry an id before it will
   * accept a `content_block_delta`, and it needs `content_block_start` and
   * `message_stop` to close the message cleanly. A three-frame shortcut parses
   * as "no usage, no finish reason" rather than as an error.
   */
  frames: (over = {}) =>
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_contract',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: over.tokensIn ?? 11, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Once ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'upon ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a time' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: over.finishReason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: over.tokensOut ?? 4 },
      },
      { type: 'message_stop' },
    ].map((event) => JSON.stringify(event)),
};

describe('phase 3: anthropic ai sdk adapter', () => {
  runProviderContract(anthropicSdk);
});
