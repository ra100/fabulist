/**
 * A generic OpenID Connect issuer as an `AuthProvider` — Authelia, Keycloak,
 * Authentik, Zitadel, Dex, Google, or anything else that publishes discovery
 * metadata and speaks authorization-code-with-PKCE.
 *
 * Why this exists: `AUTH_REQUIRE_LOGIN=true` used to mean "WorkOS", full stop,
 * so a self-hoster who already runs an identity provider had to either create a
 * WorkOS account or run with login off — and login-off is loopback-only, which
 * a real deployment is not. The MCP connector already accepted any
 * spec-compliant issuer (`src/mcp/auth.ts`); this brings web login to parity,
 * and with it the property that makes the two halves fit together: point both
 * at the same issuer and a token's `sub` *is* the `SessionUser.id` the browser
 * session carries, so "log in on the web, connect the connector, same stories"
 * needs no translation between two id spaces.
 *
 * What this file owns that the WorkOS path gets from its SDK:
 *
 * - **The exchange.** A plain authorization-code + PKCE token request, with the
 *   ID token verified against the issuer's published JWKS (`jose`, the same
 *   library and the same key-source rules the MCP check uses), including the
 *   `nonce` binding that makes a stolen-and-replayed ID token useless.
 * - **The cookie.** WorkOS seals its own session; here the session is sealed
 *   with `jose`'s encrypted JWT (`dir` + `A256GCM`) under a key derived from
 *   `AUTH_COOKIE_PASSWORD`. So the cookie is encrypted *and* authenticated, and
 *   its contents (subject, email, name, refresh token) are never readable by
 *   the browser or by anything else that gets hold of the cookie value alone.
 * - **Renewal.** If the issuer granted a refresh token (`offline_access`), the
 *   session is re-validated against the issuer whenever the access token
 *   expires, which is what makes a disabled account stop working here within
 *   the access token's lifetime rather than at cookie expiry. If it granted
 *   none — the common default, since many issuers only mint refresh tokens for
 *   clients that ask — the sealed cookie stands on its own until it expires
 *   (`SESSION_MAX_AGE_SECONDS`), the same way any app-session-after-SSO design
 *   works. That tradeoff is the operator's to make, so it is logged once rather
 *   than decided here.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify } from 'jose';
import { DiscoveryError, fetchIssuerMetadata, isTrustedKeySource } from './oidc-discovery.ts';
import type { AuthIdentity, AuthProvider, AuthorizationRequest, CodeExchange, ResolvedSession } from './provider.ts';

export interface OidcProviderOptions {
  /** The issuer's base URL, exactly as it appears in its own metadata `issuer` field (no trailing slash). */
  issuer: string;
  clientId: string;
  /** Omitted for a public client, which PKCE alone protects. Present for the more usual confidential client. */
  clientSecret?: string;
  /** Requested scopes. `openid` is mandatory; `email` is what the admin allowlist needs; `offline_access` is what buys refresh-backed revocation. */
  scopes: string[];
  /** 32+ chars; the session cookie's encryption key is derived from it. */
  cookiePassword: string;
  /** How long a sealed cookie stays valid. Passed in rather than imported so this module owns no session policy — `resolveAuthConfig` hands it `SESSION_MAX_AGE_SECONDS`, the same lifetime the WorkOS path uses. */
  sessionMaxAgeSeconds: number;
  /** Bounds one metadata-discovery attempt. Exists for tests. */
  discoveryTimeoutMs?: number;
}

/** How long one discovery attempt — every candidate metadata URL, bodies included — may take in total. Every concurrent request waits on the same attempt, so an issuer that accepts connections and never answers must not hold login open indefinitely. */
const DISCOVERY_TIMEOUT_MS = 10_000;

/** How long a token request (code exchange, refresh) may take. A login the issuer never answers has to fail, not hang the request handler. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fallback lifetime for the verified identity when the token response says
 * nothing about how long its access token is good for and the ID token carries
 * no `exp` either (both are unusual; neither is worth refusing a login over).
 * An hour matches what mainstream issuers actually mint.
 */
const DEFAULT_IDENTITY_TTL_SECONDS = 60 * 60;

