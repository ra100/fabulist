/**
 * Google Gemini without an API key.
 *
 * Two OAuth paths, both landing on Vertex AI:
 *
 *   - Application Default Credentials written by `gcloud auth application-default
 *     login`. These are an `authorized_user` record: a refresh token plus the
 *     gcloud client id, exchanged for an access token.
 *   - A service account key file, which needs a self-signed JWT assertion. RS256
 *     via node:crypto, so no dependency.
 *
 * A `gcloud auth print-access-token` fallback exists for setups where the ADC file
 * is absent but the CLI is configured (impersonation, external account types this
 * file does not implement).
 */
import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSse, parseJsonSafe } from './stream.ts';
import type { CompletionRequest, CompletionResult, Provider, ProviderCapabilities } from './provider.ts';

export interface GoogleEnvironment {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string | null;
  fetcher: typeof fetch;
  run: (bin: string, args: string[]) => Promise<string>;
  now: () => Date;
}

export function defaultGoogleEnvironment(): GoogleEnvironment {
  return {
    env: process.env,
    readFile: (path) => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    },
    fetcher: fetch,
    run: (bin, args) =>
      new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
      }),
    now: () => new Date(),
  };
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface Token {
  accessToken: string;
  expiresAt: number;
  source: string;
}

export class GoogleAuth {
  private envs: GoogleEnvironment;
  private token: Token | null = null;

  constructor(envs: GoogleEnvironment = defaultGoogleEnvironment()) {
    this.envs = envs;
  }

  private adcPath(): string {
    const explicit = this.envs.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (explicit) return explicit;
    const home = this.envs.env.HOME ?? homedir();
    // Windows uses APPDATA; harmless to check both.
    const appdata = this.envs.env.APPDATA;
    return appdata
      ? join(appdata, 'gcloud', 'application_default_credentials.json')
      : join(home, '.config', 'gcloud', 'application_default_credentials.json');
  }

  /** The project id Vertex needs, which is separate from authentication. */
  project(): string | null {
    const fromEnv =
      this.envs.env.GOOGLE_CLOUD_PROJECT ??
      this.envs.env.GCLOUD_PROJECT ??
      this.envs.env.GCP_PROJECT ??
      null;
    if (fromEnv) return fromEnv;

    const text = this.envs.readFile(this.adcPath());
    if (text) {
      try {
        const parsed = JSON.parse(text) as { quota_project_id?: string; project_id?: string };
        if (parsed.quota_project_id) return parsed.quota_project_id;
        if (parsed.project_id) return parsed.project_id;
      } catch {
        // fall through
      }
    }
    return null;
  }

