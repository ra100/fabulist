/**
 * Web login: AuthKit-hosted sign-in for the browser UI. Distinct from
 * `src/mcp/auth.ts`, which is the MCP connector's own bearer-token check —
 * that one verifies tokens Claude/ChatGPT present on every tool call; this
 * one is a session cookie for a human sitting at a browser, set once at
 * login and read on every request after.
 *
 * Two-tier access, not one: any WorkOS-verified identity may sign in and
 * gets their own stories, fully isolated from every other user's (per-story
 * data — `stories`, chronicle, `style_anchors` — is scoped by
 * `owner_user_id`/`story_id`; see `CurrentStory.worldFor` in
 * `src/store/index.ts`). Separately, `AuthConfig.adminEmails` names who may
 * also see and change *system-wide* settings — LLM/image provider config,
 * canon ingest — which are not per-story at all and would otherwise let any
 * signed-in stranger repoint the whole server's model or spend its ingest
 * budget. "Signed in" answers "is this a real person"; "admin" answers "may
 * this person touch things every user shares."
 *
 * Off on loopback-only local runs, on for a real deployment: see
 * `resolveAuthConfig` below.
 */
import { WorkOS } from '@workos-inc/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config/config.ts';

export interface AuthConfig {
  requireLogin: boolean;
  workos: WorkOS;
  clientId: string;
  /** 32+ chars, required by the SDK's own session-sealing (`sealData`/`unsealData`) — this is the AES key the session cookie is encrypted with, not a login password anyone types. */
  cookiePassword: string;
  /**
   * Lowercased emails allowed to see and change system-wide settings — LLM
   * provider config, image provider config, and canon ingest — none of
   * which is scoped to any one story or user, unlike style/knobs/palette
   * (already per-story, hence per-user; see `stories.knobs`/`.style` and
   * `style_anchors`'s own `story_id` scoping in `schema.sql`). Empty means
   * nobody is an admin — deliberately fail closed rather than treat an
   * unset allowlist as "everyone," since the whole point is that a public
   * deployment must not let an arbitrary signed-in stranger repoint the
   * server's LLM provider or spend its ingest budget.
   */
  adminEmails: Set<string>;
  /**
   * The canonical origin (scheme + host + port, no path) the OAuth
   * `redirect_uri` is built from — `${callbackOrigin}/auth/callback`.
   * Resolved once at startup by `resolveAuthConfig` from `AUTH_PUBLIC_ORIGIN`,
   * falling back to the server's own loopback bind address in local dev.
   * Deliberately never derived from an incoming request's `Host` or
   * `X-Forwarded-*` headers: a redirect URI is where WorkOS will deliver the
   * user's authorization code, so it is a security boundary — an attacker who
   * can reach the server directly (bypassing the proxy that would otherwise
   * fix those headers) could steer the code to their own host by sending
   * `Host: evil.example`. A configured origin cannot be steered per-request;
   * the cost is one env var in a real deployment, which such a deployment must
   * set anyway so its WorkOS app's allowed callback URL matches.
   */
  callbackOrigin: string;
}

/** Loopback hosts whose plain-`http:` origin is safe as a callback URL without TLS — anything else must be `https`, mirroring `src/mcp/auth.ts`'s own rule for issuers. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Validates and normalizes `AUTH_PUBLIC_ORIGIN` into a bare origin
 * (scheme + host + port, no path) for `AuthConfig.callbackOrigin`. Fails
 * loudly rather than guessing — the same posture as `buildMcpAuth` refusing
 * to invent an issuer URL: a subtly wrong callback origin does not crash, it
 * just breaks login at WorkOS's own URL-match check, which is harder to
 * diagnose than a startup error.
 */
function canonicalOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`AUTH_PUBLIC_ORIGIN must be an absolute URL (e.g. https://fabulist.example.com), got ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`AUTH_PUBLIC_ORIGIN must use http or https, got ${u.protocol}//`);
  }
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') {
    throw new Error(
      `AUTH_PUBLIC_ORIGIN must be a bare origin (scheme + host + port, no path), got ${raw} — the callback route is always /auth/callback at the server root.`,
    );
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new Error(
      `AUTH_PUBLIC_ORIGIN uses plain http for a non-loopback host (${u.hostname}): a redirect URI over plain http lets anyone on the path read the authorization code. Use https for public deployments, or http only on loopback (e.g. http://127.0.0.1:4317).`,
    );
  }
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname) && !u.port) {
    throw new Error(`AUTH_PUBLIC_ORIGIN http://${u.hostname} has no port, and the dev server does not listen on 80. Include the port, e.g. http://127.0.0.1:4317.`);
  }
  const host = u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}

