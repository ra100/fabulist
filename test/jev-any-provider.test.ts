/**
 * The Jev fast path on providers with no typed-decision API.
 *
 * OpenRouter keeps a dedicated adapter because it has `/alpha/decisions`,
 * which returns *calibrated* probabilities. Every other provider is asked the
 * same questions over chat completions, and a model asked for a confidence
 * returns its own say-so. That difference is the whole reason this is a
 * separate file rather than a line removed from a guard: the questions and the
 * cutoffs are identical, but the number on the far side is not the same number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevCompatProvider, JevProvider, caps } from '../src/providers/http.ts';
import { byokEndpoint, byokProvider } from '../src/providers/byok.ts';
import { checkWithJev } from '../src/loop/jev-fastpath.ts';
import { jevTestCapabilities } from './jev-fixtures.ts';
import type { CompletionRequest, CompletionResult } from '../src/providers/provider.ts';

const REQ: CompletionRequest = {
  role: 'jev-fastpath',
  messages: [{ role: 'user', content: 'state text' }],
  temperature: 0,
  schema: {
    name: 'jev_fast_checks',
    schema: {
      type: 'object',
      properties: {
        referee: {
          instructions: 'Allow only when there is no cost.',
          criteria: { clear_no_cost_allow: 'No cost', full_referee_review: 'Anything else' },
        },
      },
    },
  },
};

const CLEAR = {
  answers: { referee: { choice: 'clear_no_cost_allow', probabilities: { clear_no_cost_allow: 0.999 } } },
};

/** A chat endpoint that records the request and replies with `body`. */
function chatServer(body: unknown) {
  const seen: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    seen.push({ url: String(url), payload });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const capsNone = caps({ structuredOutput: 'none' });

test('a non-OpenRouter provider asks the same question as an answer, not as a typed decision', async () => {
  const { fetcher, seen } = chatServer(CLEAR);
  const provider = new JevCompatProvider('opencode-zen', {
    apiKey: 'sk-user',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher,
  });
  await provider.complete(REQ);

  const call = seen[0];
  // Chat completions, never the typed endpoint: `/alpha/decisions` 404s on
  // every gateway but OpenRouter, so pointing it elsewhere would just 404.
  assert.equal(call?.url, 'https://opencode.ai/zen/v1/chat/completions');
  const messages = call?.payload.messages as Array<{ role: string; content: string }>;
  const last = messages[messages.length - 1]?.content ?? '';
  assert.match(last, /clear_no_cost_allow/, 'the criteria reach the model as prose');
  assert.match(last, /no cost/i);
  // The schema asks for an answer envelope, not the question it was given.
  const schema = (call?.payload.response_format as { json_schema?: { schema?: unknown } } | undefined)?.json_schema
    ?.schema as { properties?: { answers?: { properties?: Record<string, unknown> } } };
  const referee = schema?.properties?.answers?.properties?.referee as
    | { properties?: { choice?: { enum?: string[] } } }
    | undefined;
  assert.deepEqual(referee?.properties?.choice?.enum, ['clear_no_cost_allow', 'full_referee_review']);
  assert.equal(call?.payload.response_format && (call.payload.response_format as { type: string }).type, 'json_schema');
});

test('a provider that honours no schema at all still gets json_object rather than prose', async () => {
  const { fetcher, seen } = chatServer(CLEAR);
  const provider = new JevCompatProvider('groq', {
    apiKey: 'sk-user',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'jev-1.13',
    capabilities: capsNone,
    fetcher,
  });
  assert.equal(provider.capabilities.structuredOutput, 'json-mode');
  await provider.complete(REQ);
  assert.equal(seen[0]?.payload.response_format && (seen[0]!.payload.response_format as { type: string }).type, 'json_object');
});

test('it never claims the answer was schema-enforced, because nothing constrained it', async () => {
  const { fetcher } = chatServer(CLEAR);
  const provider = new JevCompatProvider('opencode-go', {
    apiKey: 'sk-user',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher,
  });
  const result: CompletionResult = await provider.complete(REQ);
  assert.equal(result.schemaEnforced, false, 'a chat model agreeing is not constrained decoding');
});

test('the same cutoffs apply, so an uncertain answer still falls back to full review', async () => {
  const uncertain = chatServer({
    answers: { referee: { choice: 'clear_no_cost_allow', probabilities: { clear_no_cost_allow: 0.9 } } },
  });
  const provider = new JevCompatProvider('opencode-zen', {
    apiKey: 'sk-user',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher: uncertain.fetcher,
  });
  const verdicts = await checkWithJev({ optionalProvider: () => provider, log: () => {} }, {
    rawInput: 'Maybe.',
    refereeState: 'Uncertain.',
  });
  assert.deepEqual(verdicts, {}, '0.9 is below the 0.995 referee cutoff, exactly as for the typed API');
});

test('a confident answer clears the fast path on a non-OpenRouter provider', async () => {
  const clear = chatServer(CLEAR);
  const provider = new JevCompatProvider('opencode-zen', {
    apiKey: 'sk-user',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher: clear.fetcher,
  });
  const verdicts = await checkWithJev({ optionalProvider: () => provider, log: () => {} }, {
    rawInput: 'I carefully copy the page.',
    refereeState: 'The scriptorium is open.',
  });
  assert.deepEqual(verdicts, { referee: true });
});

test('OpenRouter keeps the typed adapter, on the path that actually exists', async () => {
  const paths: string[] = [];
  const fetcher = (async (url: string) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify(CLEAR), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const ask = async (endpointId: string) => {
    const endpoint = byokEndpoint(endpointId);
    assert.ok(endpoint, endpointId);
    return byokProvider(endpoint, 'jev-1.13', () => 'sk-user', fetcher).complete(REQ);
  };

  await ask('openrouter');
  await ask('opencode-zen');
  // Not `/api/v1/alpha/decisions`, which is a 404 — the allowlist base carries
  // `/v1` for /models and /chat/completions, but the typed API is one level up.
  assert.deepEqual(paths, ['/api/alpha/decisions', '/zen/v1/chat/completions']);
  assert.equal(typeof JevProvider, 'function');
  assert.notEqual(JevProvider, JevCompatProvider);
});

test('a provider with no questions is rejected rather than sent an empty decision', async () => {
  const { fetcher } = chatServer(CLEAR);
  const provider = new JevCompatProvider('opencode-zen', {
    apiKey: 'sk-user',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher,
  });
  await assert.rejects(provider.complete({ ...REQ, schema: { name: 'x', schema: { type: 'object' } } }), /at least one/);
});
