/**
 * The phase 0 baseline: the current hand-rolled adapters, held to the parity
 * contract in `provider-contract.ts`.
 *
 * These are the *definitions* only — the assertions live in the harness and
 * are shared with every replacement adapter that comes later. If a future SDK
 * adapter passes the same suite, that is the proof the transport changed and
 * the behaviour did not.
 */
import { describe } from 'node:test';
import { AnthropicProvider, OllamaProvider, OpenAICompatProvider } from '../../src/providers/http.ts';
import { BedrockProvider } from '../../src/providers/bedrock.ts';
import { VertexProvider } from '../../src/providers/google.ts';
import { AwsCredentialProvider } from '../../src/providers/aws.ts';
import { GoogleAuth } from '../../src/providers/google.ts';
import type { ProviderContract } from './provider-contract.ts';
import { runProviderContract } from './provider-contract.ts';

const MODEL = 'contract-model';

function caps(over: Record<string, unknown> = {}) {
  return {
    contextWindow: 64_000,
    structuredOutput: 'native-schema',
    systemRole: true,
    streaming: true,
    costTier: 'cheap',
    charsPerToken: 4,
    proseQuality: 0.5,
    steerability: 0.5,
    ...over,
  } as never;
}

/** The chunk sequence the streaming assertions expect, three pieces. */
const CHUNKS = ['Once ', 'upon ', 'a time'];

const openaiCompat: ProviderContract = {
  label: 'openai-compat (chat completions)',
  model: MODEL,
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new OpenAICompatProvider('openai', {
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
      model: MODEL,
      capabilities: caps({ ...(capabilities as object) }),
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    choices: [{ message: { content: over.text ?? 'a plain answer' }, finish_reason: over.finishReason ?? 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  }),
  frames: (over = {}) => [
    ...CHUNKS.map((content) => ({ choices: [{ delta: { content } }] })),
    ...(over.finishReason ? [{ choices: [{ delta: {}, finish_reason: over.finishReason }] }] : []),
    { choices: [], usage: { prompt_tokens: over.tokensIn ?? 11, completion_tokens: over.tokensOut ?? 4 } },
  ].map((event) => JSON.stringify(event)),
};

const anthropic: ProviderContract = {
  label: 'anthropic (messages)',
  model: MODEL,
  nativeSchema: false,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new AnthropicProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.test',
      model: MODEL,
      capabilities: caps({ structuredOutput: 'none', systemRole: false, ...(capabilities as object) }),
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    content: [{ type: 'text', text: over.text ?? 'a plain answer' }],
    stop_reason: over.finishReason ?? 'end_turn',
    usage: { input_tokens: 11, output_tokens: 4 },
  }),
  frames: (over = {}) => [
    { type: 'message_start', message: { usage: { input_tokens: over.tokensIn ?? 11 } } },
    ...CHUNKS.map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })),
    { type: 'message_delta', delta: { stop_reason: over.finishReason ?? 'end_turn' }, usage: { output_tokens: over.tokensOut ?? 4 } },
  ].map((event) => JSON.stringify(event)),
};

const ollama: ProviderContract = {
  label: 'ollama (ndjson stream)',
  model: MODEL,
  // Ollama passes a bare JSON Schema as `format`, which llama.cpp enforces with
  // a grammar — that is real constrained decoding, so the adapter's
  // `schemaEnforced: !!req.schema` is honest. It ignores the declared
  // `structuredOutput` mode, which is worth knowing but not a contract break.
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: MODEL,
      capabilities: caps({ structuredOutput: 'native-schema', ...(capabilities as object) }),
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    message: { content: over.text ?? 'a plain answer' },
    done_reason: over.finishReason === 'length' ? 'length' : 'stop',
    prompt_eval_count: 11,
    eval_count: 4,
  }),
  // Ollama streams newline-delimited JSON rather than SSE, so it declares its
  // own framing and gets held to the same streaming assertions.
  framing: 'ndjson',
  frames: (over = {}) =>
    [
      { message: { content: 'Once ' }, prompt_eval_count: over.tokensIn ?? 11 },
      { message: { content: 'upon ' } },
      { message: { content: 'a time' }, eval_count: over.tokensOut ?? 4, done_reason: over.finishReason ?? 'stop' },
    ].map((event) => JSON.stringify(event)),
};

