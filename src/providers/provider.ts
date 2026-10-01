/**
 * Provider abstraction. See DESIGN.md §9.3.
 *
 * The interface is deliberately five methods wide. The value is not in
 * abstracting providers away, it is in owning the *degradation path* for
 * structured output, because that is where a weak provider does permanent
 * damage: a malformed delta corrupts the graph and every later turn inherits it.
 */

export type StructuredOutputMode = 'native-schema' | 'json-mode' | 'none';

export interface ProviderCapabilities {
  contextWindow: number;
  structuredOutput: StructuredOutputMode;
  systemRole: boolean;
  streaming: boolean;
  costTier: 'free' | 'cheap' | 'mid' | 'premium';
  /** Chars-per-token estimate; see frame/tokenizer.ts for why this is a heuristic. */
  charsPerToken: number;
  /** Subjective, your own rating. Benchmarks do not predict prose quality. */
  proseQuality: number;
  /** How well it holds a style contract over many turns. */
  steerability: number;
  /**
   * Some newer models reject an explicit `temperature` outright rather than
   * clamping it — Bedrock's `claude-sonnet-5` returns a 400 ("temperature is
   * deprecated for this model") for every value except its own default of 1.0,
   * discovered by hitting it directly rather than assumed. When true, the
   * adapter omits the field instead of sending whatever the caller asked for,
   * so callers that want deterministic output (`temperature: 0` for the
   * mechanical roles) still get the closest thing the model allows.
   */
  fixedTemperature?: boolean;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: Message[];
  /** Role name, for logging and per-role model routing. */
  role: string;
  maxTokens?: number;
  temperature?: number;
  /** When set, the provider must return JSON conforming to this shape. */
  schema?: JsonSchema;
  stop?: string[];
  /**
   * Called with each text fragment as it arrives. Only honoured by providers
   * whose capabilities declare streaming, and never used with `schema`: a
   * half-arrived JSON object is worthless, whereas half a paragraph of prose is
   * exactly what a writer wants to see.
   */
  onToken?: (chunk: string) => void;
}

export interface CompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  /** True when the provider guaranteed schema conformance rather than us parsing it. */
  schemaEnforced: boolean;
  /** Normalized provider termination status; safe to include in diagnostic logs. */
  finishReason?: ProviderFinishReason;
}

export type ProviderFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'other';

/** Reduce provider-specific finish statuses to an allowlisted diagnostic value. */
export function normalizeFinishReason(value: unknown): ProviderFinishReason | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    // Gemini reports in SCREAMING_SNAKE and upper case.
    case 'STOP':
    case 'MODEL_STOP':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'length';
    case 'content_filter':
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'function_call':
      return 'function_call';
    default:
      return 'other';
  }
}

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * A non-2xx provider answer.
 *
 * Lives beside the contract rather than in `http.ts` so an SDK-backed adapter
 * can raise the same error without importing the hand-rolled transport:
 * `byok.ts` branches on `status` and reads `body` to tell a rejected key from
 * an outage, and that branch must not care which transport produced it.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  /**
   * The response body, kept raw and short. A status alone cannot tell a bad key
   * from a key that is fine but not allowed to make this call, and several
   * providers put the difference only in the body — so the caller gets to read
   * it rather than reverse-engineer it back out of the message.
   */
  readonly body: string;

  constructor(status: number, message: string, body = '') {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.body = body;
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

/**
 * Rebuilds a provider failure with secrets scrubbed, keeping what diagnosis
 * needs: an HTTP failure stays a `ProviderHttpError` with its status and body,
 * and anything else keeps its `cause`, which is where a fetch failure says why.
 */
export function scrubProviderError(err: unknown, known: readonly string[] = []): Error {
  if (err instanceof ProviderHttpError) {
    return new ProviderHttpError(err.status, scrubSecrets(err.message, known), scrubSecrets(err.body, known));
  }
  const message = scrubSecrets(err instanceof Error ? err.message : String(err), known);
  return err instanceof Error && err.cause !== undefined ? new Error(message, { cause: err.cause }) : new Error(message);
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  /** Credential row used by this provider, for per-key usage attribution. */
  readonly usageKeyId?: string;
  /** Usage source when a mixed personal registry falls back to this provider. */
  readonly usageKeySource?: 'own' | 'server';
  readonly capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Adapts a request to what the provider actually supports.
 * Two degradations matter in practice: no system role (fold it into the first
 * user message) and no schema support (ask for a fenced JSON block instead).
 */
export function adaptRequest(req: CompletionRequest, caps: ProviderCapabilities): CompletionRequest {
  let messages = req.messages;

  if (!caps.systemRole) {
    const systems = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = messages.filter((m) => m.role !== 'system');
    if (systems.length) {
      const first = rest[0];
      const merged = `${systems.join('\n\n')}\n\n${first?.content ?? ''}`.trim();
      messages = [{ role: 'user', content: merged }, ...rest.slice(1)];
    }
  }

  if (req.schema && caps.structuredOutput === 'none') {
    // No constrained decoding available: instruct explicitly and validate hard
    // on the way back in. The validator, not the prompt, is the real guard.
    const instruction =
      `Reply with a single JSON object and nothing else. No prose, no code fence.\n` +
      `It must match this JSON Schema:\n${JSON.stringify(req.schema.schema)}`;
    messages = [...messages, { role: 'user', content: instruction }];
  }

  return { ...req, messages };
}

/**
 * Pulls a JSON object out of a model response. Providers with no schema support
 * wrap JSON in fences, add preamble, or trail commentary; all three are common
 * enough that tolerating them is worth the small parser.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to recovery
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  // Balance braces from the first `{` so trailing commentary is ignored.
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(`no JSON object found in response: ${trimmed.slice(0, 200)}`);
}

/** Per-role routing so cheap models do bookkeeping and a strong one narrates. */
export interface Registry {
  get(role: string): Provider;
  /** Returns only an explicitly routed provider, without the global fallback. */
  getOptional?(role: string): Provider | undefined;
  all(): Provider[];
}

/**
 * A registry whose backing registry can be replaced.
 *
 * The engine and the setup service both hold their registry for the process
 * lifetime, so switching provider profile would otherwise mean a restart. They
 * hold this instead, and swapping is one assignment — which is what makes
 * "you have Bedrock available, use it" a button rather than a documentation note.
 */
export class SwappableRegistry implements Registry {
  private current: Registry;
  private label: string;

  constructor(initial: Registry, label = 'mock') {
    this.current = initial;
    this.label = label;
  }

  get(role: string): Provider {
    return this.current.get(role);
  }

  getOptional(role: string): Provider | undefined {
    return this.current.getOptional?.(role);
  }

  all(): Provider[] {
    return this.current.all();
  }

  swap(next: Registry, label: string): void {
    this.current = next;
    this.label = label;
  }

  profile(): string {
    return this.label;
  }
}

export class ProviderRegistry implements Registry {
  private byRole = new Map<string, Provider>();
  private fallback: Provider;

  constructor(fallback: Provider, routes: Record<string, Provider> = {}) {
    this.fallback = fallback;
    for (const [role, p] of Object.entries(routes)) this.byRole.set(role, p);
  }

  get(role: string): Provider {
    return this.byRole.get(role) ?? this.fallback;
  }

  getOptional(role: string): Provider | undefined {
    return this.byRole.get(role);
  }

  route(role: string, provider: Provider): void {
    this.byRole.set(role, provider);
  }

  all(): Provider[] {
    return [...new Set([this.fallback, ...this.byRole.values()])];
  }
}
