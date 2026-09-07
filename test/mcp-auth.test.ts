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

async function startJwksServer(jwk: Record<string, unknown>) {
  const server = createServer((req, res) => {
    if (req.url === '/oauth2/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { server, issuer: `http://127.0.0.1:${port}` };
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
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const { server, issuer } = await startJwksServer(jwk);

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
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const { server, issuer } = await startJwksServer(jwk);

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
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const { server, issuer } = await startJwksServer(jwk);

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
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const { server, issuer } = await startJwksServer(jwk);

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
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const { server, issuer } = await startJwksServer(jwk);

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
