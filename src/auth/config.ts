/**
 * Web login: hosted sign-in for the browser UI, against either WorkOS
 * AuthKit or any OpenID Connect issuer (Authelia, Keycloak, Authentik,
 * Zitadel — whatever a self-hoster already runs). Which one is a single
 * environment variable, `AUTH_PROVIDER`; everything below this line is the
 * same either way, because the provider-specific half lives behind
 * `AuthProvider` (`src/auth/provider.ts`).
 *
 * Distinct from `src/mcp/auth.ts`, which is the MCP connector's own
 * bearer-token check — that one verifies tokens Claude/ChatGPT present on
 * every tool call; this one is a session cookie for a human sitting at a
 * browser, set once at login and read on every request after. Point both at
 * the same issuer and the two line up by construction: a token's `sub` is the
 * `SessionUser.id` a browser session for the same person carries.
 *
 * Two-tier access, not one: any verified identity may sign in and
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
import { createOidcProvider } from './oidc-provider.ts';
import type { AuthIdentity, AuthProvider, ResolvedSession } from './provider.ts';
import { createWorkosProvider } from './workos-provider.ts';

export interface AuthConfig {
  requireLogin: boolean;
  /**
   * Who authenticates the user, and how — WorkOS AuthKit or a generic OIDC
   * issuer. Everything else on this interface is policy that holds whichever
   * it is; see `src/auth/provider.ts` for where the line falls and why.
   */
  provider: AuthProvider;
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
 * Resolves whether login is required and, if so, builds the provider that
 * will do the authenticating (`AUTH_PROVIDER`: `workos`, the default, or
 * `oidc`). Returns `null` when login is off — every call site reads that as "mount
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

  // Built before the callback origin is resolved, deliberately: a deployment
  // missing both its credentials and its public origin should be told about the
  // credentials first, since that is the error an operator hits on the very
  // first boot of a new install.
  const provider = buildProvider(env);

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

  return { requireLogin: true, provider, adminEmails, callbackOrigin };
}

/** Which login mechanism a deployment runs. `workos` stays the default so an existing AuthKit deployment needs no new variable. */
export type AuthProviderKind = 'workos' | 'oidc';

/**
 * Which provider to build, from `AUTH_PROVIDER`.
 *
 * Unset is inferred rather than defaulted blindly: if `AUTH_OIDC_ISSUER` is
 * there, the operator has plainly configured an OIDC issuer and does not also
 * need to say so twice; otherwise it is WorkOS, which is what every deployment
 * predating this option already was. An unrecognized value throws rather than
 * silently falling back — the same fail-loud posture `parseRequireLoginEnv`
 * takes, and for the same reason: quietly picking the other provider would
 * either break login outright or (worse) start a second, separate identity
 * space in which nobody owns any of the existing stories.
 */
export function resolveProviderKind(env: Record<string, string | undefined>): AuthProviderKind {
  const raw = env.AUTH_PROVIDER?.trim().toLowerCase();
  if (raw) {
    if (raw === 'workos' || raw === 'authkit') return 'workos';
    if (raw === 'oidc' || raw === 'openid' || raw === 'openid-connect') return 'oidc';
    throw new Error(
      `AUTH_PROVIDER=${JSON.stringify(env.AUTH_PROVIDER)} is not recognized. Accepted: "workos" (WorkOS AuthKit, the default) or "oidc" (any OpenID Connect issuer — Authelia, Keycloak, Authentik, Zitadel, Dex, …).`,
    );
  }
  return env.AUTH_OIDC_ISSUER?.trim() ? 'oidc' : 'workos';
}

/**
 * The session cookie's encryption key, from `AUTH_COOKIE_PASSWORD` or the
 * WorkOS-named `WORKOS_COOKIE_PASSWORD` it used to be spelled as.
 *
 * Both names are accepted for either provider: the value is a symmetric key
 * this server uses to seal its own cookie, nothing about it is WorkOS-specific,
 * and an existing deployment must not have to rename a working variable to
 * switch providers. 32 characters is WorkOS's own documented minimum and a
 * sensible floor for the HKDF input the OIDC path derives an AES-256 key from.
 *
 * `missingAs` is the name reported when it is absent, so each provider's error
 * message names the variable that provider's documentation tells you to set.
 */
