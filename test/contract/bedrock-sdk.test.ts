/**
 * Phase 4: the phase 0 contract, run against the Bedrock SDK adapter.
 *
 * Credentials are injected through Fabulist's own resolver, so this exercises
 * the real precedence path — only the AWS config it reads is stubbed.
 */
import { describe } from 'node:test';
import { BedrockSdkProvider } from '../../src/providers/bedrock-sdk.ts';
import { AwsCredentialProvider } from '../../src/providers/aws.ts';
import type { ProviderContract } from './provider-contract.ts';
import { runProviderContract } from './provider-contract.ts';

const MODEL = 'contract-model';

function stubCredentials(fetcher: typeof fetch) {
  return new AwsCredentialProvider({
    env: {
      AWS_ACCESS_KEY_ID: 'AKIACONTRACT',
      AWS_SECRET_ACCESS_KEY: 'contractsecret',
      AWS_SESSION_TOKEN: 'contract-session',
      AWS_REGION: 'us-east-1',
    },
    readFile: () => null,
    listDir: () => [],
    fetcher,
    run: async () => '',
    now: () => new Date(),
  });
}

const bedrockSdk: ProviderContract = {
  label: 'bedrock converse (ai sdk)',
  model: MODEL,
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new BedrockSdkProvider({
      modelId: MODEL,
      capabilities: {
        contextWindow: 200_000,
        structuredOutput: 'native-schema',
        systemRole: false,
        streaming: true,
        costTier: 'premium',
        charsPerToken: 4,
        proseQuality: 0.9,
        steerability: 0.9,
        ...(capabilities as object),
      } as never,
      credentials: stubCredentials(fetcher),
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    output: { message: { role: 'assistant', content: [{ text: over.text ?? 'a plain answer' }] } },
    // `totalTokens` is required by the SDK's response schema, though
    // Fabulist never reads it.
    usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    stopReason: over.finishReason === 'length' ? 'max_tokens' : 'end_turn',
  }),
  structuredBody: () => ({
    output: {
      message: {
        role: 'assistant',
        // Forced tool use in this provider's `jsonTool` mode always names the
        // tool `json`, not the schema's name — an SDK implementation detail that
        // Fabulist does not depend on, since it validates the parsed object.
        content: [{ toolUse: { toolUseId: 'tooluse_contract', name: 'json', input: { verdict: 'yes' } } }],
      },
    },
    usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    stopReason: 'tool_use',
  }),
  structuredValue: { verdict: 'yes' },
  framing: 'aws-eventstream',
  /**
   * ConverseStream frames differ from the flat shape `readAwsEventStream` in
   * `src/providers/stream.ts` parses in two ways, and both fail silently rather
   * than loudly: each frame needs an `:event-type` header, and the payload must
   * be the *bare* event object, because the SDK wraps it as
   * `{ [eventType]: parsed }` itself. Pre-wrapping produces an empty stream
   * with no error at all.
   */
  frames: (over = {}) => [
    { event: 'contentBlockDelta', data: { contentBlockIndex: 0, delta: { text: 'Once ' } } },
    { event: 'contentBlockDelta', data: { contentBlockIndex: 0, delta: { text: 'upon ' } } },
    { event: 'contentBlockDelta', data: { contentBlockIndex: 0, delta: { text: 'a time' } } },
    { event: 'contentBlockStop', data: { contentBlockIndex: 0 } },
    { event: 'messageStop', data: { stopReason: over.finishReason === 'length' ? 'max_tokens' : 'end_turn' } },
    {
      event: 'metadata',
      data: { usage: { inputTokens: over.tokensIn ?? 11, outputTokens: over.tokensOut ?? 4, totalTokens: 15 } },
    },
  ],
};

describe('phase 4: bedrock ai sdk adapter', () => {
  runProviderContract(bedrockSdk);
});
