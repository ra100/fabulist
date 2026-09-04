import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSse, readNdjson, readAwsEventStream } from '../src/providers/stream.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { OpenAICompatProvider, AnthropicProvider, OllamaProvider } from '../src/providers/http.ts';
import { ProviderRegistry, SwappableRegistry, type Provider, type ProviderCapabilities } from '../src/providers/provider.ts';
import { switchProfile, defaultConfig, saveConfig, loadConfig } from '../src/config/config.ts';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';

function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true, streaming: true,
    costTier: 'free', charsPerToken: 4, proseQuality: 0.5, steerability: 0.5, ...over,
  };
}

/** Serves a fixed body as a stream, so framing can be tested without a network. */
function streamFetcher(chunks: string[]) {
  return (async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    json: async () => ({}),
    text: async () => '',
  })) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

// ------------------------------------------------------------------- framing

test('sse events split across reads are reassembled', async () => {
  // fetch gives no guarantee that a chunk ends on an event boundary, and getting
  // this wrong drops fragments in a way that looks like a bad model.
  const events = await collect(readSse(bodyOf(['data: {"a":1}\n\ndata: {"b', '":2}\n\n'])));
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
});

test('sse terminators and blank lines are skipped', async () => {
  const events = await collect(readSse(bodyOf(['\n', 'data: one\n', '\n', 'data: [DONE]\n\n'])));
  assert.deepEqual(events, ['one'], '[DONE] is a terminator, not a payload');
});

test('a final sse event without a trailing newline is not lost', async () => {
  assert.deepEqual(await collect(readSse(bodyOf(['data: last']))), ['last']);
});

test('ndjson lines split across reads are reassembled', async () => {
  const lines = await collect(readNdjson(bodyOf(['{"a":1}\n{"b', '":2}\n'])));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('aws binary event frames yield their decoded payloads', async () => {
  const payload = Buffer.from(JSON.stringify({ delta: { text: 'hi' } })).toString('base64');
  const frames = await collect(readAwsEventStream(bodyOf([`\u0000\u0000{"bytes":"${payload}","p":"x"}`])));
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0]!), { delta: { text: 'hi' } });
});

test('an empty body yields nothing rather than hanging', async () => {
  assert.deepEqual(await collect(readSse(null)), []);
  assert.deepEqual(await collect(readNdjson(null)), []);
  assert.deepEqual(await collect(readAwsEventStream(null)), []);
});

// --------------------------------------------------------- provider streaming

test('openai-compatible streaming assembles deltas and reports usage', async () => {
  const fetcher = streamFetcher([
    'data: {"choices":[{"delta":{"content":"The ink "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"had frozen."}}]}\n\n',
    'data: {"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const provider = new OpenAICompatProvider('x', { apiKey: '', baseUrl: 'http://x/v1', model: 'm', capabilities: caps(), fetcher });

  const seen: string[] = [];
  const res = await provider.complete({
    role: 'narrate', messages: [{ role: 'user', content: 'x' }], onToken: (c) => seen.push(c),
  });

  assert.deepEqual(seen, ['The ink ', 'had frozen.']);
  assert.equal(res.text, 'The ink had frozen.');
  assert.equal(res.tokensIn, 11);
  assert.equal(res.tokensOut, 4);
});

test('anthropic streaming reads its named event types', async () => {
  const fetcher = streamFetcher([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"text":"He waited."}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
  ]);
  const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', capabilities: caps({ structuredOutput: 'none' }), fetcher });

  const seen: string[] = [];
  const res = await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }], onToken: (c) => seen.push(c) });

  assert.deepEqual(seen, ['He waited.']);
  assert.equal(res.tokensIn, 9);
  assert.equal(res.tokensOut, 3);
});

test('ollama streaming reads newline-delimited json', async () => {
  const fetcher = streamFetcher([
    '{"message":{"content":"one "}}\n',
    '{"message":{"content":"two"},"prompt_eval_count":5,"eval_count":2}\n',
  ]);
  const provider = new OllamaProvider({ baseUrl: 'http://x', model: 'm', capabilities: caps(), fetcher });

  const seen: string[] = [];
  const res = await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }], onToken: (c) => seen.push(c) });

  assert.deepEqual(seen, ['one ', 'two']);
  assert.equal(res.text, 'one two');
  assert.equal(res.tokensOut, 2);
});

