import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, OllamaProvider, OpenAICompatProvider, buildProvider, PRESETS } from '../src/providers/http.ts';
import { adaptRequest, type ProviderCapabilities } from '../src/providers/provider.ts';
import { buildRegistry, defaultConfig } from '../src/config/config.ts';

function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    contextWindow: 64_000,
    structuredOutput: 'native-schema',
    systemRole: true,
    streaming: false,
    costTier: 'cheap',
    charsPerToken: 4,
    proseQuality: 0.5,
    steerability: 0.5,
    ...over,
  };
}

/** Captures the outgoing request so we can assert on the wire format. */
function spyFetch(response: unknown) {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return { ok: true, status: 200, json: async () => response, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const schema = { name: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } } };

// ------------------------------------------------------- request adaptation

test('a provider without a system role gets it folded into the first message', () => {
  const req = adaptRequest(
    { role: 'x', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }] },
    caps({ systemRole: false }),
  );
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0]?.role, 'user');
  assert.match(req.messages[0]!.content, /SYS[\s\S]*USER/);
});

test('a provider with no structured output gets an explicit JSON instruction', () => {
  const req = adaptRequest(
    { role: 'x', messages: [{ role: 'user', content: 'hi' }], schema },
    caps({ structuredOutput: 'none' }),
  );
  assert.equal(req.messages.length, 2);
  assert.match(req.messages[1]!.content, /single JSON object/);
});

test('a schema-capable provider gets no extra instruction', () => {
  const req = adaptRequest(
    { role: 'x', messages: [{ role: 'user', content: 'hi' }], schema },
    caps({ structuredOutput: 'native-schema' }),
  );
  assert.equal(req.messages.length, 1, 'constrained decoding does the work instead');
});

// ------------------------------------------------------------ openai-compat

test('openai-compat sends json_schema only when natively supported', async () => {
  const { fetcher, seen } = spyFetch({ choices: [{ message: { content: '{"a":"b"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const p = new OpenAICompatProvider('openai', {
    apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', capabilities: caps(), fetcher,
  });
  const res = await p.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema });

  assert.equal(res.text, '{"a":"b"}');
  assert.equal(res.tokensIn, 5);
  assert.equal(res.schemaEnforced, true);
  assert.equal((seen[0]!.body.response_format as { type: string }).type, 'json_schema');
  assert.match(seen[0]!.headers.authorization!, /^Bearer k$/);
});

test('openai-compat degrades to json_object when that is all there is', async () => {
  const { fetcher, seen } = spyFetch({ choices: [{ message: { content: '{}' } }] });
  const p = new OpenAICompatProvider('x', {
    apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm',
    capabilities: caps({ structuredOutput: 'json-mode' }), fetcher,
  });
  const res = await p.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema });
  assert.equal((seen[0]!.body.response_format as { type: string }).type, 'json_object');
  assert.equal(res.schemaEnforced, false, 'json-mode guarantees valid JSON, not the right shape');
});

test('openai-compat sends no response_format when the provider ignores it', async () => {
  const { fetcher, seen } = spyFetch({ choices: [{ message: { content: '{}' } }] });
  const p = new OpenAICompatProvider('x', {
    apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm',
    capabilities: caps({ structuredOutput: 'none' }), fetcher,
  });
  await p.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema });
  assert.equal(seen[0]!.body.response_format, undefined, 'asking for what it ignores yields prose');
});

test('a non-ok http response raises with the status visible', async () => {
  const fetcher = (async () => ({ ok: false, status: 429, text: async () => 'slow down' })) as unknown as typeof fetch;
  const p = new OpenAICompatProvider('x', {
    apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', capabilities: caps(), fetcher,
  });
  await assert.rejects(() => p.complete({ role: 'x', messages: [{ role: 'user', content: 'x' }] }), /429/);
});

// ---------------------------------------------------------------- anthropic

