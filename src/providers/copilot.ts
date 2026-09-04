/**
 * GitHub Copilot, using the OAuth token the Copilot editor plugins store locally.
 *
 * ── Read this before enabling it ────────────────────────────────────────────
 *
 * This is NOT a supported integration. Copilot's chat endpoint is an internal
 * API for GitHub's own editor extensions. It is undocumented, unversioned, and
 * using it from a third-party client is very likely outside the Copilot terms of
 * service. It can break without notice, and in principle it could put your
 * GitHub account at risk.
 *
 * It is implemented because it is your credential on your machine and you asked
 * for it, but it is opt-in: `allowUnofficial` must be set explicitly, so nothing
 * reaches this endpoint by default or by accident. If you want a supported
 * keyless option, Bedrock via AWS_PROFILE and Vertex via gcloud OAuth are both
 * first-class here.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adaptRequest, type CompletionRequest, type CompletionResult, type Provider, type ProviderCapabilities } from './provider.ts';

export interface CopilotEnvironment {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string | null;
  listDir: (path: string) => string[];
  fetcher: typeof fetch;
  now: () => Date;
}

export function defaultCopilotEnvironment(): CopilotEnvironment {
  return {
    env: process.env,
    readFile: (path) => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    },
    listDir: (path) => {
      try {
        return existsSync(path) ? readdirSync(path) : [];
      } catch {
        return [];
      }
    },
    fetcher: fetch,
    now: () => new Date(),
  };
}

/**
 * Finds the stored OAuth token. The plugins have moved this file around, so
 * several locations and both known shapes are checked.
 */
export function findCopilotOAuthToken(envs: CopilotEnvironment): { token: string; source: string } | null {
  const home = envs.env.HOME ?? homedir();
  const configHome = envs.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const candidates = [
    join(configHome, 'github-copilot', 'apps.json'),
    join(configHome, 'github-copilot', 'hosts.json'),
    join(home, '.config', 'github-copilot', 'apps.json'),
    join(home, '.config', 'github-copilot', 'hosts.json'),
  ];

  for (const path of [...new Set(candidates)]) {
    const text = envs.readFile(path);
    if (!text) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Both shapes are `{ <key>: { oauth_token: "..." } }`; the key differs by
    // version ("github.com" vs "github.com:<app id>").
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const token = (value as { oauth_token?: unknown }).oauth_token;
      if (typeof token === 'string' && token.length > 8) {
        return { token, source: `${path.replace(home, '~')} (${key})` };
      }
    }
  }
  return null;
}

interface SessionToken {
  token: string;
  expiresAt: number;
}

export interface CopilotOptions {
  model: string;
  capabilities: ProviderCapabilities;
  /** Must be true. Exists so this endpoint is never reached implicitly. */
  allowUnofficial: boolean;
  copilotEnvironment?: CopilotEnvironment;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class CopilotProvider implements Provider {
  readonly id = 'copilot';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private envs: CopilotEnvironment;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private session: SessionToken | null = null;

  constructor(opts: CopilotOptions) {
    if (!opts.allowUnofficial) {
      throw new Error(
        'the Copilot provider is unofficial and disabled by default. ' +
          'Set "allowUnofficial": true on its provider spec to acknowledge that it uses an ' +
          'undocumented endpoint and may breach the Copilot terms of service.',
      );
    }
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.envs = opts.copilotEnvironment ?? defaultCopilotEnvironment();
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  /** Exchanges the long-lived OAuth token for a short-lived session token. */
  private async sessionToken(): Promise<string> {
    if (this.session && this.session.expiresAt - this.envs.now().getTime() > 60_000) return this.session.token;

    const oauth = findCopilotOAuthToken(this.envs);
    if (!oauth) {
      throw new Error('no Copilot OAuth token found. Sign in to Copilot in your editor first.');
    }

    const res = await this.fetcher('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        authorization: `token ${oauth.token}`,
        accept: 'application/json',
        'user-agent': 'fabulist',
      },
    });
    if (!res.ok) {
      throw new Error(`Copilot token exchange failed (${res.status}). Your Copilot session may have expired.`);
    }
    const json = (await res.json()) as { token?: string; expires_at?: number };
    if (!json.token) throw new Error('Copilot token exchange returned no token');

    this.session = {
      token: json.token,
      expiresAt: json.expires_at ? json.expires_at * 1000 : this.envs.now().getTime() + 20 * 60_000,
    };
    return this.session.token;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const token = await this.sessionToken();
    const adapted = adaptRequest(req, this.capabilities);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: adapted.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher('https://api.githubcopilot.com/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // The endpoint rejects requests without editor identification.
          'editor-version': 'vscode/1.96.0',
          'editor-plugin-version': 'copilot-chat/0.23.0',
          'copilot-integration-id': 'vscode-chat',
          'user-agent': 'GitHubCopilotChat/0.23.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`copilot ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        tokensIn: json.usage?.prompt_tokens ?? 0,
        tokensOut: json.usage?.completion_tokens ?? 0,
        model: this.model,
        schemaEnforced: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async whoami(): Promise<{ source: string }> {
    const oauth = findCopilotOAuthToken(this.envs);
    return { source: oauth ? oauth.source : 'not signed in' };
  }
}
