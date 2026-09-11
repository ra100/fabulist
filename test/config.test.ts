import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { ConfigService, validateSpec, ROUTABLE_ROLES } from '../src/config/service.ts';
import { defaultConfig, loadConfig, localPathFor, saveConfig, type Config } from '../src/config/config.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { makeProseGate } from '../src/lint/gate.ts';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwappableImageRegistry } from '../src/providers/image.ts';

/** In-memory config, so nothing touches a real file. */
function service(initial: Partial<Config> = {}, registry?: SwappableRegistry) {
  let stored: Config = { ...defaultConfig(), ...initial };
  const svc = new ConfigService({
    path: 'test.json',
    ...(registry ? { registry } : {}),
    env: {},
    load: () => stored,
    save: (cfg) => {
      stored = cfg;
    },
  });
  return { svc, saved: () => stored };
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'story-cfg-local-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------- local config override

test('localPathFor inserts .local before the final extension', () => {
  assert.equal(localPathFor('fabulist.config.json'), 'fabulist.config.local.json');
  assert.equal(localPathFor('/a/b/cfg.json'), '/a/b/cfg.local.json');
  assert.equal(localPathFor('no-extension'), 'no-extension.local');
});

test('loadConfig reads the tracked file alone when no local override exists', () => {
  withTempDir((dir) => {
    const path = join(dir, 'fabulist.config.json');
    writeFileSync(path, JSON.stringify({ ...defaultConfig(), profile: 'tracked' }));
    assert.equal(loadConfig(path).profile, 'tracked');
  });
});

test('a local override wins over the tracked file, field by field', () => {
  withTempDir((dir) => {
    const path = join(dir, 'fabulist.config.json');
    writeFileSync(path, JSON.stringify({ ...defaultConfig(), profile: 'tracked', proseLintThreshold: 9 }));
    writeFileSync(localPathFor(path), JSON.stringify({ profile: 'local' }));
    const cfg = loadConfig(path);
    assert.equal(cfg.profile, 'local', 'the local override wins');
    assert.equal(cfg.proseLintThreshold, 9, 'a field the override never mentioned still comes from the tracked file');
  });
});

test('saveConfig always writes the local override, never the tracked file', () => {
  withTempDir((dir) => {
    const path = join(dir, 'fabulist.config.json');
    writeFileSync(path, JSON.stringify({ ...defaultConfig(), profile: 'tracked' }));
    saveConfig({ ...defaultConfig(), profile: 'switched' }, path);

    assert.equal(
      JSON.parse(readFileSync(path, 'utf8')).profile,
      'tracked',
      'the tracked file is untouched by a runtime write',
    );
    assert.equal(loadConfig(path).profile, 'switched', 'but the effective config reflects the write');
  });
});

test('the very first write creates the local override with no tracked file present at all', () => {
  withTempDir((dir) => {
    const path = join(dir, 'fabulist.config.json');
    assert.ok(!existsSync(path));
    saveConfig({ ...defaultConfig(), profile: 'first-run' }, path);
    assert.ok(!existsSync(path), 'still no tracked file — nothing created or touched it');
    assert.equal(loadConfig(path).profile, 'first-run');
  });
});

// -------------------------------------------------------------- validation

test('a valid local server spec is accepted and normalised', () => {
  const { spec, issues } = validateSpec('vllm:mine', {
    kind: 'openai-compat', model: 'Qwen/Qwen2.5-14B', baseUrl: 'http://127.0.0.1:8001/v1/', auth: 'none', dialect: 'vllm',
  });
  assert.deepEqual(issues, []);
  assert.equal(spec?.baseUrl, 'http://127.0.0.1:8001/v1', 'trailing slash trimmed');
  assert.equal(spec?.dialect, 'vllm');
});

test('an unknown kind is rejected rather than half-accepted', () => {
  const { spec, issues } = validateSpec('x', { kind: 'telepathy', model: 'm' });
  assert.equal(spec, null);
  assert.match(issues[0]!.field, /\.kind$/);
});

test('a missing model id is reported against its own field', () => {
  const { spec, issues } = validateSpec('x', { kind: 'ollama', model: '  ' });
  assert.equal(spec, null);
  assert.ok(issues.some((i) => i.field === 'x.model'));
});

test('a non-http base url is refused', () => {
  const { issues } = validateSpec('x', { kind: 'openai-compat', model: 'm', baseUrl: 'ftp://nope', auth: 'none' });
  assert.ok(issues.some((i) => i.field === 'x.baseUrl'));
});

test('api-key auth without an environment variable name is flagged', () => {
  // A common slip: choosing api-key and forgetting to say where the key lives.
  const { issues } = validateSpec('x', { kind: 'openai-compat', model: 'm', auth: 'api-key' });
  assert.ok(issues.some((i) => i.field === 'x.apiKeyEnv'));
});

test('a context window below the engine floor is refused, not silently accepted', () => {
  // Accepting it would truncate prompts rather than fail loudly.
  const { issues } = validateSpec('x', {
    kind: 'ollama', model: 'm', capabilities: { contextWindow: 8192 },
  });
  assert.ok(issues.some((i) => i.field === 'x.capabilities.contextWindow'));
});

test('copilot demands its acknowledgement', () => {
  const without = validateSpec('c', { kind: 'copilot', model: 'gpt-4o' });
  assert.ok(without.issues.some((i) => i.field === 'c.allowUnofficial'));
  const with_ = validateSpec('c', { kind: 'copilot', model: 'gpt-4o', allowUnofficial: true });
  assert.deepEqual(with_.issues, []);
});

// ------------------------------------------------------------------ patch

test('the lint threshold round-trips and persists', () => {
  const { svc, saved } = service();
  const result = svc.patch({ proseLintThreshold: 12 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.config.proseLintThreshold, 12);
  assert.equal(saved().proseLintThreshold, 12, 'so a restart keeps it');
});

test('a nonsensical threshold is refused and leaves the old value', () => {
  const { svc } = service({ proseLintThreshold: 6 });
  const result = svc.patch({ proseLintThreshold: -3 });
  assert.ok(result.issues.some((i) => i.field === 'proseLintThreshold'));
  assert.equal(result.config.proseLintThreshold, 6);
});

test('dbPath cannot be changed while a world is open', () => {
  // Changing it at runtime would leave the UI talking to a database the engine
  // is not using.
  const { svc } = service({ dbPath: 'data/a.db' });
  const result = svc.patch({ dbPath: 'data/b.db' });
  assert.ok(result.issues.some((i) => i.field === 'dbPath'));
  assert.equal(result.config.dbPath, 'data/a.db');
});

test('the blocklist deduplicates case-insensitively and drops noise', () => {
  const { svc } = service();
  svc.addBlocked('a wave of nausea');
  svc.addBlocked('A Wave Of Nausea');
  const result = svc.addBlocked('x');
  assert.equal(result.config.blocklist.length, 1, 'a one-character phrase is not useful');
  assert.ok(result.issues.some((i) => i.field === 'blocklist'));
});

test('unblocking removes regardless of case', () => {
  const { svc } = service({ blocklist: ['Something Unspoken'] });
  const result = svc.removeBlocked('something unspoken');
  assert.deepEqual(result.config.blocklist, []);
});

test('a route to an unknown provider is refused', () => {
  const { svc } = service();
  const result = svc.patch({ routes: { narrate: 'nope:missing' } });
  assert.ok(result.issues.some((i) => i.field === 'routes.narrate'));
  assert.deepEqual(result.config.routes, {});
});

test('a route to a known preset is kept', () => {
  const { svc } = service();
  const result = svc.patch({ routes: { narrate: 'ollama:qwen2.5' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.config.routes.narrate, 'ollama:qwen2.5');
});

test('an empty route value clears the override', () => {
  const { svc } = service({ routes: { narrate: 'ollama:qwen2.5' } });
  const result = svc.patch({ routes: { narrate: '' } });
  assert.equal(result.config.routes.narrate, undefined);
});

test('every routable role is offered', () => {
  // Extraction and pass B especially: the design pins them separately because
  // they write the world model.
  for (const role of ['narrate', 'extract', 'passb']) {
    assert.ok((ROUTABLE_ROLES as readonly string[]).includes(role), role);
  }
});

// -------------------------------------------------------------- providers

test('adding a provider makes it routable', () => {
  const { svc } = service();
  svc.putProvider('vllm:mine', { kind: 'openai-compat', model: 'qwen', baseUrl: 'http://127.0.0.1:8001/v1', auth: 'none' });
  assert.ok(svc.providerKeys().includes('vllm:mine'));
  const result = svc.patch({ routes: { narrate: 'vllm:mine' } });
  assert.deepEqual(result.issues, []);
});

test('a provider with no name is refused', () => {
  const { svc } = service();
  const result = svc.putProvider('  ', { kind: 'ollama', model: 'm' });
  assert.ok(result.issues.some((i) => i.field === 'key'));
});

test('removing a provider also drops routes that pointed at it', () => {
  // Otherwise the registry fails to build and the engine silently falls back.
  const { svc } = service();
  svc.putProvider('vllm:mine', { kind: 'openai-compat', model: 'qwen', baseUrl: 'http://x/v1', auth: 'none' });
  svc.patch({ routes: { narrate: 'vllm:mine', extract: 'ollama:qwen2.5' } });

  const result = svc.removeProvider('vllm:mine');
  assert.equal(result.config.providers['vllm:mine'], undefined);
  assert.equal(result.config.routes.narrate, undefined, 'the dangling route went too');
  assert.equal(result.config.routes.extract, 'ollama:qwen2.5', 'unrelated routes survive');
});

test('a configured provider overrides a preset of the same name', () => {
  const { svc } = service();
  svc.putProvider('ollama:qwen2.5', { kind: 'ollama', model: 'qwen2.5:32b', baseUrl: 'http://127.0.0.1:11434' });
  assert.equal(svc.resolveSpec('ollama:qwen2.5')?.model, 'qwen2.5:32b');
});

test('presets are resolvable for the editor to prefill', () => {
  const { svc } = service();
  assert.equal(svc.resolveSpec('vllm:local')?.kind, 'openai-compat');
  assert.equal(svc.resolveSpec('nope'), undefined);
});

// ------------------------------------------------------- live side effects

test('changing routes rebuilds the live registry without a restart', () => {
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'local');
  const { svc } = service({ profile: 'local' }, registry);

  assert.equal(registry.get('narrate').id, 'mock');
  const result = svc.patch({ routes: { narrate: 'ollama:llama3.1' } });

  assert.equal(result.registryRebuilt, true);
  assert.equal(registry.get('narrate').id, 'ollama', 'the swap already happened');
});

test('changing only the lint threshold does not rebuild the registry', () => {
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');
  const { svc } = service({}, registry);
  assert.equal(svc.patch({ proseLintThreshold: 9 }).registryRebuilt, false);
});

test('the prose gate reads settings live, so a new block applies to the next turn', () => {
  const { svc } = service({ proseLintThreshold: 6 });
  const gate = makeProseGate({ live: () => svc.lintOptions() });

  const passage = 'He crossed the yard. The bell had already rung twice.';
  assert.equal(gate.lint(passage).findings.length, 0, 'clean to begin with');

  svc.addBlocked('crossed the yard');
  const after = gate.lint(passage);
  assert.ok(after.findings.some((f) => /blocklist/i.test(f.rule)), 'the gate saw the change without being rebuilt');
});

test('raising the threshold stops a marginal passage from tripping', () => {
  const { svc } = service({ proseLintThreshold: 0 });
  const gate = makeProseGate({ live: () => svc.lintOptions() });
  const slop = 'She let out a breath she didn\'t know she was holding. Everything changed.';

  assert.equal(gate.lint(slop).tripped, true);
  svc.patch({ proseLintThreshold: 10_000 });
  assert.equal(gate.lint(slop).tripped, false, 'the same gate instance honoured the new threshold');
});

// ------------------------------------------------------------------ routes

async function withServer(fn: (base: string, svc: ConfigService, registry: SwappableRegistry) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');
  let stored: Config = defaultConfig();
  const config = new ConfigService({
    path: 'test.json', registry, env: {},
    load: () => stored,
    save: (cfg) => {
      stored = cfg;
    },
  });
  const engine = new Engine({ world, providers: registry, proseGate: makeProseGate({ live: () => config.lintOptions() }) });
  const server = createApiServer({ world, engine, registry, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, config, registry);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

const send = async (base: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test('the config endpoint exposes everything the editor needs', async () => {
  await withServer(async (base) => {
    const { status, body } = await send(base, 'GET', '/api/config');
    assert.equal(status, 200);
    assert.ok((body.config as unknown as Config).dbPath);
    assert.ok((body.providerKeys as unknown as string[]).includes('vllm:local'));
    assert.ok((body.roles as unknown as string[]).includes('extract'));
    assert.ok((body.presets as Record<string, unknown>)['bedrock:sonnet'], 'presets prefill the form');
  });
});

test('patching config through the api validates per field', async () => {
  await withServer(async (base) => {
    const { body } = await send(base, 'PUT', '/api/config', { proseLintThreshold: -1 });
    const issues = body.issues as unknown as Array<{ field: string }>;
    assert.ok(issues.some((i) => i.field === 'proseLintThreshold'));
  });
});

test('a provider can be added, routed to, and removed over the api', async () => {
  await withServer(async (base, svc) => {
    const added = await send(base, 'PUT', '/api/config/provider/vllm%3Amine', {
      kind: 'openai-compat', model: 'qwen', baseUrl: 'http://127.0.0.1:8001/v1', auth: 'none', dialect: 'vllm',
    });
    assert.deepEqual(added.body.issues, []);
    assert.ok(svc.providerKeys().includes('vllm:mine'));

    await send(base, 'PUT', '/api/config', { routes: { narrate: 'vllm:mine' } });
    assert.equal(svc.get().routes.narrate, 'vllm:mine');

    const removed = await send(base, 'DELETE', '/api/config/provider/vllm%3Amine');
    assert.equal((removed.body.config as unknown as Config).routes.narrate, undefined);
  });
});

test('testing a spec probes it without saving it', async () => {
  await withServer(async (base, svc) => {
    const { body } = await send(base, 'POST', '/api/config/provider/test', {
      key: 'candidate',
      spec: { kind: 'openai-compat', model: 'm', baseUrl: 'http://127.0.0.1:59999/v1', auth: 'none' },
    });
    assert.equal(body.status as unknown as string, 'unavailable', 'nothing is listening on that port');
    assert.ok(String(body.fix), 'and it says how to start one');
    assert.ok(!svc.providerKeys().includes('candidate'), 'test must not persist');
  });
});

test('testing an invalid spec reports the fields rather than probing', async () => {
  await withServer(async (base) => {
    const { body } = await send(base, 'POST', '/api/config/provider/test', {
      key: 'bad', spec: { kind: 'openai-compat', model: '' },
    });
    assert.equal(body.status as unknown as string, 'unavailable');
    assert.ok((body.issues as unknown as Array<{ field: string }>).some((i) => i.field === 'bad.model'));
  });
});

test('blocking a phrase over the api affects the very next lint', async () => {
  await withServer(async (base, svc) => {
    await send(base, 'POST', '/api/config/blocklist', { phrase: 'the air was thick with' });
    assert.ok(svc.get().blocklist.includes('the air was thick with'));

    const gate = makeProseGate({ live: () => svc.lintOptions() });
    assert.ok(gate.lint('The air was thick with something.').findings.length > 0);

    await send(base, 'POST', '/api/config/blocklist', { phrase: 'the air was thick with', remove: true });
    assert.deepEqual(svc.get().blocklist, []);
  });
});

test('blocking with no phrase is a 400', async () => {
  await withServer(async (base) => {
    assert.equal((await send(base, 'POST', '/api/config/blocklist', {})).status, 400);
  });
});

test('config routes are refused when the server has no config service', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(res.status, 503);
  await new Promise<void>((r) => server.close(() => r()));
  world.close();
});

test('a live config change is visible to a turn taken immediately after', async () => {
  await withServer(async (base, _svc) => {
    // Block a phrase the mock narrator always emits, then confirm the lint on the
    // next turn reports it.
    await send(base, 'POST', '/api/config/blocklist', { phrase: 'moved as intended' });
    const played = await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    const outcome = played.body.outcome as unknown as { kind: string; turn: { id: string } };
    assert.equal(outcome.kind, 'narrated');

    const turn = await send(base, 'GET', `/api/turn/${encodeURIComponent(outcome.turn.id)}`);
    const lint = (turn.body.meta as unknown as { lint: { findings: Array<{ rule: string }> } }).lint;
    assert.ok(lint.findings.some((f) => /blocklist/i.test(f.rule)), 'no restart was needed');
  });
});

/**
 * Regression: an unrelated provider edit used to silently revert the image
 * profile, turning illustration off behind the user's back.
 *
 * `switchImageProfile` writes the config file directly, while `ConfigService`
 * holds an in-memory copy taken at construction. Without a reload after the
 * switch, the next `PUT /api/config/provider/:key` saved that stale copy and
 * `imageProfile` vanished from the file. Reproduced against a live server before
 * the fix, which is also how it was found — it only became visible once the
 * server stopped writing to the developer's real config.
 */
test('switching the image profile survives a later, unrelated config write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-cfg-'));
  const path = join(dir, 'cfg.json');
  try {
    const world = World.open(':memory:');
    seedWorld(world);
    const config = new ConfigService({ path });
    const imageRegistry = new SwappableImageRegistry(null, 'none');
    const server = createApiServer({
      world,
      engine: new Engine({ world, providers: new ProviderRegistry(new MockProvider()) }),
      config,
      imageRegistry,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    // Writes land on the gitignored local override, not `path` itself — see
    // `config.ts`'s `saveConfig`.
    const readFile = () => JSON.parse(readFileSync(localPathFor(path), 'utf8')) as { imageProfile?: string };

    try {
      const switched = await fetch(`${base}/api/images/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'mock' }),
      });
      assert.equal(switched.status, 200);
      assert.equal(readFile().imageProfile, 'mock', 'the switch is persisted');

      // Anything that saves through ConfigService. Nothing about image profiles.
      const put = await fetch(`${base}/api/config/provider/probe:x`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:11434' }),
      });
      assert.equal(put.status, 200);
      assert.equal(readFile().imageProfile, 'mock', 'and survives an unrelated write');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      world.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The routes that write config must write the file the server was started with
 * (its local override, not the tracked default it never touches — see
 * `config.ts`'s `saveConfig`/`localPathFor`). Their module-level defaults point
 * at `fabulist.config.json`, so a server on a throwaway config would otherwise
 * edit the operator's real one — which happened twice while browser-testing
 * the provider UI.
 */
test('profile switches write the server\'s own config file, not the default path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-cfg-'));
  const path = join(dir, 'cfg.json');
  try {
    const world = World.open(':memory:');
    seedWorld(world);
    const config = new ConfigService({ path });
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');
    const server = createApiServer({
      world,
      engine: new Engine({ world, providers: registry }),
      config,
      registry,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    try {
      // 'mock' always resolves, so this exercises the write path without needing
      // credentials for anything.
      const res = await fetch(`http://127.0.0.1:${port}/api/providers/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'mock' }),
      });
      assert.equal(res.status, 200);
      assert.ok(!existsSync(path), 'the tracked path itself is never written');
      const localPath = localPathFor(path);
      assert.ok(existsSync(localPath), 'the switch wrote this server\'s local override instead');
      assert.equal((JSON.parse(readFileSync(localPath, 'utf8')) as { profile: string }).profile, 'mock');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      world.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The setup wizard's model step offers `usableProfiles` and nothing else, and
 * every built-in profile names presets pinned to 127.0.0.1. So an Ollama living
 * anywhere else — another host, another container — could be added in settings,
 * pass its Test, and still leave the wizard with only the mock to pick, because
 * no profile mentioned it. The field workaround was a 127.0.0.1→ollama TCP
 * shim, which is the tell: nothing was wrong with the provider.
 */
test('a provider on a custom base url is selectable as a profile once it tests green', async () => {
  // Stands in for an Ollama that is not on the preset's 127.0.0.1:11434.
  const ollama = createServer((req, res) => {
    res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }));
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), 'story-cfg-'));
  const world = World.open(':memory:');
  seedWorld(world);
  // A real file, on a throwaway path: `switchProfile` reads and writes config
  // through the module functions rather than the service, so the two have to be
  // pointed at the same place for the switch below to mean anything.
  const config = new ConfigService({ path: join(dir, 'cfg.json') });
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()), 'mock');
  const server = createApiServer({ world, engine: new Engine({ world, providers: registry }), registry, config });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const spec = { kind: 'ollama', model: 'qwen2.5:14b', baseUrl };

    const tested = await send(base, 'POST', '/api/config/provider/test', { key: 'ollama:remote', spec });
    assert.equal(tested.body.status, 'ready', "the wizard's own Test button says this model works");

    const kept = await send(base, 'PUT', '/api/config/provider/ollama%3Aremote', spec);
    assert.deepEqual(kept.body.issues, []);

    const report = await send(base, 'GET', '/api/providers');
    assert.ok(
      (report.body.usableProfiles as string[]).includes('ollama:remote'),
      'the model step lists usable profiles, so a provider that tested green has to be one',
    );

    const switched = await send(base, 'POST', '/api/providers/profile', { profile: 'ollama:remote' });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.ok, true, 'selecting it is what lets the wizard advance');
    assert.equal(registry.profile(), 'ollama:remote');
    assert.equal(registry.get('narrate').id, 'ollama', 'and the world is written by that model, not the mock');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => ollama.close(() => r()));
    world.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
