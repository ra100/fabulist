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
import { verifySession, SESSION_COOKIE, type AuthConfig } from '../src/auth/config.ts';

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
