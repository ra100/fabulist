/**
 * Phase 1 opt-in: the SDK transport is available but not the default.
 *
 * Issue #166. The point of these tests is that turning it on is a single field
 * and turning it back off is deleting it — and that a user's key is read per
 * call rather than captured at construction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatProvider, PRESETS, buildProvider, caps } from '../src/providers/http.ts';
import { OpenAISdkProvider } from '../src/providers/openai-sdk.ts';
import type { ProviderSpec } from '../src/providers/http.ts';
import { scrubSecrets } from '../src/providers/byok.ts';

const ENV = { OPENAI_API_KEY: 'sk-live-0123456789abcdefghij' };

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

test('openai-compat keeps the hand-rolled transport unless asked otherwise', () => {
  const provider = buildProvider(spec(), ENV);
  assert.ok(provider instanceof OpenAICompatProvider, 'default is unchanged, so the rollback path is deleting one field');
  assert.ok(!(provider instanceof OpenAISdkProvider));
});

test('transport sdk opts a single spec onto the AI SDK adapter', () => {
  const provider = buildProvider(spec({ transport: 'sdk' }), ENV);
  assert.ok(provider instanceof OpenAISdkProvider);
  assert.equal(provider.id, 'gpt-4o', 'the same id the legacy adapter derives, so routing and attribution are untouched');
  assert.equal(provider.model, 'gpt-4o');
});

test('transport sdk refuses a dialect rather than sending a shape the endpoint ignores', () => {
  for (const dialect of ['vllm', 'llamacpp'] as const) {
    assert.throws(
      () => buildProvider(spec({ transport: 'sdk', dialect }), ENV),
      new RegExp(`does not support the ${dialect} dialect`),
    );
  }
});

test('every preset builds identically with transport unset', () => {
  // The opt-in is additive: no shipped preset names it, so nothing a user has
  // already configured changes shape.
  for (const [key, preset] of Object.entries(PRESETS)) {
    assert.equal(preset.transport, undefined, `${key} does not opt in`);
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
      assert.doesNotMatch(err.message, new RegExp(key), 'the key is redacted');
      assert.doesNotMatch(err.message, new RegExp('wardens'), 'the prompt is never echoed');
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
