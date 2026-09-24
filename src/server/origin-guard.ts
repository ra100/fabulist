/**
 * Which browser requests the HTTP servers answer at all.
 *
 * Shared by the Postgres server and the local SQLite one: a JSON-only API with
 * an Origin allowlist and a `Sec-Fetch-Site` guard, so another website open in
 * the same browser can neither read responses nor send state-changing requests.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { AuthConfig } from '../auth/config.ts';

/**
 * Whether a login-off server must refuse this request's `Host`.
 *
 * With login off, whoever reaches the port is the owner, and the Origin check
 * below trusts the request's own Host. DNS rebinding defeats both: a page at
 * `attacker.example` re-resolves its own name to 127.0.0.1, and its requests are
 * then same-origin with `Host: attacker.example`. Rebinding needs a DNS name,
 * so a login-off server answers only to `localhost`, an IP literal, or the MCP
 * resource's own host. With login on, the session is the gate and any Host goes.
 */
export function rejectsHost(req: IncomingMessage, authConfig: AuthConfig | undefined, mcpResourceUrl?: string): boolean {
  if (authConfig) return false;
  const raw = req.headers.host;
  if (!raw) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return false;
  try {
    return !mcpResourceUrl || new URL(mcpResourceUrl).hostname.toLowerCase() !== hostname;
  } catch {
    return true;
  }
}

const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && raw === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

export function requestOrigin(req: IncomingMessage): { present: boolean; origin: string | null } {
  const raw = req.headers.origin;
  if (raw === undefined) return { present: false, origin: null };
  return { present: true, origin: typeof raw === 'string' ? originOf(raw) : null };
}

function allowedOriginsFor(
  req: IncomingMessage,
  url: URL,
  authConfig: AuthConfig | undefined,
  mcpResourceUrl: string | undefined,
): Set<string> {
  const allowed = new Set<string>();
  if (authConfig) allowed.add(authConfig.callbackOrigin);
  const mcpOrigin = originOf(mcpResourceUrl);
  if (mcpOrigin) allowed.add(mcpOrigin);
  if (!authConfig) {
    const hostOrigin = originOf(`${url.protocol}//${req.headers.host ?? ''}`);
    if (hostOrigin) allowed.add(hostOrigin);
  }
  return allowed;
}

export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authConfig: AuthConfig | undefined,
  mcpResourceUrl: string | undefined,
): boolean {
  const { present, origin } = requestOrigin(req);
  if (present) {
    if (!origin) return false;
    if (!allowedOriginsFor(req, url, authConfig, mcpResourceUrl).has(origin)) return false;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    if (authConfig) res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type,authorization,mcp-protocol-version,mcp-session-id,last-event-id',
  );
  res.setHeader('access-control-expose-headers', 'mcp-session-id');
  return true;
}

/**
 * A top-level page visit: `GET`/`HEAD`, mode `navigate`, destination
 * `document`. Every inbound link to the app has this shape — and when the
 * link (or an OAuth redirect chain, which keeps its initiator's site for the
 * whole chain) started on another origin, it arrives as
 * `Sec-Fetch-Site: cross-site` with no `Origin` header at all, because
 * browsers omit `Origin` on plain GET navigations. The fetch-site guard is
 * the wrong tool for that shape: an attacker cannot read a navigation's
 * response, only send the user to a page they could have typed themselves,
 * and every state-changing route is a POST that the guard still rejects.
 * Framing is not a loophole either — `frame-ancestors 'none'` plus
 * `X-Frame-Options: DENY` already kill nested document loads, and a framed
 * navigation would carry `dest: iframe` rather than `document` regardless.
 */
function isTopLevelNavigation(req: IncomingMessage): boolean {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document'
  );
}

export function passesFetchSiteGuard(req: IncomingMessage, crossSiteHasAllowedOrigin: boolean): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite !== 'string') return true;
  const site = fetchSite.toLowerCase();
  return (
    SAFE_FETCH_SITES.has(site) ||
    (site === 'cross-site' && (crossSiteHasAllowedOrigin || isTopLevelNavigation(req)))
  );
}
