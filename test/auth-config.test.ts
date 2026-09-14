/**
 * `verifySession` (`src/auth/config.ts`) — specifically the refresh path
 * added so a 14-day cookie (`SESSION_MAX_AGE_SECONDS`) is what a user
 * actually experiences, rather than "logged out roughly every hour" because
 * WorkOS's *access token* sealed inside the cookie is short-lived and
 * nothing ever called `session.refresh()` on it.
 *
 * Tested against a fake `WorkOS` shaped exactly like the one real seam this
 * function calls through (`workos.userManagement.loadSealedSession(...)`,
 * whose `.authenticate()`/`.refresh()` are the two methods `CookieSession`
 * exposes) — the same pattern `test/api.test.ts`'s `fakeAuthConfig` already
 * uses for `.authenticate()` alone. This does not re-prove WorkOS's own
 * cookie-sealing or JWT verification (already exercised against a real
 * account in the session that added `src/auth/`); it proves this codebase's
 * own branching on the SDK's documented response shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkOS } from '@workos-inc/node';
import {
  verifySession,
  resolveAuthConfig,
  parseRequireLoginEnv,
  readSessionCookie,
  SESSION_COOKIE,
  type AuthConfig,
} from '../src/auth/config.ts';
import { defaultConfig } from '../src/config/config.ts';

type FakeUser = { id: string; email: string };

/**
 * `authenticate` and `refresh` are independently scriptable per test —
 * `authenticate` almost always returns the `invalid_jwt` failure real WorkOS
 * returns once the access token has expired, and `refresh` is what this
 * test actually exercises.
 */
function fakeSession(opts: {
  authenticate: () => Promise<{ authenticated: true; user: FakeUser } | { authenticated: false; reason: string }>;
  refresh?: () => Promise<
    { authenticated: true; user: FakeUser; sealedSession?: string } | { authenticated: false; reason: string }
  >;
}) {
  return {
    authenticate: async () => {
      const r = await opts.authenticate();
      return r.authenticated ? { authenticated: true as const, user: { ...r.user, firstName: null, lastName: null } } : r;
    },
    refresh: async () => {
      if (!opts.refresh) throw new Error('refresh() called but no fake refresh was configured for this test');
      const r = await opts.refresh();
      return r.authenticated
        ? { authenticated: true as const, user: { ...r.user, firstName: null, lastName: null }, sealedSession: r.sealedSession }
        : r;
    },
  };
}

function authConfigWith(session: ReturnType<typeof fakeSession>): AuthConfig {
  return {
    requireLogin: true,
    clientId: 'client_test',
    cookiePassword: 'x'.repeat(32),
    adminEmails: new Set(),
    callbackOrigin: 'http://127.0.0.1:4317',
    workos: {
      userManagement: { loadSealedSession: () => session },
    } as unknown as WorkOS,
  };
}

function fakeReq(cookieValue: string | undefined): IncomingMessage {
  return { headers: { cookie: cookieValue !== undefined ? `${SESSION_COOKIE}=${encodeURIComponent(cookieValue)}` : undefined } } as unknown as IncomingMessage;
}

/** Records every `Set-Cookie` header written, so a test can assert a refresh actually re-sealed the browser's cookie rather than only this one request's in-memory view of the session. */
function fakeRes(): { res: ServerResponse; setCookieCalls: string[] } {
  const setCookieCalls: string[] = [];
  const res = {
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === 'set-cookie') setCookieCalls.push(value);
    },
  } as unknown as ServerResponse;
  return { res, setCookieCalls };
}

test('verifySession returns null with no cookie at all — never calls WorkOS', async () => {
  const auth = authConfigWith(
    fakeSession({ authenticate: async () => assert.fail('authenticate should not be called with no cookie') }),
  );
  const user = await verifySession(auth, fakeReq(undefined));
  assert.equal(user, null);
});