test('a schema request never streams, even when a sink is supplied', async () => {
  // Half an arrived JSON object is worthless, whereas half a paragraph is exactly
  // what a writer wants; so the two paths must not be confused.
  let streamed = false;
  const fetcher = (async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { stream?: boolean };
    streamed = body.stream === true;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }), text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;

  const provider = new OpenAICompatProvider('x', { apiKey: '', baseUrl: 'http://x/v1', model: 'm', capabilities: caps(), fetcher });
  const seen: string[] = [];
  await provider.complete({
    role: 'extract', messages: [{ role: 'user', content: 'x' }],
    schema: { name: 'd', schema: { type: 'object' } }, onToken: (c) => seen.push(c),
  });

  assert.equal(streamed, false);
  assert.equal(seen.length, 0);
});

test('a provider that declares no streaming is not asked to stream', async () => {
  let streamed = false;
  const fetcher = (async (_url: string, init: RequestInit = {}) => {
    streamed = (JSON.parse(String(init.body)) as { stream?: boolean }).stream === true;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }), text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;

  const provider = new OpenAICompatProvider('x', { apiKey: '', baseUrl: 'http://x/v1', model: 'm', capabilities: caps({ streaming: false }), fetcher });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }], onToken: () => {} });
  assert.equal(streamed, false);
});

test('the mock streams in fragments so the path is exercised offline', async () => {
  const mock = new MockProvider();
  const seen: string[] = [];
  const res = await mock.complete({
    role: 'narrate',
    messages: [{ role: 'user', content: '<player-input>i warm the ink</player-input>' }],
    onToken: (c) => seen.push(c),
  });
  assert.ok(seen.length > 3, 'more than one fragment');
  assert.equal(seen.join(''), res.text, 'fragments reassemble to exactly the result');
});

// ------------------------------------------------------ engine + swappable

test('the engine streams narration and reports its stages in order', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });

  const tokens: string[] = [];
  const stages: string[] = [];
  const out = await engine.takeTurn('i warm the ink', {
    onToken: (c) => tokens.push(c),
    onStage: (s) => stages.push(s),
  });

  assert.equal(out.kind, 'narrated');
  if (out.kind !== 'narrated') return;
  assert.equal(tokens.join(''), out.prose, 'the streamed text is the committed prose');
  assert.deepEqual(stages, [
    'reading your input',
    'checking it against your character',
    'checking it against the world',
    'deciding what happens',
    'writing',
    'recording what changed',
  ]);
  world.close();
});

test('an interrupted turn streams no narration', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });

  const tokens: string[] = [];
  const out = await engine.takeTurn('i stab the captain', { onToken: (c) => tokens.push(c) });
  assert.equal(out.kind, 'interrupted');
  assert.equal(tokens.length, 0, 'nothing is written before the gate passes');
  world.close();
});

test('a swappable registry delegates and can be replaced live', () => {
  const first = new MockProvider({ id: 'first' });
  const second = new MockProvider({ id: 'second' });
  const registry = new SwappableRegistry(new ProviderRegistry(first), 'mock');

  assert.equal(registry.get('narrate').id, 'first');
  assert.equal(registry.profile(), 'mock');

  registry.swap(new ProviderRegistry(second), 'other');
  assert.equal(registry.get('narrate').id, 'second');
  assert.equal(registry.profile(), 'other');
});

test('an engine built on a swappable registry picks up the swap', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider({ id: 'before' })), 'a');
  const engine = new Engine({ world, providers: registry });

  const first = await engine.takeTurn('i warm the ink');
  if (first.kind !== 'narrated') throw new Error('expected narration');
  assert.equal(first.turn.meta.providerCalls[0]?.provider, 'before');

  registry.swap(new ProviderRegistry(new MockProvider({ id: 'after' })), 'b');

  const second = await engine.takeTurn('i check the door');
  if (second.kind !== 'narrated') throw new Error('expected narration');
  assert.equal(second.turn.meta.providerCalls[0]?.provider, 'after', 'no restart needed');
  world.close();
});

// ------------------------------------------------------------ profile switch

