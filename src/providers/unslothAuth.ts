/**
 * Unsloth Studio credential resolution.
 *
 * Unsloth has no anonymous mode: every useful endpoint carries
 * `security: HTTPBearer`, and `GET /api/auth/status` on a fresh install reports
 * `initialized: true` with a default user. So "available without an API key"
 * cannot mean "unauthenticated" — but it does not have to mean *manual* either.
 *
 * A desktop install writes a local auth secret to
 * `~/.unsloth/studio/auth/.desktop_secret`, and `POST /api/auth/desktop-login`
 * exchanges it for a normal bearer token. Verified directly against the running
 * instance: the resulting token authorises both `/v1/models` and
 * `/api/inference/images/status`, exactly as a hand-made `sk-unsloth-…` key
 * would. That makes the common case — Unsloth running on this machine — genuinely
 * keyless, with no visit to Settings → API.
 *
 * The precedence below is deliberate:
 *
 * 1. **An explicit key**, from `apiKeyEnv`. Always wins: it is the only option
 *    that works for a *remote* Unsloth, and someone who set it meant it.
 * 2. **The desktop secret**, read from disk. Local-only by construction — the
 *    file is on this machine, so it can only authenticate an Unsloth on this
 *    machine — which is precisely why it is safe to try automatically.
 * 3. **Username + password**, if supplied. The documented fallback for a server
 *    installed without the desktop app.
 *
 * Nothing here logs or returns the secret itself, only the short-lived token it
 * mints, and tokens are cached with a small safety margin rather than re-minted
 * per request.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a desktop install keeps its local auth secret. */
export function defaultDesktopSecretPath(env: Record<string, string | undefined> = process.env): string {
  // Honours the documented relocation hook, so an isolated install
  // (`UNSLOTH_STUDIO_HOME`) is found rather than silently missed.
  const root = env.UNSLOTH_STUDIO_HOME?.trim();
  return root
    ? join(root, 'auth', '.desktop_secret')
    : join(homedir(), '.unsloth', 'studio', 'auth', '.desktop_secret');
}

/**
 * Current Unsloth Studio releases keep locally minted agent keys here. They
 * are scoped to the loopback Studio URL that minted them, so they are a local
 * credential fallback just like the older desktop secret above.
 */
export function defaultAgentApiKeyPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.UNSLOTH_STUDIO_HOME?.trim();
  return root
    ? join(root, 'auth', 'agent_api_key.json')
    : join(homedir(), '.unsloth', 'studio', 'auth', 'agent_api_key.json');
}

export type UnslothAuthSource = 'api-key' | 'desktop-secret' | 'agent-cache' | 'password' | 'none';

/**
 * Why no token could be produced. `no-credentials` is a stable configuration
 * fact (nothing to try); `exchange-failed` means a credential was found but the
 * round trip did not succeed — a timeout, a refusal, or a malformed reply — and
 * therefore says something about the server, not the config. The two used to
 * collapse into one `null`, which sent someone debugging a dead local server on
 * a wild goose chase through Settings → API.
 */
export type UnslothTokenFailure = {
  ok: false;
  reason: 'no-credentials' | 'exchange-failed';
  /** Short, secret-free diagnostic for the exchange-failed case. */
  detail?: string;
};

export type UnslothTokenResolution = { ok: true; token: string; source: UnslothAuthSource } | UnslothTokenFailure;

/** The one place an exchange failure is shaped, so the union's form lives in one spot. */
const exchangeFailed = (detail?: string): UnslothTokenFailure => ({ ok: false, reason: 'exchange-failed', detail });

export interface UnslothAuthOptions {
  baseUrl: string;
  /** Explicit key, when one was configured. Highest precedence. */
  apiKey?: string;
  /** Overridable for tests; defaults to the desktop install location. */
  desktopSecretPath?: string;
  /** Overridable for tests; defaults to Unsloth Studio's local agent-key cache. */
  agentApiKeyPath?: string;
  /** Documented fallback for a non-desktop install. */
  username?: string;
  password?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Injected in tests so no real file is read. */
  readFile?: (path: string) => Promise<string>;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
}

/**
 * Resolves and caches a bearer token for one Unsloth instance.
 *
 * Held per provider rather than per request: `desktop-login` is a round trip,
 * and an illustration already costs two.
 */
export class UnslothAuth {
  readonly baseUrl: string;
  private apiKey: string;
  private desktopSecretPath: string;
  private agentApiKeyPath: string;
  private username: string | undefined;
  private password: string | undefined;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private readFileFn: (path: string) => Promise<string>;

  /** Cached exchanged token, with the source that produced it. */
  private cached: { token: string; source: UnslothAuthSource; expiresAt: number } | null = null;

