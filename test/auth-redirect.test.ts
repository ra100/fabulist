/**
 * The OAuth `redirect_uri`'s origin — `AuthConfig.callbackOrigin`
 * (`src/auth/config.ts`) as resolved by `resolveAuthConfig` and consumed by
 * `handleLogin` (`src/auth/routes.ts`). This is the fix for the Host-header
 * injection where the callback URL used to be built from the incoming
 * request's own `Host`/`X-Forwarded-*` headers: a redirect URI is where
 * WorkOS will deliver the user's authorization code, so it is a security
 * boundary, and an attacker who could reach the server directly (bypassing
 * the proxy that would otherwise fix those headers) could have steered the
 * code to their own host with `Host: evil.example`.
 *
 * Two halves are pinned here. The first is origin resolution in
 * `resolveAuthConfig`: `AUTH_PUBLIC_ORIGIN` wins when set (validated
 * strictly — a subtly wrong callback origin breaks login at WorkOS's own
 * URL-match check, so startup fails loudly instead), a loopback bind falls
 * back to its own address for local dev, and a non-loopback bind with no
 * configured origin refuses to start rather than guess. The second is the
 * route itself, exercised end to end through a real HTTP server: requests
 * carrying attacker-controlled `Host`/`X-Forwarded-*` headers still produce
 * the configured callback URL — and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkOS } from '@workos-inc/node';
import { CurrentStory, World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';
import { resolveAuthConfig, type AuthConfig } from '../src/auth/config.ts';
import { createWorkosProvider } from '../src/auth/workos-provider.ts';
import type { Config } from '../src/config/config.ts';

/** `resolveAuthConfig` only reads `config.requireLogin` when the env override is absent, and every test below sets the override — so a bare cast is honest here. */
const cfg = { requireLogin: false } as Config;

function baseEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    AUTH_REQUIRE_LOGIN: 'true',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_test',
    WORKOS_COOKIE_PASSWORD: 'x'.repeat(32),
    ...overrides,
  };
}

// --- Origin resolution in `resolveAuthConfig` -------------------------------

test('AUTH_PUBLIC_ORIGIN is used as the callback origin (https public deployment)', () => {
  const auth = resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'https://fabulist.example.com' }), { host: '0.0.0.0', port: 8080 });
  assert.equal(auth?.callbackOrigin, 'https://fabulist.example.com');
});

test('AUTH_PUBLIC_ORIGIN normalizes a trailing slash and keeps an explicit non-default port', () => {
  const slashed = resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'https://fabulist.example.com/' }), { host: '0.0.0.0', port: 8080 });
  assert.equal(slashed?.callbackOrigin, 'https://fabulist.example.com');
  const ported = resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'https://fabulist.example.com:8443' }), { host: '0.0.0.0', port: 8080 });
  assert.equal(ported?.callbackOrigin, 'https://fabulist.example.com:8443');
});

test('AUTH_PUBLIC_ORIGIN allows plain http only on loopback (the local-dev case)', () => {
  const auth = resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:4317' }), { host: '127.0.0.1', port: 4317 });
  assert.equal(auth?.callbackOrigin, 'http://127.0.0.1:4317');
});

test('AUTH_PUBLIC_ORIGIN refuses plain http for a public host — the authorization code would ride the wire in the clear', () => {
  assert.throws(
    () => resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'http://fabulist.example.com' }), { host: '0.0.0.0', port: 8080 }),
    /plain http/,
  );
});

test('AUTH_PUBLIC_ORIGIN must be a bare origin — no path, query, or hash (the callback route is always at the server root)', () => {
  assert.throws(
    () => resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'https://fabulist.example.com/sub' }), { host: '0.0.0.0', port: 8080 }),
    /bare origin/,
  );
});

test('AUTH_PUBLIC_ORIGIN must be an absolute URL', () => {
  assert.throws(() => resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'fabulist.example.com' }), { host: '0.0.0.0', port: 8080 }), /absolute URL/);
});