/**
 * Resolves whether login is required and, if so, builds the WorkOS client.
 * Returns `null` when login is off — every call site reads that as "mount
 * no auth routes, gate nothing," the same "absent means disabled, not
 * disabled-and-unsafe" shape `src/mcp/auth.ts`'s `buildMcpAuth` already
 * uses for the MCP connector.
 *
 * Priority, matching this codebase's existing pattern for anything
 * env-vs-config (`config.ts`'s own `dbPath` reasoning): `AUTH_REQUIRE_LOGIN`
 * in the environment wins when set at all, because a real deployment's
 * requirement should not silently drift from whatever a committed or
 * locally-edited JSON file says; `config.requireLogin` (from
 * `fabulist.config.json`/its `.local` sibling) is the fallback for someone
 * who wants this behind a config toggle rather than an env var, per the
 * direct request that added this.
 *
 * `bind` is the address this server process actually listens on (`--host`/
 * `--port`, or their env equivalents). It feeds only the callback-origin
 * fallback below: with no `AUTH_PUBLIC_ORIGIN`, a loopback bind yields
 * `http://<bind>/auth/callback` (the local-dev default, header-free), while a
 * non-loopback bind throws — there is no safe default for where `/auth/callback`
 * lives on a public interface, and the one obvious candidate (the request's
 * own `Host` header) is attacker-controllable, which is exactly what the
 * configured origin exists to replace. See `AuthConfig.callbackOrigin`.
 *
 * The env value is parsed by `parseRequireLoginEnv`: any of true/1/yes/on
 * or false/0/no/off (case-insensitive, surrounding whitespace ignored) —
 * so an operator who writes `AUTH_REQUIRE_LOGIN=1` or `TRUE` does not get a
 * silently-open API. Empty means "unset" (fall back to config), and any
 * other value throws rather than guessing, because the two wrong answers
 * are asymmetric: a typo that disables login exposes every route.
 */
