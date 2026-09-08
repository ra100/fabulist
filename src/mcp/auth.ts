/**
 * MCP bearer-token verification. See `.design/MCP-CONNECTOR.md` §1.
 *
 * Two modes, chosen by environment at boot (`buildMcpAuth`, called once from
 * `serve.ts`), never mixed:
 *
 * - **OAuth** (`MCP_OAUTH_ISSUER` set): verifies a JWT against a real OAuth
 *   2.1 authorization server's published JWKS — AuthKit (WorkOS), or any
 *   other spec-compliant issuer. This is the only mode fit for a public,
 *   multi-user deployment: the token's `sub` claim is a real, externally
 *   verified user identity, and the issuer (not this server) runs the whole
 *   authorization-code + Dynamic Client Registration dance the MCP spec
 *   requires (RFC 7591/8414/9728) — see the plan doc for why hand-rolling
 *   that is explicitly not this codebase's usual "implement the protocol
 *   directly" move for once.
 * - **Dev token** (`MCP_DEV_TOKEN` set, `MCP_OAUTH_ISSUER` unset): one
 *   static bearer secret from an environment variable, checked with a
 *   constant-time comparison. Exists so the transport and tools can be
 *   exercised end to end — including against a real Claude/ChatGPT client
 *   — before anyone has created an AuthKit account, or for a genuinely
 *   single-operator deployment where "real OAuth" buys nothing. It maps to
 *   a fixed pseudo-user (`dev`), not a real multi-user identity: this mode
 *   is not what a public, many-user deployment should run behind.
 *
 * Neither configured: the `/mcp` route (`src/server/api.ts`) is not mounted
 * at all, rather than mounted and silently unauthenticated — the one failure
 * direction that matters here is "the tool is unreachable," never
 * "the tool is reachable with no check."
 */
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from 'jose';
import type { SessionUser } from '../auth/config.ts';

export interface VerifiedUser {
  /** Stable subject id from the token — an AuthKit user id in OAuth mode, the literal string `dev` in dev-token mode. */
  userId: string;
  /** For a log line or an audit trail; not used for any access decision. */
  raw: Record<string, unknown>;
}

export interface McpAuth {
  /** Throws on a missing, malformed, expired, or wrong-audience token. Never returns a "maybe". */
  verify(authorizationHeader: string | undefined): Promise<VerifiedUser>;
  /** What `WWW-Authenticate` on a 401, and `/.well-known/oauth-protected-resource`, should point at. */
  protectedResourceMetadata(resourceUrl: string): { resource: string; authorization_servers: string[]; bearer_methods_supported: string[] };
  /** Human-readable, for the boot log — which mode is active and against what, so a misconfiguration is visible on startup rather than on the first 401. */
  describe(): string;
}

/**
 * The verified token's subject, as the same `SessionUser` shape every REST
 * route and `CurrentStory.worldFor` already take.
 *
 * The point is that the ids line up: web login and MCP OAuth both authenticate
 * against the same AuthKit environment, so a token's `sub` *is* the
 * `SessionUser.id` a browser session for the same person carries. That single
 * fact is what makes "log in on the web, connect the connector, same books"
 * true rather than aspirational — nothing here translates between two id
 * spaces, because there is only one.
 *
 * `email`/`firstName`/`lastName` come from the token when the issuer put them
 * there and are blank/null otherwise; nothing about story ownership depends on
 * them, only `id` does. `isAdmin` is resolved against the same `adminEmails`
 * allowlist the cookie path uses, so an MCP connection cannot become an admin
 * by a different route — and is `false` whenever the token carries no email to
 * check, which is the fail-closed direction.
 *
 * Returns `null` when this server has no login configured at all, and that is
 * the load-bearing case rather than an edge one. Story *ownership* only means
 * something where identities do: on a single-operator box (no `authConfig`,
 * typically `MCP_DEV_TOKEN`) there is one reader, the shared current story is
 * the right answer, and minting a per-subject story instead would strand the
 * world's existing book behind a brand-new empty one. So the whole per-user
 * mechanism switches on here, once, and every ownership check downstream
 * no-ops on a null user — exactly the pre-existing behaviour.
 */
export function mcpSessionUser(
  verified: { userId: string; raw: Record<string, unknown> },
  authConfig?: { adminEmails: Set<string> },
): SessionUser | null {
  if (!authConfig) return null;
  const claims = verified.raw;
  const email = typeof claims.email === 'string' ? claims.email : '';
  const firstName = typeof claims.given_name === 'string' ? claims.given_name : null;
  const lastName = typeof claims.family_name === 'string' ? claims.family_name : null;
  return {
    id: verified.userId,
    email,
    firstName,
    lastName,
    isAdmin: !!email && !!authConfig?.adminEmails.has(email.toLowerCase()),
  };
}