  async accessToken(): Promise<Token> {
    // Refresh a minute early; a token that expires between the referee call and
    // the narrator call is a confusing mid-turn failure.
    if (this.token && this.token.expiresAt - this.envs.now().getTime() > 60_000) return this.token;

    const text = this.envs.readFile(this.adcPath());
    if (text) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`could not parse ${this.adcPath()}`);
      }
      if (parsed.type === 'authorized_user') {
        this.token = await this.fromRefreshToken(parsed);
        return this.token;
      }
      if (parsed.type === 'service_account') {
        this.token = await this.fromServiceAccount(parsed);
        return this.token;
      }
    }

    // Last resort: let gcloud mint one. Covers impersonation and external account
    // types that would each need their own flow here.
    try {
      const out = await this.envs.run('gcloud', ['auth', 'print-access-token']);
      if (out) {
        this.token = { accessToken: out, expiresAt: this.envs.now().getTime() + 45 * 60_000, source: 'gcloud cli' };
        return this.token;
      }
    } catch {
      // fall through to the error below
    }

    throw new Error(
      'no Google credentials. Run: gcloud auth application-default login ' +
        '(or set GOOGLE_APPLICATION_CREDENTIALS to a service account key)',
    );
  }

  private async fromRefreshToken(adc: Record<string, unknown>): Promise<Token> {
    const body = new URLSearchParams({
      client_id: String(adc.client_id ?? ''),
      client_secret: String(adc.client_secret ?? ''),
      refresh_token: String(adc.refresh_token ?? ''),
      grant_type: 'refresh_token',
    });
    const res = await this.envs.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(
        `Google token refresh failed (${res.status}). Run: gcloud auth application-default login`,
      );
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Google token refresh returned no token');
    return {
      accessToken: json.access_token,
      expiresAt: this.envs.now().getTime() + (json.expires_in ?? 3600) * 1000,
      source: 'application default credentials',
    };
  }

  /** Self-signed JWT assertion, exchanged for an access token. */
  private async fromServiceAccount(key: Record<string, unknown>): Promise<Token> {
    const clientEmail = String(key.client_email ?? '');
    const privateKey = String(key.private_key ?? '');
    if (!clientEmail || !privateKey) throw new Error('service account key is missing client_email or private_key');

    const nowSeconds = Math.floor(this.envs.now().getTime() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: clientEmail,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode(header)}.${encode(claims)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');

    const res = await this.envs.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    if (!res.ok) throw new Error(`service account token exchange failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('service account exchange returned no token');
    return {
      accessToken: json.access_token,
      expiresAt: this.envs.now().getTime() + (json.expires_in ?? 3600) * 1000,
      source: `service account (${clientEmail})`,
    };
  }
}

export interface VertexOptions {
  model: string;
  capabilities: ProviderCapabilities;
  /** Defaults to the discovered project. */
  project?: string;
  location?: string;
  auth?: GoogleAuth;
  googleEnvironment?: GoogleEnvironment;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class VertexProvider implements Provider {
  readonly id = 'google';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private auth: GoogleAuth;
  private projectOverride: string | undefined;
  private location: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(opts: VertexOptions) {
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.auth = opts.auth ?? new GoogleAuth(opts.googleEnvironment);
    this.projectOverride = opts.project;
    this.location = opts.location ?? 'us-central1';
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const token = await this.auth.accessToken();
    const project = this.projectOverride ?? this.auth.project();
    if (!project) {
      throw new Error('no Google Cloud project. Set GOOGLE_CLOUD_PROJECT or configure it in the provider spec.');
    }

    // Gemini calls the system prompt systemInstruction, and assistant turns "model".
    const systemText = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '...' }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.7,
        maxOutputTokens: req.maxTokens ?? 2048,
        ...(req.stop?.length ? { stopSequences: req.stop.slice(0, 5) } : {}),
        ...(req.schema
          ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.schema.schema) }
          : {}),
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    const wantsStream = !!req.onToken && this.capabilities.streaming && !req.schema;
    const method = wantsStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url =
      `https://${this.location}-aiplatform.googleapis.com/v1/projects/${project}` +
      `/locations/${this.location}/publishers/google/models/${this.model}:${method}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json: GenerateResponse;
    try {
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok && wantsStream) {
        return await this.consumeStream(res, req.onToken!);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`vertex ${res.status}: ${text.slice(0, 300)}`);
      }
      json = (await res.json()) as GenerateResponse;
    } finally {
      clearTimeout(timer);
    }

    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    return {
      text,
      tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.model,
      schemaEnforced: !!req.schema,
    };
  }

  private async consumeStream(res: Response, onToken: (chunk: string) => void): Promise<CompletionResult> {
    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const payload of readSse(res.body)) {
      const event = parseJsonSafe(payload) as GenerateResponse | null;
      if (!event) continue;
      const chunk = (event.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (chunk) {
        text += chunk;
        onToken(chunk);
      }
      if (event.usageMetadata) {
        tokensIn = event.usageMetadata.promptTokenCount ?? tokensIn;
        tokensOut = event.usageMetadata.candidatesTokenCount ?? tokensOut;
      }
    }
    return { text, tokensIn, tokensOut, model: this.model, schemaEnforced: false };
  }

  async whoami(): Promise<{ source: string; project: string | null; location: string }> {
    const token = await this.auth.accessToken();
    return { source: token.source, project: this.projectOverride ?? this.auth.project(), location: this.location };
  }
}

/**
 * Gemini's responseSchema is OpenAPI-flavoured, not JSON Schema: it rejects
 * `additionalProperties` and union-typed fields like `["string","null"]`, which
 * the engine's schemas use freely. Translating is cheaper than maintaining two
 * sets of schemas.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && Array.isArray(value)) {
      // Collapse `["string","null"]` to the non-null member; nullability is
      // expressed by omitting the field from `required`.
      const first = value.find((t) => t !== 'null') ?? 'string';
      out.type = first;
      out.nullable = value.includes('null');
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}
