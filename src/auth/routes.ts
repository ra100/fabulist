/**
 * Web login routes: `/auth/login`, `/auth/callback`, `/auth/logout`, plus
 * the gate every other route passes through when login is required. See
 * `src/auth/config.ts` for what "required" means and where it's decided.
 *
 * PKCE plus one-time OAuth `state`: `getAuthorizationUrlWithPKCE` generates
 * the verifier, this route generates a random state, and the login attempt
 * cookie binds both values for one redirect round trip. A small in-memory
 * pending-state set makes the callback one-use, so a copied callback cannot
 * replay after the first exchange.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AuthConfig } from './config.ts';
import { clearSessionCookie, setSessionCookie, SESSION_MAX_AGE_SECONDS, parseCookies } from './config.ts';

const PKCE_COOKIE = 'fabulist_pkce';
const LOGIN_ATTEMPT_MAX_AGE_SECONDS = 600;
const LOGIN_ATTEMPT_MAX_AGE_MS = LOGIN_ATTEMPT_MAX_AGE_SECONDS * 1000;
const MAX_PENDING_OAUTH_STATES = 10_000;
const pendingOAuthStates = new Map<string, { codeVerifier: string; expiresAt: number }>();

interface LoginAttempt {
  codeVerifier: string;
  state: string;
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

function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

function createLoginAttempt(codeVerifier: string, state: string, now = Date.now()): LoginAttempt {
  cleanupExpiredOAuthStates(now);
  evictOldestOAuthStates();
  const attempt = { codeVerifier, state, expiresAt: now + LOGIN_ATTEMPT_MAX_AGE_MS };
  pendingOAuthStates.set(attempt.state, { codeVerifier, expiresAt: attempt.expiresAt });
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
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return undefined;
    return { codeVerifier: parsed.codeVerifier, state: parsed.state, expiresAt: parsed.expiresAt };
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
    pending.expiresAt === attempt.expiresAt;
  if (valid) pendingOAuthStates.delete(attempt.state);
  return valid;
}

function clearPkceCookie(res: ServerResponse): void {
  res.appendHeader('Set-Cookie', `${PKCE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** `GET /auth/login` — redirects to AuthKit's hosted sign-in. Takes no request: everything it needs (client id, callback origin) is startup configuration, which is the point — nothing on this route may be derived from attacker-controllable request headers. */
export async function handleLogin(auth: AuthConfig, res: ServerResponse): Promise<void> {
  // `Secure` follows the configured origin rather than `X-Forwarded-Proto`:
  // a header an attacker can set is not a basis for a cookie's security
  // flags either (same reasoning as the redirect URI above). An https
  // deployment marks the PKCE cookie Secure; a plain-http loopback dev
  // server does not, since browsers drop Secure cookies over http.
  const secure = auth.callbackOrigin.startsWith('https://');
  const state = generateOAuthState();
  const { url, codeVerifier } = await auth.workos.userManagement.getAuthorizationUrlWithPKCE({
    clientId: auth.clientId,
    provider: 'authkit',
    redirectUri: callbackUrl(auth),
  });
  const authorizationUrl = new URL(url);
  authorizationUrl.searchParams.set('state', state);
  const attempt = createLoginAttempt(codeVerifier, state);
  setPkceCookie(res, attempt, secure);
  res.writeHead(302, { location: authorizationUrl.toString() });
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
    const result = await auth.workos.userManagement.authenticateWithCode({
      clientId: auth.clientId,
      code,
      codeVerifier: attempt.codeVerifier,
      session: { sealSession: true, cookiePassword: auth.cookiePassword },
    });
    if (!result.sealedSession) throw new Error('WorkOS did not return a sealed session');
    setSessionCookie(auth, res, result.sealedSession, SESSION_MAX_AGE_SECONDS);
    clearPkceCookie(res);
    res.writeHead(302, { location: '/' });
    res.end();
  } catch {
    // Deliberately no error detail forwarded to the client — see the doc
    // comment above. Logged server-side would be the next step; this app
    // has no logging layer beyond console.log at boot (see serve.ts), and
    // adding one is out of scope for the login flow itself.
    clearPkceCookie(res);
    res.writeHead(302, { location: '/auth/login' });
    res.end();
  }
}

/** `POST /auth/logout` — clears the session cookie. Does not call WorkOS's own session-revocation endpoint (`getLogoutUrl`/session `sid`), since a cleared cookie is sufficient for "this browser is signed out" and there is no server-side session store whose entry would otherwise linger. */
export function handleLogout(res: ServerResponse): void {
  clearSessionCookie(res);
  res.writeHead(302, { location: '/' });
  res.end();
}
