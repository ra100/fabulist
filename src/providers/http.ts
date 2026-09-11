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
import type { CompletionRequest, CompletionResult, Provider, ProviderCapabilities } from './provider.ts';
import { readNdjson, readSse, parseJsonSafe } from './stream.ts';
import { BedrockProvider } from './bedrock.ts';
import { VertexProvider } from './google.ts';
import { CopilotProvider } from './copilot.ts';

interface HttpOptions {
  /** Empty for local servers, which have nothing to authenticate against. */
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

/**
 * Dialect differences between servers that all claim to be OpenAI-compatible.
 * They agree on the chat shape and disagree on constrained decoding, which is
 * exactly the part that matters for delta extraction.
 */
export type OpenAIDialect = 'openai' | 'vllm' | 'llamacpp';

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private apiKey: string;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private dialect: OpenAIDialect;
  /**
   * Resolves an auth header per request when there is no static key.
   *
   * Exists for Unsloth Studio, which needs a bearer token but can mint one from
   * a local desktop secret — so a local install is usable with no key
   * configured. Kept as an injected hook rather than special-casing Unsloth in
   * this class: the adapter's job is the wire shape, not credential discovery.
   */
  private authHeader: (() => Promise<Record<string, string>>) | undefined;

  constructor(id: string, opts: HttpOptions & { dialect?: OpenAIDialect; authHeader?: () => Promise<Record<string, string>> }) {
    this.id = id;
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.dialect = opts.dialect ?? 'openai';
    this.authHeader = opts.authHeader;
  }

