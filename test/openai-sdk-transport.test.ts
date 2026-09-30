/**
 * Phase 1 opt-in: the SDK transport is available but not the default.
 *
 * Issue #166. The point of these tests is that turning it on is a single field
 * and turning it back off is deleting it — and that a user's key is read per
 * call rather than captured at construction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenAICompatProvider,
  PRESETS,
  TRANSPORT_DECISION_TABLE,
  buildProvider,
  caps,
  resolveTransport,
} from '../src/providers/http.ts';
import { OpenAISdkProvider } from '../src/providers/openai-sdk.ts';
import { AnthropicSdkProvider } from '../src/providers/anthropic-sdk.ts';
import { AnthropicProvider } from '../src/providers/http.ts';
import type { ProviderSpec } from '../src/providers/http.ts';
import { scrubSecrets } from '../src/providers/byok.ts';

const ENV: Record<string, string> = { OPENAI_API_KEY: 'sk-live-0123456789abcdefghij' };

function spec(over: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    kind: 'openai-compat',
    model: 'gpt-4o',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    ...over,
  };
}

/** Records requests so header and body assertions need no network. */
function spyFetch(response: unknown) {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const COMPLETION = {
  id: 'chatcmpl-test',
  model: 'gpt-4o',
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

// ------------------------------------------------------------ the switch

// -------------------------------------------------------- the decision table

test('a dialect always keeps the hand-rolled transport', () => {
  // The whole point of `dialect` is to record "OpenAI-shaped but not
  // OpenAI-behaved", so it is the one signal that overrides the default.
  for (const dialect of ['vllm', 'llamacpp'] as const) {
    assert.equal(resolveTransport({ dialect }), 'legacy', dialect);
    const provider = buildProvider(spec({ dialect }), ENV);
    assert.ok(provider instanceof OpenAICompatProvider, `${dialect} keeps its own shaping`);
  }
});

test('a standard endpoint uses the AI SDK adapter by default', () => {
  assert.equal(resolveTransport({}), 'sdk');
  const provider = buildProvider(spec(), ENV);
  assert.ok(provider instanceof OpenAISdkProvider);
  assert.equal(provider.id, 'gpt-4o', 'the same id the legacy adapter derives, so routing and attribution are untouched');
  assert.equal(provider.model, 'gpt-4o');
});

test('every shipped preset routes to the transport the table says', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.kind !== 'openai-compat') continue;
    const expected = preset.dialect ? 'legacy' : 'sdk';
    assert.equal(resolveTransport(preset, {}), expected, key);
    assert.equal(preset.transport, undefined, `${key} pins no transport, so the table stays in charge`);
  }
});

test('the decision table covers every openai-compat target in the presets', () => {
  const classes = new Set(TRANSPORT_DECISION_TABLE.map((row) => row.transport));
  assert.equal(classes.size, 2, 'both transports are represented');
  for (const row of TRANSPORT_DECISION_TABLE) assert.ok(row.why.length > 20, `${row.class} explains itself`);
});

test('every preset still builds, on whichever transport it decided', () => {
  // The migration must not leave a preset that only one transport can construct.
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.kind === 'jev') continue;
    const env = { ...ENV };
    if (preset.apiKeyEnv) env[preset.apiKeyEnv] = env[preset.apiKeyEnv] ?? 'sk-test-0123456789abcdef';
    // Copilot's own acknowledgement gate, which the migration does not touch.
    const provider = buildProvider({ ...preset, allowUnofficial: true }, env);
    assert.ok(provider.id, key);
  }
});

// ------------------------------------------------------------ the rollback

test('a single spec can roll back to the hand-rolled adapter', () => {
  assert.equal(resolveTransport({ transport: 'legacy' }), 'legacy');
  assert.ok(buildProvider(spec({ transport: 'legacy' }), ENV) instanceof OpenAICompatProvider);
});

test('the operator-wide switch rolls every compatible target back at once', () => {
  // The incident lever: one env var, no config rewrite, no per-target edits.
  assert.equal(resolveTransport({}, { FABULIST_PROVIDER_TRANSPORT: 'legacy' }), 'legacy');
  assert.ok(buildProvider(spec(), { ...ENV, FABULIST_PROVIDER_TRANSPORT: 'legacy' }) instanceof OpenAICompatProvider);
  assert.equal(resolveTransport({}, { FABULIST_PROVIDER_TRANSPORT: 'sdk' }), 'sdk');
});

test('an explicit transport beats the operator-wide switch', () => {
  // Otherwise the rollback could not be undone for one target without an edit.
  assert.equal(resolveTransport({ transport: 'sdk' }, { FABULIST_PROVIDER_TRANSPORT: 'legacy' }), 'sdk');
});

