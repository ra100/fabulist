/**
 * Generic OpenID Connect web login (`src/auth/oidc-provider.ts`), and the
 * provider selection in front of it (`resolveAuthConfig`,
 * `src/auth/config.ts`).
 *
 * The regression this starts from: `AUTH_REQUIRE_LOGIN=true` used to mean
 * WorkOS and nothing else, so a self-hoster with their own identity provider
 * got `AUTH_REQUIRE_LOGIN is on but missing: WORKOS_API_KEY, WORKOS_CLIENT_ID,
 * WORKOS_COOKIE_PASSWORD` and no way past it — login-disabled mode being
 * loopback-only, which a real deployment is not.
 *
 * Tested against a real local issuer: a real metadata document, a real JWKS,
 * real RS256 ID tokens signed by `jose`, and a token endpoint that checks the
 * PKCE verifier and the client credentials the way a real one does — the same
 * "spin up an actual server rather than stub the protocol" pattern
 * `test/mcp-auth.test.ts` uses for bearer-token verification, and for the same
 * reason: the part worth testing is whether this codebase speaks the protocol,
 * which a stub of the protocol cannot tell you. The browser half of the flow
 * (`/auth/login` → issuer → `/auth/callback` → a session cookie that
 * `/api/auth/me` accepts) runs through a real `createApiServer` over HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type KeyObject } from 'jose';
import { resolveAuthConfig, resolveProviderKind, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, toSessionUser, type AuthConfig } from '../src/auth/config.ts';
import { createOidcProvider } from '../src/auth/oidc-provider.ts';
import type { Config } from '../src/config/config.ts';
import { CurrentStory, World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';

const CLIENT_ID = 'fabulist';
const CLIENT_SECRET = 'top+secret/value';
const COOKIE_PASSWORD = 'k'.repeat(32);
const REDIRECT_URI = 'https://fabulist.example.com/auth/callback';

/** `resolveAuthConfig` only reads `config.requireLogin` when the env override is absent, and every test below sets the override — so a bare cast is honest here, as in `test/auth-redirect.test.ts`. */
const cfg = { requireLogin: false } as Config;

interface IssuerOptions {
  /** Leave `email` out of the ID token, so the userinfo fallback is what has to supply it. */
  emailOnlyInUserinfo?: boolean;
  /** Assert `email_verified: false`, as an issuer with open, unconfirmed self-registration does. */
  emailUnverified?: boolean;
  /** Grant a refresh token (what `offline_access` buys), enabling the renewal path. */
  refreshTokens?: boolean;
  /** Access-token lifetime the token endpoint advertises. Small values make the renewal path reachable with a mocked clock. */
  expiresIn?: number;
  /** Advertise only `client_secret_post`, the issuers that refuse HTTP Basic. */
  postOnlyClientAuth?: boolean;
  /** Sign ID tokens with a key the published JWKS does not contain. */
  signWithForeignKey?: boolean;
  /** Echo this nonce instead of the one the authorization request asked for. */
  forceNonce?: string;
  /** Omit `id_token` from the *refresh* response, which OIDC Core §12.2 permits. */
  refreshWithoutIdToken?: boolean;
}

interface PendingCode {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
}

interface FakeIssuer {
  url: string;
  close(): void;
  /**
   * Stands in for the user at the issuer's sign-in page: validates the
   * authorization request the server built and hands back the code the issuer
   * would redirect with. Deliberately strict — a missing PKCE challenge or a
   * `response_type` other than `code` fails the test here rather than silently
   * passing because the fake was lenient.
   */
  authorize(authorizationUrl: string): string;
  /** Every request the token endpoint saw, for asserting on client authentication and grant types. */
  tokenRequests: { grant: string; auth: string | undefined; body: URLSearchParams }[];
  userinfoRequests: number;
  /** Rotated on each refresh, so a test can tell a renewed cookie from a stale one. */
  currentRefreshToken: string;
  /** Every token the revocation endpoint was asked to revoke. */
  revokedTokens: string[];
}

