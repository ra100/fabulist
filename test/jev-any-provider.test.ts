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
import { byokEndpoint, byokProvider, providerErrorReason } from '../src/providers/byok.ts';
import { checkWithJev } from '../src/loop/jev-fastpath.ts';
import { redactEchoes } from '../src/loop/provider-telemetry.ts';
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

test('a provider with a typed API uses it, and one without falls back to chat', async () => {
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
    return byokProvider(endpoint, 'jev-1.13-free', () => 'sk-user', fetcher).complete(REQ);
  };

  await ask('openrouter');
  await ask('opencode-zen');
  await ask('groq');
  // Neither typed API is at the other one's depth, so these cannot be derived
  // from one another: OpenRouter's sits above its `/v1`, Zen's inside its own.
  // Go has no Jev model at all, so it stays on chat completions.
  assert.deepEqual(paths, ['/api/alpha/decisions', '/zen/v1/systemone', '/openai/v1/chat/completions']);
  assert.equal(typeof JevProvider, 'function');
  assert.notEqual(JevProvider, JevCompatProvider);
});

test('both typed APIs are recorded as fixed https URLs', () => {
  // A bare path would be wrong for one of them, so the allowlist carries the
  // whole URL and this checks it cannot be swapped for something user-supplied.
  for (const id of ['openrouter', 'opencode-zen']) {
    const typedUrl = byokEndpoint(id)?.typedUrl;
    assert.ok(typedUrl, `${id} has a typed API`);
    assert.match(typedUrl, /^https:\/\/[a-z0-9.-]+\.[a-z]+(\/[\w./-]*)?$/, id);
  }
  assert.equal(byokEndpoint('opencode-go')?.typedUrl, undefined, 'Go carries no Jev model');
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

test('a refusal is reported in the provider\'s own words, not as a bad key', async () => {
  // The whole point: a 403 from OpenCode Zen means the key is valid and simply
  // not allowed to call this from outside OpenCode. "rejected your API key"
  // would send someone to rotate a working credential.
  const cases: Array<[number, string, RegExp]> = [
    [403, '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}', /free tier can only be used from within OpenCode/],
    [402, '{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}', /Insufficient account funds/],
  ];
  for (const [status, body, expected] of cases) {
    const endpoint = byokEndpoint('opencode-zen')!;
    const fetcher = (async () => new Response(body, { status })) as unknown as typeof fetch;
    const provider = byokProvider(endpoint, 'jev-1.13', () => 'sk-user-0123456789abcdef', fetcher);
    await assert.rejects(provider.complete(REQ), expected, `status ${status}`);
  }
});

test('a refusal with no readable reason still falls back to the fixed copy', async () => {
  for (const [status, body] of [[401, '<html>gateway error</html>'], [429, 'not json at all']] as const) {
    const endpoint = byokEndpoint('opencode-zen')!;
    const fetcher = (async () => new Response(body, { status })) as unknown as typeof fetch;
    const provider = byokProvider(endpoint, 'jev-1.13', () => 'sk-user-0123456789abcdef', fetcher);
    await assert.rejects(provider.complete(REQ), /\(401\)|\(429\)/, `status ${status}`);
  }
});

test('a key echoed back by a provider is scrubbed out of the message', async () => {
  // Provider text is untrusted and this is the one path that shows it rather
  // than replacing it, so the key must not survive into the message.
  const key = 'sk-user-0123456789abcdef';
  const body = JSON.stringify({ error: { message: `bad key ${key} rejected` } });
  const endpoint = byokEndpoint('opencode-zen')!;
  const fetcher = (async () => new Response(body, { status: 401 })) as unknown as typeof fetch;
  const provider = byokProvider(endpoint, 'jev-1.13', () => key, fetcher);
  await assert.rejects(provider.complete(REQ), (err: Error) => {
    assert.ok(!err.message.includes(key), `key leaked: ${err.message}`);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test('the reason parser reads the two error shapes these gateways use', () => {
  // OpenCode nests under `error`, most others put `message` at the top.
  assert.equal(providerErrorReason('{"error":{"message":"nested"}}'), 'nested');
  assert.equal(providerErrorReason('{"message":"top level"}'), 'top level');
  assert.equal(providerErrorReason('plain text'), '');
  assert.equal(providerErrorReason(''), '');
  assert.equal(providerErrorReason('{"message":42}'), '');
  assert.equal(providerErrorReason('{"message":"key sk-abcdefghijklmnop is bad"}', ['sk-abcdefghijklmnop']), 'key [redacted] is bad');
});

test('a failed Jev call logs the status and the provider\'s reason, not just "Error"', async () => {
  // Anything but a key refusal used to be rewrapped as a bare Error, so a 400
  // for a bad model id logged as `errorKind: "Error"` with nothing else to go on.
  const key = 'sk-user-0123456789abcdef';
  const body = JSON.stringify({ error: { code: 400, message: `Model does not exist (key ${key})` } });
  const fetcher = (async () => new Response(body, { status: 400 })) as unknown as typeof fetch;
  const provider = byokProvider(byokEndpoint('openrouter')!, 'typesafe/jev-1.13', () => key, fetcher);
  const calls: Array<Record<string, unknown>> = [];
  const verdicts = await checkWithJev(
    { optionalProvider: () => provider, log: () => {}, onProviderCall: (call) => calls.push({ ...call }) },
    { rawInput: 'I copy the page.', refereeState: 'The scriptorium is open.' },
  );
  assert.deepEqual(verdicts, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.ok, false);
  assert.equal(calls[0]?.errorKind, 'ProviderHttpError');
  assert.equal(calls[0]?.errorStatus, 400);
  assert.equal(calls[0]?.errorDetail, 'Model does not exist (key [redacted])');
});

test('a Jev call that never reached the provider logs the network error code', async () => {
  const fetcher = (async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
  }) as unknown as typeof fetch;
  const provider = byokProvider(byokEndpoint('openrouter')!, 'typesafe/jev-1.13', () => 'sk-user', fetcher);
  const calls: Array<Record<string, unknown>> = [];
  await checkWithJev(
    { optionalProvider: () => provider, log: () => {}, onProviderCall: (call) => calls.push({ ...call }) },
    { rawInput: 'I copy the page.', refereeState: 'The scriptorium is open.' },
  );
  assert.equal(calls[0]?.errorDetail, 'fetch failed (ENOTFOUND)');
  assert.equal(calls[0]?.errorStatus, undefined);
});

test('a provider error that echoes the request logs its wording, not what was sent', async () => {
  const echoed = JSON.stringify({
    error: { message: 'Invalid value for state: "The Scriptorium is   OPEN." exceeds the limit' },
  });
  const fetcher = (async () => new Response(echoed, { status: 422 })) as unknown as typeof fetch;
  const provider = byokProvider(byokEndpoint('openrouter')!, 'typesafe/jev-1.13', () => 'sk-user', fetcher);
  const calls: Array<Record<string, unknown>> = [];
  await checkWithJev(
    { optionalProvider: () => provider, log: () => {}, onProviderCall: (call) => calls.push({ ...call }) },
    { rawInput: 'I copy the page.', refereeState: 'The scriptorium is open.' },
  );
  assert.equal(calls[0]?.errorStatus, 422);
  const detail = String(calls[0]?.errorDetail);
  assert.match(detail, /^Invalid value for state: "\[redacted\]" exceeds the limit$/);
  assert.doesNotMatch(detail, /scriptorium/i);
});

test('echo redaction leaves text the request never contained', () => {
  assert.equal(redactEchoes('Model does not exist', ['The scriptorium is open.']), 'Model does not exist');
  assert.equal(redactEchoes('saw: the scriptorium is open. done', ['The Scriptorium  is open.']), 'saw: [redacted] done');
});
