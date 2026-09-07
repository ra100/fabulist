/**
 * Unsloth credential resolution.
 *
 * The behaviour under test is the precedence order and, more importantly, that a
 * *local* install needs no API key: Unsloth has no anonymous mode (every useful
 * endpoint carries `security: HTTPBearer`), but `POST /api/auth/desktop-login`
 * exchanges the on-disk desktop secret for a bearer token. Confirmed against a
 * running instance before being relied on here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnslothAuth, defaultDesktopSecretPath } from '../src/providers/unslothAuth.ts';

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

function stub(opts: { desktopOk?: boolean; passwordOk?: boolean } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const ok = (token: string) =>
      new Response(JSON.stringify({ access_token: token, token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (u.includes('/api/auth/desktop-login')) {
      return opts.desktopOk === false ? new Response('{}', { status: 401 }) : ok('desktop-token');
    }
    if (u.includes('/api/auth/login')) {
      return opts.passwordOk ? ok('password-token') : new Response('{}', { status: 401 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const readsSecret = async () => 'a-desktop-secret\n';
const noSecret = async () => {
  throw new Error('ENOENT');
};

// ------------------------------------------------------------------ precedence

test('an explicit api key wins and costs no round trip', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', apiKey: 'sk-unsloth-real', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.deepEqual(resolved, { token: 'sk-unsloth-real', source: 'api-key' });
  assert.equal(calls.length, 0, 'a key is already a bearer credential — nothing to exchange');
  assert.equal(auth.hasExplicitKey(), true);
});

test('with no key, the local desktop secret is exchanged for a token', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.equal(resolved?.source, 'desktop-secret', 'this is what makes a local install keyless');
  assert.equal(resolved?.token, 'desktop-token');
  assert.match(calls[0]!.url, /\/api\/auth\/desktop-login$/);
  assert.equal(calls[0]!.body?.secret, 'a-desktop-secret', 'the secret is trimmed before being sent');
  assert.equal(auth.hasExplicitKey(), false);
});

test('username and password are the documented fallback for a non-desktop install', async () => {
  const { fetcher, calls } = stub({ passwordOk: true });
  const auth = new UnslothAuth({
    baseUrl: 'http://127.0.0.1:8888',
    username: 'unsloth',
    password: 'hunter2',
    fetcher,
    readFile: noSecret,
  });

  const resolved = await auth.token();
  assert.equal(resolved?.source, 'password');
  assert.match(calls.at(-1)!.url, /\/api\/auth\/login$/);
});

test('a rejected desktop secret falls through to the password path', async () => {
  const { fetcher, calls } = stub({ desktopOk: false, passwordOk: true });
  const auth = new UnslothAuth({
    baseUrl: 'http://127.0.0.1:8888',
    username: 'unsloth',
    password: 'hunter2',
    fetcher,
    readFile: readsSecret,
  });

  assert.equal((await auth.token())?.source, 'password');
  assert.equal(calls.length, 2, 'desktop-login was tried first, then login');
});

test('a remote instance with nothing to offer resolves to null, not a throw', async () => {
  // The honest outcome: no key configured, and no local secret can authenticate
  // a machine that is not this one. Saying so beats a 401 at illustration time.
  const { fetcher } = stub({ desktopOk: false });
  const auth = new UnslothAuth({ baseUrl: 'https://gpu.example.com', fetcher, readFile: noSecret });
  assert.equal(await auth.token(), null);
  assert.deepEqual(await auth.authHeader(), {}, 'and the header is simply absent');
});

test('an unreachable server resolves to null rather than propagating', async () => {
  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher: dead, readFile: readsSecret });
  assert.equal(await auth.token(), null);
});

// ---------------------------------------------------------------------- caching

test('an exchanged token is cached, so a burst of calls logs in once', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  for (let i = 0; i < 4; i++) await auth.token();
  assert.equal(calls.length, 1, 'one desktop-login for four resolutions');
});

test('the header helper produces exactly what a request needs', async () => {
  const { fetcher } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });
  assert.deepEqual(await auth.authHeader(), { authorization: 'Bearer desktop-token' });
});

// ------------------------------------------------------------- secret location

test('the secret path follows the documented relocation hook', () => {
  const isolated = defaultDesktopSecretPath({ UNSLOTH_STUDIO_HOME: '/opt/unsloth' });
  assert.equal(isolated, '/opt/unsloth/auth/.desktop_secret');

  const standard = defaultDesktopSecretPath({});
  assert.match(standard, /\.unsloth\/studio\/auth\/\.desktop_secret$/, 'the default desktop install location');
});

test('a blank secret file is treated as absent', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: async () => '   \n' });
  assert.equal(await auth.token(), null);
  assert.equal(calls.length, 0, 'nothing is exchanged for whitespace');
});
