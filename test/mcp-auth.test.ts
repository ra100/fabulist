/**
 * MCP bearer-token verification (`src/mcp/auth.ts`). See `.design/MCP-CONNECTOR.md`
 * §1 for why this file exists at all — MCP requires the server to check a
 * real access token on every call, not a session cookie.
 *
 * OAuth mode is tested against a real local HTTP server serving a real JWKS
 * document and real JWTs signed with `jose`, not a hand-rolled stub of the
 * verification logic — the whole point of using `jose`/`jwtVerify` here
 * (rather than decoding a JWT by hand, this codebase's more usual style) is
 * that the cryptographic and claim-checking logic is exactly what a test
 * should not reimplement in miniature. See `WikiClient`'s own tests
 * (`test/ingest.test.ts`) for the same "spin up a real local server" pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { buildMcpAuth, buildOAuthAuth, InvalidTokenError, MissingTokenError } from '../src/mcp/auth.ts';

interface IssuerOptions {
  /**
   * Which metadata document the issuer publishes, if any. `'none'` is an
   * issuer that publishes neither — the shape this server used to assume of
   * everyone, and the only one the `/oauth2/jwks` fallback still serves.
   */
  discovery?: 'openid-configuration' | 'oauth-authorization-server' | 'none';
  /**
   * Where the keys actually live. Deliberately *not* AuthKit's `/oauth2/jwks`
   * by default: an issuer that serves its keys anywhere else is precisely what
   * a hardcoded path cannot verify.
   */
  jwksPath?: string;
  /** Also serve the keys at AuthKit's path, for the last-resort fallback. */
  alsoServeAuthKitPath?: boolean;
  /** What the metadata document claims its own `issuer` is (RFC 8414 §3.3). */
  claimedIssuer?: string;
}

/**
 * A local stand-in for a real OIDC/OAuth issuer: a metadata document at a
 * well-known path pointing at a JWKS document somewhere the client could not
 * have guessed. Non-AuthKit deployments (Keycloak, Authelia, Zitadel,
 * Authentik) differ from AuthKit in exactly this way and no other, so this is
 * the whole of what has to be faked.
 */
async function startIssuer(jwk: Record<string, unknown>, opts: IssuerOptions = {}) {
  const discovery = opts.discovery ?? 'openid-configuration';
  const jwksPath = opts.jwksPath ?? '/keys/signing-keys.json';
  let issuer = '';
  const server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (discovery !== 'none' && req.url === `/.well-known/${discovery}`) {
      json({ issuer: opts.claimedIssuer ?? issuer, jwks_uri: `${issuer}${jwksPath}` });
      return;
    }
    if (req.url === jwksPath || (opts.alsoServeAuthKitPath && req.url === '/oauth2/jwks')) {
      json({ keys: [jwk] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  issuer = `http://127.0.0.1:${port}`;
  return { server, issuer, jwksUri: `${issuer}${jwksPath}` };
}

/** An RS256 keypair plus the public JWK the issuer above will publish. */
async function signingKey() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, jwk };
}

function signFor(
  privateKey: CryptoKey,
  issuer: string,
  audience: string,
  claims: Record<string, unknown> = { sub: 'user_abc123' },
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('1h')
    .sign(privateKey);
}

// -------------------------------------------------------------- dev token

test('dev-token mode accepts the exact configured secret', async () => {
  const auth = buildMcpAuth({ MCP_DEV_TOKEN: 'super-secret-dev-token' });
  assert.ok(auth);
  const user = await auth!.verify('Bearer super-secret-dev-token');
  assert.equal(user.userId, 'dev');
});

test('dev-token mode rejects a wrong secret', async () => {
  const auth = buildMcpAuth({ MCP_DEV_TOKEN: 'super-secret-dev-token' });
  await assert.rejects(() => auth!.verify('Bearer wrong-token'), InvalidTokenError);
});

test('dev-token mode rejects a token of a different length without leaking which', async () => {
  const auth = buildMcpAuth({ MCP_DEV_TOKEN: 'super-secret-dev-token' });
  await assert.rejects(() => auth!.verify('Bearer short'), InvalidTokenError);
});

test('a missing Authorization header is reported distinctly from an invalid one', async () => {
  const auth = buildMcpAuth({ MCP_DEV_TOKEN: 'x' });
  await assert.rejects(() => auth!.verify(undefined), MissingTokenError);
  await assert.rejects(() => auth!.verify('not-a-bearer-header'), MissingTokenError);
});

test('neither MCP_OAUTH_ISSUER nor MCP_DEV_TOKEN configured means no auth object at all', () => {
  assert.equal(buildMcpAuth({}), null);
});

test('MCP_OAUTH_ISSUER takes priority over MCP_DEV_TOKEN when both are set', () => {
  const auth = buildMcpAuth({ MCP_OAUTH_ISSUER: 'https://example.authkit.app', MCP_DEV_TOKEN: 'x' });
  assert.match(auth!.describe(), /OAuth/);
});

test("dev-token mode's protected-resource metadata still shapes correctly for a client that insists on discovery", () => {
  const auth = buildMcpAuth({ MCP_DEV_TOKEN: 'x', MCP_RESOURCE_URL: 'http://127.0.0.1:4317/mcp' });
  const meta = auth!.protectedResourceMetadata('http://127.0.0.1:4317/mcp');
  assert.equal(meta.resource, 'http://127.0.0.1:4317/mcp');
  assert.deepEqual(meta.bearer_methods_supported, ['header']);
});

// ------------------------------------------------------------------ OAuth

test('OAuth mode verifies a real JWT against a real remote JWKS', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk);

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await new SignJWT({ sub: 'user_abc123' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(`${issuer}/mcp`)
      .setExpirationTime('1h')
      .sign(privateKey);

    const user = await auth.verify(`Bearer ${jwt}`);
    assert.equal(user.userId, 'user_abc123');
  } finally {
    server.close();
  }
});

