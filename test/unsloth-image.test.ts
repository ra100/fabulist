/**
 * Unsloth image adapter tests. Offline, against an injected fetcher, mirroring
 * how `test/providers.test.ts` exercises the text adapters — the point is the
 * wire contract (what we send, what we do with what comes back), not that a
 * diffusion model produces a nice picture.
 *
 * The request/response shapes asserted here were read from a live Unsloth
 * Studio's own `GET /openapi.json`, so these tests are pinning a real contract
 * rather than a guess: `POST /api/inference/images/generate` takes
 * `init_image`/`strength`/`negative_prompt`, and answers with gallery records
 * whose bytes need a second authenticated GET.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnslothImageProvider, unslothImageStatus } from '../src/providers/unslothImage.ts';
import { buildImageProvider, probeImageProviders } from '../src/providers/imageConfig.ts';
import { flatPng } from '../src/providers/mockImage.ts';

const PNG = flatPng(8, 8, [10, 20, 30]);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/**
 * A fetcher that answers the two-step generate→fetch-bytes exchange and logs
 * what it was asked, so tests can assert on the request rather than only the
 * result.
 */
function stubFetch(opts: { gallery?: Record<string, unknown>; status?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });

    if (opts.status && opts.status >= 400) {
      return new Response('nope', { status: opts.status });
    }
    // The desktop-login exchange a keyless local install uses. Answering it here
    // makes the stub behave like a real desktop install: authenticated with no
    // API key exported.
    if (u.includes('/api/auth/desktop-login') || u.includes('/api/auth/login')) {
      return new Response(JSON.stringify({ access_token: 'desktop-token', token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/inference/images/generate')) {
      const image = {
        id: 'img-1',
        url: '/api/inference/images/gallery/img-1/file',
        prompt: 'p',
        width: 1024,
        height: 640,
        steps: 9,
        guidance: 0,
        seed: 4242,
        model: 'unsloth/Qwen-Image-Edit-2511-GGUF',
        created_at: 0,
        ...opts.gallery,
      };
      return new Response(JSON.stringify({ images: [image] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/file')) {
      return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (u.includes('/api/inference/images/status')) {
      return new Response(JSON.stringify({ loaded: true, repo_id: 'unsloth/Qwen-Image-Edit-2511-GGUF', workflows: ['txt2img', 'img2img'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function provider(fetcher: typeof fetch, over: Record<string, unknown> = {}) {
  return new UnslothImageProvider({ apiKey: 'sk-unsloth-test', fetcher, ...over });
}

// ------------------------------------------------------------------ the basics

test('a generation posts to the native endpoint and returns the fetched PNG bytes', async () => {
  const { fetcher, calls } = stubFetch();
  const result = await provider(fetcher).generate({ prompt: 'a scriptorium at dawn' });

  assert.deepEqual([...result.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'real PNG bytes came back');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.seed, 4242, 'the seed the server actually used is reported');
  assert.equal(result.model, 'unsloth/Qwen-Image-Edit-2511-GGUF', 'the real repo id wins over our informational label');

  assert.equal(calls.length, 2, 'generate, then fetch the bytes');
  assert.match(calls[0]!.url, /\/api\/inference\/images\/generate$/);
  // Deliberately NOT /v1/images/generations: that shape cannot carry a
  // reference image or a negative prompt.
  assert.doesNotMatch(calls[0]!.url, /\/v1\/images/);
  assert.equal(calls[0]!.body?.prompt, 'a scriptorium at dawn');
});

test('every request carries the bearer key, including the image fetch', async () => {
  const { fetcher, calls } = stubFetch();
  await provider(fetcher).generate({ prompt: 'x' });
  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer sk-unsloth-test', `${call.url} was authenticated`);
  }
});

test('a relative gallery url is joined onto the base url rather than trusted as absolute', async () => {
  const { fetcher, calls } = stubFetch();
  await provider(fetcher, { baseUrl: 'http://127.0.0.1:9999' }).generate({ prompt: 'x' });
  assert.equal(calls[1]!.url, 'http://127.0.0.1:9999/api/inference/images/gallery/img-1/file');
});

// ------------------------------------------------------- the reason it exists

test('a reference image is sent as init_image with strength — the lever ComfyUI cannot pull', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsloth-img-'));
  const ref = join(dir, 'portrait.png');
  writeFileSync(ref, PNG);
  try {
    const { fetcher, calls } = stubFetch();
    await provider(fetcher).generate({ prompt: 'x', referenceImagePath: ref, referenceStrength: 0.55 });

    const body = calls[0]!.body!;
    assert.ok(typeof body.init_image === 'string' && (body.init_image as string).startsWith('data:image/png;base64,'), 'the reference went as a data URL');
    assert.ok((body.init_image as string).length > 40, 'and it carries actual encoded bytes');
    assert.equal(body.strength, 0.55, 'referenceStrength maps straight onto strength');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a spec that turns conditioning off genuinely stops sending the reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsloth-img-'));
  const ref = join(dir, 'portrait.png');
  writeFileSync(ref, PNG);
  try {
    const { fetcher, calls } = stubFetch();
    const p = provider(fetcher, { capabilities: { imageConditioning: false } });
    await p.generate({ prompt: 'x', referenceImagePath: ref, referenceStrength: 0.55 });
    assert.equal(calls[0]!.body?.init_image, undefined, 'no init_image when the capability is off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the declared capabilities are the two levers this endpoint really supports', () => {
  const p = provider(stubFetch().fetcher);
  assert.equal(p.capabilities.imageConditioning, true);
  assert.equal(p.capabilities.seedControl, true);
});

// ---------------------------------------------------------------- seed + dims

test('an omitted seed is left out of the body so the server randomises, and a given one is sent', async () => {
  const a = stubFetch();
  await provider(a.fetcher).generate({ prompt: 'x' });
  assert.equal('seed' in (a.calls[0]!.body ?? {}), false, 'no seed key at all when none was asked for');

  const b = stubFetch();
  await provider(b.fetcher).generate({ prompt: 'x', seed: 99 });
  assert.equal(b.calls[0]!.body?.seed, 99);
});

test('dimensions default to ComfyUI\u2019s 1024x640 so switching provider does not resize everything', async () => {
  const { fetcher, calls } = stubFetch();
  await provider(fetcher).generate({ prompt: 'x' });
  assert.equal(calls[0]!.body?.width, 1024);
  assert.equal(calls[0]!.body?.height, 640);
});

test('out-of-range dimensions are clamped and snapped to the multiple of 16 the API requires', async () => {
  const { fetcher, calls } = stubFetch();
  // 100 is below the 256 floor; 5000 is above the 2048 ceiling; 999 is not a
  // multiple of 16. All three would be a 422 mid-turn if forwarded as-is.
  await provider(fetcher).generate({ prompt: 'x', width: 100, height: 5000 });
  assert.equal(calls[0]!.body?.width, 256);
  assert.equal(calls[0]!.body?.height, 2048);

  const b = stubFetch();
  await provider(b.fetcher).generate({ prompt: 'x', width: 999, height: 641 });
  assert.equal((b.calls[0]!.body?.width as number) % 16, 0);
  assert.equal((b.calls[0]!.body?.height as number) % 16, 0);
});

// -------------------------------------------------------------------- failures

test('a 401 explains where the key comes from rather than just the status', async () => {
  const { fetcher } = stubFetch({ status: 401 });
  await assert.rejects(() => provider(fetcher).generate({ prompt: 'x' }), /401.*Settings → API/s);
});

test('a 404 points at the likely cause: an Unsloth too old to have the image API', async () => {
  const { fetcher } = stubFetch({ status: 404 });
  await assert.rejects(() => provider(fetcher).generate({ prompt: 'x' }), /404.*update Unsloth Studio/s);
});

test('an empty images array blames the most likely cause: no diffusion model loaded', async () => {
  const fetcher = (async (url: unknown) =>
    String(url).includes('/generate')
      ? new Response(JSON.stringify({ images: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('x', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => provider(fetcher).generate({ prompt: 'x' }), /no images.*diffusion model loaded/s);
});

// ----------------------------------------------------------------- the probe

test('the status probe separates not-running from no-key from no-model-loaded', async () => {
  const ok = await unslothImageStatus('http://127.0.0.1:8888', 'sk-x', stubFetch().fetcher);
  assert.deepEqual({ up: ok.up, authed: ok.authed, loaded: ok.loaded }, { up: true, authed: true, loaded: true });
  assert.match(ok.detail, /Qwen-Image-Edit/);

  const unauth = (async () => new Response('{"detail":"Not authenticated"}', { status: 401 })) as unknown as typeof fetch;
  const noKey = await unslothImageStatus('http://127.0.0.1:8888', '', unauth);
  assert.deepEqual({ up: noKey.up, authed: noKey.authed }, { up: true, authed: false }, '401 still proves something is listening');

  const notLoaded = (async () =>
    new Response(JSON.stringify({ loaded: false }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const idle = await unslothImageStatus('http://127.0.0.1:8888', 'sk-x', notLoaded);
  assert.deepEqual({ up: idle.up, loaded: idle.loaded }, { up: true, loaded: false });
  assert.match(idle.detail, /no diffusion model is loaded/);

  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const down = await unslothImageStatus('http://127.0.0.1:8888', 'sk-x', dead);
  assert.equal(down.up, false);
});

test('each probe failure carries a distinct, actionable fix', async () => {
  const specs = { 'unsloth:local': { kind: 'unsloth' as const, model: 'loaded', baseUrl: 'http://127.0.0.1:8888', apiKeyEnv: 'UNSLOTH_API_KEY' } };

  // No key exported, but the stub answers desktop-login, which is exactly the
  // local desktop-install case: usable, so `ready` is the correct verdict.
  const keyless = await probeImageProviders(specs, { fetcher: stubFetch().fetcher, env: {} });
  assert.equal(keyless.find((r) => r.key === 'unsloth:local')!.status, 'ready', 'keyless local works');

  const ready = await probeImageProviders(specs, { fetcher: stubFetch().fetcher, env: { UNSLOTH_API_KEY: 'sk-x' } });
  assert.equal(ready.find((r) => r.key === 'unsloth:local')!.status, 'ready');

  // Nothing to authenticate with at all: no key, and desktop-login refused.
  const noCredential = (async (url: unknown) =>
    String(url).includes('/api/auth/')
      ? new Response('{}', { status: 401 })
      : new Response('{"detail":"Not authenticated"}', { status: 401 })) as unknown as typeof fetch;
  const stuck = await probeImageProviders(specs, { fetcher: noCredential, env: {} });
  const s = stuck.find((r) => r.key === 'unsloth:local')!;
  assert.equal(s.status, 'unavailable');
  assert.match(s.fix, /desktop app|Settings → API/, 'names both the local and remote remedy');

  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const down = await probeImageProviders(specs, { fetcher: dead, env: { UNSLOTH_API_KEY: 'sk-x' } });
  assert.match(down.find((r) => r.key === 'unsloth:local')!.fix, /unsloth studio/);
});

// ------------------------------------------------------------------ the wiring

test('the preset builds with or without a key, since a local desktop login can supply one', () => {
  const spec = { kind: 'unsloth' as const, model: 'loaded', baseUrl: 'http://127.0.0.1:8888', apiKeyEnv: 'UNSLOTH_API_KEY' };
  // Used to throw here, which left illustration off until a key was exported —
  // for the setup that needs no key at all.
  const keyless = buildImageProvider(spec, {});
  assert.equal(keyless.id, 'unsloth');
  assert.equal(keyless.capabilities.imageConditioning, true);

  const built = buildImageProvider(spec, { UNSLOTH_API_KEY: 'sk-x' });
  assert.equal(built.id, 'unsloth');
  assert.equal(built.capabilities.imageConditioning, true, 'the preset keeps conditioning on');
});
