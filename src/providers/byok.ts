import { JevCompatProvider, JevProvider, caps } from './http.ts';
import { OpenAISdkProvider } from './openai-sdk.ts';
import { AnthropicSdkProvider } from './anthropic-sdk.ts';
import { ProviderHttpError, scrubSecrets, type CompletionRequest, type CompletionResult, type Provider } from './provider.ts';

// Re-exported so existing callers keep one obvious home for credential handling.
export { scrubSecrets } from './provider.ts';

export interface ByokEndpoint {
  id: string;
  label: string;
  kind: 'openai-compat' | 'anthropic';
  baseUrl: string;
  /**
   * Full URL of this provider's typed-decision API, when it has one, and so
   * can answer the Jev fast path directly with calibrated probabilities.
   *
   * A bare path is not enough to record here, because the typed API does not
   * always sit at the same depth as the chat API. OpenRouter's is one level
   * *above* the `/v1` its `baseUrl` carries (`/api/alpha/decisions`), while
   * Zen's sits *inside* it (`/zen/v1/systemone`). Writing the whole URL is the
   * only form that is true for both, and it is the form that can be checked
   * against the live endpoint.
   *
   * Absent means there is no typed API here, and the fast path falls back to
   * asking over chat completions.
   */
  typedUrl?: string;
}

/** Fixed hosts only: a user-supplied base URL would let a key holder make this server fetch anything (SSRF). */
export const BYOK_ENDPOINTS: readonly ByokEndpoint[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'openai-compat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { id: 'mistral', label: 'Mistral', kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'xai', label: 'xAI', kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1' },
  { id: 'groq', label: 'Groq', kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'cerebras', label: 'Cerebras', kind: 'openai-compat', baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'together', label: 'Together', kind: 'openai-compat', baseUrl: 'https://api.together.ai/v1' },
  { id: 'fireworks', label: 'Fireworks', kind: 'openai-compat', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    typedUrl: 'https://openrouter.ai/api/alpha/decisions',
  },
  { id: 'kilo', label: 'Kilo Code', kind: 'openai-compat', baseUrl: 'https://api.kilo.ai/api/gateway' },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    kind: 'openai-compat',
    baseUrl: 'https://opencode.ai/zen/v1',
    typedUrl: 'https://opencode.ai/zen/v1/systemone',
  },
  // No `typedUrl`: Go's model list carries no Jev, and its chat endpoint wants
  // a per-conversation `x-opencode-session` header that this app does not send.
  { id: 'opencode-go', label: 'OpenCode Go', kind: 'openai-compat', baseUrl: 'https://opencode.ai/zen/go/v1' },
];

export function byokEndpoint(id: string): ByokEndpoint | undefined {
  return BYOK_ENDPOINTS.find((e) => e.id === id);
}

export class ProviderKeyLockedError extends Error {
  constructor(message = 'your provider key is locked; unlock private storage to use it') {
    super(message);
    this.name = 'ProviderKeyLockedError';
  }
}

const REJECTED_COPY: Record<number, string> = {
  401: 'Your provider rejected your API key',
  403: 'Your provider rejected your API key',
  402: 'Your provider refused your API key for lack of credit or quota',
  429: 'Your provider is rate-limiting your API key or it is out of quota',
};

/**
 * Pulls a human-readable reason out of a provider's error body.
 *
 * Status alone lies often enough to be worth decoding. OpenCode Zen answers
 * `403 {"type":"FreeTierError","message":"…can only be used from within
 * OpenCode"}` and `400 {"type":"MissingSessionID",…}` — a perfectly good key
 * that simply may not make that call, which "rejected your API key" sends you
 * to fix by rotating a key that is not broken. OpenCode's 402 is
 * `"Insufficient account funds"`, which is at least actionable.
 *
 * Only the `message` is read, and it is still scrubbed of the key before it
 * reaches anyone: provider text is untrusted, and this path is the one place
 * such text is shown rather than replaced.
 */
export function providerErrorReason(body: string, known: readonly string[] = []): string {
  const text = body.slice(0, 2000);
  try {
    const parsed: unknown = JSON.parse(text);
    const message =
      (parsed as { message?: unknown } | null)?.message ??
      (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message.trim()) return scrubSecrets(message.trim().slice(0, 200), known);
  } catch {
    // Not JSON, or truncated by the slice. Fall through to the fixed copy.
  }
  return '';
}