test('loopback http without a port is refused — the dev server does not listen on 80, so that origin would never match', () => {
  assert.throws(() => resolveAuthConfig(cfg, baseEnv({ AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1' }), { host: '127.0.0.1', port: 4317 }), /port/);
});

test('with no AUTH_PUBLIC_ORIGIN, a loopback bind falls back to its own address — local dev needs zero config', () => {
  const auth = resolveAuthConfig(cfg, baseEnv(), { host: '127.0.0.1', port: 4317 });
  assert.equal(auth?.callbackOrigin, 'http://127.0.0.1:4317');
});

test('with no AUTH_PUBLIC_ORIGIN, a non-loopback bind refuses to start rather than guess — there is no safe default, and the Host header is not one', () => {
  assert.throws(() => resolveAuthConfig(cfg, baseEnv(), { host: '0.0.0.0', port: 8080 }), /AUTH_PUBLIC_ORIGIN/);
});

test('login off is loopback-only — a public bind with login disabled refuses to start', () => {
  assert.throws(
    () => resolveAuthConfig(cfg, baseEnv({ AUTH_REQUIRE_LOGIN: 'false' }), { host: '0.0.0.0', port: 8080 }),
    /Login-disabled mode is only allowed on loopback/,
  );
});

// --- `handleLogin` end to end: Host-header injection ------------------------

/** A fake WorkOS that records the `redirect_uri` it was asked to build an authorization URL for and echoes it back into the Location, so a test can assert on both what this server sent and what the browser would follow. */
function recordingWorkos(captured: { redirectUri?: string }): WorkOS {
  return {
    userManagement: {
      getAuthorizationUrlWithPKCE: async (params: { redirectUri: string }) => {
        captured.redirectUri = params.redirectUri;
        return {
          url: `https://auth.workos.com/authorize?client_id=client_test&redirect_uri=${encodeURIComponent(params.redirectUri)}`,
          codeVerifier: 'verifier_123',
        };
      },
    },
  } as unknown as WorkOS;
}

function authWith(origin: string, workos: WorkOS): AuthConfig {
  return {
    requireLogin: true,
    adminEmails: new Set(),
    callbackOrigin: origin,
    provider: createWorkosProvider({ workos, clientId: 'client_test', cookiePassword: 'x'.repeat(32) }),
  };
}

/** A raw-socket GET so the test controls every header on the wire — including `Host`, which a normal client derives from the URL and an attacker who talks to the server directly is free to spoof. */
function getRaw(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

function pkceCookie(headers: http.IncomingHttpHeaders): string | undefined {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return undefined;
  return (Array.isArray(setCookies) ? setCookies : [setCookies]).find((c) => c.startsWith('fabulist_pkce='));
}

function stateFromLocation(headers: http.IncomingHttpHeaders): string {
  const location = headers.location;
  assert.equal(typeof location, 'string');
  const state = new URL(location!).searchParams.get('state');
  assert.equal(typeof state, 'string');
  return state!;
}

function statefulWorkos(captured: { authenticateCalls?: number; codeVerifier?: string; code?: string }): WorkOS {
  return {
    userManagement: {
      getAuthorizationUrlWithPKCE: async (params: { redirectUri: string }) => {
        const url = new URL('https://auth.workos.com/authorize');
        url.searchParams.set('client_id', 'client_test');
        url.searchParams.set('redirect_uri', params.redirectUri);
        return { url: url.toString(), codeVerifier: 'verifier_123' };
      },
      authenticateWithCode: async (params: { code: string; codeVerifier: string }) => {
        captured.authenticateCalls = (captured.authenticateCalls ?? 0) + 1;
        captured.code = params.code;
        captured.codeVerifier = params.codeVerifier;
        return { sealedSession: 'sealed_session' };
      },
    },
  } as unknown as WorkOS;
}

async function withAuthServer(authConfig: AuthConfig, fn: (base: string) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const currentStory = new CurrentStory(world.db, world.storyId);
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world: () => currentStory.world(), engine, currentStory, authConfig });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

test('a Host-header injection cannot steer the OAuth redirect URI — WorkOS is told the configured origin, not the attacker\u2019s host', async () => {
  const captured: { redirectUri?: string } = {};
  await withAuthServer(authWith('https://fabulist.example.com', recordingWorkos(captured)), async (base) => {
    const res = await getRaw(base, '/auth/login', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    });
    assert.equal(res.status, 302);
    // What this server asked WorkOS to redirect back to — the security-relevant assertion.
    assert.equal(captured.redirectUri, 'https://fabulist.example.com/auth/callback');
    // And what the browser would actually follow — no attacker host anywhere in it.
    const location = res.headers.location;
    assert.equal(typeof location, 'string');
    assert.match(location!, /redirect_uri=https%3A%2F%2Ffabulist\.example\.com%2Fauth%2Fcallback/);
    assert.doesNotMatch(location!, /evil\.example/);
  });
});

test('the same holds with a spoofed X-Forwarded-Host alone (the header a reverse proxy is supposed to set)', async () => {
  const captured: { redirectUri?: string } = {};
  await withAuthServer(authWith('https://fabulist.example.com', recordingWorkos(captured)), async (base) => {
    const res = await getRaw(base, '/auth/login', { 'x-forwarded-host': 'evil.example' });
    assert.equal(res.status, 302);
    assert.equal(captured.redirectUri, 'https://fabulist.example.com/auth/callback');
  });
});

test('a plain local-dev login (no injected headers) still redirects to the loopback callback', async () => {
  const captured: { redirectUri?: string } = {};
  await withAuthServer(authWith('http://127.0.0.1:4317', recordingWorkos(captured)), async (base) => {
    const res = await getRaw(base, '/auth/login', {});
    assert.equal(res.status, 302);
    assert.equal(captured.redirectUri, 'http://127.0.0.1:4317/auth/callback');
  });
});

test('the PKCE cookie is Secure for an https origin even when the request claims X-Forwarded-Proto: http — security flags follow configuration, not attacker-set headers', async () => {
  const captured: { redirectUri?: string } = {};
  await withAuthServer(authWith('https://fabulist.example.com', recordingWorkos(captured)), async (base) => {
    const res = await getRaw(base, '/auth/login', { 'x-forwarded-proto': 'http' });
    assert.equal(res.status, 302);
    assert.match(pkceCookie(res.headers) ?? '', /Secure/);
  });
});

test('the PKCE cookie is not Secure for a plain-http loopback origin — browsers would drop it over http', async () => {
  const captured: { redirectUri?: string } = {};
  await withAuthServer(authWith('http://127.0.0.1:4317', recordingWorkos(captured)), async (base) => {
    const res = await getRaw(base, '/auth/login', {});
    assert.equal(res.status, 302);
    assert.doesNotMatch(pkceCookie(res.headers) ?? '', /Secure/);
  });
});

test('OAuth login sends a cryptographically random state alongside PKCE and stores the login attempt cookie', async () => {
  const captured: { authenticateCalls?: number } = {};
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const first = await getRaw(base, '/auth/login', {});
    assert.equal(first.status, 302);
    const firstState = stateFromLocation(first.headers);
    assert.match(firstState, /^[A-Za-z0-9_-]{32,}$/);
    assert.match(pkceCookie(first.headers) ?? '', /HttpOnly/);

    const second = await getRaw(base, '/auth/login', {});
    assert.equal(second.status, 302);
    const secondState = stateFromLocation(second.headers);
    assert.notEqual(secondState, firstState);
  });
});

test('OAuth callback rejects a missing state before exchanging the code', async () => {
  const captured: { authenticateCalls?: number } = {};
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const login = await getRaw(base, '/auth/login', {});
    const cookie = pkceCookie(login.headers);
    assert.ok(cookie);

    const callback = await getRaw(base, '/auth/callback?code=auth_code', { cookie: cookie! });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/auth/login');
    assert.equal(captured.authenticateCalls ?? 0, 0);
  });
});