function readCookiePassword(env: Record<string, string | undefined>): string | undefined {
  return env.AUTH_COOKIE_PASSWORD?.trim() || env.WORKOS_COOKIE_PASSWORD?.trim() || undefined;
}

function assertCookiePasswordLength(cookiePassword: string, name: string): void {
  if (cookiePassword.length < 32) {
    throw new Error(
      `${name} must be at least 32 characters (WorkOS's own session-sealing minimum, and the floor for the key the OIDC session cookie is encrypted with); got ${cookiePassword.length}.`,
    );
  }
}

function buildProvider(env: Record<string, string | undefined>): AuthProvider {
  return resolveProviderKind(env) === 'oidc' ? buildOidcProviderFromEnv(env) : buildWorkosProviderFromEnv(env);
}

function buildWorkosProviderFromEnv(env: Record<string, string | undefined>): AuthProvider {
  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = readCookiePassword(env);
  const missing = [
    !apiKey && 'WORKOS_API_KEY',
    !clientId && 'WORKOS_CLIENT_ID',
    !cookiePassword && 'WORKOS_COOKIE_PASSWORD',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `AUTH_REQUIRE_LOGIN is on but missing: ${missing.join(', ')}. Login cannot start with no way to reach WorkOS or seal a session. If you do not use WorkOS, point this server at your own identity provider instead: AUTH_PROVIDER=oidc with AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, AUTH_OIDC_CLIENT_SECRET and AUTH_COOKIE_PASSWORD.`,
    );
  }
  assertCookiePasswordLength(cookiePassword!, 'WORKOS_COOKIE_PASSWORD');
  return createWorkosProvider({
    workos: new WorkOS(apiKey!, { clientId: clientId! }),
    clientId: clientId!,
    cookiePassword: cookiePassword!,
  });
}

/**
 * Scopes for the OIDC path. `openid` is what makes it an OIDC request at all
 * and is added back if an operator's list omits it; `profile` and `email` are
 * what fill in a display name and the address `AUTH_ADMIN_EMAILS` is checked
 * against. `offline_access` is deliberately *not* default: an issuer that has
 * not granted that scope to this client rejects the whole authorization request
 * when it is asked for, so defaulting it on would break first-time logins on
 * exactly the self-hosted setups this path exists for. Add it (both here and at
 * the issuer) to get refresh-backed sessions — see `createOidcProvider`.
 */
function parseScopes(raw: string | undefined): string[] {
  const requested = (raw ?? 'openid profile email')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return requested.includes('openid') ? requested : ['openid', ...requested];
}

