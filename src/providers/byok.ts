import { AnthropicProvider, OpenAICompatProvider, caps } from './http.ts';
import type { CompletionRequest, CompletionResult, Provider } from './provider.ts';

export interface ByokEndpoint {
  id: string;
  label: string;
  kind: 'openai-compat' | 'anthropic';
  baseUrl: string;
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
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'kilo', label: 'Kilo Code', kind: 'openai-compat', baseUrl: 'https://api.kilo.ai/api/gateway' },
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

const KEY_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[^\s"',}]+/gi,
  /\b(?:sk|pk|rk|gsk|xai|fw|csk|key)[-_][A-Za-z0-9_-]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/** Removes `known` secrets and anything shaped like an API key from provider error text. */
export function scrubSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[redacted]');
  return out;
}

export function byokProvider(
  endpoint: ByokEndpoint,
  model: string,
  secret: () => string,
  fetcher?: typeof fetch,
): Provider {
  const capabilities = caps({ structuredOutput: endpoint.id === 'openai' ? 'native-schema' : 'none' });
  return {
    id: endpoint.id,
    model,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      // Read per call, so a lock or delete between two calls of one turn stops the second.
      const apiKey = secret();
      const opts = { apiKey, baseUrl: endpoint.baseUrl, model, capabilities, fetcher };
      const inner =
        endpoint.kind === 'anthropic' ? new AnthropicProvider(opts) : new OpenAICompatProvider(endpoint.id, opts);
      try {
        return await inner.complete(req);
      } catch (err) {
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), [apiKey]));
      }
    },
  };
}

export async function listModels(
  endpoint: ByokEndpoint,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const anthropic = endpoint.kind === 'anthropic';
  const url = anthropic ? `${endpoint.baseUrl}/v1/models` : `${endpoint.baseUrl}/models`;
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetcher(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort()
      .slice(0, 500);
  } catch {
    return [];
  }
}