test('readSessionCookie ignores malformed cookie values instead of throwing', () => {
  const req = { headers: { cookie: `broken=%; ${SESSION_COOKIE}=sealed-cookie` } } as unknown as IncomingMessage;
  assert.equal(readSessionCookie(req), 'sealed-cookie');
});

test('readSessionCookie treats a malformed session cookie as absent', () => {
  const req = { headers: { cookie: `${SESSION_COOKIE}=%` } } as unknown as IncomingMessage;
  assert.equal(readSessionCookie(req), undefined);
});

test('verifySession returns the user on a still-valid session — no refresh attempted', async () => {
  const auth = authConfigWith(
    fakeSession({
      authenticate: async () => ({ authenticated: true, user: { id: 'user_1', email: 'a@x.com' } }),
      refresh: async () => assert.fail('refresh should not be called when authenticate already succeeds'),
    }),
  );
  const user = await verifySession(auth, fakeReq('sealed-cookie'));
  assert.equal(user?.id, 'user_1');
  assert.equal(user?.email, 'a@x.com');
});

test('verifySession returns null on a tampered/invalid cookie — does not attempt a refresh', async () => {
  const auth = authConfigWith(
    fakeSession({
      authenticate: async () => ({ authenticated: false, reason: 'invalid_session_cookie' }),
      refresh: async () => assert.fail('refresh should only be attempted for invalid_jwt, not invalid_session_cookie'),
    }),
  );
  const user = await verifySession(auth, fakeReq('garbage'));
  assert.equal(user, null);
});

test('verifySession refreshes and succeeds on an expired access token (invalid_jwt), and re-seals the cookie', async () => {
  const auth = authConfigWith(
    fakeSession({
      authenticate: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
      refresh: async () => ({ authenticated: true, user: { id: 'user_2', email: 'b@x.com' }, sealedSession: 'fresh-sealed-cookie' }),
    }),
  );
  const { res, setCookieCalls } = fakeRes();
  const user = await verifySession(auth, fakeReq('expired-but-refreshable'), res);
  assert.equal(user?.id, 'user_2');
  assert.equal(setCookieCalls.length, 1);
  assert.match(setCookieCalls[0]!, /fresh-sealed-cookie/);
  // The 14-day lifetime, not a shorter one — a refresh must not shrink how
  // long the browser's cookie is good for relative to a fresh login.
  assert.match(setCookieCalls[0]!, /Max-Age=1209600/);
});

test('verifySession returns null when the refresh token has also expired/been revoked', async () => {
  const auth = authConfigWith(
    fakeSession({
      authenticate: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
      refresh: async () => ({ authenticated: false, reason: 'session_expired' }),
    }),
  );
  const { res } = fakeRes();
  const user = await verifySession(auth, fakeReq('long-expired'), res);
  assert.equal(user, null);
});

test('verifySession still works with no res passed (skips the cookie rewrite rather than throwing)', async () => {
  const auth = authConfigWith(
    fakeSession({
      authenticate: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
      refresh: async () => ({ authenticated: true, user: { id: 'user_3', email: 'c@x.com' }, sealedSession: 'fresh' }),
    }),
  );
  const user = await verifySession(auth, fakeReq('expired-but-refreshable'));
  assert.equal(user?.id, 'user_3');
});

/**
 * `resolveAuthConfig`'s `AUTH_REQUIRE_LOGIN` parsing (issue #38): the old
 * `envOverride === 'true'` comparison made `1`, `TRUE`, and padded variants
 * silently fall through to "login off," exposing every route on a deployment
 * whose operator clearly intended the opposite. Now the standard boolean
 * env-var set is accepted case-insensitively, blank means "unset" (fall back
 * to `config.requireLogin`), and anything unrecognized throws — fail closed,
 * because a typo that disables login is the unsafe direction.
 */

/** A full WorkOS env so a test asserting "login required" gets past the missing-credential checks; construction makes no network calls. */
const WORKOS_ENV = {
  WORKOS_API_KEY: 'sk_test_fake',
  WORKOS_CLIENT_ID: 'client_fake',
  WORKOS_COOKIE_PASSWORD: 'x'.repeat(32),
};