test('anthropic lifts the system prompt out of the message list', async () => {
  const { fetcher, seen } = spyFetch({ content: [{ text: 'prose' }], usage: { input_tokens: 9, output_tokens: 3 } });
  const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', capabilities: caps({ structuredOutput: 'none' }), fetcher });
  const res = await p.complete({ role: 'narrate', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U' }] });

  assert.equal(seen[0]!.body.system, 'SYS');
  assert.equal((seen[0]!.body.messages as unknown[]).length, 1, 'system is not a message here');
  assert.equal(res.text, 'prose');
  assert.equal(res.tokensIn, 9);
  assert.match(seen[0]!.headers['x-api-key']!, /^k$/);
});

test('anthropic prefills a brace for json and restores it on the way back', async () => {
  const { fetcher, seen } = spyFetch({ content: [{ text: '"a":"b"}' }] });
  const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', capabilities: caps({ structuredOutput: 'none' }), fetcher });
  const res = await p.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema });

  const msgs = seen[0]!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs.at(-1)?.role, 'assistant');
  assert.equal(msgs.at(-1)?.content, '{');
  assert.equal(res.text, '{"a":"b"}', 'the parser sees a whole object');
  assert.deepEqual(JSON.parse(res.text), { a: 'b' });
});

// ------------------------------------------------------------------- ollama

test('ollama sets num_ctx explicitly, or it silently truncates to 2k', async () => {
  const { fetcher, seen } = spyFetch({ message: { content: 'out' }, prompt_eval_count: 11, eval_count: 4 });
  const p = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen', capabilities: caps({ contextWindow: 64_000 }), fetcher });
  const res = await p.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  const options = seen[0]!.body.options as { num_ctx: number };
  assert.equal(options.num_ctx, 64_000, 'the default would look like the model forgetting things');
  assert.equal(res.tokensIn, 11);
  assert.match(seen[0]!.url, /\/api\/chat$/);
});

test('ollama passes the schema through as a format constraint', async () => {
  const { fetcher, seen } = spyFetch({ message: { content: '{}' } });
  const p = new OllamaProvider({ baseUrl: 'http://x', model: 'm', capabilities: caps(), fetcher });
  await p.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema });
  assert.deepEqual(seen[0]!.body.format, schema.schema);
});

// -------------------------------------------------------------- config

test('a missing api key is refused with the variable named', () => {
  assert.throws(() => buildProvider(PRESETS['openai:gpt-4o']!, {}), /OPENAI_API_KEY/);
});

test('ollama needs no api key', () => {
  const p = buildProvider(PRESETS['ollama:llama3.1']!, {});
  assert.equal(p.id, 'ollama');
});

test('the default config runs entirely on the mock provider', () => {
  const { registry, notes } = buildRegistry(defaultConfig(), {});
  assert.equal(registry.get('narrate').id, 'mock');
  assert.match(notes.join(' '), /mock/);
});

test('a profile with no keys configured falls back to mock rather than failing', () => {
  const { registry, notes } = buildRegistry({ ...defaultConfig(), profile: 'premium' }, {});
  assert.equal(registry.get('narrate').id, 'mock', 'an unset key should not stop you playing');
  assert.ok(notes.some((n) => /ANTHROPIC_API_KEY|unavailable/.test(n)), 'but it says why');
});

test('a real profile routes mechanics and extraction away from the narrator', () => {
  const { registry } = buildRegistry(
    { ...defaultConfig(), profile: 'balanced' },
    { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
  );
  const narrate = registry.get('narrate');
  const classify = registry.get('classify');
  assert.equal(narrate.id, 'anthropic');
  assert.notEqual(classify.model, narrate.model, 'cheap models do the bookkeeping');
  assert.equal(registry.get('extract').model, 'gpt-4o-mini', 'the extractor is pinned separately');
  assert.equal(registry.get('passb').model, 'gpt-4o-mini', 'pass B follows the extractor, since it also writes canon');
});

test('an unknown profile falls back to mock with a note', () => {
  const { registry, notes } = buildRegistry({ ...defaultConfig(), profile: 'nonsense' }, {});
  assert.equal(registry.get('narrate').id, 'mock');
  assert.ok(notes.some((n) => /unknown profile/.test(n)));
});

test('every preset declares a context window of at least 64k', () => {
  // The design commits to 64k as the floor; a preset below it would silently
  // break frame assembly.
  for (const [key, spec] of Object.entries(PRESETS)) {
    const window = spec.capabilities?.contextWindow ?? 64_000;
    assert.ok(window >= 64_000, `${key} declares ${window}`);
  }
});