function withConfig(fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'fab-cfg-'));
  const path = join(dir, 'fabulist.config.json');
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('switching to an unusable profile changes nothing and says so', () => {
  withConfig((path) => {
    saveConfig({ ...defaultConfig(), profile: 'mock' }, path);
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');

    // "premium" needs API keys that are not set here.
    const result = switchProfile(registry, 'premium', path, {});
    assert.equal(result.ok, false);
    assert.equal(registry.profile(), 'mock', 'refusing beats silently degrading to the mock');
    assert.equal(loadConfig(path).profile, 'mock', 'and the config is untouched');
    assert.ok(result.notes.length > 0, 'with a reason');
  });
}); 

test('switching to a usable profile swaps live and persists', () => {
  withConfig((path) => {
    saveConfig({ ...defaultConfig(), profile: 'mock' }, path);
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');

    // ollama needs no key, so this resolves without any environment.
    const result = switchProfile(registry, 'local', path, {});
    assert.equal(result.ok, true);
    assert.equal(registry.profile(), 'local');
    assert.equal(registry.get('narrate').id, 'ollama');
    assert.equal(loadConfig(path).profile, 'local', 'so a restart keeps the choice');
  });
});

test('switching back to mock always works', () => {
  withConfig((path) => {
    saveConfig({ ...defaultConfig(), profile: 'local' }, path);
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'local');
    assert.equal(switchProfile(registry, 'mock', path, {}).ok, true);
    assert.equal(registry.get('narrate').id, 'mock');
  });
});

// --------------------------------------------------------------- sse endpoint

async function withServer(fn: (base: string, world: World, registry: SwappableRegistry) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');
  const engine = new Engine({ world, providers: registry });
  const server = createApiServer({ world, engine, registry });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world, registry);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

/** Minimal SSE client, mirroring what the browser does. */
async function readEvents(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        try {
          out.push({ event, data: JSON.parse(line.slice(5).trim()) as Record<string, unknown> });
        } catch {
          // partial
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
  return out;
}

test('the streaming endpoint emits stages, tokens and a final done', async () => {
  await withServer(async (base, world) => {
    const res = await fetch(`${base}/api/play/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'i warm the ink and keep copying' }),
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = await readEvents(res);
    const kinds = [...new Set(events.map((e) => e.event))];
    assert.ok(kinds.includes('stage'));
    assert.ok(kinds.includes('token'));
    assert.ok(kinds.includes('done'));

    const prose = events.filter((e) => e.event === 'token').map((e) => String(e.data.chunk)).join('');
    const done = events.find((e) => e.event === 'done')!;
    const outcome = done.data.outcome as { kind: string; prose: string };
    assert.equal(outcome.kind, 'narrated');
    assert.equal(prose, outcome.prose, 'what was streamed is what was committed');
    assert.equal(world.chronicle.turns().length, 1);
  });
});

test('a vow breach comes back through the stream as an interrupt', async () => {
  await withServer(async (base, world) => {
    const res = await fetch(`${base}/api/play/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'i stab the captain' }),
    });
    const events = await readEvents(res);
    const outcome = (events.find((e) => e.event === 'done')!.data.outcome) as { kind: string };
    assert.equal(outcome.kind, 'interrupted');
    assert.equal(events.filter((e) => e.event === 'token').length, 0, 'nothing was written');
    assert.equal(world.chronicle.turns().length, 0);
  });
});

test('empty input is rejected before the stream opens', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/play/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: '  ' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});

test('the providers endpoint reports the live profile, not the file', async () => {
  await withServer(async (base, _world, registry) => {
    registry.swap(new ProviderRegistry(new MockProvider({ id: 'x' })), 'local');
    const res = await fetch(`${base}/api/providers`);
    const body = (await res.json()) as { profile: string };
    assert.equal(body.profile, 'local', 'a live swap is visible immediately');
  });
});

test('the profile route refuses an unusable profile with a 400', async () => {
  await withServer(async (base, _world, registry) => {
    const res = await fetch(`${base}/api/providers/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'premium' }),
    });
    assert.equal(res.status, 400);
    assert.equal(registry.profile(), 'mock');
  });
});

test('profile switching is refused when the server has no swappable registry', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/providers/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'local' }),
  });
  assert.equal(res.status, 503);
  await new Promise<void>((r) => server.close(() => r()));
  world.close();
});