class MissingTokenError extends Error {
  constructor() {
    super('no bearer token provided');
  }
}

class InvalidTokenError extends Error {}

export { MissingTokenError, InvalidTokenError };

function extractBearer(header: string | undefined): string {
  const m = header?.match(/^Bearer (.+)$/);
  if (!m?.[1]) throw new MissingTokenError();
  return m[1];
}

/**
 * OAuth mode. `issuer` is the authorization server's base URL (e.g. an
 * AuthKit domain); its JWKS and metadata are fetched from the well-known
 * paths every OAuth 2.0 Authorization Server Metadata (RFC 8414) publisher
 * exposes, AuthKit included (confirmed directly against AuthKit's own docs,
 * not assumed of "any OAuth server").
 *
 * Exported directly, alongside `buildDevTokenAuth` below, rather than only
 * reachable through `buildMcpAuth`'s environment lookup, so
 * `test/mcp-auth.test.ts` can build one against a real local JWKS server
 * without threading values through `process.env` — the environment lookup
 * itself is one line (`buildMcpAuth`) and not worth its own test.
 */
export function buildOAuthAuth(issuer: string, audience: string): McpAuth {
  const jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/oauth2/jwks`));
  const verifyOpts: JWTVerifyOptions = { issuer, audience };

  return {
    async verify(header) {
      const token = extractBearer(header);
      try {
        const { payload } = await jwtVerify(token, jwks, verifyOpts);
        if (typeof payload.sub !== 'string' || !payload.sub) {
          throw new InvalidTokenError('token has no subject claim');
        }
        return { userId: payload.sub, raw: payload as Record<string, unknown> };
      } catch (err) {
        if (err instanceof MissingTokenError) throw err;
        throw new InvalidTokenError(err instanceof Error ? err.message : String(err));
      }
    },
    protectedResourceMetadata(resourceUrl) {
      return { resource: resourceUrl, authorization_servers: [issuer], bearer_methods_supported: ['header'] };
    },
    describe() {
      return `MCP auth: OAuth, issuer=${issuer}, audience=${audience}`;
    },
  };
}

/**
 * Dev-token mode. `timingSafeEqual` needs equal-length buffers, which a
 * naive `===` on attacker-controlled input would leak through timing; the
 * length check ahead of it is itself constant enough not to matter (it is
 * comparing to one fixed, non-secret length known from `secret` itself).
 */
export function buildDevTokenAuth(secret: string, resourceHint: string): McpAuth {
  const secretBuf = Buffer.from(secret, 'utf8');
  return {
    async verify(header) {
      const token = extractBearer(header);
      const tokenBuf = Buffer.from(token, 'utf8');
      const matches = tokenBuf.length === secretBuf.length && timingSafeEqual(tokenBuf, secretBuf);
      if (!matches) throw new InvalidTokenError('token does not match MCP_DEV_TOKEN');
      return { userId: 'dev', raw: { mode: 'dev-token' } };
    },
    protectedResourceMetadata(resourceUrl) {
      // No real authorization server to point at in this mode; naming this
      // server as its own "authorization server" is what lets a client that
      // insists on doing metadata discovery still find *something* rather
      // than fail outright — there is nothing behind that endpoint to steal.
      return { resource: resourceUrl, authorization_servers: [resourceHint], bearer_methods_supported: ['header'] };
    },
    describe() {
      return 'MCP auth: dev token (single static secret) — set MCP_OAUTH_ISSUER for real multi-user auth before any public deployment';
    },
  };
}

/**
 * Resolves which mode from environment, once, at boot. Returns `null` when
 * neither is configured — `serve.ts` reads that as "do not mount /mcp at
 * all," per this file's header comment.
 */
export function buildMcpAuth(env: Record<string, string | undefined> = process.env): McpAuth | null {
  const issuer = env.MCP_OAUTH_ISSUER;
  if (issuer) {
    const audience = env.MCP_OAUTH_AUDIENCE ?? issuer;
    return buildOAuthAuth(issuer, audience);
  }
  const devToken = env.MCP_DEV_TOKEN;
  if (devToken) {
    return buildDevTokenAuth(devToken, env.MCP_RESOURCE_URL ?? 'http://127.0.0.1:4317/mcp');
  }
  return null;
}
