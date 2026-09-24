/**
 * Web login routes: `/auth/login`, `/auth/callback`, `/auth/logout`, plus
 * the gate every other route passes through when login is required. See
 * `src/auth/config.ts` for what "required" means and where it's decided, and
 * `src/auth/provider.ts` for the seam that keeps this file the same whether the
 * identity provider is WorkOS AuthKit or a generic OIDC issuer.
 *
 * PKCE, a one-time OAuth `state`, and an OIDC `nonce`: the provider generates
 * the PKCE verifier, this route generates the state and nonce, and the
 * login-attempt cookie binds all three for one redirect round trip. A small
 * in-memory pending-state set makes the callback one-use, so a copied callback
 * cannot replay after the first exchange. The nonce is carried through to the
 * exchange because an OIDC provider must check the ID token echoes it (OIDC
 * Core §3.1.2.1); the WorkOS SDK has no nonce parameter and verifies the
 * exchange itself, so its provider ignores the value.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AuthConfig } from './config.ts';
import { clearSessionCookie, setSessionCookie, SESSION_MAX_AGE_SECONDS, parseCookies, readSessionCookie } from './config.ts';

const PKCE_COOKIE = 'fabulist_pkce';
const LOGIN_ATTEMPT_MAX_AGE_SECONDS = 600;
const LOGIN_ATTEMPT_MAX_AGE_MS = LOGIN_ATTEMPT_MAX_AGE_SECONDS * 1000;
const MAX_PENDING_OAUTH_STATES = 10_000;
const pendingOAuthStates = new Map<string, { codeVerifier: string; nonce: string; expiresAt: number }>();

interface LoginAttempt {
  codeVerifier: string;
  state: string;
  /** Optional only for backwards compatibility with an attempt cookie set by a build that predates it — such a cookie is one redirect old at most, and an OIDC exchange with no nonce to check is refused by the provider rather than accepted. */
  nonce?: string;
  expiresAt: number;
}

/**
 * Where `getAuthorizationUrl`'s own `redirect_uri` needs to point — this
 * server's own `/auth/callback`, at the origin `resolveAuthConfig` resolved
 * once at startup (`AUTH_PUBLIC_ORIGIN`, or a loopback bind fallback). The
 * old version derived it from this request's `Host`/`X-Forwarded-Proto`
 * headers, on the reasoning that "the URL a redirect names must be one the
 * browser can actually follow back to." That reasoning is sound but the
 * headers are not: a redirect URI is where WorkOS will deliver the user's
 * authorization code, so it is a security boundary, and an attacker who can
 * reach this server directly (bypassing the proxy that would otherwise fix
 * `Host`/`X-Forwarded-*`) could have steered the code to their own host with
 * `Host: evil.example`. The configured origin makes the same "reachable by
 * the browser" guarantee without per-request input — how this server is
 * reached (localhost in dev, a real domain behind a proxy in production) is
 * now deployment configuration rather than something inferred from each
 * request. See `AuthConfig.callbackOrigin` for the full rationale.
 */
function callbackUrl(auth: AuthConfig): string {
  return `${auth.callbackOrigin}/auth/callback`;
}

function cleanupExpiredOAuthStates(now = Date.now()): void {
  // Fixed TTL means insertion order is also expiry order, so stop at the
  // first live state instead of sweeping the whole map on every login.
  for (const [state, attempt] of pendingOAuthStates) {
    if (attempt.expiresAt > now) break;
    pendingOAuthStates.delete(state);
  }
}

function evictOldestOAuthStates(): void {
  while (pendingOAuthStates.size >= MAX_PENDING_OAUTH_STATES) {
    const oldest = pendingOAuthStates.keys().next().value;
    if (oldest === undefined) break;
    pendingOAuthStates.delete(oldest);
  }
}

/** One 32-byte random value, base64url — used for both the OAuth `state` and the OIDC `nonce`, which need the same property (unguessable, unique per attempt) and nothing more. */
function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

function createLoginAttempt(codeVerifier: string, state: string, nonce: string, now = Date.now()): LoginAttempt {
  cleanupExpiredOAuthStates(now);
  evictOldestOAuthStates();
  const attempt = { codeVerifier, state, nonce, expiresAt: now + LOGIN_ATTEMPT_MAX_AGE_MS };
  pendingOAuthStates.set(attempt.state, { codeVerifier, nonce, expiresAt: attempt.expiresAt });
  return attempt;
}

