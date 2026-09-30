/**
 * Anthropic Messages, through the AI SDK. Issue #168, phase 3.
 *
 * Replaces the transport in `AnthropicProvider` (in `http.ts`) while keeping
 * Fabulist's structured-output policy: a model that answers with the wrong shape
 * is caught by Fabulist's validator, not by the SDK, because that validator also
 * decides whether to repair or fail.
 *
 * The two Anthropic-specific behaviours preserved here:
 *
 *   - The system prompt is a top-level field, not a message, joined with blank
 *     lines — which is what the hand-rolled adapter sent and what
 *     `adaptRequest`'s system-role folding is written against.
 *   - For a provider with no constrained decoding, a prefilled assistant turn
 *     opening a brace is the most reliable way to get JSON out without tool
 *     use, and the brace is restored on the way back so the parser sees a whole
 *     object.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { Output, generateText, jsonSchema, type LanguageModel, type ModelMessage } from 'ai';
import {
  normalizeFinishReason,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderCapabilities,
} from './provider.ts';
import { asProviderError, streamProse } from './sdk-transport.ts';

export interface AnthropicSdkOptions {
  apiKey: string | (() => string | Promise<string>);
  baseUrl: string;
  model: string;
  capabilities: ProviderCapabilities;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class AnthropicSdkProvider implements Provider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private inner: LanguageModel;
  private resolveKey: () => Promise<string>;
  private timeoutMs: number;

  constructor(opts: AnthropicSdkOptions) {
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    const source = opts.apiKey;
    this.resolveKey = async () => (typeof source === 'function' ? await source() : source);
    this.timeoutMs = opts.timeoutMs ?? 120_000;

    const transport = opts.fetcher ?? fetch;
    const resolveKey = this.resolveKey;
    this.inner = createAnthropic({
      baseURL: opts.baseUrl.replace(/\/$/, ''),
      // `createAnthropic` refuses to build without an apiKey. The real one is
      // read per request in the fetch wrapper, so this placeholder only has to
      // satisfy construction — and the wrapper deletes it, so it can never reach
      // the wire. Anthropic wants `x-api-key`, not a bearer token.
      apiKey: 'resolved-per-request',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('x-api-key');
        headers.delete('authorization');
        const key = await resolveKey();
        // Fail closed: with no key the request goes out unauthenticated and the
        // provider refuses it, rather than a placeholder being sent in its place.
        if (key) headers.set('x-api-key', key);
        return transport(input, { ...init, headers });
      },
    })(opts.model);
  }

  private request(req: CompletionRequest) {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages: ModelMessage[] = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    // Anthropic rejects an empty message list outright.
    if (messages.length === 0) messages.push({ role: 'user', content: '...' });

    return {
      model: this.inner,
      ...(system ? { system } : {}),
      messages,
      maxOutputTokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.7,
      ...(req.stop?.length ? { stopSequences: req.stop } : {}),
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      maxRetries: 0,
    };
  }

  /** Prefilled brace for a provider with no constrained decoding; nothing otherwise. */
  private prefilled(req: CompletionRequest, messages: ModelMessage[]): ModelMessage[] | undefined {
    if (!req.schema || this.capabilities.structuredOutput === 'native-schema') return undefined;
    return [...messages, { role: 'assistant', content: '{' }];
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base = this.request(req);
    const prefilled = this.prefilled(req, base.messages);
    const messages = prefilled ?? base.messages;

    // Streaming is only for prose. A half-arrived JSON object is worthless.
    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return streamProse({ ...base, messages }, this.model, this.resolveKey, (chunk) => req.onToken?.(chunk));
    }

    try {
      const output =
        req.schema && this.capabilities.structuredOutput === 'native-schema'
          ? Output.object({ schema: jsonSchema(req.schema.schema), name: req.schema.name })
          : undefined;
      const result = await generateText({
        ...base,
        messages,
        ...(output ? { output } : {}),
      });
      // A shape mismatch must not throw: the caller validates and decides.
      if (output) await Promise.resolve(result.output).catch(() => undefined);

      let text = result.text;
      // Put back the brace we prefilled so the parser sees a whole object.
      if (req.schema && !output && text && !text.trimStart().startsWith('{')) text = `{${text}`;

      return {
        text,
        tokensIn: result.usage.inputTokens ?? 0,
        tokensOut: result.usage.outputTokens ?? 0,
        model: this.model,
        schemaEnforced: !!output,
        finishReason: normalizeFinishReason(result.finishReason),
      };
    } catch (err) {
      throw asProviderError(err, await this.resolveKey());
    }
  }
}