  /** A static key wins; otherwise ask the resolver, if one was supplied. */
  private async headers(): Promise<Record<string, string>> {
    if (this.apiKey) return { authorization: `Bearer ${this.apiKey}` };
    return this.authHeader ? await this.authHeader() : {};
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
        if (this.dialect === 'vllm') {
          // vLLM constrains generation through guided_json rather than
          // response_format, and silently ignores the latter.
          body.guided_json = req.schema.schema;
        } else if (this.dialect === 'llamacpp') {
          // llama-server takes a bare schema under json_schema.
          body.response_format = { type: 'json_object' };
          body.json_schema = req.schema.schema;
        } else {
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: req.schema.name, schema: req.schema.schema, strict: false },
          };
        }
      } else if (this.capabilities.structuredOutput === 'json-mode') {
        body.response_format = { type: 'json_object' };
      }
    }

    const headers: Record<string, string> = await this.headers();

    // Streaming is only for prose. A half-arrived JSON object is worthless.
    if (req.onToken && this.capabilities.streaming && !req.schema) {
      body.stream = true;
      body.stream_options = { include_usage: true };
      return this.stream(headers, body, req.onToken);
    }

    const json = (await postJson(
      `${this.baseUrl}/chat/completions`,
      headers,
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

  private async stream(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onToken: (chunk: string) => void,
  ): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${this.baseUrl} returned ${res.status}: ${text.slice(0, 300)}`);
      }

      let text = '';
      let tokensIn = 0;
      let tokensOut = 0;
      for await (const payload of readSse(res.body)) {
        const event = parseJsonSafe(payload);
        if (!event) continue;
        const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
        const chunk = choices?.[0]?.delta?.content;
        if (chunk) {
          text += chunk;
          onToken(chunk);
        }
        const usage = event.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage) {
          tokensIn = usage.prompt_tokens ?? tokensIn;
          tokensOut = usage.completion_tokens ?? tokensOut;
        }
      }
      return { text, tokensIn, tokensOut, model: this.model, schemaEnforced: false };
    } finally {
      clearTimeout(timer);
    }
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

    const authHeaders = { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };

    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return this.stream(authHeaders, { ...body, stream: true }, req.onToken);
    }

    const json = (await postJson(
      `${this.baseUrl}/v1/messages`,
      authHeaders,
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

  private async stream(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onToken: (chunk: string) => void,
  ): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
      }

      let text = '';
      let tokensIn = 0;
      let tokensOut = 0;
      for await (const payload of readSse(res.body)) {
        const event = parseJsonSafe(payload);
        if (!event) continue;
        // Anthropic names its events; content arrives as content_block_delta.
        if (event.type === 'content_block_delta') {
          const chunk = (event.delta as { text?: string } | undefined)?.text;
          if (chunk) {
            text += chunk;
            onToken(chunk);
          }
        }
        if (event.type === 'message_start') {
          const usage = (event.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
          tokensIn = usage?.input_tokens ?? tokensIn;
        }
        if (event.type === 'message_delta') {
          const usage = event.usage as { output_tokens?: number } | undefined;
          tokensOut = usage?.output_tokens ?? tokensOut;
        }
      }
      return { text, tokensIn, tokensOut, model: this.model, schemaEnforced: false };
    } finally {
      clearTimeout(timer);
    }
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

    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return this.stream({ ...body, stream: true }, req.onToken);
    }

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

  private async stream(body: Record<string, unknown>, onToken: (chunk: string) => void): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);

      let text = '';
      let tokensIn = 0;
      let tokensOut = 0;
      // Ollama streams newline-delimited JSON rather than SSE.
      for await (const line of readNdjson(res.body)) {
        const event = parseJsonSafe(line);
        if (!event) continue;
        const chunk = (event.message as { content?: string } | undefined)?.content;
        if (chunk) {
          text += chunk;
          onToken(chunk);
        }
        if (typeof event.prompt_eval_count === 'number') tokensIn = event.prompt_eval_count;
        if (typeof event.eval_count === 'number') tokensOut = event.eval_count;
      }
      return { text, tokensIn, tokensOut, model: this.model, schemaEnforced: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

// -------------------------------------------------------------- presets

function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    contextWindow: 64_000,
    structuredOutput: 'json-mode',
    systemRole: true,
    streaming: true,
    costTier: 'mid',
    charsPerToken: 4,
    proseQuality: 0.6,
    steerability: 0.7,
    ...over,
  };
}

export type ProviderKind =
  | 'openai-compat'
  | 'anthropic'
  | 'ollama'
  | 'bedrock'
  | 'google'
  | 'copilot'
  | 'mock';

/**
 * How a provider authenticates. Naming this explicitly matters because the
 * interesting cases are the keyless ones: a work laptop has an AWS profile or a
 * gcloud login, not an exported API key.
 */
export type AuthMode = 'none' | 'api-key' | 'aws-profile' | 'google-oauth' | 'copilot-oauth';

export interface ProviderSpec {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  /** Only meaningful for auth 'api-key'. */
  apiKeyEnv?: string;
  auth?: AuthMode;
  capabilities?: Partial<ProviderCapabilities>;
  dialect?: OpenAIDialect;
  /** AWS: overrides AWS_PROFILE and the resolved region. */
  profile?: string;
  region?: string;
  /** Google: project and location, both discoverable but overridable. */
  project?: string;
  location?: string;
  /** Copilot: required acknowledgement that the endpoint is unofficial. */
  allowUnofficial?: boolean;
  /**
   * A local credential fallback this target supports, tried when `apiKeyEnv` is
   * unset. `unsloth-desktop` exchanges the desktop install's on-disk secret for
   * a bearer token, which is what makes a local Unsloth usable with no key.
   */
  localAuth?: 'unsloth-desktop';
  /** Human note shown by the provider doctor. */
  note?: string;
}

/** Which auth a kind uses when the spec does not say. */
export function defaultAuth(kind: ProviderKind): AuthMode {
  switch (kind) {
    case 'ollama':
    case 'mock':
      return 'none';
    case 'bedrock':
      return 'aws-profile';
    case 'google':
      return 'google-oauth';
    case 'copilot':
      return 'copilot-oauth';
    default:
      return 'api-key';
  }
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

  // --- local OpenAI-compatible servers. No key: there is nothing to
  // authenticate against, and sending a bogus bearer makes some of them 401.

  'vllm:local': {
    kind: 'openai-compat',
    model: 'default',
    baseUrl: 'http://127.0.0.1:8000/v1',
    auth: 'none',
    dialect: 'vllm',
    note: 'set model to the id vLLM was launched with (see GET /v1/models)',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', costTier: 'free', proseQuality: 0.55, steerability: 0.6 },
  },
  'llamacpp:local': {
    kind: 'openai-compat',
    model: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    auth: 'none',
    dialect: 'llamacpp',
    note: 'llama-server; start it with --ctx-size 65536 or larger',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', costTier: 'free', proseQuality: 0.45, steerability: 0.5 },
  },
  'unsloth:local': {
    kind: 'openai-compat',
    model: 'unsloth',
    // Unsloth Studio's real port and auth, confirmed against a running
    // instance's `GET /openapi.json` rather than assumed: it serves
    // `/v1/chat/completions` on 8888 behind a bearer key, *not* an unauthed
    // vLLM on 8000. This preset previously described the latter, so it could
    // only ever have failed — with a connection refusal or a 401.
    baseUrl: 'http://127.0.0.1:8888/v1',
    auth: 'api-key',
    apiKeyEnv: 'UNSLOTH_API_KEY',
    // A desktop install is authenticated from its own local secret, so this
    // builds and works with no key exported; UNSLOTH_API_KEY is needed only for
    // a remote instance, whose secret this machine cannot read.
    localAuth: 'unsloth-desktop',
    note: 'Unsloth Studio. A local desktop install needs no key; set UNSLOTH_API_KEY for a remote one. Serves images on the same port — see the unsloth:local image preset',
    // Downgraded from 'native-schema': the OpenAI-compatible surface here is
    // llama-server's, which honours json_object but not a full json_schema
    // contract, and claiming otherwise is exactly the silent-corruption path
    // `provider.ts` warns about for the extract role.
    capabilities: { contextWindow: 64_000, structuredOutput: 'json-mode', costTier: 'free', proseQuality: 0.5, steerability: 0.55 },
  },
  'lmstudio:local': {
    kind: 'openai-compat',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    auth: 'none',
    capabilities: { contextWindow: 64_000, structuredOutput: 'json-mode', costTier: 'free', proseQuality: 0.45, steerability: 0.5 },
  },

  // --- keyless cloud.

  'bedrock:sonnet': {
    kind: 'bedrock',
    // Cross-region inference profile id, not the bare model id: on-demand
    // invocation of this model is refused outright ("Retry your request with
    // the ID or ARN of an inference profile that contains this model"),
    // confirmed directly against the API rather than assumed from the docs.
    model: 'us.anthropic.claude-sonnet-5',
    auth: 'aws-profile',
    note: 'needs model access enabled in the Bedrock console for your region',
    capabilities: {
      contextWindow: 200_000,
      structuredOutput: 'native-schema',
      costTier: 'premium',
      proseQuality: 0.92,
      steerability: 0.9,
      // Confirmed directly: every temperature except the model's own default
      // of 1.0 comes back as a 400 ("temperature is deprecated for this
      // model"). Omitting the field is the only value that works.
      fixedTemperature: true,
    },
  },
  'bedrock:haiku': {
    kind: 'bedrock',
    // Cross-region inference profile id, not the bare model id — same trap as
    // bedrock:sonnet: on-demand invocation of this model is refused outright.
    // The pinned model id ages out of Bedrock's catalog independently of this
    // one; confirmed directly against the API each time, not assumed.
    model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    auth: 'aws-profile',
    capabilities: { contextWindow: 200_000, structuredOutput: 'native-schema', costTier: 'cheap', proseQuality: 0.65, steerability: 0.75 },
  },
  'bedrock:nova-pro': {
    kind: 'bedrock',
    model: 'amazon.nova-pro-v1:0',
    auth: 'aws-profile',
    capabilities: { contextWindow: 300_000, structuredOutput: 'native-schema', costTier: 'mid', proseQuality: 0.6, steerability: 0.65 },
  },
  'google:gemini-pro': {
    kind: 'google',
    model: 'gemini-2.5-pro',
    auth: 'google-oauth',
    note: 'gcloud auth application-default login',
    capabilities: { contextWindow: 1_000_000, structuredOutput: 'native-schema', costTier: 'premium', proseQuality: 0.8, steerability: 0.8 },
  },
  'google:gemini-flash': {
    kind: 'google',
    model: 'gemini-2.5-flash',
    auth: 'google-oauth',
    capabilities: { contextWindow: 1_000_000, structuredOutput: 'native-schema', costTier: 'cheap', proseQuality: 0.6, steerability: 0.7 },
  },
  'copilot:gpt-4o': {
    kind: 'copilot',
    model: 'gpt-4o',
    auth: 'copilot-oauth',
    note: 'UNOFFICIAL: undocumented endpoint, likely outside the Copilot terms of service',
    capabilities: { contextWindow: 128_000, structuredOutput: 'none', costTier: 'free', proseQuality: 0.7, steerability: 0.75 },
  },
};

export function buildProvider(spec: ProviderSpec, env: Record<string, string | undefined> = process.env): Provider {
  const capabilities = caps(spec.capabilities);
  const auth = spec.auth ?? defaultAuth(spec.kind);
  const apiKey = auth === 'api-key' && spec.apiKeyEnv ? (env[spec.apiKeyEnv] ?? '') : '';

  // A spec may name its own local credential fallback. Unsloth is the case that
  // needs it: it requires a bearer token, but a desktop install can mint one
  // from a secret already on this machine, so demanding an exported key would
  // make the common local setup fail for no reason.
  const localAuth = spec.localAuth === 'unsloth-desktop';
  if (auth === 'api-key' && !apiKey && !localAuth) {
    throw new Error(`missing ${spec.apiKeyEnv ?? 'API key'} for model ${spec.model}`);
  }

  switch (spec.kind) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey, baseUrl: spec.baseUrl ?? 'https://api.anthropic.com', model: spec.model, capabilities });
    case 'ollama':
      return new OllamaProvider({ baseUrl: spec.baseUrl ?? 'http://127.0.0.1:11434', model: spec.model, capabilities });
    case 'bedrock':
      return new BedrockProvider({
        modelId: spec.model,
        capabilities,
        ...(spec.profile ? { profile: spec.profile } : {}),
        ...(spec.region ? { region: spec.region } : {}),
      });
    case 'google':
      return new VertexProvider({
        model: spec.model,
        capabilities,
        ...(spec.project ? { project: spec.project } : {}),
        ...(spec.location ? { location: spec.location } : {}),
      });
    case 'copilot':
      return new CopilotProvider({
        model: spec.model,
        capabilities,
        allowUnofficial: spec.allowUnofficial === true,
      });
    case 'openai-compat': {
      const base = spec.baseUrl ?? 'https://api.openai.com/v1';
      // The resolver is attached only when the spec asked for it, so no other
      // openai-compatible target grows a surprise credential lookup.
      const authHeader = localAuth
        ? async () => {
            const { UnslothAuth } = await import('./unslothAuth.ts');
            // `/v1` is this provider's API prefix; the auth endpoints sit at the
            // server root, so it is stripped before handing the base over.
            const root = base.replace(/\/v1\/?$/, '');
            return new UnslothAuth({ baseUrl: root }).authHeader();
          }
        : undefined;
      return new OpenAICompatProvider(spec.model.split(':')[0] ?? 'openai', {
        apiKey,
        baseUrl: base,
        model: spec.model,
        capabilities,
        ...(spec.dialect ? { dialect: spec.dialect } : {}),
        ...(authHeader ? { authHeader } : {}),
      });
    }
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
  vllm: { narrate: 'vllm:local', mechanics: 'vllm:local', extract: 'vllm:local' },
  llamacpp: { narrate: 'llamacpp:local', mechanics: 'llamacpp:local', extract: 'llamacpp:local' },
  balanced: { narrate: 'anthropic:sonnet', mechanics: 'openai:gpt-4o-mini', extract: 'openai:gpt-4o-mini' },
  premium: { narrate: 'anthropic:sonnet', mechanics: 'openai:gpt-4o', extract: 'openai:gpt-4o' },
  cheap: { narrate: 'deepseek:chat', mechanics: 'deepseek:chat', extract: 'deepseek:chat' },
  // Keyless: an AWS profile or a gcloud login is all these need.
  bedrock: { narrate: 'bedrock:sonnet', mechanics: 'bedrock:haiku', extract: 'bedrock:haiku' },
  google: { narrate: 'google:gemini-pro', mechanics: 'google:gemini-flash', extract: 'google:gemini-flash' },
  copilot: { narrate: 'copilot:gpt-4o', mechanics: 'copilot:gpt-4o', extract: 'copilot:gpt-4o' },
};

/**
 * The profiles a given configuration can actually offer: the built-ins, plus one
 * per provider the operator added themselves.
 *
 * `PROFILES` names *preset keys*, and every local preset is pinned to
 * 127.0.0.1 — so a model living anywhere else (an Ollama on the LAN, a vLLM in
 * the next container) could be added, tested green, and still leave the setup
 * wizard with nothing but the mock to offer, because no built-in profile
 * mentions it. Configuring a provider is already the statement "I want to use
 * this one", so it gets a profile of its own name routing every role at it.
 *
 * Reserved names win a collision: `local` has to keep meaning the two-model
 * Ollama profile even if someone names a provider `local`, and `mock` stays the
 * offline one.
 */
export function profilesFor(
  providers: Record<string, ProviderSpec> = {},
): Record<string, { narrate: string; mechanics: string; extract: string }> {
  const derived: Record<string, { narrate: string; mechanics: string; extract: string }> = {};
  for (const key of Object.keys(providers)) {
    if (key === 'mock' || key in PROFILES) continue;
    derived[key] = { narrate: key, mechanics: key, extract: key };
  }
  return { ...derived, ...PROFILES };
}

export const MECHANIC_ROLES = ['classify', 'integrity', 'referee', 'director', 'humanize', 'summarize', 'setup'] as const;
