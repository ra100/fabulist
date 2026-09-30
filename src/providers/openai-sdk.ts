/**
 * OpenAI-shaped chat completions, through the AI SDK. Issue #166, phase 1.
 *
 * This is a drop-in replacement for `OpenAICompatProvider`, and the parity
 * contract in `test/contract/provider-contract.ts` is what makes it safe to
 * swap: the two run the same assertions, so a difference is a failing test
 * rather than a bug report.
 *
 * Three things are not the SDK's to decide, and are therefore owned here:
 *
 *   - **Credentials.** `createOpenAICompatible` takes `headers` as a *static*
 *     record, with no dynamic seam at provider or model-call settings. So the
 *     wrapped `fetch` is the only place a key can enter, and it reads it per
 *     request. See `docs/ai-sdk-transport-decision.md`.
 *   - **Errors.** `APICallError` carries an untruncated `responseBody` *and* a
 *     `requestBodyValues` holding the entire prompt. Both are dropped here and
 *     rebuilt into a `ProviderHttpError`, which is what `byok.ts` branches on.
 *   - **Schema policy.** Fabulist's validator, not the SDK's, is the real guard
 *     on a model that answers with the wrong shape, so a parse failure is
 *     returned as text rather than thrown.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, generateText, jsonSchema, type LanguageModel } from 'ai';
import {
  normalizeFinishReason,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderCapabilities,
} from './provider.ts';
import { asProviderError, streamProse } from './sdk-transport.ts';

export interface OpenAISdkOptions {
  id: string;
  /**
   * A fixed key, or a resolver called per request.
   *
   * BYOK passes a resolver so a lock or delete between two calls of one turn
   * stops the second call, exactly as the hand-rolled adapter does.
   */
  apiKey: string | (() => string | Promise<string>);
  baseUrl: string;
  model: string;
  capabilities: ProviderCapabilities;
  /**
   * Extra headers resolved per request, for targets with no static key.
   *
   * This exists for Unsloth Studio, which needs a bearer token but can mint one
   * from a local desktop secret. It is an injected hook rather than a special
   * case, so credential discovery stays outside the transport.
   */
  authHeader?: () => Promise<Record<string, string>>;
  /** Injectable for tests, and for BYOK's redirect policy. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class OpenAISdkProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private inner: LanguageModel;
  private resolveKey: () => Promise<string>;
  private timeoutMs: number;

  constructor(opts: OpenAISdkOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    const source = opts.apiKey;
    this.resolveKey = async () => (typeof source === 'function' ? await source() : source);
    this.timeoutMs = opts.timeoutMs ?? 120_000;

    const transport = opts.fetcher ?? fetch;
    const resolveKey = this.resolveKey;
    this.inner = createOpenAICompatible({
      name: opts.id,
      baseURL: opts.baseUrl.replace(/\/$/, ''),
      // Streaming usage is off by default on this provider; Fabulist meters
      // every token, and a narrator reporting zero would quietly under-bill.
      includeUsage: true,
      supportsStructuredOutputs: opts.capabilities.structuredOutput === 'native-schema',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        // A static key wins; otherwise ask the injected resolver, if there is one.
        const key = await resolveKey();
        if (key) headers.set('authorization', `Bearer ${key}`);
        if (opts.authHeader) for (const [name, value] of Object.entries(await opts.authHeader())) headers.set(name, value);
        return transport(input, { ...init, headers });
      },
    })(opts.model);
  }

  /**
   * Only the request shape, so a caller and an executor cannot drift.
   */
  private request(req: CompletionRequest) {
    return {
      model: this.inner,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.stop?.length ? { stopSequences: req.stop } : {}),
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      // System messages default to *rejected* in AI SDK 7; they must go in
      // `instructions`. Fabulist's whole message contract, and `adaptRequest`'s
      // system-role folding, is built on `role: 'system'` appearing in the
      // message list, and the hand-rolled adapter sends exactly that on the
      // wire. Moving them to `instructions` would re-order them relative to the
      // conversation, so the old shape is opted back into explicitly.
      allowSystemInMessages: true,
      // The hand-rolled adapter never retries, and Fabulist meters and narrates
      // per call: a silent SDK retry would double the cost of a turn and turn a
      // fast failure into a six-second one. Retry policy belongs to the caller.
      maxRetries: 0,
    };
  }

  /**
   * Asks for constrained decoding only when the provider has it. Requesting
   * `json_schema` from an endpoint that ignores it yields prose, which is a
   * worse failure than not asking at all.
   */
  private output(req: CompletionRequest) {
    if (!req.schema) return undefined;
    if (this.capabilities.structuredOutput === 'native-schema') {
      return Output.object({ schema: jsonSchema(req.schema.schema), name: req.schema.name });
    }
    if (this.capabilities.structuredOutput === 'json-mode') return Output.json();
    // No constrained decoding: `adaptRequest` has already appended an explicit
    // JSON instruction to the messages, and the validator does the rest.
    return undefined;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Streaming is only for prose. A half-arrived JSON object is worthless.
    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return this.stream(req);
    }

    try {
      const output = this.output(req);
      const result = await generateText({ ...this.request(req), ...(output ? { output } : {}) });
      // A shape mismatch must not throw here: the caller validates and decides
      // whether to repair or fail, and a thrown error would skip that entirely.
      // `result.output` is only thenable when an output spec was supplied.
      if (output) await Promise.resolve(result.output).catch(() => undefined);
      return {
        text: result.text,
        tokensIn: result.usage.inputTokens ?? 0,
        tokensOut: result.usage.outputTokens ?? 0,
        model: this.model,
        schemaEnforced: !!req.schema && this.capabilities.structuredOutput === 'native-schema',
        finishReason: normalizeFinishReason(result.finishReason),
      };
    } catch (err) {
      throw asProviderError(err, await this.resolveKey());
    }
  }

  private stream(req: CompletionRequest): Promise<CompletionResult> {
    return streamProse(this.request(req), this.model, this.resolveKey, (chunk) => req.onToken?.(chunk));
  }
}