  constructor(opts: UnslothAuthOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey?.trim() ?? '';
    this.desktopSecretPath = opts.desktopSecretPath ?? defaultDesktopSecretPath();
    this.agentApiKeyPath = opts.agentApiKeyPath ?? defaultAgentApiKeyPath();
    this.username = opts.username;
    this.password = opts.password;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.readFileFn =
      opts.readFile ??
      (async (path: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path, 'utf8');
      });
  }

  /** True when a key was configured explicitly, so callers can explain precedence. */
  hasExplicitKey(): boolean {
    return !!this.apiKey;
  }

  /**
   * The bearer value to send, or a failure that says why there is none. Both
   * are real outcomes, not errors: a *remote* Unsloth with no key configured has
   * no local secret to fall back on (`no-credentials`), while a dead or refusing
   * server produces `exchange-failed` — and the two need different advice, so
   * they are reported separately rather than collapsed into one null.
   */
  async token(): Promise<UnslothTokenResolution> {
    // An explicit key is used verbatim: it is already a bearer credential, so
    // there is nothing to exchange and nothing to cache.
    if (this.apiKey) return { ok: true, token: this.apiKey, source: 'api-key' };

    if (this.cached && Date.now() < this.cached.expiresAt) {
      return { ok: true, token: this.cached.token, source: this.cached.source };
    }

    // The last exchange failure wins as the reported reason: it is what a caller
    // acting on the result would hit next.
    let failure: UnslothTokenFailure | null = null;

    const secret = await this.readDesktopSecret();
    if (secret) {
      const token = await this.exchange('desktop login', '/api/auth/desktop-login', { secret });
      if (token.ok) return this.cache(token.token, 'desktop-secret');
      failure = token;
    }

    // Studio 2026+ mints an API key for its local coding-agent client and
    // stores it in this private, per-server cache. Reuse it only for the exact
    // loopback URL it is scoped to, and verify it before handing it to callers.
    for (const key of await this.readAgentApiKeys()) {
      if (await this.acceptsApiKey(key)) return this.cache(key, 'agent-cache');
    }

    if (this.username && this.password) {
      const token = await this.exchange('login', '/api/auth/login', { username: this.username, password: this.password });
      if (token.ok) return this.cache(token.token, 'password');
      failure = token;
    }

    return failure ?? { ok: false, reason: 'no-credentials' };
  }

  /** Header object, empty when unauthenticated — the shape call sites want. */
  async authHeader(): Promise<Record<string, string>> {
    const resolved = await this.token();
    return resolved.ok ? { authorization: `Bearer ${resolved.token}` } : {};
  }

  private cache(token: string, source: UnslothAuthSource): { ok: true; token: string; source: UnslothAuthSource } {
    // The token's own lifetime is not reported by the endpoint, so this is a
    // conservative window rather than a claim: short enough that a rotated
    // secret is picked up quickly, long enough that a burst of illustrations
    // does not re-login for each one.
    this.cached = { token, source, expiresAt: Date.now() + 10 * 60_000 };
    return { ok: true, token, source };
  }

  private async readDesktopSecret(): Promise<string | null> {
    try {
      const raw = await this.readFileFn(this.desktopSecretPath);
      const trimmed = raw.trim();
      return trimmed || null;
    } catch {
      // Absent is the normal case for a server-only or remote install.
      return null;
    }
  }

  private async readAgentApiKeys(): Promise<string[]> {
    if (!isLoopbackUrl(this.baseUrl)) return [];
    try {
      const raw = await this.readFileFn(this.agentApiKeyPath);
      const parsed = JSON.parse(raw) as { servers?: Record<string, { saved?: unknown; minted?: unknown }> };
      const entry = parsed.servers?.[this.baseUrl];
      if (!entry) return [];
      const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []);
      return [...strings(entry.saved), ...strings(entry.minted)];
    } catch {
      return [];
    }
  }

  private async acceptsApiKey(key: string): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * One credential exchange, with the failure kept descriptive. `label` is what
   * the endpoint means to a human ("desktop login" vs "login"); it appears in
   * `detail`, which never carries the secret or any request body.
   */
  private async exchange(label: string, path: string, body: Record<string, string>): Promise<{ ok: true; token: string } | UnslothTokenFailure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return exchangeFailed(`${label} returned ${res.status}`);
      const parsed = await res.json().catch((): undefined => undefined);
      // `null` is valid JSON, so the guard must cover it as well as a parse failure.
      if (parsed == null) return exchangeFailed(`${label} returned a malformed response`);
      const token = (parsed as TokenResponse).access_token?.trim();
      return token ? { ok: true, token } : exchangeFailed(`${label} response carried no access token`);
    } catch (err) {
      // An aborted controller is our own timeout; anything else is the network.
      if (controller.signal.aborted) return exchangeFailed(`${label} timed out after ${this.timeoutMs}ms`);
      // undici wraps socket errors: `fetch failed` is the message, and the
      // actionable reason (ECONNREFUSED, EAI_AGAIN, …) rides in `cause`.
      const cause = (err as { cause?: unknown } | null)?.cause;
      const why = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
      return exchangeFailed(`${label} unreachable: ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}