/** The sealed cookie's claim set. Short names because this rides in a cookie on every request; `exp`/`iat` are `jose`'s own and validated by it. */
interface SealedClaims {
  /** Subject — the provider's stable user id. */
  sub: string;
  /** Email, or absent if the issuer published none. */
  em?: string;
  /** Given name. */
  gn?: string;
  /** Family name. */
  fn?: string;
  /** When the verified identity goes stale and must be re-validated, epoch seconds. Only acted on when `rt` is present — with no refresh token there is nothing to re-validate against. */
  vex: number;
  /** Refresh token, when the issuer granted one. */
  rt?: string;
}

interface TokenResponse {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
}

interface Endpoints {
  authorization: string;
  token: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  userinfo?: string;
  /** From `token_endpoint_auth_methods_supported`; decides Basic vs. form-body client authentication. */
  authMethods: string[];
}

/**
 * The cookie key is derived rather than used raw: `AUTH_COOKIE_PASSWORD` is a
 * human-supplied string of arbitrary length and entropy distribution, and
 * `A256GCM` needs exactly 32 bytes. HKDF is the standard answer, and the fixed
 * salt/info pair domain-separates this key from any other use of the same
 * password (there is none today; there being none is not something to rely on).
 */
function sealingKey(cookiePassword: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', cookiePassword, 'fabulist.oidc.session.v1', 'session-cookie', 32));
}

