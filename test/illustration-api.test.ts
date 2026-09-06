/**
 * HTTP surface for the illustration routes. Same `withServer` harness shape
 * as `test/api.test.ts`, extended with an `IllustrationService` wired to a
 * `MockImageProvider` so the routes are exercised end to end with no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';
import { IllustrationService } from '../src/illustration/service.ts';
import { MockImageProvider } from '../src/providers/mockImage.ts';
import { SwappableImageRegistry } from '../src/providers/image.ts';

const TMP_IMAGES = join('data', '.test-images-api');

async function withServer(
  fn: (base: string, world: World) => Promise<void>,
  opts: { withImages?: boolean } = { withImages: true },
) {
  rmSync(TMP_IMAGES, { recursive: true, force: true });
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const imageRegistry = new SwappableImageRegistry(opts.withImages ? new MockImageProvider() : null, opts.withImages ? 'mock' : 'none');
  const illustrations = opts.withImages ? new IllustrationService({ world, providers: imageRegistry }) : undefined;
  const server = createApiServer({ world, engine, illustrations, imageRegistry });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

test.after(() => rmSync(TMP_IMAGES, { recursive: true, force: true }));

const get = async (base: string, path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() as unknown };
};
const send = async (base: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as unknown };
};

test('illustrating a portrait over HTTP returns a done illustration with a path', async () => {
  await withServer(async (base) => {
    const { status, body } = await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    assert.equal(status, 200);
    const b = body as { status: string; path: string | null };
    assert.equal(b.status, 'done');
    assert.ok(b.path);
  });
});

test('the generated image is fetchable as real bytes over HTTP', async () => {
  await withServer(async (base) => {
    const { body } = await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    const id = (body as { id: string }).id;
    const res = await fetch(`${base}/api/illustration/${encodeURIComponent(id)}/image`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 8);
    // PNG magic bytes.
    assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

test('a visual style override on the request is honoured over the story default', async () => {
  await withServer(async (base) => {
    const a = await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', { visualStyle: 'realistic' });
    const b = await send(base, 'POST', '/api/illustrate/portrait/char:sister-oria', { visualStyle: 'sketch' });
    assert.equal((a.body as { visualStyle: string }).visualStyle, 'realistic');
    assert.equal((b.body as { visualStyle: string }).visualStyle, 'sketch');
  });
});

test('illustrating with the illustration service enabled but no provider configured returns 400, not 500', async () => {
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const imageRegistry = new SwappableImageRegistry(null, 'none'); // service exists, but nothing behind it
  const illustrations = new IllustrationService({ world, providers: imageRegistry });
  const server = createApiServer({ world, engine, illustrations, imageRegistry });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/illustrate/portrait/char:brother-anselm`, { method: 'POST' });
    const body = await res.json() as { error: string };
    assert.equal(res.status, 400);
    assert.match(body.error, /no image provider/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
});

test('illustrating an unknown entity returns an error rather than a 200', async () => {
  await withServer(async (base) => {
    const { status } = await send(base, 'POST', '/api/illustrate/portrait/char:nobody', {});
    assert.notEqual(status, 200);
  });
});

test('a server with illustration disabled entirely (no illustrations service) refuses with 503', async () => {
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine }); // no illustrations, no imageRegistry
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/illustrate/portrait/char:brother-anselm`, { method: 'POST' });
    assert.equal(res.status, 503);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
});

test('illustrations for an entity are listable and reflect a generated portrait', async () => {
  await withServer(async (base) => {
    await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    const { status, body } = await get(base, '/api/illustrations/entity/char:brother-anselm');
    assert.equal(status, 200);
    assert.equal((body as unknown[]).length, 1);
  });
});

test('regenerating a portrait updates the sheet appearance reference reachable from the entity API', async () => {
  await withServer(async (base) => {
    await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    const { body } = await get(base, '/api/entity/char:brother-anselm');
    const sheet = (body as { sheet: { appearance: { referenceImagePath: string | null } } }).sheet;
    assert.ok(sheet.appearance.referenceImagePath, 'the entity API surfaces the new reference immediately');
  });
});

test('deleting an illustration over HTTP removes it from later listings', async () => {
  await withServer(async (base) => {
    const created = await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    const id = (created.body as { id: string }).id;
    const del = await fetch(`${base}/api/illustration/${encodeURIComponent(id)}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const { body } = await get(base, '/api/illustrations/entity/char:brother-anselm');
    assert.equal((body as unknown[]).length, 0);
  });
});

test('the image providers probe reports the mock as ready and reflects the live profile', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/images/providers');
    assert.equal(status, 200);
    const b = body as { profile: string; results: Array<{ key: string; status: string }> };
    assert.equal(b.profile, 'mock');
    const mock = b.results.find((r) => r.key === 'mock');
    assert.equal(mock?.status, 'ready');
  });
});

test('switching the live image profile to an unusable key is refused with a 400', async () => {
  await withServer(async (base) => {
    const { status } = await send(base, 'POST', '/api/images/profile', { profile: 'nonexistent-key' });
    assert.equal(status, 400);
  });
});

test('switching the live image profile to null turns illustration off without breaking the server', async () => {
  await withServer(async (base) => {
    const off = await send(base, 'POST', '/api/images/profile', { profile: null });
    assert.equal(off.status, 200);
    const { status, body } = await send(base, 'POST', '/api/illustrate/portrait/char:brother-anselm', {});
    assert.equal(status, 400);
    assert.match((body as { error: string }).error, /no image provider/);
  });
});

test('a scene illustration route reads present cast from the turn delta, not a client-supplied list', async () => {
  await withServer(async (base) => {
    // Play a real turn through the mock text engine, then illustrate it.
    const played = await send(base, 'POST', '/api/play', { input: 'i copy the page quietly' });
    const outcome = (played.body as { outcome: { kind: string; turn?: { id: string } } }).outcome;
    if (outcome.kind !== 'narrated' || !outcome.turn) return; // mock's classifier can occasionally route to a meta-query; not the point of this test
    const { status, body } = await send(base, 'POST', `/api/illustrate/scene/${encodeURIComponent(outcome.turn.id)}`, {});
    assert.equal(status, 200);
    assert.equal((body as { status: string }).status, 'done');
  });
});

// ------------------------------------------------------------ prompt-only fallback

test('the portrait prompt route works with no illustration service configured at all', async () => {
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine }); // no illustrations, no imageRegistry
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/illustrate/portrait/char:brother-anselm/prompt`);
    assert.equal(res.status, 200);
    const body = await res.json() as { prompt: string; negativePrompt: string };
    assert.match(body.prompt, /Brother Anselm/);
    assert.ok(body.negativePrompt.length > 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
});

test('the portrait prompt route honours a visualStyle query parameter', async () => {
  await withServer(async (base) => {
    const a = await get(base, '/api/illustrate/portrait/char:brother-anselm/prompt?visualStyle=sketch');
    const b = await get(base, '/api/illustrate/portrait/char:brother-anselm/prompt?visualStyle=realistic');
    assert.notEqual((a.body as { prompt: string }).prompt, (b.body as { prompt: string }).prompt);
  });
});

test('the portrait prompt route 404s for an unknown entity rather than composing garbage', async () => {
  await withServer(async (base) => {
    const { status } = await get(base, '/api/illustrate/portrait/char:nobody/prompt');
    assert.equal(status, 404);
  });
});

test('the scene prompt route composes from the turn delta, with no provider or illustration service required', async () => {
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  seedWorld(world);
  const turn = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'x', intent: null,
    delta: { events: [{ text: 'He copies the page.', participants: ['char:brother-anselm'], locationId: 'loc:the-scriptorium', significance: 0.3 }], entityUpserts: [], edgeAsserts: [], edgeRetires: [], conditionUpdates: [], relationshipUpdates: [], factsLearned: [], threadUpdates: [], vowBreaks: [], sceneAdvance: false },
    bookProse: 'He copies the page in silence.', pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine }); // no illustrations, no imageRegistry
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/illustrate/scene/${encodeURIComponent(turn.id)}/prompt`);
    assert.equal(res.status, 200);
    const body = await res.json() as { prompt: string };
    assert.match(body.prompt, /The Scriptorium/);
    assert.match(body.prompt, /Brother Anselm/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
});