/**
 * Bedrock and Vertex both need credentials before they will speak, so their
 * contracts inject a deterministic environment rather than reaching for the
 * developer's real AWS or Google config. The transport under test is unchanged
 * either way; only credential discovery is stubbed.
 */
const bedrock: ProviderContract = {
  label: 'bedrock (converse)',
  model: MODEL,
  // Forced tool use obliges the model to emit arguments matching the schema,
  // which is constrained decoding reached a different way.
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new BedrockProvider({
      modelId: MODEL,
      capabilities: caps({ ...(capabilities as object) }),
      credentials: new AwsCredentialProvider({
        env: { AWS_ACCESS_KEY_ID: 'AKIACONTRACT', AWS_SECRET_ACCESS_KEY: 'contractsecret', AWS_REGION: 'us-east-1' },
        readFile: () => null,
        listDir: () => [],
        fetcher,
        run: async () => '',
        now: () => new Date(),
      }),
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    output: { message: { role: 'assistant', content: [{ text: over.text ?? 'a plain answer' }] } },
    usage: { inputTokens: 11, outputTokens: 4 },
    stopReason: over.finishReason ?? 'end_turn',
  }),
  structuredBody: () => ({
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { name: 'contract_probe', input: { verdict: 'yes' } } }],
      },
    },
    usage: { inputTokens: 11, outputTokens: 4 },
    stopReason: 'tool_use',
  }),
  structuredValue: { verdict: 'yes' },
  framing: 'aws-eventstream',
  frames: (over = {}) => [
    { delta: { text: 'Once ' }, usage: { inputTokens: over.tokensIn ?? 11 } },
    { delta: { text: 'upon ' } },
    { delta: { text: 'a time' }, usage: { outputTokens: over.tokensOut ?? 4 }, stopReason: over.finishReason ?? 'end_turn' },
  ].map((event) => JSON.stringify(event)),
};

/** Vertex needs an access token; this answers the refresh call without a network. */
function googleAuth(): GoogleAuth {
  return new GoogleAuth({
    env: { GOOGLE_CLOUD_PROJECT: 'contract-project' },
    readFile: (path) =>
      path.includes('application_default_credentials.json')
        ? JSON.stringify({
            type: 'authorized_user',
            client_id: 'cid',
            client_secret: 'csecret',
            refresh_token: 'rtoken',
          })
        : null,
    fetcher: (async () =>
      new Response(JSON.stringify({ access_token: 'contract-token', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    run: async () => '',
    now: () => new Date(),
  });
}

const vertex: ProviderContract = {
  label: 'vertex (gemini generateContent)',
  model: MODEL,
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new VertexProvider({
      model: MODEL,
      capabilities: caps({ ...(capabilities as object) }),
      auth: googleAuth(),
      project: 'contract-project',
      location: 'us-central1',
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    candidates: [
      {
        content: { parts: [{ text: over.text ?? 'a plain answer' }] },
        // Gemini reports STOP / MAX_TOKENS, not OpenAI's stop / length.
        finishReason: over.finishReason === 'length' ? 'MAX_TOKENS' : 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
  }),
  frames: (over = {}) => [
    { candidates: [{ content: { parts: [{ text: 'Once ' }] } }], usageMetadata: { promptTokenCount: over.tokensIn ?? 11 } },
    { candidates: [{ content: { parts: [{ text: 'upon ' }] } }] },
    {
      candidates: [
        {
          content: { parts: [{ text: 'a time' }] },
          finishReason: over.finishReason === 'length' ? 'MAX_TOKENS' : 'STOP',
        },
      ],
      usageMetadata: { candidatesTokenCount: over.tokensOut ?? 4 },
    },
  ].map((event) => JSON.stringify(event)),
};

describe('phase 0 baseline', () => {
  runProviderContract(openaiCompat);
  runProviderContract(anthropic);
  runProviderContract(ollama);
  runProviderContract(bedrock);
  runProviderContract(vertex);
});