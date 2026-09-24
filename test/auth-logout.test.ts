/**
 * Signing out ends the session at the identity provider, not only in this browser.
 *
 * Clearing the cookie alone left the provider's session alive, so a copied cookie
 * kept working until it expired (up to `SESSION_MAX_AGE_SECONDS`), refresh token
 * and all. Logout now revokes it too, best effort: a provider that is down must
 * not stop the browser from signing out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { WorkOS } from '@workos-inc/node';
import { createWorkosProvider } from '../src/auth/workos-provider.ts';
import { SESSION_COOKIE, type AuthConfig } from '../src/auth/config.ts';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';

const user = { id: 'user_1', email: 'a@example.com', emailVerified: true, firstName: null, lastName: null };

/** A WorkOS double whose session is live (`sessionId`) or needs a refresh first, and which records revocations. */
function fakeWorkos(opts: { expired?: boolean; revokeFails?: boolean } = {}) {
  const revoked: string[] = [];
  const workos = {
    userManagement: {
      loadSealedSession: () => ({
        authenticate: async () =>
          opts.expired
            ? { authenticated: false as const, reason: 'invalid_jwt' as const }
            : { authenticated: true as const, sessionId: 'session_live', user },
        refresh: async () => ({ authenticated: true as const, sessionId: 'session_refreshed', user, sealedSession: 'resealed' }),
      }),
      revokeSession: async ({ sessionId }: { sessionId: string }) => {
        if (opts.revokeFails) throw new Error('WorkOS is down');
        revoked.push(sessionId);
      },
    },
  } as unknown as WorkOS;
  return { workos, revoked };
}

const provider = (workos: WorkOS) => createWorkosProvider({ workos, clientId: 'client_test', cookiePassword: 'x'.repeat(32) });

test('WorkOS revoke ends the sealed session, refreshing first when its access token has expired', async () => {
  const live = fakeWorkos();
  await provider(live.workos).revoke!('sealed');
  assert.deepEqual(live.revoked, ['session_live']);

  const expired = fakeWorkos({ expired: true });
  await provider(expired.workos).revoke!('sealed');
  assert.deepEqual(expired.revoked, ['session_refreshed']);
});

async function logout(authConfig: AuthConfig) {
  const world = World.open(':memory:');
  seedWorld(world);
  const server = createApiServer({ world, engine: new Engine({ world, providers: new ProviderRegistry(new MockProvider()) }), authConfig });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fetch(`http://127.0.0.1:${port}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${SESSION_COOKIE}=sealed` },
    });
  } finally {
    console.warn = original;
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

const authConfigFor = (workos: WorkOS): AuthConfig => ({
  requireLogin: true,
  adminEmails: new Set(),
  callbackOrigin: 'http://127.0.0.1:4317',
  provider: provider(workos),
});

test('POST /auth/logout revokes the provider session and clears the cookie', async () => {
  const fake = fakeWorkos();
  const res = await logout(authConfigFor(fake.workos));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
  assert.deepEqual(fake.revoked, ['session_live']);
});

test('a provider that cannot revoke does not stop the browser from signing out', async () => {
  const res = await logout(authConfigFor(fakeWorkos({ revokeFails: true }).workos));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
});