function setPkceCookie(res: ServerResponse, attempt: LoginAttempt, secure: boolean): void {
  const parts = [
    `${PKCE_COOKIE}=${encodeURIComponent(JSON.stringify(attempt))}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${LOGIN_ATTEMPT_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  res.appendHeader('Set-Cookie', parts.join('; '));
}

/** Reads the short-lived PKCE/state login-attempt cookie, or `undefined` if absent, malformed, expired, or no longer pending. */
function readLoginAttemptCookie(req: IncomingMessage, now = Date.now()): LoginAttempt | undefined {
  const raw = parseCookies(req.headers.cookie)[PKCE_COOKIE];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LoginAttempt>;
    if (typeof parsed.codeVerifier !== 'string' || parsed.codeVerifier.length === 0) return undefined;
    if (typeof parsed.state !== 'string' || parsed.state.length === 0) return undefined;
    if (parsed.nonce !== undefined && (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0)) return undefined;
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return undefined;
    return { codeVerifier: parsed.codeVerifier, state: parsed.state, nonce: parsed.nonce, expiresAt: parsed.expiresAt };
  } catch {
    return undefined;
  }
}

function consumeOAuthState(attempt: LoginAttempt, state: string, now = Date.now()): boolean {
  const pending = pendingOAuthStates.get(attempt.state);
  if (!pending) return false;
  if (pending.expiresAt <= now) {
    pendingOAuthStates.delete(attempt.state);
    return false;
  }
  const valid =
    state === attempt.state &&
    pending.codeVerifier === attempt.codeVerifier &&
    pending.nonce === attempt.nonce &&
    pending.expiresAt === attempt.expiresAt;
  if (valid) pendingOAuthStates.delete(attempt.state);
  return valid;
}

function clearPkceCookie(res: ServerResponse): void {
  res.appendHeader('Set-Cookie', `${PKCE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** `GET /auth/login` — redirects to the identity provider's hosted sign-in. Takes no request: everything it needs (the provider, the callback origin) is startup configuration, which is the point — nothing on this route may be derived from attacker-controllable request headers. */
export async function handleLogin(auth: AuthConfig, res: ServerResponse): Promise<void> {
  // `Secure` follows the configured origin rather than `X-Forwarded-Proto`:
  // a header an attacker can set is not a basis for a cookie's security
  // flags either (same reasoning as the redirect URI above). An https
  // deployment marks the PKCE cookie Secure; a plain-http loopback dev
  // server does not, since browsers drop Secure cookies over http.
  const secure = auth.callbackOrigin.startsWith('https://');
  const state = generateOAuthState();
  const nonce = generateOAuthState();
  const { url, codeVerifier } = await auth.provider.authorize({ redirectUri: callbackUrl(auth), state, nonce });
  const attempt = createLoginAttempt(codeVerifier, state, nonce);
  setPkceCookie(res, attempt, secure);
  res.writeHead(302, { location: url });
  res.end();
}

/**
 * `GET /auth/callback` — exchanges the code for a session, seals it into a
 * cookie, and redirects to `/`. On any failure, redirects back to
 * `/auth/login` rather than surfacing WorkOS's own error page — a failed
 * login should offer "try again," not a stack trace, since the failure
 * modes here (expired code, cookie lost between redirects, user denied
 * consent) are all just "that attempt didn't work," not this server's bug.
 */
export async function handleCallback(auth: AuthConfig, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const attempt = readLoginAttemptCookie(req);

  if (!code || !state || !attempt || !consumeOAuthState(attempt, state)) {
    clearPkceCookie(res);
    res.writeHead(302, { location: '/auth/login' });
    res.end();
    return;
  }

  try {
    const { sealedSession } = await auth.provider.exchangeCode({
      code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: callbackUrl(auth),
      nonce: attempt.nonce ?? '',
    });
    setSessionCookie(auth, res, sealedSession, SESSION_MAX_AGE_SECONDS);
    clearPkceCookie(res);
    res.writeHead(302, { location: '/' });
    res.end();
  } catch (err) {
    // Deliberately no error detail forwarded to the client — see the doc
    // comment above. It *is* logged, though: unlike the failures above (a lost
    // cookie, a replayed callback), a failed exchange is usually a
    // misconfiguration at the identity provider — a redirect URI the issuer
    // does not allow, a wrong client secret, a scope the client may not
    // request — and none of that is diagnosable from a 302 to /auth/login.
    console.error('auth callback: code exchange failed:', err);
    clearPkceCookie(res);
    res.writeHead(302, { location: '/auth/login' });
    res.end();
  }
}

/**
 * `POST /auth/logout` — revokes the session at the provider (`AuthProvider.revoke`),
 * then clears the cookie. Clearing alone signed out this browser but left the
 * provider session, and so any copy of the cookie, working until it expired.
 * Revocation is best effort: a provider outage is logged, and the browser is
 * signed out anyway.
 *
 * Returns the id of the user signed out, or null when there was no valid session.
 */
export async function handleLogout(auth: AuthConfig, req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const sealed = readSessionCookie(req);
  let userId: string | null = null;
  if (sealed) {
    try {
      // Resolved first: a stale session is refreshed here, and a refresh rotates
      // the refresh token, so the revocation must use the renewed cookie.
      const resolved = await auth.provider.resolveSession(sealed);
      userId = resolved?.identity.id ?? null;
      if (resolved) await auth.provider.revoke?.(resolved.resealed ?? sealed);
    } catch (err) {
      console.warn('logout: could not revoke the provider session:', err instanceof Error ? err.message : String(err));
    }
  }
  clearSessionCookie(res);
  res.writeHead(302, { location: '/' });
  res.end();
  return userId;
}
