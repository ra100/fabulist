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
import { UnslothAuth, defaultAgentApiKeyPath, defaultDesktopSecretPath } from '../src/providers/unslothAuth.ts';

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
  assert.deepEqual(resolved, { ok: true, token: 'sk-unsloth-real', source: 'api-key' });
  assert.equal(calls.length, 0, 'a key is already a bearer credential — nothing to exchange');
  assert.equal(auth.hasExplicitKey(), true);
});

test('with no key, the local desktop secret is exchanged for a token', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(resolved.ok, 'the desktop secret should exchange for a token');
  assert.equal(resolved.source, 'desktop-secret', 'this is what makes a local install keyless');
  assert.equal(resolved.token, 'desktop-token');
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
  assert.ok(resolved.ok, 'the password fallback should exchange for a token');
  assert.equal(resolved.source, 'password');
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

  const resolved = await auth.token();
  assert.ok(resolved.ok, 'the password fallback should win after the rejected secret');
  assert.equal(resolved.source, 'password');
  assert.equal(calls.length, 2, 'desktop-login was tried first, then login');
});

test('a current local Studio install reuses its scoped agent key without an exported key', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.headers && new Headers(init.headers).get('authorization'), 'Bearer cached-local-key');
    return new Response(JSON.stringify({ data: [{ id: 'bonsai', loaded: true }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const auth = new UnslothAuth({
    baseUrl: 'http://127.0.0.1:8888',
    fetcher,
    desktopSecretPath: '/missing-desktop-secret',
    agentApiKeyPath: '/agent-api-key.json',
    readFile: async (path) => {
      if (path === '/agent-api-key.json') return JSON.stringify({ servers: { 'http://127.0.0.1:8888': { minted: ['cached-local-key'] } } });
      throw new Error('ENOENT');
    },
  });

  assert.deepEqual(await auth.token(), { ok: true, token: 'cached-local-key', source: 'agent-cache' });
  assert.deepEqual(calls, ['http://127.0.0.1:8888/v1/models']);
});

test('a remote instance with nothing to offer resolves to no-credentials, not a throw', async () => {
  // The honest outcome: no key configured, and no local secret can authenticate
  // a machine that is not this one. Saying so beats a 401 at illustration time.
  const { fetcher } = stub({ desktopOk: false });
  const auth = new UnslothAuth({ baseUrl: 'https://gpu.example.com', fetcher, readFile: noSecret });
  assert.deepEqual(await auth.token(), { ok: false, reason: 'no-credentials' });
  assert.deepEqual(await auth.authHeader(), {}, 'and the header is simply absent');
});

test('an unreachable server reports exchange-failed rather than propagating', async () => {
  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher: dead, readFile: readsSecret });
  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed', 'a secret exists, so this is a failure, not "nothing configured"');
  assert.match(resolved.detail ?? '', /unreachable/);
});

// ------------------------------------------------------- failure distinction

test('a rejected desktop secret with no fallback reports the refusal, not absence', async () => {
  // The case the old null hid: credentials exist and were actively refused.
  // "No local desktop login was available" would send the user to create a key
  // they do not need — the server is up and simply did not accept the secret.
  const { fetcher } = stub({ desktopOk: false });
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed');
  assert.match(resolved.detail ?? '', /desktop login returned 401/);
});

test('a malformed exchange response is reported as such', async () => {
  const fetcher = (async () => new Response('<html>gateway error</html>', { status: 200 })) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed');
  assert.match(resolved.detail ?? '', /malformed response/);
});

test('a 200 with a null JSON body is malformed, not unreachable', async () => {
  // `null` parses as valid JSON, so the guard must catch it explicitly —
  // otherwise reading access_token throws and the failure misreports itself.
  const fetcher = (async () => new Response('null', { status: 200 })) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed');
  assert.match(resolved.detail ?? '', /malformed response/);
});

test('a wrapped network error surfaces the underlying cause, not "fetch failed"', async () => {
  // undici shape: the message is generic; ECONNREFUSED rides in `cause`.
  const wrapped = Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
  const fetcher = (async () => {
    throw wrapped;
  }) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed');
  assert.match(resolved.detail ?? '', /ECONNREFUSED/);
});

test('a timed-out exchange is reported as a timeout', async () => {
  // Waits for the abort signal instead of answering: proves the timeout path,
  // not just any fetch rejection.
  const hanging = (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher: hanging, timeoutMs: 50, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok && resolved.reason === 'exchange-failed');
  assert.match(resolved.detail ?? '', /timed out after 50ms/);
});

test('failure details never carry the secret', async () => {
  const { fetcher } = stub({ desktopOk: false });
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: readsSecret });

  const resolved = await auth.token();
  assert.ok(!resolved.ok);
  assert.doesNotMatch(JSON.stringify(resolved), /a-desktop-secret/);
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

  assert.equal(defaultAgentApiKeyPath({ UNSLOTH_STUDIO_HOME: '/opt/unsloth' }), '/opt/unsloth/auth/agent_api_key.json');
});

test('a blank secret file is treated as absent', async () => {
  const { fetcher, calls } = stub();
  const auth = new UnslothAuth({ baseUrl: 'http://127.0.0.1:8888', fetcher, readFile: async () => '   \n' });
  assert.deepEqual(await auth.token(), { ok: false, reason: 'no-credentials' });
  assert.equal(calls.length, 0, 'nothing is exchanged for whitespace');
});