test('OAuth callback rejects a mismatched state before exchanging the code', async () => {
  const captured: { authenticateCalls?: number; codeVerifier?: string } = {};
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const login = await getRaw(base, '/auth/login', {});
    const cookie = pkceCookie(login.headers);
    assert.ok(cookie);
    const state = stateFromLocation(login.headers);

    const callback = await getRaw(base, '/auth/callback?code=auth_code&state=attacker_state', { cookie: cookie! });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/auth/login');
    assert.equal(captured.authenticateCalls ?? 0, 0);

    const validAfterMismatch = await getRaw(base, `/auth/callback?code=auth_code&state=${state}`, { cookie: cookie! });
    assert.equal(validAfterMismatch.status, 302);
    assert.equal(validAfterMismatch.headers.location, '/');
    assert.equal(captured.authenticateCalls, 1);
    assert.equal(captured.codeVerifier, 'verifier_123');
  });
});

test('OAuth callback rejects expired state before exchanging the code', async (t) => {
  const captured: { authenticateCalls?: number } = {};
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const login = await getRaw(base, '/auth/login', {});
    const cookie = pkceCookie(login.headers);
    assert.ok(cookie);
    const state = stateFromLocation(login.headers);

    now += 601_000;
    const callback = await getRaw(base, `/auth/callback?code=auth_code&state=${state}`, { cookie: cookie! });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/auth/login');
    assert.equal(captured.authenticateCalls ?? 0, 0);
  });
});