function buildOidcProviderFromEnv(env: Record<string, string | undefined>): AuthProvider {
  const issuer = env.AUTH_OIDC_ISSUER?.trim();
  const clientId = env.AUTH_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.AUTH_OIDC_CLIENT_SECRET?.trim() || undefined;
  const cookiePassword = readCookiePassword(env);
  const missing = [
    !issuer && 'AUTH_OIDC_ISSUER',
    !clientId && 'AUTH_OIDC_CLIENT_ID',
    !cookiePassword && 'AUTH_COOKIE_PASSWORD',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `AUTH_PROVIDER=oidc but missing: ${missing.join(', ')}. AUTH_OIDC_ISSUER is your identity provider's base URL (the one its own /.well-known/openid-configuration names as "issuer"), AUTH_OIDC_CLIENT_ID is the client you registered there for this server, and AUTH_COOKIE_PASSWORD (32+ chars) is the key its session cookie is sealed with.`,
    );
  }
  assertCookiePasswordLength(cookiePassword!, 'AUTH_COOKIE_PASSWORD');
  // No client secret is a public client, which is legitimate — PKCE is what
  // protects the exchange either way — but it is worth one line in the log,
  // since the far more common cause is a secret that failed to reach the
  // process (an unexported variable, a .env that was not read).
  if (!clientSecret) {
    console.warn(
      `OIDC login: no AUTH_OIDC_CLIENT_SECRET set — treating ${clientId} as a public client authenticated by PKCE alone. Set it if you registered a confidential client at ${issuer}.`,
    );
  }
  return createOidcProvider({
    issuer: issuer!,
    clientId: clientId!,
    clientSecret,
    scopes: parseScopes(env.AUTH_OIDC_SCOPES),
    cookiePassword: cookiePassword!,
    sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
  });
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
 * `secure` follows the configured, admin-set `callbackOrigin` rather than
 * the per-request `X-Forwarded-Proto` header (issue #25): that header is
 * only trustworthy when it is guaranteed to have been set by a reverse
 * proxy fronting this process and stripped from anything a client could
 * send directly — a guarantee this server has no way to check, and one a
 * deployment that binds Node directly to a public interface (no proxy at
 * all) does not have. An attacker who can reach the process directly could
 * otherwise send `X-Forwarded-Proto: https` over a plain HTTP connection
 * and get a `Secure` cookie the browser will still send in the clear.
 * `callbackOrigin` has no such gap: it is startup configuration
 * (`AUTH_PUBLIC_ORIGIN`, or the loopback dev default), never derived from
 * any request, so its scheme is exactly what this deployment is actually
 * reachable over — the same reasoning `handleLogin`'s PKCE cookie already
 * follows for `Secure`. A `secure` cookie set over plain HTTP is simply
 * dropped by the browser — silently, with no error, which is why a
 * loopback dev server (`callbackOrigin` starts `http://`) must not mark it
 * `Secure` either.
 */
export function setSessionCookie(auth: AuthConfig, res: ServerResponse, sealed: string, maxAgeSeconds: number): void {
  const secure = auth.callbackOrigin.startsWith('https://');
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
 * no cookie at all, or a renewal that itself fails (refresh token also
 * expired/revoked) are all just "not logged in" to a caller, since nothing on
 * this side needs to distinguish *why* a caller should be shown the login
 * page.
 *
 * The provider does the provider-specific part (unseal, and renew when the
 * short-lived token inside has expired but the session as a whole has not);
 * this function does the two things that are the same for every provider.
 *
 * First, it writes a renewed cookie back to the browser when the provider
 * hands one back, so the *browser's* stored cookie advances past its old
 * access token rather than re-running the renewal on every subsequent
 * request. Access tokens are short-lived by design — on the order of an hour —
 * while the cookie is good for `SESSION_MAX_AGE_SECONDS` (14 days), and this
 * write-back is the whole reason the cookie's stated lifetime is what a user
 * actually experiences. It re-seals with the full lifetime, not the remainder:
 * a session renewed on day 3 should not be good for less time than one created
 * today. Pass `res` whenever one is available (every real HTTP request has
 * one); it is optional only so a caller with no response to write to still
 * compiles — such a caller silently skips the rewrite and re-renews on its
 * very next call, which is correct, just less efficient.
 *
 * Second, it catches. This runs inside an `async` request-handler callback
 * with no surrounding try/catch of its own (`api.ts`/`api-pg.ts`'s
 * server-level catch only wraps matched-route dispatch, which happens *after*
 * the session gate calls this), so an uncaught rejection here would escape as
 * an unhandled promise rejection — Node's default is to crash the whole
 * process on one of those, taking every other in-flight request down with it
 * over what is, from a caller's perspective, just an expired or unreachable
 * session. An identity-provider outage or network blip is therefore treated
 * the same as "not logged in" (logged, not thrown), which degrades every
 * current session to a re-login rather than the server itself going down.
 */
export async function verifySession(auth: AuthConfig, req: IncomingMessage, res?: ServerResponse): Promise<SessionUser | null> {
  const sealed = readSessionCookie(req);
  if (!sealed) return null;
  let resolved: ResolvedSession | null;
  try {
    resolved = await auth.provider.resolveSession(sealed);
  } catch (err) {
    console.error('verifySession: provider.resolveSession() threw:', err);
    return null;
  }
  if (!resolved) return null;
  if (resolved.resealed && res) setSessionCookie(auth, res, resolved.resealed, SESSION_MAX_AGE_SECONDS);
  return toSessionUser(auth, resolved.identity);
}

/**
 * Adds the one thing no provider gets to decide: whether this person may
 * touch system-wide settings. Resolved against `AuthConfig.adminEmails` (see
 * its own doc comment), by email, case-insensitively — and `false` for an
 * identity carrying no email at all, or one the issuer has not verified, which
 * is the fail-closed direction and the shape `mcpSessionUser` already uses on
 * the connector side.
 */
export function toSessionUser(auth: Pick<AuthConfig, 'adminEmails'>, identity: AuthIdentity): SessionUser {
  return {
    id: identity.id,
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    isAdmin: identity.emailVerified === true && identity.email !== '' && auth.adminEmails.has(identity.email.toLowerCase()),
  };
}