function claimString(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Names, from whichever claims the issuer actually publishes. `given_name`/
 * `family_name` are the OIDC standard claims; a single `name` is what several
 * issuers send instead (Authelia's `profile` scope, for one), and splitting it
 * on the first space is better than showing a signed-in user no name at all.
 */
function namesFrom(claims: Record<string, unknown>): { firstName: string | null; lastName: string | null } {
  const given = claimString(claims, 'given_name');
  const family = claimString(claims, 'family_name');
  if (given || family) return { firstName: given ?? null, lastName: family ?? null };
  const full = claimString(claims, 'name');
  if (!full) return { firstName: null, lastName: null };
  const space = full.indexOf(' ');
  if (space === -1) return { firstName: full, lastName: null };
  return { firstName: full.slice(0, space), lastName: full.slice(space + 1) };
}

function identityFrom(claims: Record<string, unknown>): AuthIdentity {
  const { firstName, lastName } = namesFrom(claims);
  return { id: String(claims.sub), email: claimString(claims, 'email') ?? '', firstName, lastName };
}

export function createOidcProvider(options: OidcProviderOptions): AuthProvider {
  const { clientId, clientSecret, scopes, cookiePassword, sessionMaxAgeSeconds } = options;
  const issuer = options.issuer.replace(/\/$/, '');
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  if (!isTrustedKeySource(issuer)) {
    throw new Error(
      `AUTH_OIDC_ISSUER must be an https URL (plain http only on a loopback address), got ${issuer}. Anyone who can substitute the issuer's signing keys can mint sessions this server accepts, so its metadata may only be read over an authenticated channel.`,
    );
  }
  const key = sealingKey(cookiePassword);
  const scope = scopes.join(' ');
  let warnedAboutRefresh = false;

  // Discovery is one network round-trip, so it cannot happen at construction
  // time — that runs at boot, before anything is listening, and a temporarily
  // unreachable issuer must not stop the server from starting. It happens on
  // first use and is memoized from then on (as is `createRemoteJWKSet`'s own
  // key cache, which is why the *set* is kept rather than just the URI). A
  // failed resolution clears the memo so the next request retries instead of
  // pinning a transient DNS blip for the process's lifetime.
  let endpointsPromise: Promise<Endpoints> | undefined;

  function resolveEndpoints(): Promise<Endpoints> {
    if (!endpointsPromise) {
      endpointsPromise = discoverEndpoints().catch((err) => {
        endpointsPromise = undefined;
        throw err;
      });
    }
    return endpointsPromise;
  }

  async function discoverEndpoints(): Promise<Endpoints> {
    let found: Awaited<ReturnType<typeof fetchIssuerMetadata>>;
    try {
      found = await fetchIssuerMetadata(issuer, discoveryTimeoutMs);
    } catch (err) {
      if (err instanceof DiscoveryError) {
        throw new Error(
          `${err.message}. AUTH_OIDC_ISSUER must be the issuer's base URL — the one its own metadata names, e.g. https://auth.example.com for a document at https://auth.example.com/.well-known/openid-configuration.`,
        );
      }
      throw err;
    }
    const { url, doc } = found;
    const authorization = claimString(doc, 'authorization_endpoint');
    const token = claimString(doc, 'token_endpoint');
    const jwksUri = claimString(doc, 'jwks_uri');
    const missing = [!authorization && 'authorization_endpoint', !token && 'token_endpoint', !jwksUri && 'jwks_uri'].filter(Boolean);
    if (missing.length) {
      throw new Error(`${url} is missing ${missing.join(', ')} — not a usable OpenID Connect issuer for web login`);
    }
    // The same rule the keys themselves are held to, applied to every endpoint
    // this flow trusts: the token endpoint receives the authorization code (and
    // the client secret), so a cleartext one would hand both to anyone on the
    // path, and an issuer that advertises one is misconfigured rather than
    // something to accommodate.
    for (const [name, endpoint] of [
      ['authorization_endpoint', authorization!],
      ['token_endpoint', token!],
      ['jwks_uri', jwksUri!],
    ] as const) {
      if (!isTrustedKeySource(endpoint)) {
        throw new Error(`${url} advertises ${name} ${endpoint}, which is not https (or loopback http) — refusing to send credentials or read keys over cleartext`);
      }
    }
    const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? doc.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
      : [];
    const pkceMethods = Array.isArray(doc.code_challenge_methods_supported)
      ? doc.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string')
      : [];
    if (pkceMethods.length && !pkceMethods.includes('S256')) {
      // Sent anyway: a challenge the issuer ignores costs nothing, whereas not
      // sending one would silently drop the protection on issuers whose
      // metadata simply understates what they support.
      console.warn(`OIDC login: ${issuer} does not advertise PKCE S256 support (code_challenge_methods_supported: ${pkceMethods.join(', ')}); sending S256 regardless`);
    }
    const userinfo = claimString(doc, 'userinfo_endpoint');
    return {
      authorization: authorization!,
      token: token!,
      jwks: createRemoteJWKSet(new URL(jwksUri!)),
      userinfo: userinfo && isTrustedKeySource(userinfo) ? userinfo : undefined,
      authMethods: methods,
    };
  }

  /**
   * Client authentication at the token endpoint. `client_secret_basic` is the
   * spec's default and what most issuers prefer, but a few accept only
   * `client_secret_post`, so the advertised list decides when it says anything.
   * A public client (no secret) sends `client_id` in the body and nothing else,
   * which is exactly what PKCE is for.
   */
  function clientAuth(endpoints: Endpoints, body: URLSearchParams): Record<string, string> {
    if (!clientSecret) {
      body.set('client_id', clientId);
      return {};
    }
    const preferPost = endpoints.authMethods.length > 0 && !endpoints.authMethods.includes('client_secret_basic') && endpoints.authMethods.includes('client_secret_post');
    if (preferPost) {
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
      return {};
    }
    // RFC 6749 §2.3.1: both halves are form-urlencoded before base64, which
    // matters for a generated secret containing `+` or `/`.
    const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    return { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` };
  }

  async function postToken(endpoints: Endpoints, body: URLSearchParams): Promise<TokenResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...clientAuth(endpoints, body),
    };
    const res = await fetch(endpoints.token, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The issuer's own `error`/`error_description` is the only useful part of
      // a failed token request, and it is not secret (it describes the request
      // this server just made). The response body is not forwarded to the
      // browser either way — see `handleCallback`.
      const detail = await res.text().catch(() => '');
      throw new Error(`token endpoint ${endpoints.token} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
    const parsed: unknown = await res.json();
    if (!parsed || typeof parsed !== 'object') throw new Error(`token endpoint ${endpoints.token} did not return a JSON object`);
    return parsed as TokenResponse;
  }

  /**
   * Verifies an ID token the way OIDC Core requires: the issuer's own published
   * key, `iss` matching the configured issuer, `aud` containing this client, and
   * — on a fresh login — the `nonce` this server generated for that one attempt.
   * Everything else in the flow rests on this, so it is `jose` doing the
   * cryptography and claim checks rather than anything hand-rolled here.
   */
  async function verifyIdToken(endpoints: Endpoints, idToken: unknown, expectedNonce?: string): Promise<Record<string, unknown>> {
    if (typeof idToken !== 'string' || !idToken) throw new Error('token response contained no id_token');
    const { payload } = await jwtVerify(idToken, endpoints.jwks, { issuer, audience: clientId });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('id_token has no subject claim');
    if (expectedNonce !== undefined) {
      if (payload.nonce !== expectedNonce) {
        throw new Error('id_token nonce does not match this login attempt — refusing a replayed or substituted token');
      }
    }
    return payload as Record<string, unknown>;
  }

  /**
   * The admin allowlist is by email (`AUTH_ADMIN_EMAILS`), so an issuer that
   * keeps `email` out of the ID token and serves it only from `userinfo` would
   * otherwise leave every admin silently un-admined. One extra request, only
   * when the ID token had no email and the issuer publishes a userinfo
   * endpoint. `sub` is re-checked: a userinfo response describing a different
   * subject is a mix-up (or worse) and its claims must not be merged in.
   */
  async function fillEmailFromUserinfo(endpoints: Endpoints, claims: Record<string, unknown>, accessToken: string | undefined): Promise<Record<string, unknown>> {
    if (claimString(claims, 'email') || !endpoints.userinfo || !accessToken) return claims;
    try {
      const res = await fetch(endpoints.userinfo, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return claims;
      const body: unknown = await res.json();
      if (!body || typeof body !== 'object') return claims;
      const extra = body as Record<string, unknown>;
      if (extra.sub !== claims.sub) return claims;
      return { ...extra, ...claims, email: claimString(extra, 'email') ?? claimString(claims, 'email') };
    } catch {
      // A userinfo failure is not a login failure: the ID token already proved
      // who this is, and the only thing missing is an email used for the admin
      // check, which fails closed on its own.
      return claims;
    }
  }

  async function seal(claims: Record<string, unknown>, tokens: TokenResponse, previous?: SealedClaims): Promise<{ sealed: string; identity: AuthIdentity }> {
    const identity = identityFrom(claims);
    const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : previous?.rt;
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in : undefined;
    const idExp = typeof claims.exp === 'number' ? claims.exp - Math.floor(Date.now() / 1000) : undefined;
    const ttl = expiresIn ?? (idExp && idExp > 0 ? idExp : DEFAULT_IDENTITY_TTL_SECONDS);
    if (!refreshToken && !warnedAboutRefresh) {
      warnedAboutRefresh = true;
      console.warn(
        `OIDC login: ${issuer} issued no refresh token, so a signed-in session is only re-checked against the issuer when its cookie expires (up to 14 days). Add offline_access to AUTH_OIDC_SCOPES (and allow it for this client at the issuer) if a disabled account should lose access sooner.`,
      );
    }
    const payload: SealedClaims = {
      sub: identity.id,
      em: identity.email || undefined,
      gn: identity.firstName ?? undefined,
      fn: identity.lastName ?? undefined,
      vex: Math.floor(Date.now() / 1000) + ttl,
      rt: refreshToken,
    };
    const sealed = await new EncryptJWT({ ...payload })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(clientId)
      .setExpirationTime(`${sessionMaxAgeSeconds}s`)
      .encrypt(key);
    return { sealed, identity };
  }

  return {
    async authorize({ redirectUri, state, nonce }: AuthorizationRequest) {
      const endpoints = await resolveEndpoints();
      // 32 random bytes, base64url — comfortably inside RFC 7636's 43–128
      // character range for a verifier, and the same shape the `state` uses.
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const url = new URL(endpoints.authorization);
      // Whatever query the issuer put in its own authorization endpoint is kept
      // (some deployments carry a tenant or realm hint there); these are set on
      // top of it.
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', scope);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { url: url.toString(), codeVerifier };
    },

    async exchangeCode({ code, codeVerifier, redirectUri, nonce }: CodeExchange) {
      const endpoints = await resolveEndpoints();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      const tokens = await postToken(endpoints, body);
      const verified = await verifyIdToken(endpoints, tokens.id_token, nonce);
      const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
      const claims = await fillEmailFromUserinfo(endpoints, verified, accessToken);
      const { sealed } = await seal(claims, tokens);
      return { sealedSession: sealed };
    },

    /**
     * Three outcomes, in order of how often they happen: the sealed cookie is
     * live and its identity still fresh (the overwhelming majority of
     * requests — no network call at all); the identity has gone stale and a
     * refresh token renews it against the issuer; or the cookie is unsealable,
     * expired, or stale with nothing to renew it, all of which are "not signed
     * in". The first case is why this is cheap enough to run on every request:
     * decrypting a cookie is local work.
     */
    async resolveSession(sealed: string): Promise<ResolvedSession | null> {
      let claims: SealedClaims;
      try {
        // `jose` checks `exp`, `iss` and `aud` here, so a cookie sealed by a
        // different deployment (or for a different client at the same issuer)
        // is rejected rather than trusted for its subject.
        const { payload } = await jwtDecrypt(sealed, key, { issuer, audience: clientId });
        if (typeof payload.sub !== 'string' || !payload.sub) return null;
        claims = payload as unknown as SealedClaims;
      } catch {
        // Tampered, expired, sealed under a different cookie password, or a
        // WorkOS-sealed cookie left over from a provider switch — all just
        // "not signed in", and all indistinguishable to the caller by design.
        return null;
      }
      const identity: AuthIdentity = {
        id: claims.sub,
        email: claims.em ?? '',
        firstName: claims.gn ?? null,
        lastName: claims.fn ?? null,
      };
      const fresh = typeof claims.vex === 'number' && claims.vex > Math.floor(Date.now() / 1000);
      if (fresh || !claims.rt) return { identity };

      const endpoints = await resolveEndpoints();
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: claims.rt });
      if (scope) body.set('scope', scope);
      let tokens: TokenResponse;
      try {
        tokens = await postToken(endpoints, body);
      } catch (err) {
        // A refused refresh is the normal way a revoked or logged-out session
        // ends, so it is "not signed in" rather than an error to propagate.
        console.warn(`OIDC login: refresh failed for ${claims.sub}, treating as signed out: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      // A refresh response MAY omit the ID token (OIDC Core §12.2). When it
      // does, the subject is not re-asserted, so the cookie's existing identity
      // is kept — the issuer accepting the refresh token is itself the
      // statement that this session is still good.
      const refreshedClaims = tokens.id_token !== undefined ? await verifyIdToken(endpoints, tokens.id_token) : undefined;
      if (refreshedClaims && refreshedClaims.sub !== claims.sub) {
        console.warn(`OIDC login: refresh for ${claims.sub} returned a token for ${String(refreshedClaims.sub)} — refusing to switch identity mid-session`);
        return null;
      }
      // A refreshed ID token need not repeat every claim the original carried,
      // and `email` in particular is what the admin allowlist reads — so the
      // cookie's own values stand in wherever the new token is silent, rather
      // than a refresh quietly demoting an admin.
      const base: Record<string, unknown> = refreshedClaims
        ? {
            ...refreshedClaims,
            email: claimString(refreshedClaims, 'email') ?? claims.em,
            given_name: claimString(refreshedClaims, 'given_name') ?? claims.gn,
            family_name: claimString(refreshedClaims, 'family_name') ?? claims.fn,
          }
        : { sub: claims.sub, email: claims.em, given_name: claims.gn, family_name: claims.fn };
      const { sealed: resealed, identity: renewed } = await seal(base, tokens, claims);
      return { identity: renewed, resealed };
    },

    describe() {
      const client = clientSecret ? `client ${clientId}` : `public client ${clientId}`;
      return `login required (OpenID Connect, issuer ${issuer}, ${client}, scope "${scope}")`;
    },
  };
}