test('parseRequireLoginEnv accepts the truthy set case-insensitively, with surrounding whitespace ignored', () => {
  for (const raw of ['true', 'TRUE', 'True', ' true ', '1', 'YES', 'yes', 'ON', ' on ']) {
    assert.equal(parseRequireLoginEnv(raw), true, `expected ${JSON.stringify(raw)} to parse as true`);
  }
});

test('parseRequireLoginEnv accepts the falsy set case-insensitively, with surrounding whitespace ignored', () => {
  for (const raw of ['false', 'FALSE', 'False', ' false ', '0', 'NO', 'no', 'OFF', ' off ']) {
    assert.equal(parseRequireLoginEnv(raw), false, `expected ${JSON.stringify(raw)} to parse as false`);
  }
});

test('parseRequireLoginEnv treats an empty or whitespace-only value as "unset"', () => {
  assert.equal(parseRequireLoginEnv(''), undefined);
  assert.equal(parseRequireLoginEnv('   '), undefined);
});

test('parseRequireLoginEnv throws on unrecognized values instead of guessing', () => {
  for (const raw of ['ture', 'maybe', 'truely', '2', 'true false']) {
    assert.throws(
      () => parseRequireLoginEnv(raw),
      (err: Error) => err.message.includes(JSON.stringify(raw)) && err.message.includes('case-insensitive'),
      `expected ${JSON.stringify(raw)} to throw with an actionable message`,
    );
  }
});

test('resolveAuthConfig: AUTH_REQUIRE_LOGIN=1 requires login even when config says off (env wins)', () => {
  const auth = resolveAuthConfig(
    { ...defaultConfig(), requireLogin: false },
    { AUTH_REQUIRE_LOGIN: '1', ...WORKOS_ENV },
  );
  assert.ok(auth);
  assert.equal(auth.requireLogin, true);
});

test('resolveAuthConfig: padded/mixed-case AUTH_REQUIRE_LOGIN=TRUE requires login (the issue #38 regression)', () => {
  const auth = resolveAuthConfig({ ...defaultConfig() }, { AUTH_REQUIRE_LOGIN: ' TRUE ', ...WORKOS_ENV });
  assert.ok(auth);
  assert.equal(auth.requireLogin, true);
});

test('resolveAuthConfig: explicit falsy env wins over config.requireLogin=true and needs no WorkOS credentials', () => {
  const auth = resolveAuthConfig({ ...defaultConfig(), requireLogin: true }, { AUTH_REQUIRE_LOGIN: 'off' });
  assert.equal(auth, null);
});

test('resolveAuthConfig: blank AUTH_REQUIRE_LOGIN falls back to config.requireLogin (treated as unset)', () => {
  const on = resolveAuthConfig({ ...defaultConfig(), requireLogin: true }, { AUTH_REQUIRE_LOGIN: '', ...WORKOS_ENV });
  assert.ok(on);
  const off = resolveAuthConfig({ ...defaultConfig(), requireLogin: false }, { AUTH_REQUIRE_LOGIN: '   ' });
  assert.equal(off, null);
});

test('resolveAuthConfig: env unset keeps the original config-fallback behavior', () => {
  const on = resolveAuthConfig({ ...defaultConfig(), requireLogin: true }, { ...WORKOS_ENV });
  assert.ok(on);
  const offByDefault = resolveAuthConfig(defaultConfig(), {});
  assert.equal(offByDefault, null);
});

test('resolveAuthConfig: unrecognized AUTH_REQUIRE_LOGIN value throws fail-closed even when WorkOS credentials are present', () => {
  assert.throws(
    () => resolveAuthConfig({ ...defaultConfig() }, { AUTH_REQUIRE_LOGIN: 'ture', ...WORKOS_ENV }),
    /AUTH_REQUIRE_LOGIN="ture" is not a recognized boolean/,
  );
});