async function startIssuer(opts: IssuerOptions = {}): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test-key' };
  const signingKey: KeyObject = (opts.signWithForeignKey ? foreign.privateKey : privateKey) as KeyObject;
  const expiresIn = opts.expiresIn ?? 3600;

  let url = '';
  const codes = new Map<string, PendingCode>();
  const issuer: FakeIssuer = {
    url: '',
    close: () => server.close(),
    tokenRequests: [],
    userinfoRequests: 0,
    currentRefreshToken: 'refresh-1',
    revokedTokens: [],
    authorize(authorizationUrl: string): string {
      const parsed = new URL(authorizationUrl);
      assert.equal(`${parsed.origin}${parsed.pathname}`, `${url}/authorize`);
      assert.equal(parsed.searchParams.get('response_type'), 'code');
      assert.equal(parsed.searchParams.get('client_id'), CLIENT_ID);
      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
      const challenge = parsed.searchParams.get('code_challenge');
      const nonce = parsed.searchParams.get('nonce');
      const redirectUri = parsed.searchParams.get('redirect_uri');
      assert.ok(challenge, 'authorization request carried no PKCE challenge');
      assert.ok(nonce, 'authorization request carried no nonce');
      assert.ok(redirectUri, 'authorization request carried no redirect_uri');
      const code = `code-${codes.size + 1}`;
      codes.set(code, { codeChallenge: challenge, nonce, redirectUri, scope: parsed.searchParams.get('scope') ?? '' });
      return code;
    },
  };

  async function idTokenFor(nonce: string | undefined): Promise<string> {
    const claims: Record<string, unknown> = {
      sub: 'user-42',
      name: 'Ada Lovelace',
      ...(opts.emailOnlyInUserinfo ? {} : { email: 'ada@example.com', email_verified: !opts.emailUnverified }),
      ...(nonce !== undefined ? { nonce: opts.forceNonce ?? nonce } : {}),
    };
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(url)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
  }

  const server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '').split('?')[0];

    if (path === '/.well-known/openid-configuration') {
      json({
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        userinfo_endpoint: `${url}/userinfo`,
        revocation_endpoint: `${url}/revoke`,
        jwks_uri: `${url}/jwks.json`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: opts.postOnlyClientAuth ? ['client_secret_post'] : ['client_secret_basic', 'client_secret_post'],
      });
      return;
    }
    if (path === '/jwks.json') {
      json({ keys: [jwk] });
      return;
    }
    if (path === '/revoke' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        issuer.revokedTokens.push(body.get('token') ?? '');
        if (body.get('token') === issuer.currentRefreshToken) issuer.currentRefreshToken = 'revoked';
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (path === '/userinfo') {
      issuer.userinfoRequests += 1;
      if (req.headers.authorization !== 'Bearer access-token') return json({ error: 'invalid_token' }, 401);
      json({ sub: 'user-42', email: 'ada@example.com', email_verified: !opts.emailUnverified });
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        void (async () => {
          const body = new URLSearchParams(raw);
          const grant = body.get('grant_type') ?? '';
          issuer.tokenRequests.push({ grant, auth: req.headers.authorization, body });

          // Client authentication, exactly as `clientAuth` sends it: HTTP Basic
          // with each half form-urlencoded (RFC 6749 §2.3.1), or the same pair
          // in the body for an issuer that advertises only client_secret_post.
          const header = req.headers.authorization;
          if (header?.startsWith('Basic ')) {
            const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
            if (decodeURIComponent(id ?? '') !== CLIENT_ID || decodeURIComponent(secret ?? '') !== CLIENT_SECRET) {
              return json({ error: 'invalid_client' }, 401);
            }
          } else if (body.get('client_id') === CLIENT_ID && body.get('client_secret') === CLIENT_SECRET) {
            // client_secret_post — fine.
          } else {
            return json({ error: 'invalid_client', error_description: 'no usable client authentication' }, 401);
          }

          if (grant === 'authorization_code') {
            const pending = codes.get(body.get('code') ?? '');
            if (!pending) return json({ error: 'invalid_grant', error_description: 'unknown code' }, 400);
            codes.delete(body.get('code') ?? '');
            const verifier = body.get('code_verifier') ?? '';
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            if (challenge !== pending.codeChallenge) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
            if (body.get('redirect_uri') !== pending.redirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
            return json({
              token_type: 'Bearer',
              access_token: 'access-token',
              expires_in: expiresIn,
              id_token: await idTokenFor(pending.nonce),
              ...(opts.refreshTokens ? { refresh_token: issuer.currentRefreshToken } : {}),
            });
          }
          if (grant === 'refresh_token') {
            if (body.get('refresh_token') !== issuer.currentRefreshToken) {
              return json({ error: 'invalid_grant', error_description: 'stale refresh token' }, 400);
            }
            issuer.currentRefreshToken = `refresh-${Number(issuer.currentRefreshToken.split('-')[1]) + 1}`;
            return json({
              token_type: 'Bearer',
              access_token: 'access-token',
              expires_in: expiresIn,
              refresh_token: issuer.currentRefreshToken,
              // A refresh response MAY omit the ID token; both shapes are real.
              ...(opts.refreshWithoutIdToken ? {} : { id_token: await idTokenFor(undefined) }),
            });
          }
          return json({ error: 'unsupported_grant_type' }, 400);
        })();
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuer.url = url;
  return issuer;
}

function providerFor(issuerUrl: string, overrides: Partial<Parameters<typeof createOidcProvider>[0]> = {}) {
  return createOidcProvider({
    issuer: issuerUrl,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: ['openid', 'profile', 'email'],
    cookiePassword: COOKIE_PASSWORD,
    sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    discoveryTimeoutMs: 2_000,
    ...overrides,
  });
}

/** One full sign-in, driven the way a browser would drive it, returning the sealed cookie the server would have set. */
async function signIn(issuer: FakeIssuer, provider: ReturnType<typeof createOidcProvider>): Promise<string> {
  const { url, codeVerifier } = await provider.authorize({ redirectUri: REDIRECT_URI, state: 'state-1', nonce: 'nonce-1' });
  const code = issuer.authorize(url);
  const { sealedSession } = await provider.exchangeCode({ code, codeVerifier, redirectUri: REDIRECT_URI, nonce: 'nonce-1' });
  return sealedSession;
}

// --- provider selection -----------------------------------------------------

test('AUTH_PROVIDER=oidc starts login with no WorkOS credentials at all — the regression this feature fixes', () => {
  const auth = resolveAuthConfig(
    cfg,
    {
      AUTH_REQUIRE_LOGIN: 'true',
      AUTH_PROVIDER: 'oidc',
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: CLIENT_ID,
      AUTH_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      AUTH_COOKIE_PASSWORD: COOKIE_PASSWORD,
      AUTH_PUBLIC_ORIGIN: 'https://fabulist.example.com',
    },
    { host: '0.0.0.0', port: 8080 },
  );
  assert.ok(auth);
  assert.equal(auth.requireLogin, true);
  assert.match(auth.provider.describe(), /OpenID Connect, issuer https:\/\/auth\.example\.com/);
});

test('AUTH_OIDC_ISSUER alone is enough — the provider is inferred rather than needing AUTH_PROVIDER too', () => {
  assert.equal(resolveProviderKind({ AUTH_OIDC_ISSUER: 'https://auth.example.com' }), 'oidc');
  assert.equal(resolveProviderKind({}), 'workos');
  assert.equal(resolveProviderKind({ AUTH_PROVIDER: 'WorkOS', AUTH_OIDC_ISSUER: 'https://auth.example.com' }), 'workos');
});

test('an unrecognized AUTH_PROVIDER throws rather than silently picking one', () => {
  assert.throws(() => resolveProviderKind({ AUTH_PROVIDER: 'authelia' }), /AUTH_PROVIDER="authelia" is not recognized/);
});

test('the WorkOS-credentials error now points at the OIDC alternative', () => {
  assert.throws(
    () => resolveAuthConfig(cfg, { AUTH_REQUIRE_LOGIN: 'true' }, { host: '0.0.0.0', port: 8080 }),
    /AUTH_REQUIRE_LOGIN is on but missing: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD[\s\S]*AUTH_PROVIDER=oidc/,
  );
});

test('AUTH_PROVIDER=oidc with nothing configured names every variable it needs', () => {
  assert.throws(
    () => resolveAuthConfig(cfg, { AUTH_REQUIRE_LOGIN: 'true', AUTH_PROVIDER: 'oidc' }, { host: '127.0.0.1', port: 4317 }),
    /AUTH_PROVIDER=oidc but missing: AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, AUTH_COOKIE_PASSWORD/,
  );
});

test('the existing WORKOS_COOKIE_PASSWORD is accepted for OIDC too — switching providers must not force a variable rename', () => {
  const auth = resolveAuthConfig(
    cfg,
    {
      AUTH_REQUIRE_LOGIN: 'true',
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: CLIENT_ID,
      WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
    },
    { host: '127.0.0.1', port: 4317 },
  );
  assert.ok(auth);
});

test('a too-short cookie password is refused at startup, naming the variable the operator set', () => {
  assert.throws(
    () =>
      resolveAuthConfig(
        cfg,
        { AUTH_REQUIRE_LOGIN: 'true', AUTH_OIDC_ISSUER: 'https://auth.example.com', AUTH_OIDC_CLIENT_ID: CLIENT_ID, AUTH_COOKIE_PASSWORD: 'short' },
        { host: '127.0.0.1', port: 4317 },
      ),
    /AUTH_COOKIE_PASSWORD must be at least 32 characters/,
  );
});

test('a cleartext non-loopback issuer is refused at construction — its keys decide who may sign in', () => {
  assert.throws(() => providerFor('http://auth.example.com'), /AUTH_OIDC_ISSUER must be an https URL/);
  assert.doesNotThrow(() => providerFor('http://127.0.0.1:9999'));
});

test('scopes default to openid/profile/email, and openid is added back if an operator leaves it out', () => {
  const env = {
    AUTH_REQUIRE_LOGIN: 'true',
    AUTH_OIDC_ISSUER: 'https://auth.example.com',
    AUTH_OIDC_CLIENT_ID: CLIENT_ID,
    AUTH_COOKIE_PASSWORD: COOKIE_PASSWORD,
  };
  assert.match(resolveAuthConfig(cfg, env)!.provider.describe(), /scope "openid profile email"/);
  assert.match(
    resolveAuthConfig(cfg, { ...env, AUTH_OIDC_SCOPES: 'profile email groups' })!.provider.describe(),
    /scope "openid profile email groups"/,
  );
  assert.match(
    resolveAuthConfig(cfg, { ...env, AUTH_OIDC_SCOPES: 'openid, profile, email, offline_access' })!.provider.describe(),
    /scope "openid profile email offline_access"/,
  );
});

// --- the exchange -----------------------------------------------------------

test('a full sign-in: discovery, PKCE, the code exchange, and a session cookie that resolves to the user', async () => {
  const issuer = await startIssuer();
  try {
    const provider = providerFor(issuer.url);
    const sealed = await signIn(issuer, provider);
    const resolved = await provider.resolveSession(sealed);
    assert.equal(resolved?.identity.id, 'user-42');
    assert.equal(resolved?.identity.email, 'ada@example.com');
    // `name` split into given/family, since this issuer publishes no
    // given_name/family_name of its own.
    assert.equal(resolved?.identity.firstName, 'Ada');
    assert.equal(resolved?.identity.lastName, 'Lovelace');
    // No refresh token was granted, so a live session costs no network call.
    assert.equal(resolved?.resealed, undefined);
    assert.deepEqual(
      issuer.tokenRequests.map((r) => r.grant),
      ['authorization_code'],
    );
    assert.ok(issuer.tokenRequests[0]!.auth?.startsWith('Basic '), 'client authenticated with HTTP Basic by default');
  } finally {
    issuer.close();
  }
});

test('client_secret_post is used when the issuer advertises only that', async () => {
  const issuer = await startIssuer({ postOnlyClientAuth: true });
  try {
    const sealed = await signIn(issuer, providerFor(issuer.url));
    assert.ok(sealed);
    assert.equal(issuer.tokenRequests[0]!.auth, undefined);
    assert.equal(issuer.tokenRequests[0]!.body.get('client_secret'), CLIENT_SECRET);
  } finally {
    issuer.close();
  }
});

test('an ID token echoing the wrong nonce is refused — a replayed or substituted token buys nothing', async () => {
  const issuer = await startIssuer({ forceNonce: 'attacker-nonce' });
  try {
    await assert.rejects(() => signIn(issuer, providerFor(issuer.url)), /nonce does not match/);
  } finally {
    issuer.close();
  }
});

test('an ID token signed by a key outside the published JWKS is refused', async () => {
  const issuer = await startIssuer({ signWithForeignKey: true });
  try {
    await assert.rejects(() => signIn(issuer, providerFor(issuer.url)));
  } finally {
    issuer.close();
  }
});

test('the email the admin allowlist needs is fetched from userinfo when the ID token omits it', async () => {
  const issuer = await startIssuer({ emailOnlyInUserinfo: true });
  try {
    const provider = providerFor(issuer.url);
    const resolved = await provider.resolveSession(await signIn(issuer, provider));
    assert.equal(resolved?.identity.email, 'ada@example.com');
    assert.equal(resolved?.identity.emailVerified, true, 'userinfo’s own email_verified comes with its email');
    assert.equal(issuer.userinfoRequests, 1);
  } finally {
    issuer.close();
  }
});

test('an email the issuer has not verified never makes its holder an admin', async () => {
  for (const emailOnlyInUserinfo of [false, true]) {
    const issuer = await startIssuer({ emailUnverified: true, emailOnlyInUserinfo, refreshTokens: true, expiresIn: 1 });
    try {
      const provider = providerFor(issuer.url);
      const sealed = await signIn(issuer, provider);
      const resolved = await provider.resolveSession(sealed);
      assert.equal(resolved?.identity.email, 'ada@example.com');
      assert.equal(resolved?.identity.emailVerified, false);
      const user = toSessionUser({ adminEmails: new Set(['ada@example.com']) }, resolved!.identity);
      assert.equal(user.isAdmin, false, `unverified admin email (userinfo: ${emailOnlyInUserinfo}) must not grant admin`);
    } finally {
      issuer.close();
    }
  }
});

test('logout revokes the refresh token, so a copied cookie cannot be renewed', async (t) => {
  const issuer = await startIssuer({ refreshTokens: true, expiresIn: 60 });
  try {
    const provider = providerFor(issuer.url);
    const sealed = await signIn(issuer, provider);
    await provider.revoke!(sealed);
    assert.deepEqual(issuer.revokedTokens, ['refresh-1']);
    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 120_000);
    const original = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await provider.resolveSession(sealed), null, 'the stale copy is refused at refresh');
    } finally {
      console.warn = original;
    }
  } finally {
    issuer.close();
  }
});