test('transport sdk still refuses a dialect rather than sending a shape the endpoint ignores', () => {
  for (const dialect of ['vllm', 'llamacpp'] as const) {
    assert.throws(
      () => buildProvider(spec({ transport: 'sdk', dialect }), ENV),
      new RegExp(`does not support the ${dialect} dialect`),
    );
  }
});

// --------------------------------------------------------- credentials

test('the SDK adapter reads a per-user key at call time, not at construction', async () => {
  const keys = ['sk-live-first-0123456789', 'sk-live-second-0123456789'];
  let turn = 0;
  const { fetcher, seen } = spyFetch(COMPLETION);
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: () => keys[Math.min(turn++, keys.length - 1)]!,
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps({ structuredOutput: 'native-schema' }),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'a' }] });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'b' }] });

  assert.equal(seen[0]?.headers.authorization, `Bearer ${keys[0]}`);
  assert.equal(seen[1]?.headers.authorization, `Bearer ${keys[1]}`, 'a lock between calls stops the second');
});

test('a refusal carries neither the key nor the prompt', async () => {
  // `APICallError` holds both. The prompt is never quoted into the message and
  // the key is scrubbed before the body is kept, so neither can reach a log.
  const key = 'sk-live-0123456789abcdefghij';
  const secretLine = 'the wardens spoke of Marta and the iron gate';
  const fetcher = (async () => new Response(`bad key ${key}`, { status: 401 })) as unknown as typeof fetch;
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: key,
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps(),
    fetcher,
  });

  await assert.rejects(
    () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: secretLine }] }),
    (err: Error) => {
      assert.doesNotMatch(err.message, /sk-live-0123456789abcdefghij/, 'the key is redacted');
      assert.doesNotMatch(err.message, /wardens/, 'the prompt is never echoed');
      assert.match(err.message, /401/, 'and the status survives, which is what BYOK branches on');
      assert.equal(scrubSecrets(err.message, [key]), err.message, 'so the outer gate has nothing left to do');
      return true;
    },
  );
});

test('the SDK adapter raises the error BYOK branches on', async () => {
  // `byok.ts` decides "your key was rejected" vs "we are down" purely from
  // `status` and `body`. An adapter that threw a different error class would
  // turn a rate limit into a support ticket.
  const fetcher = (async () => new Response('{"error":{"message":"quota"}}', { status: 429 })) as unknown as typeof fetch;
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: 'sk-test-0123456789',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps(),
    fetcher,
  });

  await assert.rejects(
    () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] }),
    (err: Error & { status?: number; body?: string }) => {
      assert.equal(err.name, 'ProviderHttpError');
      assert.equal(err.status, 429);
      assert.match(err.body ?? '', /quota/, 'the body survives for providerErrorReason');
      assert.ok((err.body ?? '').length <= 300, 'and stays bounded');
      return true;
    },
  );
});

// ------------------------------------------------------ request shaping

test('a provider with no constrained decoding is sent no response_format', async () => {
  const { fetcher, seen } = spyFetch({ ...COMPLETION, choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: 'sk-test-0123456789',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps({ structuredOutput: 'none' }),
    fetcher,
  });

  const res = await provider.complete({
    role: 'extract',
    messages: [{ role: 'user', content: 'x' }],
    schema: { name: 'probe', schema: { type: 'object', properties: { a: { type: 'string' } } } },
  });

  assert.equal(seen[0]?.body.response_format, undefined);
  assert.equal(res.schemaEnforced, false);
});

test('json-mode asks for valid JSON without claiming schema conformance', async () => {
  const { fetcher, seen } = spyFetch({ ...COMPLETION, choices: [{ message: { content: '{"a":"b"}' }, finish_reason: 'stop' }] });
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: 'sk-test-0123456789',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps({ structuredOutput: 'json-mode' }),
    fetcher,
  });

  const res = await provider.complete({
    role: 'extract',
    messages: [{ role: 'user', content: 'x' }],
    schema: { name: 'probe', schema: { type: 'object', properties: { a: { type: 'string' } } } },
  });

  assert.equal(res.schemaEnforced, false, 'json-mode guarantees valid JSON, not the right shape');
  assert.equal(res.text, '{"a":"b"}');
  assert.notEqual(seen[0]?.body.response_format, undefined);
});

