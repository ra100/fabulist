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
}

export interface CompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  /** True when the provider guaranteed schema conformance rather than us parsing it. */
  schemaEnforced: boolean;
}

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
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
  all(): Provider[];
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

  route(role: string, provider: Provider): void {
    this.byRole.set(role, provider);
  }

  all(): Provider[] {
    return [...new Set([this.fallback, ...this.byRole.values()])];
  }
}
