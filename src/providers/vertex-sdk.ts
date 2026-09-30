/**
 * Vertex Gemini, through the AI SDK. Issue #170, phase 5.
 *
 * **`GoogleAuth` stays the injection boundary.** `createVertex` offers
 * `googleAuthOptions`, which would hand credential discovery to the SDK's own
 * `google-auth-library`. That would be a regression: the discovery this app
 * implements — Application Default Credentials, service-account keys,
 * refresh-token exchange, and a `gcloud auth print-access-token` fallback for
 * impersonation and external account types — is deterministic, tested, and
 * partly ours. So the token still comes from `GoogleAuth.accessToken()` and
 * enters through the wrapped `fetch`, and `googleAuthOptions` is left unset.
 *
 * Two Vertex specifics are preserved: Gemini's `systemInstruction` (the system
 * prompt is not a message, and its assistant turns are `model` turns), and the
 * five-stop-sequence cap.
 */
import { createVertex } from '@ai-sdk/google-vertex';
import { Output, generateText, jsonSchema, type LanguageModel } from 'ai';
import { GoogleAuth } from './google.ts';
import {
  normalizeFinishReason,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderCapabilities,
} from './provider.ts';
import { asProviderError, readStructuredOutput, streamProse } from './sdk-transport.ts';

export interface VertexSdkOptions {
  model: string;
  capabilities: ProviderCapabilities;
  /** Defaults to the project `GoogleAuth` discovers. */
  project?: string;
  location?: string;
  auth?: GoogleAuth;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class VertexSdkProvider implements Provider {
  readonly id = 'google';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private auth: GoogleAuth;
  private location: string;
  private project: string | undefined;
  private fetcher: typeof fetch | undefined;
  private resolveToken: () => Promise<string>;
  /** Cached per project: the project is baked into the request URL. */
  private inner = new Map<string, LanguageModel>();
  private timeoutMs: number;

  constructor(opts: VertexSdkOptions) {
    this.model = opts.model;
    this.capabilities = opts.capabilities;
    this.auth = opts.auth ?? new GoogleAuth();
    this.location = opts.location ?? 'us-central1';
    this.project = opts.project;
    this.fetcher = opts.fetcher;
    this.timeoutMs = opts.timeoutMs ?? 180_000;

    // Reading the key and the project per call is what keeps BYOK-style
    // rotation working, and both are cheap: `GoogleAuth` caches the token until
    // a minute before it expires, and the project comes from the environment.
    const auth = this.auth;
    this.resolveToken = async () => (await auth.accessToken()).accessToken;

  }

  /**
   * The language model, built on first use.
   *
   * Deferred because the project is baked into the request URL and discovery
   * may legitimately fail at construction: `buildProvider` has to be able to
   * *build* a keyless provider so the setup wizard can list it and say why it
   * is unavailable. Failing on the first call, rather than on construction, is
   * what the hand-rolled adapter did.
   */
  private languageModel(): LanguageModel {
    const project = this.project ?? this.auth.project();
    if (!project) {
      throw new Error('no Google Cloud project. Set GOOGLE_CLOUD_PROJECT or configure it in the provider spec.');
    }
    const cached = this.inner.get(project);
    if (cached) return cached;

    const model = createVertex({
      project,
      location: this.location,
      // The SDK otherwise builds its own `GoogleAuth` and asks it for a token —
      // which throws before any request is made, because this app's credentials
      // live in its own `GoogleAuth`, not in google-auth-library's discovery.
      // `authClient` is the documented seam, so a token from our resolver is
      // handed over there instead, and the SDK never reaches for its own.
      googleAuthOptions: {
        authClient: {
          getAccessToken: async () => ({ token: await this.resolveToken() }),
        },
      } as never,
      ...(this.fetcher ? { fetch: this.fetcher } : {}),
    })(this.model);
    this.inner.set(project, model);
    return model;
  }

  private request(req: CompletionRequest) {
    return {
      model: this.languageModel(),
      temperature: req.temperature ?? 0.7,
      maxOutputTokens: req.maxTokens ?? 2048,
      // Gemini accepts at most five stop sequences.
      ...(req.stop?.length ? { stopSequences: req.stop.slice(0, 5) } : {}),
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      maxRetries: 0,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base = this.request(req);
    // Gemini names its stops `STOP` / `MAX_TOKENS`, which
    // `normalizeFinishReason` reduces onto the shared allowlist.
    const systemText = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    // Streaming is only for prose. A half-arrived JSON object is worthless.
    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return streamProse(
        { ...base, ...(systemText ? { system: systemText } : {}), messages: userTurns(req) },
        this.model,
        this.resolveToken,
        (chunk) => req.onToken?.(chunk),
      );
    }

    try {
      const output =
        req.schema && this.capabilities.structuredOutput === 'native-schema'
          ? Output.object({ schema: jsonSchema(req.schema.schema), name: req.schema.name })
          : undefined;
      const result = await generateText({
        ...base,
        ...(systemText ? { system: systemText } : {}),
        messages: userTurns(req),
        ...(output ? { output } : {}),
      });
      // A shape mismatch must not throw: the caller validates and decides.
      if (output) await readStructuredOutput(result);

      return {
        text: result.text,
        tokensIn: result.usage.inputTokens ?? 0,
        tokensOut: result.usage.outputTokens ?? 0,
        model: this.model,
        schemaEnforced: !!output,
        finishReason: normalizeFinishReason(result.finishReason),
      };
    } catch (err) {
      throw asProviderError(err, '');
    }
  }
}

/** Gemini rejects an empty message list; system turns are sent separately. */
function userTurns(req: CompletionRequest) {
  const contents = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));
  return contents.length ? contents : [{ role: 'user' as const, content: '...' }];
}