test('the adapter does not retry, so one call costs one call', async () => {
  let attempts = 0;
  const fetcher = (async () => {
    attempts++;
    return new Response('busy', { status: 503 });
  }) as unknown as typeof fetch;
  const provider = new OpenAISdkProvider({
    id: 'openai',
    apiKey: 'sk-test-0123456789',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-4o',
    capabilities: caps(),
    fetcher,
  });

  await assert.rejects(() => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(attempts, 1, 'retry policy belongs to the caller, not the transport');
});

// ------------------------------------------------------------- anthropic

test('anthropic routes to the SDK adapter by default and can roll back', () => {
  assert.equal(resolveTransport({}), 'sdk', 'anthropic declares no dialect, so the default applies');
  const spec: ProviderSpec = {
    kind: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  };
  const env = { ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef' };
  assert.ok(buildProvider(spec, env) instanceof AnthropicSdkProvider);
  assert.ok(buildProvider({ ...spec, transport: 'legacy' }, env) instanceof AnthropicProvider);
  assert.ok(
    buildProvider(spec, { ...env, FABULIST_PROVIDER_TRANSPORT: 'legacy' }) instanceof AnthropicProvider,
    'the operator-wide rollback reaches anthropic too',
  );
});

test('the anthropic preset builds on the SDK adapter without changing its id or model', () => {
  const provider = buildProvider(PRESETS['anthropic:sonnet']!, { ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef' });
  assert.equal(provider.id, 'anthropic');
  assert.equal(provider.model, 'claude-sonnet-4-20250514');
  assert.ok(provider instanceof AnthropicSdkProvider);
});

test('an anthropic key still travels in x-api-key, never as a bearer token', async () => {
  const { fetcher, seen } = spyFetch({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const provider = new AnthropicSdkProvider({
    apiKey: 'sk-ant-0123456789abcdef',
    baseUrl: 'https://api.anthropic.test',
    model: 'm',
    capabilities: caps({ structuredOutput: 'none' }),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(seen[0]?.headers['x-api-key'], 'sk-ant-0123456789abcdef');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.doesNotMatch(seen[0]?.headers['x-api-key'] ?? '', /resolved-per-request/, 'the placeholder never reaches the wire');
});

test('the system prompt stays a top-level field, not a message', async () => {
  const { fetcher, seen } = spyFetch({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const provider = new AnthropicSdkProvider({
    apiKey: 'sk-ant-0123456789abcdef',
    baseUrl: 'https://api.anthropic.test',
    model: 'm',
    capabilities: caps({ structuredOutput: 'none' }),
    fetcher,
  });

  await provider.complete({
    role: 'narrate',
    messages: [
      { role: 'system', content: 'SYS-A' },
      { role: 'system', content: 'SYS-B' },
      { role: 'user', content: 'U' },
    ],
  });

  // Anthropic takes the system prompt as a top-level content block rather than a
  // message, and joined with a blank line — the same text the hand-rolled
  // adapter sent, in the block form this API documents.
  const system = seen[0]?.body.system as Array<{ text: string }>;
  assert.equal(system.map((block) => block.text).join(''), 'SYS-A\n\nSYS-B');
  assert.doesNotMatch(JSON.stringify(seen[0]?.body.messages), /SYS-A/, 'and it is not carried as a message');
});

test('a provider with no constrained decoding still gets the prefilled brace', async () => {
  // Anthropic's preset is `structuredOutput: 'none'`, and forcing tool use onto
  // a model documented to reject it is worse than the brace trick.
  const { fetcher, seen } = spyFetch({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'm',
    // The model continues the prefilled `{`, so it emits the rest of the object
    // and closes it itself — the adapter only restores the opening brace.
    content: [{ type: 'text', text: '"verdict":"yes"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const provider = new AnthropicSdkProvider({
    apiKey: 'sk-ant-0123456789abcdef',
    baseUrl: 'https://api.anthropic.test',
    model: 'm',
    capabilities: caps({ structuredOutput: 'none' }),
    fetcher,
  });

  const res = await provider.complete({
    role: 'extract',
    messages: [{ role: 'user', content: 'x' }],
    schema: { name: 'probe', schema: { type: 'object', properties: { verdict: { type: 'string' } } } },
  });

  const messages = seen[0]?.body.messages as Array<{ role: string; content: Array<{ text: string }> }>;
  assert.equal(messages.at(-1)?.role, 'assistant');
  assert.equal(messages.at(-1)?.content.map((block) => block.text).join(''), '{');
  assert.equal(res.text, '{"verdict":"yes"}', 'the parser sees a whole object');
  assert.equal(res.schemaEnforced, false, 'Fabulist validates it, not the provider');
  assert.equal(seen[0]?.body.tools, undefined, 'and no tool use was forced');
});