test('a verified admin email survives the sealed cookie and a refresh', async (t) => {
  const issuer = await startIssuer({ refreshTokens: true, expiresIn: 60 });
  try {
    const provider = providerFor(issuer.url);
    const sealed = await signIn(issuer, provider);
    const admins = { adminEmails: new Set(['ada@example.com']) };
    const restored = await provider.resolveSession(sealed);
    assert.equal(toSessionUser(admins, restored!.identity).isAdmin, true, 'read back from the cookie');
    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 120_000);
    const refreshed = await provider.resolveSession(sealed);
    assert.ok(refreshed?.resealed, 'the stale cookie was renewed');
    assert.equal(toSessionUser(admins, refreshed.identity).isAdmin, true, 'after a refresh');
  } finally {
    issuer.close();
  }
});

// --- the session cookie -----------------------------------------------------

test('a session cookie sealed under a different password, or for a different client, is not accepted', async () => {
  const issuer = await startIssuer();
  try {
    const sealed = await signIn(issuer, providerFor(issuer.url));
    assert.equal(await providerFor(issuer.url, { cookiePassword: 'z'.repeat(32) }).resolveSession(sealed), null);
    assert.equal(await providerFor(issuer.url, { clientId: 'other-client' }).resolveSession(sealed), null);
    assert.equal(await providerFor(issuer.url).resolveSession('not-a-sealed-cookie'), null);
  } finally {
    issuer.close();
  }
});