/**
 * The provider refused the request. Fixed copy by status, unless the body said
 * something more specific that would otherwise send someone to fix the wrong
 * thing.
 */
export class ProviderKeyRejectedError extends Error {
  readonly status: number;
  readonly keySource = 'own' as const;

  constructor(status: number, reason = '') {
    super(
      reason
        ? `${reason} (${status}). Check it in Settings → Configure providers.`
        : `${REJECTED_COPY[status] ?? 'Your provider refused the request made with your API key'} (${status}). Check it in Settings → Configure providers.`,
    );
    this.name = 'ProviderKeyRejectedError';
    this.status = status;
  }
}

// A redirect would carry the user's key and prompt to wherever the Location points.
function noRedirects(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' });
}

export function byokProvider(
  endpoint: ByokEndpoint,
  model: string,
  secret: () => string,
  fetcher?: typeof fetch,
): Provider {
  const capabilities = caps({ structuredOutput: endpoint.id === 'openai' ? 'native-schema' : 'none' });
  const guarded = noRedirects(fetcher);
  return {
    id: endpoint.id,
    model,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      // Read per call, so a lock or delete between two calls of one turn stops the second.
      const apiKey = secret();
      const opts = { apiKey, baseUrl: endpoint.baseUrl, model, capabilities, fetcher: guarded };
      // A provider with a typed-decision API keeps the dedicated adapter, which
      // returns calibrated probabilities. Only the ones without one fall back
      // to asking over chat completions — and there the number is the model's
      // own say-so, which is a weaker guarantee. See `JevCompatProvider`.
      const inner =
        req.role === 'jev-fastpath'
          ? endpoint.typedUrl
            ? new JevProvider({ ...opts, url: endpoint.typedUrl })
            : new JevCompatProvider(endpoint.id, opts)
          : endpoint.kind === 'anthropic'
            ? new AnthropicSdkProvider({
                // Resolved per call for the same reason as below.
                apiKey: () => apiKey,
                baseUrl: endpoint.baseUrl,
                model,
                capabilities,
                fetcher: guarded,
              })
            : new OpenAISdkProvider({
                id: endpoint.id,
                // Already read once for this call; the adapter resolves per
                // request rather than capturing, so a key never outlives the
                // turn that used it.
                apiKey: () => apiKey,
                baseUrl: endpoint.baseUrl,
                model,
                capabilities,
                fetcher: guarded,
              });
      try {
        return await inner.complete(req);
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status in REJECTED_COPY) {
          // Prefer the provider's own reason when it gave one: a 403 here can
          // mean "good key, wrong caller" rather than "bad key", and the fixed
          // copy would send someone to rotate a working credential.
          throw new ProviderKeyRejectedError(err.status, providerErrorReason(err.body ?? '', [apiKey]));
        }
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), [apiKey]));
      }
    },
  };
}

export interface ModelDiscoveryResult {
  status: 'verified' | 'unsupported' | 'unavailable';
  models: string[];
}

export async function discoverModels(
  endpoint: ByokEndpoint,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ModelDiscoveryResult> {
  const anthropic = endpoint.kind === 'anthropic';
  const url = anthropic ? `${endpoint.baseUrl}/v1/models` : `${endpoint.baseUrl}/models`;
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  let res: Response;
  try {
    res = await noRedirects(fetcher)(url, { headers, signal: AbortSignal.timeout(5_000) });
  } catch {
    return { status: 'unavailable', models: [] };
  }
  if (res.status === 404 || res.status === 405) return { status: 'unsupported', models: [] };
  if (res.status === 401 || res.status === 403) throw new ProviderKeyRejectedError(res.status);
  if (!res.ok) return { status: 'unavailable', models: [] };
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return { status: 'unavailable', models: [] };
    return {
      status: 'verified',
      models: body.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string')
        .sort()
        .slice(0, 500),
    };
  } catch {
    return { status: 'unavailable', models: [] };
  }
}

export async function listModels(
  endpoint: ByokEndpoint,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  return (await discoverModels(endpoint, apiKey, fetcher)).models;
}
