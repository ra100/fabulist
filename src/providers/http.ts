/**
 * Real provider adapters. See DESIGN.md §9.3.
 *
 * One thin adapter per API shape rather than a heavyweight abstraction library:
 * the surface is small, and the structured-output degradation path is the part
 * worth controlling directly.
 *
 * Keys come from the environment. Nothing here is imported by the engine tests,
 * so the suite stays offline.
 */
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderCapabilities,
} from './provider.ts';

interface HttpOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  capabilities: ProviderCapabilities;
  /** Injectable for tests. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${url} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------- OpenAI-compatible
// Covers OpenAI, Groq, Together, DeepSeek, OpenRouter, LM Studio, and anything
// else speaking /chat/completions, which is most of the field.

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private apiKey: string;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(id: string, opts: HttpOptions) {
    this.id = id;
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.7,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.stop?.length) body.stop = req.stop;

    // Only ask for constrained decoding when the provider actually supports it;
    // requesting json_schema from an endpoint that ignores it yields prose.
    if (req.schema) {
      if (this.capabilities.structuredOutput === 'native-schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.schema.name, schema: req.schema.schema, strict: false },
        };
      } else if (this.capabilities.structuredOutput === 'json-mode') {
        body.response_format = { type: 'json_object' };
      }
    }

    const json = (await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      body,
      this.fetcher,
      this.timeoutMs,
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: json.choices?.[0]?.message?.content ?? '',
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      model: this.model,
      schemaEnforced: !!req.schema && this.capabilities.structuredOutput === 'native-schema',
    };
  }
}

// ---------------------------------------------------------------- Anthropic

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private apiKey: string;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(opts: HttpOptions) {
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.7,
      messages: messages.length ? messages : [{ role: 'user', content: '...' }],
    };
    if (system) body.system = system;

    // A prefilled assistant turn opening a brace is the most reliable way to
    // get JSON out without tool calls.
    if (req.schema) {
      body.messages = [...(body.messages as unknown[]), { role: 'assistant', content: '{' }];
    }

    const json = (await postJson(
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      this.fetcher,
      this.timeoutMs,
    )) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let text = json.content?.map((c) => c.text ?? '').join('') ?? '';
    // Put back the brace we prefilled so the parser sees a whole object.
    if (req.schema && text && !text.trimStart().startsWith('{')) text = `{${text}`;

    return {
      text,
      tokensIn: json.usage?.input_tokens ?? 0,
      tokensOut: json.usage?.output_tokens ?? 0,
      model: this.model,
      schemaEnforced: false,
    };
  }
}

// ------------------------------------------------------------------- Ollama
// Local models are the reason the 64k floor exists in the first place.

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(opts: Omit<HttpOptions, 'apiKey'> & { apiKey?: string }) {
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        // num_ctx must be set explicitly or Ollama silently truncates to 2k,
        // which looks exactly like the model forgetting things.
        num_ctx: this.capabilities.contextWindow,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    };
    if (req.schema) body.format = req.schema.schema;

    const json = (await postJson(`${this.baseUrl}/api/chat`, {}, body, this.fetcher, this.timeoutMs)) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      text: json.message?.content ?? '',
      tokensIn: json.prompt_eval_count ?? 0,
      tokensOut: json.eval_count ?? 0,
      model: this.model,
      schemaEnforced: !!req.schema,
    };
  }
}

// -------------------------------------------------------------- presets

function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    contextWindow: 64_000,
    structuredOutput: 'json-mode',
    systemRole: true,
    streaming: false,
    costTier: 'mid',
    charsPerToken: 4,
    proseQuality: 0.6,
    steerability: 0.7,
    ...over,
  };
}

export interface ProviderSpec {
  kind: 'openai-compat' | 'anthropic' | 'ollama' | 'mock';
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

/**
 * Known targets. Prose quality is a subjective rating, per the design: benchmarks
 * do not predict it, and it is the hardest thing here to evaluate automatically.
 */
export const PRESETS: Record<string, ProviderSpec> = {
  'openai:gpt-4o': {
    kind: 'openai-compat',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    capabilities: { contextWindow: 128_000, structuredOutput: 'native-schema', costTier: 'premium', proseQuality: 0.75, steerability: 0.8 },
  },
  'openai:gpt-4o-mini': {
    kind: 'openai-compat',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    capabilities: { contextWindow: 128_000, structuredOutput: 'native-schema', costTier: 'cheap', proseQuality: 0.5, steerability: 0.7 },
  },
  'anthropic:sonnet': {
    kind: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    capabilities: { contextWindow: 200_000, structuredOutput: 'none', costTier: 'premium', proseQuality: 0.9, steerability: 0.9 },
  },
  'deepseek:chat': {
    kind: 'openai-compat',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    capabilities: { contextWindow: 64_000, structuredOutput: 'json-mode', costTier: 'cheap', proseQuality: 0.65, steerability: 0.7 },
  },
  'ollama:llama3.1': {
    kind: 'ollama',
    model: 'llama3.1:8b',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', costTier: 'free', proseQuality: 0.35, steerability: 0.45 },
  },
  'ollama:qwen2.5': {
    kind: 'ollama',
    model: 'qwen2.5:14b',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', costTier: 'free', proseQuality: 0.5, steerability: 0.55 },
  },
};

export function buildProvider(spec: ProviderSpec, env: Record<string, string | undefined> = process.env): Provider {
  const capabilities = caps(spec.capabilities);
  const apiKey = spec.apiKeyEnv ? (env[spec.apiKeyEnv] ?? '') : '';

  if (spec.kind !== 'ollama' && spec.kind !== 'mock' && !apiKey) {
    throw new Error(`missing ${spec.apiKeyEnv} for model ${spec.model}`);
  }

  switch (spec.kind) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey, baseUrl: spec.baseUrl ?? 'https://api.anthropic.com', model: spec.model, capabilities });
    case 'ollama':
      return new OllamaProvider({ baseUrl: spec.baseUrl ?? 'http://127.0.0.1:11434', model: spec.model, capabilities });
    case 'openai-compat':
      return new OpenAICompatProvider(spec.model.split(':')[0] ?? 'openai', {
        apiKey,
        baseUrl: spec.baseUrl ?? 'https://api.openai.com/v1',
        model: spec.model,
        capabilities,
      });
    default:
      throw new Error(`unsupported provider kind: ${spec.kind}`);
  }
}

/**
 * Role routing profiles. Most calls per turn are small ones, so putting a cheap
 * model on the mechanics and a strong one on narration dominates cost.
 *
 * The extractor is deliberately pinned separately: changing the model that
 * writes your graph mid-campaign yields a subtly inconsistent world with no
 * obvious cause.
 */
export const PROFILES: Record<string, { narrate: string; mechanics: string; extract: string }> = {
  local: { narrate: 'ollama:qwen2.5', mechanics: 'ollama:llama3.1', extract: 'ollama:qwen2.5' },
  balanced: { narrate: 'anthropic:sonnet', mechanics: 'openai:gpt-4o-mini', extract: 'openai:gpt-4o-mini' },
  premium: { narrate: 'anthropic:sonnet', mechanics: 'openai:gpt-4o', extract: 'openai:gpt-4o' },
  cheap: { narrate: 'deepseek:chat', mechanics: 'deepseek:chat', extract: 'deepseek:chat' },
};

export const MECHANIC_ROLES = ['classify', 'integrity', 'referee', 'director', 'humanize', 'summarize'] as const;
