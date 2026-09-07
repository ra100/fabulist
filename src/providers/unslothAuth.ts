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

export type UnslothAuthSource = 'api-key' | 'desktop-secret' | 'password' | 'none';

export interface UnslothAuthOptions {
  baseUrl: string;
  /** Explicit key, when one was configured. Highest precedence. */
  apiKey?: string;
  /** Overridable for tests; defaults to the desktop install location. */
  desktopSecretPath?: string;
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
   * The bearer value to send, or null when this instance cannot be authenticated
   * at all. Null is a real outcome, not an error: a *remote* Unsloth with no key
   * configured has no local secret to fall back on, and saying so plainly is more
   * useful than a 401 at illustration time.
   */
  async token(): Promise<{ token: string; source: UnslothAuthSource } | null> {
    // An explicit key is used verbatim: it is already a bearer credential, so
    // there is nothing to exchange and nothing to cache.
    if (this.apiKey) return { token: this.apiKey, source: 'api-key' };

    if (this.cached && Date.now() < this.cached.expiresAt) {
      return { token: this.cached.token, source: this.cached.source };
    }

    const secret = await this.readDesktopSecret();
    if (secret) {
      const token = await this.exchange('/api/auth/desktop-login', { secret });
      if (token) return this.cache(token, 'desktop-secret');
    }

    if (this.username && this.password) {
      const token = await this.exchange('/api/auth/login', { username: this.username, password: this.password });
      if (token) return this.cache(token, 'password');
    }

    return null;
  }

  /** Header object, empty when unauthenticated — the shape call sites want. */
  async authHeader(): Promise<Record<string, string>> {
    const resolved = await this.token();
    return resolved ? { authorization: `Bearer ${resolved.token}` } : {};
  }

  private cache(token: string, source: UnslothAuthSource): { token: string; source: UnslothAuthSource } {
    // The token's own lifetime is not reported by the endpoint, so this is a
    // conservative window rather than a claim: short enough that a rotated
    // secret is picked up quickly, long enough that a burst of illustrations
    // does not re-login for each one.
    this.cached = { token, source, expiresAt: Date.now() + 10 * 60_000 };
    return { token, source };
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

  private async exchange(path: string, body: Record<string, string>): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as TokenResponse;
      return json.access_token?.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