test('a stale session is renewed against the issuer when a refresh token was granted, and re-sealed', async (t) => {
  const issuer = await startIssuer({ refreshTokens: true, expiresIn: 60 });
  try {
    const provider = providerFor(issuer.url, { scopes: ['openid', 'profile', 'email', 'offline_access'] });
    const sealed = await signIn(issuer, provider);

    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 120_000);
    const renewed = await provider.resolveSession(sealed);
    assert.equal(renewed?.identity.id, 'user-42');
    assert.ok(renewed?.resealed, 'a renewed session hands back a fresh cookie for the browser');
    assert.deepEqual(
      issuer.tokenRequests.map((r) => r.grant),
      ['authorization_code', 'refresh_token'],
    );

    // The renewed cookie carries the rotated refresh token: resolving it again
    // must not replay the one the issuer has already consumed.
    const again = await provider.resolveSession(renewed!.resealed!);
    assert.equal(again?.identity.id, 'user-42');
  } finally {
    issuer.close();
  }
});

test('a renewal whose response omits the ID token keeps the identity the cookie already proved', async (t) => {
  const issuer = await startIssuer({ refreshTokens: true, expiresIn: 60, refreshWithoutIdToken: true });
  try {
    const provider = providerFor(issuer.url, { scopes: ['openid', 'profile', 'email', 'offline_access'] });
    const sealed = await signIn(issuer, provider);
    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 120_000);
    const renewed = await provider.resolveSession(sealed);
    assert.equal(renewed?.identity.id, 'user-42');
    assert.equal(renewed?.identity.email, 'ada@example.com');
  } finally {
    issuer.close();
  }
});

