/**
 * Authorization-server metadata discovery, shared by the two places this
 * server has to trust an external issuer: the MCP connector's bearer-token
 * check (`src/mcp/auth.ts`) and generic-OIDC web login
 * (`src/auth/oidc-provider.ts`).
 *
 * It lives here rather than in either consumer because the *policy* parts —
 * which URLs count as a metadata document, and which URLs are safe to read
 * keys from — must be the same in both. A second copy of `isTrustedKeySource`
 * that drifted by one condition would be a downgrade attack waiting in the
 * file nobody edited. What the two consumers do with the document afterwards
 * legitimately differs (MCP wants only `jwks_uri` and has a vendor fallback
 * for issuers that publish nothing; web login needs the authorization and
 * token endpoints and has no fallback to offer), so that part stays with each
 * of them.
 */
import { isIPv4 } from 'node:net';

/**
 * Where to look for an issuer's metadata document, in preference order.
 *
 * An OAuth 2.1 authorization server publishes its endpoints in a metadata
 * document; the *path that document lives at* is standardised, the endpoint
 * paths themselves are not. AuthKit happens to serve keys at `/oauth2/jwks`,
 * Keycloak at `/protocol/openid-connect/certs`, Authelia at `/jwks.json`,
 * Authentik at `/jwks/`, Zitadel at `/oauth/v2/keys` — so anything that
 * hardcodes one vendor's path works with that vendor only. Discovery is the
 * whole point: read the document, believe what it says.
 *
 * Both well-known suffixes are tried because the two specs that define this
 * overlap: OIDC Discovery 1.0 (`openid-configuration`) and RFC 8414
 * (`oauth-authorization-server`). So does the placement — a plain append is
 * what OIDC specifies and what every issuer above answers on, while RFC 8414
 * §3.1 inserts the well-known segment *before* the issuer's path component, so
 * an issuer that has a path (a Keycloak realm, an AuthKit-style tenant path)
 * gets both forms tried.
 */
export function discoveryUrls(issuer: string): string[] {
  const { origin, pathname } = new URL(issuer);
  const path = pathname.replace(/\/$/, '');
  const urls: string[] = [];
  for (const suffix of ['openid-configuration', 'oauth-authorization-server']) {
    urls.push(`${issuer}/.well-known/${suffix}`);
    if (path) urls.push(`${origin}/.well-known/${suffix}${path}`);
  }
  return urls;
}

/**
 * Whether signing keys (or the metadata document naming where they are) may be
 * read from `url`.
 *
 * Whoever can substitute the key set can mint tokens this server accepts, so
 * the keys have to arrive over an authenticated channel: `https:` only. The one
 * exception is plain `http:` to a loopback address — a local issuer during
 * development, or one behind a reverse proxy on the same host — because there
 * is no network path there for anyone to sit on. `localhost`, `127.0.0.0/8`
 * and `[::1]` count; a private-network or container hostname does not.
 */
export function isTrustedKeySource(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname;
  return host === 'localhost' || host === '[::1]' || (isIPv4(host) && host.startsWith('127.'));
}

/**
 * Why discovery failed, and — the load-bearing part — whether trying again
 * later could succeed.
 *
 * `transient` separates "this issuer answered, and publishes no usable
 * metadata" from "we could not get an answer at all" (a network or DNS error,
 * the deadline, a 5xx/408/429). Only the first is a fact about the issuer; the
 * second is a fact about right now, and a caller that memoizes its result must
 * not pin a DNS blip for the lifetime of the process.
 */
export class DiscoveryError extends Error {
  readonly issuer: string;
  readonly transient: boolean;
  readonly reasons: string[];

  constructor(issuer: string, transient: boolean, reasons: string[]) {
    super(`could not read authorization server metadata at ${issuer} (${reasons.join('; ')})`);
    this.name = 'DiscoveryError';
    this.issuer = issuer;
    this.transient = transient;
    this.reasons = reasons;
  }
}

export interface IssuerMetadata {
  /** Which of the candidate well-known URLs actually answered — for error messages that say where a missing field was missing *from*. */
  url: string;
  doc: Record<string, unknown>;
}

/**
 * Fetches the first usable metadata document for `issuer`.
 *
 * The `issuer` a document claims is checked against the issuer we asked about
 * (RFC 8414 §3.3): a document that names someone else is a mix-up, not a
 * description of this issuer, and is skipped rather than trusted. Redirects
 * are not followed (`createRemoteJWKSet` doesn't follow them either), so a
 * metadata fetch cannot be bounced onto a cleartext hop.
 *
 * Every candidate URL shares one deadline: an issuer that accepts connections
 * and never answers must not be able to hold authentication open for
 * `timeoutMs` times however many paths we try.
 */
export async function fetchIssuerMetadata(issuer: string, timeoutMs: number): Promise<IssuerMetadata> {
  const signal = AbortSignal.timeout(timeoutMs);
  const reasons: string[] = [];
  let transient = false;
  for (const url of discoveryUrls(issuer)) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal });
      if (!res.ok) {
        reasons.push(`${url}: HTTP ${res.status}`);
        if (res.status >= 500 || res.status === 408 || res.status === 429) transient = true;
        continue;
      }
      const doc: unknown = await res.json();
      if (!doc || typeof doc !== 'object') {
        reasons.push(`${url}: not a JSON object`);
        continue;
      }
      const { issuer: claimedIssuer } = doc as Record<string, unknown>;
      const claimed = typeof claimedIssuer === 'string' ? claimedIssuer.replace(/\/$/, '') : undefined;
      if (claimed && claimed !== issuer) {
        reasons.push(`${url}: metadata names issuer ${claimed}`);
        continue;
      }
      return { url, doc: doc as Record<string, unknown> };
    } catch (err) {
      reasons.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      // A body that isn't JSON is an answer (typically an HTML page served for
      // any path); anything else — reset, DNS, timeout — is not.
      if (!(err instanceof SyntaxError)) transient = true;
    }
  }
  throw new DiscoveryError(issuer, transient, reasons);
}
