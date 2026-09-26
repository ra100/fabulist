import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYOK_ENDPOINTS,
  ProviderKeyLockedError,
  byokEndpoint,
  byokProvider,
  listModels,
  scrubSecrets,
} from '../src/providers/byok.ts';
import type { CompletionRequest } from '../src/providers/provider.ts';

const ask: CompletionRequest = { role: 'narrate', messages: [{ role: 'user', content: 'hello' }] };

function spyFetch(status: number, body: unknown, text = '') {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    return { ok: status < 400, status, json: async () => body, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test('the allowlist is exactly the spec providers, all fixed https bases, only Anthropic native', () => {
  assert.deepEqual(
    BYOK_ENDPOINTS.map((e) => e.id),
    [
      'openai',
      'anthropic',
      'gemini',
      'mistral',
      'deepseek',
      'xai',
      'groq',
      'cerebras',
      'together',
      'fireworks',
      'openrouter',
      'kilo',
    ],
  );
  for (const e of BYOK_ENDPOINTS) {
    assert.match(e.baseUrl, /^https:\/\/[a-z0-9.-]+\.[a-z]+(\/[\w./-]*)?$/, e.id);
    assert.equal(e.baseUrl.endsWith('/'), false, e.id);
    assert.equal(e.kind, e.id === 'anthropic' ? 'anthropic' : 'openai-compat', e.id);
  }
  assert.equal(byokEndpoint('localhost'), undefined);
});

test('an openai-compatible key is read per call and sent as a bearer token to the fixed base', async () => {
  const { fetcher, seen } = spyFetch(200, {
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  let key = 'sk-first-0123456789abcdef';
  const provider = byokProvider(byokEndpoint('groq')!, 'llama-test', () => key, fetcher);
  const result = await provider.complete(ask);
  key = 'sk-second-0123456789abcdef';
  await provider.complete(ask);
  assert.equal(provider.id, 'groq');
  assert.equal(result.tokensIn, 3);
  assert.equal(seen[0]?.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen[0]?.headers.authorization, 'Bearer sk-first-0123456789abcdef');
  assert.equal(seen[1]?.headers.authorization, 'Bearer sk-second-0123456789abcdef');
});

test('an Anthropic key goes in x-api-key to the Messages API', async () => {
  const { fetcher, seen } = spyFetch(200, { content: [{ text: 'hi' }], usage: { input_tokens: 4, output_tokens: 2 } });
  const provider = byokProvider(byokEndpoint('anthropic')!, 'claude-test', () => 'sk-ant-0123456789abcdef', fetcher);
  assert.equal((await provider.complete(ask)).tokensOut, 2);
  assert.equal(seen[0]?.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0]?.headers['x-api-key'], 'sk-ant-0123456789abcdef');
});

test('a provider error body echoing the key is scrubbed before it surfaces', async () => {
  const key = 'zz-custom-secret-value-42';
  const { fetcher } = spyFetch(
    401,
    {},
    `{"error":"invalid key ${key}","hint":"Bearer ${key}","other":"sk-proj-abcdefghijklmnop1234"}`,
  );
  const provider = byokProvider(byokEndpoint('openai')!, 'gpt-test', () => key, fetcher);
  await assert.rejects(provider.complete(ask), (err: Error) => {
    assert.doesNotMatch(err.message, /zz-custom-secret-value-42|sk-proj-/);
    assert.match(err.message, /returned 401/);
    return true;
  });
});

test('a locked key never reaches the network and keeps its error type', async () => {
  const { fetcher, seen } = spyFetch(200, {});
  const provider = byokProvider(
    byokEndpoint('openai')!,
    'gpt-test',
    () => {
      throw new ProviderKeyLockedError();
    },
    fetcher,
  );
  await assert.rejects(provider.complete(ask), ProviderKeyLockedError);
  assert.equal(seen.length, 0);
});

test('scrubbing keeps ordinary text and removes exact and key-shaped secrets', () => {
  assert.equal(scrubSecrets('model gpt-4o-mini not found'), 'model gpt-4o-mini not found');
  const out = scrubSecrets(
    'bad my-weird-custom-secret-1 AIzaSyA1234567890abcdefghijklmnopq xai-abcdefghijklmnopqrstu',
    ['my-weird-custom-secret-1'],
  );
  assert.doesNotMatch(out, /my-weird-custom-secret-1|AIza|xai-abc/);
});

test('model listing returns sorted ids and degrades to an empty list', async () => {
  const ok = spyFetch(200, { data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 7 }] });
  assert.deepEqual(await listModels(byokEndpoint('openrouter')!, 'sk-or-0123456789abcdef', ok.fetcher), ['m-a', 'm-b']);
  assert.equal(ok.seen[0]?.url, 'https://openrouter.ai/api/v1/models');
  const anthropic = spyFetch(200, { data: [{ id: 'claude-x' }] });
  await listModels(byokEndpoint('anthropic')!, 'sk-ant-0123456789abcdef', anthropic.fetcher);
  assert.equal(anthropic.seen[0]?.url, 'https://api.anthropic.com/v1/models');
  assert.deepEqual(await listModels(byokEndpoint('openai')!, 'bad', spyFetch(401, {}).fetcher), []);
});