test('a refused renewal is a signed-out session, not an error the caller has to handle', async (t) => {
  const issuer = await startIssuer({ refreshTokens: true, expiresIn: 60 });
  try {
    const provider = providerFor(issuer.url, { scopes: ['openid', 'profile', 'email', 'offline_access'] });
    const sealed = await signIn(issuer, provider);
    // What a revoked or logged-out session looks like from here: the issuer no
    // longer honours the refresh token this cookie carries.
    issuer.currentRefreshToken = 'revoked';
    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 120_000);
    assert.equal(await provider.resolveSession(sealed), null);
  } finally {
    issuer.close();
  }
});

test('with no refresh token granted, the sealed cookie stands on its own until it expires', async (t) => {
  const issuer = await startIssuer({ expiresIn: 60 });
  try {
    const provider = providerFor(issuer.url);
    const sealed = await signIn(issuer, provider);
    const real = Date.now();
    let offsetMs = 0;
    t.mock.method(Date, 'now', () => real + offsetMs);

    // Past the access token's lifetime: still signed in, and no token request,
    // because there is nothing to renew against.
    offsetMs = 120_000;
    assert.equal((await provider.resolveSession(sealed))?.identity.id, 'user-42');
    assert.deepEqual(
      issuer.tokenRequests.map((r) => r.grant),
      ['authorization_code'],
    );

  } finally {
    issuer.close();
  }
});

