/**
 * Web login routes: `/auth/login`, `/auth/callback`, `/auth/logout`, plus
 * the gate every other route passes through when login is required. See
 * `src/auth/config.ts` for what "required" means and where it's decided.
 *
 * PKCE without a stored `codeVerifier` server-side: `getAuthorizationUrlWithPKCE`
 * generates the verifier and hands it back alongside the URL, and this
 * stores it in a short-lived cookie of its own rather than a server-side
 * session store — there is nothing to clean up, and it survives exactly as
 * long as it needs to (one redirect round trip), which a server-side map
 * keyed by a `state` the browser could still lose would not simplify.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthConfig } from './config.ts';
import { clearSessionCookie, setSessionCookie, SESSION_MAX_AGE_SECONDS } from './config.ts';

const PKCE_COOKIE = 'fabulist_pkce';

/** Where `getAuthorizationUrl`'s own `redirect_uri` needs to point — this server's own `/auth/callback`, at whatever host the request actually arrived on, not a hardcoded guess. Mirrors the reasoning in `src/mcp/auth.ts`/`serve.ts` about `mcpResourceUrl`: the URL a redirect names must be one the browser can actually follow back to, which depends on how this server is being reached (localhost in dev, a real domain behind a proxy in production) and cannot be inferred once and cached. */
function callbackUrl(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const host = req.headers.host ?? '127.0.0.1';
  return `${proto}://${host}/auth/callback`;
}

function setPkceCookie(res: ServerResponse, codeVerifier: string, secure: boolean): void {
  const parts = [`${PKCE_COOKIE}=${encodeURIComponent(codeVerifier)}`, 'Path=/auth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readPkceCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === PKCE_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function clearPkceCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${PKCE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** `GET /auth/login` — redirects to AuthKit's hosted sign-in. */
export async function handleLogin(auth: AuthConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const { url, codeVerifier } = await auth.workos.userManagement.getAuthorizationUrlWithPKCE({
    clientId: auth.clientId,
    provider: 'authkit',
    redirectUri: callbackUrl(req),
  });
  setPkceCookie(res, codeVerifier, secure);
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
  const codeVerifier = readPkceCookie(req);
  clearPkceCookie(res);

  if (!code || !codeVerifier) {
    res.writeHead(302, { location: '/auth/login' });
    res.end();
    return;
  }

  try {
    const result = await auth.workos.userManagement.authenticateWithCode({
      clientId: auth.clientId,
      code,
      codeVerifier,
      session: { sealSession: true, cookiePassword: auth.cookiePassword },
    });
    if (!result.sealedSession) throw new Error('WorkOS did not return a sealed session');
    setSessionCookie(req, res, result.sealedSession, SESSION_MAX_AGE_SECONDS);
    res.writeHead(302, { location: '/' });
    res.end();
  } catch {
    // Deliberately no error detail forwarded to the client — see the doc
    // comment above. Logged server-side would be the next step; this app
    // has no logging layer beyond console.log at boot (see serve.ts), and
    // adding one is out of scope for the login flow itself.
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