test('OAuth callback consumes state so a replayed callback is rejected', async () => {
  const captured: { authenticateCalls?: number; code?: string; codeVerifier?: string } = {};
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const login = await getRaw(base, '/auth/login', {});
    const cookie = pkceCookie(login.headers);
    assert.ok(cookie);
    const state = stateFromLocation(login.headers);

    const first = await getRaw(base, `/auth/callback?code=auth_code&state=${state}`, { cookie: cookie! });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, '/');
    assert.equal(captured.authenticateCalls, 1);
    assert.equal(captured.code, 'auth_code');
    assert.equal(captured.codeVerifier, 'verifier_123');
    const setCookies = first.headers['set-cookie'];
    assert.ok((Array.isArray(setCookies) ? setCookies : [setCookies ?? '']).some((c) => c.startsWith('fabulist_session=sealed_session')));
    assert.ok((Array.isArray(setCookies) ? setCookies : [setCookies ?? '']).some((c) => c.startsWith('fabulist_pkce=;')));

    const replay = await getRaw(base, `/auth/callback?code=auth_code&state=${state}`, { cookie: cookie! });
    assert.equal(replay.status, 302);
    assert.equal(replay.headers.location, '/auth/login');
    assert.equal(captured.authenticateCalls, 1);
  });
});

test('OAuth callback binds the state to the matching login-attempt cookie', async () => {
  const captured: { authenticateCalls?: number } = {};
  await withAuthServer(authWith('https://fabulist.example.com', statefulWorkos(captured)), async (base) => {
    const firstLogin = await getRaw(base, '/auth/login', {});
    const firstCookie = pkceCookie(firstLogin.headers);
    const firstState = stateFromLocation(firstLogin.headers);
    assert.ok(firstCookie);

    const secondLogin = await getRaw(base, '/auth/login', {});
    const secondCookie = pkceCookie(secondLogin.headers);
    const secondState = stateFromLocation(secondLogin.headers);
    assert.ok(secondCookie);
    assert.notEqual(secondState, firstState);

    const mismatched = await getRaw(base, `/auth/callback?code=auth_code&state=${secondState}`, { cookie: firstCookie! });
    assert.equal(mismatched.status, 302);
    assert.equal(mismatched.headers.location, '/auth/login');
    assert.equal(captured.authenticateCalls ?? 0, 0);

    const matching = await getRaw(base, `/auth/callback?code=auth_code&state=${secondState}`, { cookie: secondCookie! });
    assert.equal(matching.status, 302);
    assert.equal(matching.headers.location, '/');
    assert.equal(captured.authenticateCalls, 1);
  });
});