/**
 * The other end of that tradeoff, and the reason the cookie's own expiry is the
 * backstop rather than a formality. Tested with a one-second session lifetime
 * and a real wait rather than a mocked clock: `exp` is enforced by `jose` inside
 * `jwtDecrypt`, against the actual time of day — which is the point, since a
 * cookie that outlived its stated lifetime must not be accepted on the strength
 * of this codebase's own arithmetic.
 */
test('a sealed cookie past its own lifetime is signed out, refresh token or not', async () => {
  const issuer = await startIssuer();
  try {
    const provider = providerFor(issuer.url, { sessionMaxAgeSeconds: 1 });
    const sealed = await signIn(issuer, provider);
    assert.equal((await provider.resolveSession(sealed))?.identity.id, 'user-42');
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(await provider.resolveSession(sealed), null);
  } finally {
    issuer.close();
  }
});

// --- the browser's half, over real HTTP -------------------------------------

function getRaw(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function cookieNamed(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return undefined;
  return (Array.isArray(setCookies) ? setCookies : [setCookies]).find((c) => c.startsWith(`${name}=`));
}

async function withAuthServer(authConfig: AuthConfig, fn: (base: string) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const currentStory = new CurrentStory(world.db, world.storyId);
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world: () => currentStory.world(), engine, currentStory, authConfig });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

