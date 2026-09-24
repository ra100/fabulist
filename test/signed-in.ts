/**
 * Signed-in callers for tests that need more than one identity.
 *
 * The session gate is real — `createApiServer` verifies the cookie through the
 * WorkOS provider — and only WorkOS itself is doubled: the sealed session is the
 * cookie value, so `fabulist_session=alice` is Alice. `admin` is on the admin
 * allowlist; nobody else is.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkOS } from '@workos-inc/node';
import { SESSION_COOKIE, type AuthConfig, type SessionUser } from '../src/auth/config.ts';
import { createWorkosProvider } from '../src/auth/workos-provider.ts';

export const PEOPLE = {
  alice: { id: 'user:alice', email: 'alice@example.com' },
  bob: { id: 'user:bob', email: 'bob@example.com' },
  admin: { id: 'user:admin', email: 'admin@example.com' },
} as const;
export type Who = keyof typeof PEOPLE;

export function sessionUser(who: Who): SessionUser {
  return { ...PEOPLE[who], firstName: null, lastName: null, isAdmin: who === 'admin' };
}

export function fakeAuth(): AuthConfig {
  return {
    requireLogin: true,
    adminEmails: new Set([PEOPLE.admin.email]),
    callbackOrigin: 'http://127.0.0.1:4317',
    provider: createWorkosProvider({
      clientId: 'client_test',
      cookiePassword: 'x'.repeat(32),
      workos: {
        userManagement: {
          loadSealedSession: ({ sessionData }: { sessionData: string }) => ({
            authenticate: async () => {
              const who = PEOPLE[sessionData as Who];
              return who
                ? {
                    authenticated: true as const,
                    user: { id: who.id, email: who.email, emailVerified: true, firstName: null, lastName: null },
                  }
                : { authenticated: false as const, reason: 'invalid_session_cookie' as const };
            },
          }),
        },
      } as unknown as WorkOS,
    }),
  };
}

/** The fields these tests read from a JSON reply; everything else is only logged on failure. */
export interface JsonReply {
  status: number;
  headers: Headers;
  body: { error?: string; storyId?: string; worldId?: number; previewKey?: string };
}
export type AsUser = (who: Who, method: string, path: string, body?: unknown) => Promise<JsonReply>;

/** Listens on a free port and returns a client that signs each request in as `who`. */
export async function listenSignedIn(
  server: Server,
): Promise<{ base: string; as: AsUser; close: () => Promise<void> }> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as: AsUser = (who, method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie: `${SESSION_COOKIE}=${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json() }));
  return { base, as, close: () => new Promise<void>((r) => server.close(() => r())) };
}