export function resolveAuthConfig(
  config: Config,
  env: Record<string, string | undefined> = process.env,
  bind: { host: string; port: number } = { host: '127.0.0.1', port: 4317 },
): AuthConfig | null {
  const parsedEnv = env.AUTH_REQUIRE_LOGIN !== undefined ? parseRequireLoginEnv(env.AUTH_REQUIRE_LOGIN) : undefined;
  const requireLogin = parsedEnv ?? config.requireLogin ?? !isLoopbackHost(bind.host);
  if (!requireLogin) {
    if (!isLoopbackHost(bind.host)) {
      throw new Error(
        `AUTH_REQUIRE_LOGIN is off but --host=${bind.host} is not a loopback address. Login-disabled mode is only allowed on loopback; set AUTH_REQUIRE_LOGIN=true for network-exposed deployments.`,
      );
    }
    return null;
  }

  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;
  const missing = [
    !apiKey && 'WORKOS_API_KEY',
    !clientId && 'WORKOS_CLIENT_ID',
    !cookiePassword && 'WORKOS_COOKIE_PASSWORD',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `AUTH_REQUIRE_LOGIN is on but missing: ${missing.join(', ')}. Login cannot start with no way to reach WorkOS or seal a session.`,
    );
  }
  if (cookiePassword!.length < 32) {
    throw new Error(`WORKOS_COOKIE_PASSWORD must be at least 32 characters (WorkOS's own session-sealing minimum); got ${cookiePassword!.length}.`);
  }

  // Comma-separated, matching the shape every other multi-value env var in
  // this codebase already uses (e.g. `.dockerignore`-adjacent conventions
  // elsewhere are single-value, but a *list* of emails has no single-value
  // precedent to follow, so comma-separated + trim + lowercase is the
  // plainest thing that could work). Unset means no admins at all — see
  // `AuthConfig.adminEmails`'s own doc comment for why that is the safe
  // default, not "everyone."
  const adminEmails = new Set(
    (env.AUTH_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  // The OAuth redirect_uri's origin — see `AuthConfig.callbackOrigin` for why
  // this is config, never request headers. `AUTH_PUBLIC_ORIGIN` wins when set
  // (the real-deployment case: a domain behind a proxy); otherwise a loopback
  // bind falls back to its own address (local dev, zero config), and anything
  // else refuses to start rather than guess.
  const publicOrigin = env.AUTH_PUBLIC_ORIGIN;
  let callbackOrigin: string;
  if (publicOrigin !== undefined && publicOrigin.trim() !== '') {
    callbackOrigin = canonicalOrigin(publicOrigin.trim());
  } else if (isLoopbackHost(bind.host)) {
    const host = bind.host.includes(':') ? `[${bind.host}]` : bind.host;
    callbackOrigin = `http://${host}:${bind.port}`;
  } else {
    throw new Error(
      `AUTH_REQUIRE_LOGIN is on but AUTH_PUBLIC_ORIGIN is not set, and --host=${bind.host} is not a loopback address: there is no safe default for where /auth/callback lives. Building the redirect URI from the request's Host header would make it attacker-controllable (Host-header injection), which AUTH_PUBLIC_ORIGIN exists to prevent. Set it to the origin browsers actually reach, e.g. AUTH_PUBLIC_ORIGIN=https://fabulist.example.com.`,
    );
  }

  return {
    requireLogin: true,
    workos: new WorkOS(apiKey!, { clientId: clientId! }),
    clientId: clientId!,
    cookiePassword: cookiePassword!,
    adminEmails,
    callbackOrigin,
  };
}

/**
 * The boolean spellings `AUTH_REQUIRE_LOGIN` accepts, compared
 * case-insensitively after trimming surrounding whitespace — the set every
 * common env-var consumer (shell, docker, systemd) already treats as a
 * boolean, so `1`, `TRUE`, and ` True ` all mean "yes" instead of silently
 * falling through to "no."
 */
const REQUIRE_LOGIN_TRUTHY = new Set(['true', '1', 'yes', 'on']);
const REQUIRE_LOGIN_FALSY = new Set(['false', '0', 'no', 'off']);

/**
 * Parses one `AUTH_REQUIRE_LOGIN` value. Returns `undefined` for an empty
 * (or whitespace-only) string — the universal "set but blank" shape of an
 * unfilled `.env` placeholder, which must fall back to
 * `config.requireLogin` rather than overriding it — and throws for anything
 * outside the accepted set. Throwing is deliberate fail-closed behavior: a
 * typo like `ture` used to be indistinguishable from "login off," leaving
 * every route open on a deployment whose operator clearly intended the
 * opposite; refusing to start with an actionable message is the only
 * reading that can't expose the API.
 */
export function parseRequireLoginEnv(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (REQUIRE_LOGIN_TRUTHY.has(value)) return true;
  if (REQUIRE_LOGIN_FALSY.has(value)) return false;
  throw new Error(
    `AUTH_REQUIRE_LOGIN=${JSON.stringify(raw)} is not a recognized boolean. Accepted: true/false, 1/0, yes/no, on/off (case-insensitive). Refusing to start rather than guess whether login should be required.`,
  );
}

/** The sealed session cookie's name. `httpOnly`/`sameSite=lax`/`secure` (when the request looks like it arrived over TLS) — a plain server-set cookie, not a client-readable token. */
export const SESSION_COOKIE = 'fabulist_session';

/**
 * How long the *cookie* lives — two weeks, long enough that a returning
 * player is not asked to log in every visit, short enough that a stolen
 * laptop is not a permanent key. Lives here rather than in `routes.ts`
 * (which originally defined it) because `verifySession` below now also
 * needs it, to re-seal a cookie with the same lifetime after a silent
 * refresh — a refreshed session should not get a *shorter* remaining life
 * than a freshly logged-in one just because the refresh happened to land
 * on day 3 rather than day 0.
 *
 * This is deliberately much longer than the *access token* sealed inside
 * the cookie, which WorkOS issues short-lived (on the order of an hour) by
 * design — `verifySession`'s whole refresh path exists to paper over that
 * gap so the cookie's stated 14-day lifetime is what a user actually
 * experiences, not "logged out roughly every hour because nothing ever
 * called session.refresh()."
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

/**
 * Parses a raw `Cookie` header into a name→value map, decoding each value
 * and treating a malformed percent-encoding as "skip this cookie" rather
 * than throwing. This is the one safe-decode every cookie reader on this
 * side goes through — `readSessionCookie` below and `readPkceCookie` in
 * routes.ts both read from it, so a hand-crafted or tampered cookie can
 * never surface as an unhandled `URIError`.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch (err) {
      if (err instanceof URIError) continue;
      throw err;
    }
  }
  return out;
}

export function readSessionCookie(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

/**
 * `secure` is inferred from `X-Forwarded-Proto` (what a reverse proxy sets;
 * see `deploy/nginx/fabulist.conf`'s own `proxy_set_header X-Forwarded-Proto`)
 * rather than hardcoded, because the same code path serves a plain-HTTP
 * local dev server and an HTTPS-terminated-at-the-proxy production one, and
 * a `secure` cookie set over plain HTTP is simply dropped by the browser —
 * silently, with no error, which is a much worse failure than a
 * slightly-too-permissive local cookie no attacker can reach anyway
 * (loopback-only in the local case per `serve.ts`'s own default).
 */
export function setSessionCookie(req: IncomingMessage, res: ServerResponse, sealed: string, maxAgeSeconds: number): void {
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sealed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** True when `email` (case-insensitively) is in `AuthConfig.adminEmails`. See that field's own doc comment for what "admin" actually gates — system-wide settings, not per-story data every user already only sees their own copy of. */
  isAdmin: boolean;
}

/**
 * Verifies the session cookie on an incoming request. Returns `null` on
 * anything short of a fully valid, still-live session — a tampered cookie,
 * no cookie at all, or a refresh that itself fails (refresh token also
 * expired/revoked) are all just "not logged in" to a caller, which mirrors
 * `authenticateWithSessionCookie`'s own three-reason failure enum
 * collapsing to one boolean here, since nothing on this side needs to
 * distinguish *why* a caller should be shown the login page.
 *
 * One case is *not* collapsed to "not logged in": an `invalid_jwt` failure
 * from `session.authenticate()` means the sealed cookie's *access* token
 * has expired, which WorkOS does on the order of an hour — routine, not a
 * sign the user should be asked to log in again, since the cookie also
 * carries a refresh token good for the cookie's own much longer lifetime
 * (`SESSION_MAX_AGE_SECONDS`, 14 days). That case calls `session.refresh()`
 * and, on success, writes a freshly sealed cookie via `res` before
 * returning the user — so the *browser's* stored cookie also advances
 * past its old access token, not just this one request's view of it. Pass
 * `res` whenever one is available (every real HTTP request has one); it is
 * optional only so a caller with no response to write to (none exist in
 * this codebase today, but the type would otherwise force one everywhere)
 * still compiles — such a caller silently skips the refresh-cookie
 * rewrite and would re-hit the same `invalid_jwt` refresh path on its very
 * next call, which is correct, just less efficient.
 *
 * `session.authenticate()`/`session.refresh()` are wrapped in a try/catch
 * rather than left to throw: this runs inside an `async` request-handler
 * callback with no surrounding try/catch of its own (`api.ts`/`api-pg.ts`'s
 * server-level catch only wraps matched-route dispatch, which happens
 * *after* the session gate calls this), so an uncaught rejection here would
 * escape as an unhandled promise rejection — Node's default is to crash the
 * whole process on one of those, taking every other in-flight request down
 * with it over what is, from a caller's perspective, just an expired or
 * unreachable session. A WorkOS outage or network blip is treated the same
 * as "not logged in" (logged, not thrown), which degrades every current
 * session to a re-login rather than the server itself going down.
 */
export async function verifySession(auth: AuthConfig, req: IncomingMessage, res?: ServerResponse): Promise<SessionUser | null> {
  const sealed = readSessionCookie(req);
  if (!sealed) return null;
  const session = auth.workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword: auth.cookiePassword });
  let result: Awaited<ReturnType<typeof session.authenticate>>;
  try {
    result = await session.authenticate();
  } catch (err) {
    console.error('verifySession: session.authenticate() threw:', err);
    return null;
  }
  // RefreshSessionSuccessResponse omits `accessToken` (it hands back a new
  // sealed cookie instead, per the SDK's own Omit<..., 'accessToken'> type),
  // so its `user` is read separately here rather than folding it into
  // `result` above and sharing one destructure below — the two success
  // shapes are similar but not the same type.
  if (!result.authenticated) {
    if (result.reason !== 'invalid_jwt') return null;
    let refreshed: Awaited<ReturnType<typeof session.refresh>>;
    try {
      refreshed = await session.refresh();
    } catch (err) {
      console.error('verifySession: session.refresh() threw:', err);
      return null;
    }
    if (!refreshed.authenticated) return null;
    if (refreshed.sealedSession && res) setSessionCookie(req, res, refreshed.sealedSession, SESSION_MAX_AGE_SECONDS);
    const { user } = refreshed;
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin: auth.adminEmails.has(user.email.toLowerCase()),
    };
  }
  const { user } = result;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    isAdmin: auth.adminEmails.has(user.email.toLowerCase()),
  };
}