test('end to end through the real server: /auth/login → the issuer → /auth/callback → a session /api/auth/me accepts', async () => {
  const issuer = await startIssuer();
  try {
    const authConfig: AuthConfig = {
      requireLogin: true,
      adminEmails: new Set(['ada@example.com']),
      callbackOrigin: 'http://127.0.0.1:4317',
      provider: providerFor(issuer.url),
    };
    await withAuthServer(authConfig, async (base) => {
      // Signed out: an API call is a plain 401, not a redirect.
      const anonymous = await getRaw(base, '/api/auth/me', {});
      assert.equal(anonymous.status, 401);

      const login = await getRaw(base, '/auth/login', {});
      assert.equal(login.status, 302);
      const authorizationUrl = login.headers.location!;
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      assert.match(new URL(authorizationUrl).searchParams.get('scope')!, /^openid profile email$/);
      assert.equal(new URL(authorizationUrl).searchParams.get('redirect_uri'), 'http://127.0.0.1:4317/auth/callback');
      const attemptCookie = cookieNamed(login.headers, 'fabulist_pkce')!.split(';')[0]!;

      // The issuer sends the browser back with a code.
      const code = issuer.authorize(authorizationUrl);
      const callback = await getRaw(base, `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, { cookie: attemptCookie });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.location, '/');
      const sessionCookie = cookieNamed(callback.headers, SESSION_COOKIE)!;
      assert.match(sessionCookie, /HttpOnly/);
      assert.match(sessionCookie, new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));

      const me = await getRaw(base, '/api/auth/me', { cookie: sessionCookie.split(';')[0]! });
      assert.equal(me.status, 200);
      const { user } = JSON.parse(me.body) as { user: { id: string; email: string; isAdmin: boolean } | null };
      assert.equal(user?.id, 'user-42');
      assert.equal(user?.email, 'ada@example.com');
      // The admin allowlist is the same one the WorkOS path and the MCP
      // connector use — an OIDC identity becomes an admin by being on it, and
      // by nothing else.
      assert.equal(user?.isAdmin, true);
    });
  } finally {
    issuer.close();
  }
});

test('a callback the issuer never issued a code for lands back on /auth/login rather than surfacing an error page', async () => {
  const issuer = await startIssuer();
  try {
    const authConfig: AuthConfig = {
      requireLogin: true,
      adminEmails: new Set(),
      callbackOrigin: 'http://127.0.0.1:4317',
      provider: providerFor(issuer.url),
    };
    await withAuthServer(authConfig, async (base) => {
      const login = await getRaw(base, '/auth/login', {});
      const state = new URL(login.headers.location!).searchParams.get('state')!;
      const attemptCookie = cookieNamed(login.headers, 'fabulist_pkce')!.split(';')[0]!;
      const callback = await getRaw(base, `/auth/callback?code=forged&state=${encodeURIComponent(state)}`, { cookie: attemptCookie });
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.location, '/auth/login');
      assert.equal(cookieNamed(callback.headers, SESSION_COOKIE), undefined);
    });
  } finally {
    issuer.close();
  }
});
