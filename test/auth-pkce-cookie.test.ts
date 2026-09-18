/**
 * Issue #26: the PKCE cookie is read *before* `handleCallback`'s try/catch, so
 * a malformed value (invalid percent-encoding) made `decodeURIComponent` throw
 * a `URIError` that escaped the handler and surfaced as a 500 instead of the
 * intended "redirect back to /auth/login" path. These tests exercise the real
 * `handleCallback` with a minimal fake response so the regression is pinned at
 * the boundary where it matters: a bad cookie must degrade to a login redirect,
 * never an unhandled throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkOS } from '@workos-inc/node';
import type { AuthConfig } from '../src/auth/config.ts';
import { createWorkosProvider } from '../src/auth/workos-provider.ts';
import { handleCallback } from '../src/auth/routes.ts';

function makeAuth(authenticateWithCode: (params: unknown) => Promise<{ sealedSession?: string; user: unknown }>): AuthConfig {
  return {
    requireLogin: true,
    adminEmails: new Set(),
    callbackOrigin: 'http://127.0.0.1:4317',
    provider: createWorkosProvider({
      clientId: 'client_test',
      cookiePassword: 'x'.repeat(32),
      workos: { userManagement: { authenticateWithCode } } as unknown as WorkOS,
    }),
  };
}

function makeReq(cookie: string | undefined): IncomingMessage {
  const headers: Record<string, string> = { 'x-forwarded-proto': 'https' };
  if (cookie !== undefined) headers.cookie = cookie;
  return { headers } as unknown as IncomingMessage;
}

/** Minimal fake response that records the redirect `writeHead` issued. */
function makeRes(): { res: ServerResponse; location: () => string | undefined } {
  let loc: string | undefined;
  const headers = new Map<string, string | string[]>();
  const res = {
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    appendHeader(name: string, value: string) {
      const key = name.toLowerCase();
      const existing = headers.get(key);
      if (existing === undefined) headers.set(key, value);
      else if (Array.isArray(existing)) headers.set(key, [...existing, value]);
      else headers.set(key, [existing, value]);
    },
    writeHead(_status: number, headers?: Record<string, string>) {
      if (headers?.location) loc = headers.location;
    },
    end: () => {},
  } as unknown as ServerResponse;
  return { res, location: () => loc };
}

test('malformed PKCE cookie value degrades to login redirect, does not throw', async () => {
  let authenticateCalled = false;
  const auth = makeAuth(async () => {
    authenticateCalled = true;
    return { sealedSession: 'sealed', user: {} };
  });
  const req = makeReq('fabulist_pkce=bad%ZZvalue; other=thing');
  const { res, location } = makeRes();

  // Before the fix this rejected with a URIError from decodeURIComponent.
  await handleCallback(auth, req, res, new URL('/auth/callback?code=abc123', 'http://localhost'));

  assert.strictEqual(location(), '/auth/login');
  assert.equal(authenticateCalled, false, 'a missing verifier must not reach the code exchange');
});

test('no PKCE cookie redirects to login without calling authenticateWithCode', async () => {
  let authenticateCalled = false;
  const auth = makeAuth(async () => {
    authenticateCalled = true;
    return { sealedSession: 'sealed', user: {} };
  });
  const req = makeReq(undefined);
  const { res, location } = makeRes();

  await handleCallback(auth, req, res, new URL('/auth/callback?code=abc123', 'http://localhost'));

  assert.strictEqual(location(), '/auth/login');
  assert.equal(authenticateCalled, false);
});

test('legacy verifier-only PKCE cookie redirects to login without calling authenticateWithCode', async () => {
  let authenticateCalled = false;
  const auth = makeAuth(async (params) => {
    authenticateCalled = true;
    return { sealedSession: 'sealed', user: {} };
  });
  // State validation now requires the structured login-attempt cookie written
  // by /auth/login; an old verifier-only cookie must fail closed.
  const encoded = encodeURIComponent('my-verifier-123!@#');
  const req = makeReq(`fabulist_pkce=${encoded}; other=thing`);
  const { res, location } = makeRes();

  await handleCallback(auth, req, res, new URL('/auth/callback?code=abc123&state=some-state', 'http://localhost'));

  assert.strictEqual(location(), '/auth/login');
  assert.equal(authenticateCalled, false);
});

test('missing code param redirects to login even with a valid cookie', async () => {
  const auth = makeAuth(async () => ({ sealedSession: 'sealed', user: {} }));
  const req = makeReq('fabulist_pkce=some-verifier');
  const { res, location } = makeRes();

  await handleCallback(auth, req, res, new URL('/auth/callback', 'http://localhost'));

  assert.strictEqual(location(), '/auth/login');
});