test('OAuth mode rejects a token from the wrong issuer', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk);

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await new SignJWT({ sub: 'user_abc123' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer('https://a-different-issuer.example')
      .setAudience(`${issuer}/mcp`)
      .setExpirationTime('1h')
      .sign(privateKey);

    await assert.rejects(() => auth.verify(`Bearer ${jwt}`), InvalidTokenError);
  } finally {
    server.close();
  }
});

test('OAuth mode rejects a token for the wrong audience (a different MCP server\u2019s token)', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk);

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await new SignJWT({ sub: 'user_abc123' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience('https://someone-elses-mcp-server.example/mcp')
      .setExpirationTime('1h')
      .sign(privateKey);

    await assert.rejects(() => auth.verify(`Bearer ${jwt}`), InvalidTokenError);
  } finally {
    server.close();
  }
});

test('OAuth mode rejects an expired token', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk);

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await new SignJWT({ sub: 'user_abc123' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(issuer)
      .setAudience(`${issuer}/mcp`)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    await assert.rejects(() => auth.verify(`Bearer ${jwt}`), InvalidTokenError);
  } finally {
    server.close();
  }
});

test('OAuth mode rejects a token with no subject claim', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk);

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(`${issuer}/mcp`)
      .setExpirationTime('1h')
      .sign(privateKey);

    await assert.rejects(() => auth.verify(`Bearer ${jwt}`), InvalidTokenError);
  } finally {
    server.close();
  }
});

test('protectedResourceMetadata in OAuth mode names the real issuer', () => {
  const auth = buildOAuthAuth('https://real.authkit.app', 'https://mcp.example.com/mcp');
  const meta = auth.protectedResourceMetadata('https://mcp.example.com/mcp');
  assert.deepEqual(meta.authorization_servers, ['https://real.authkit.app']);
});

// ------------------------------------------------- JWKS location discovery

test('OAuth mode discovers a non-AuthKit jwks_uri from the issuer\u2019s OIDC metadata', async () => {
  // The regression: this issuer serves its keys at /keys/signing-keys.json and
  // nothing at all at AuthKit's /oauth2/jwks, which is every non-WorkOS OIDC
  // provider (Authelia, Keycloak, Zitadel, Authentik) as far as this file is
  // concerned. Verification has to follow the metadata document to find them.
  const { privateKey, jwk } = await signingKey();
  const { server, issuer, jwksUri } = await startIssuer(jwk);

  try {
    assert.ok(!jwksUri.endsWith('/oauth2/jwks'));
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const user = await auth.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    assert.equal(user.userId, 'user_abc123');
  } finally {
    server.close();
  }
});

test('OAuth mode falls back to RFC 8414 metadata when the issuer publishes no OIDC document', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk, { discovery: 'oauth-authorization-server' });

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const user = await auth.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    assert.equal(user.userId, 'user_abc123');
  } finally {
    server.close();
  }
});

test('OAuth mode still verifies against /oauth2/jwks for an issuer that publishes no metadata at all', async () => {
  // The last-resort fallback, i.e. the previously shipped AuthKit behaviour:
  // discovery failing must not take down a deployment that worked before it
  // existed.
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk, { discovery: 'none', jwksPath: '/oauth2/jwks' });

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const user = await auth.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    assert.equal(user.userId, 'user_abc123');
  } finally {
    server.close();
  }
});

test('an explicit MCP_OAUTH_JWKS_URI skips discovery entirely', async () => {
  const { privateKey, jwk } = await signingKey();
  const { server, issuer, jwksUri } = await startIssuer(jwk, { discovery: 'none' });

  try {
    const auth = buildMcpAuth({
      MCP_OAUTH_ISSUER: issuer,
      MCP_OAUTH_AUDIENCE: `${issuer}/mcp`,
      MCP_OAUTH_JWKS_URI: jwksUri,
    });
    const user = await auth!.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    assert.equal(user.userId, 'user_abc123');
    assert.match(auth!.describe(), new RegExp(`jwks=${jwksUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    server.close();
  }
});

test('a metadata document naming a different issuer is not used as a key source', async () => {
  // RFC 8414 §3.3: a document whose `issuer` is someone else is a mix-up, not
  // a place to fetch signing keys from. Skipping it leaves this issuer with no
  // usable key source at all, which is the fail-closed direction.
  const { privateKey, jwk } = await signingKey();
  const { server, issuer } = await startIssuer(jwk, { claimedIssuer: 'https://attacker.example' });

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    const jwt = await signFor(privateKey, issuer, `${issuer}/mcp`);
    await assert.rejects(() => auth.verify(`Bearer ${jwt}`), InvalidTokenError);
  } finally {
    server.close();
  }
});

test('discovery happens once and is reused across verifications', async () => {
  const { privateKey, jwk } = await signingKey();
  const { privateKey: otherKey } = await signingKey();
  let metadataHits = 0;
  const { server, issuer } = await startIssuer(jwk);
  server.prependListener('request', (req) => {
    if (req.url?.startsWith('/.well-known/')) metadataHits += 1;
  });

  try {
    const auth = buildOAuthAuth(issuer, `${issuer}/mcp`);
    await auth.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    await auth.verify(`Bearer ${await signFor(privateKey, issuer, `${issuer}/mcp`)}`);
    // A rejected token must not re-trigger discovery either.
    const wrongKeyJwt = await signFor(otherKey, issuer, `${issuer}/mcp`);
    await assert.rejects(() => auth.verify(`Bearer ${wrongKeyJwt}`), InvalidTokenError);
    assert.equal(metadataHits, 1);
  } finally {
    server.close();
  }
});
