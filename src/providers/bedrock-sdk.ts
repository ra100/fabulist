/**
 * Bedrock Converse, through the AI SDK. Issue #169, phase 4.
 *
 * Credentials stay exactly where they were. `createAmazonBedrock` takes a
 * `credentialProvider` callback, so Fabulist's `AwsCredentialProvider` — and
 * therefore its precedence (environment, credentials file, `credential_process`,
 * SSO, assume-role) and its five-minute-early refresh — is still what decides
 * who is calling. This adapter never sees a profile, a credentials file, or a
 * role chain; it only asks for credentials and signs with what it is given.
 *
 * SigV4 signing itself moves to the SDK. `sigv4.ts` is *not* deleted: the image
 * path in `bedrockImage.ts` still signs its own requests.
 */
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { Output, generateText, jsonSchema, type LanguageModel, type ModelMessage } from 'ai';
import { AwsCredentialProvider } from './aws.ts';
import { bedrockHint, collapse } from './bedrock.ts';
import {
  ProviderHttpError,
  normalizeFinishReason,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderCapabilities,
} from './provider.ts';
import { asProviderError, readStructuredOutput, streamProse } from './sdk-transport.ts';

export interface BedrockSdkOptions {
  modelId: string;
  capabilities: ProviderCapabilities;
  profile?: string;
  region?: string;
  credentials?: AwsCredentialProvider;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Converse requires alternating turns starting with `user`, so the collapse the
 * hand-rolled adapter did is still the one that has to happen.
 *
 * The SDK's own message shape is used afterwards — `{ type: 'text', text }`
 * content blocks rather than Converse's bare `{ text }` — because the SDK
 * converts to Converse itself and validates its input against that shape first.
 */
function toSdkMessages(req: CompletionRequest): ModelMessage[] {
  const collapsed = collapse(
    req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ text: m.content }] })),
  );
  return collapsed.map((m) => ({
    role: m.role,
    content: m.content.map((block) => ({ type: 'text' as const, text: block.text })),
  })) as ModelMessage[];
}

export class BedrockSdkProvider implements Provider {
  readonly id = 'bedrock';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private credentials: AwsCredentialProvider;
  private profile: string | undefined;
  private regionOverride: string | undefined;
  private inner: LanguageModel;
  private resolveKey: () => Promise<string>;
  private timeoutMs: number;

  constructor(opts: BedrockSdkOptions) {
    this.model = opts.modelId;
    this.capabilities = opts.capabilities;
    this.credentials = opts.credentials ?? new AwsCredentialProvider();
    this.profile = opts.profile;
    this.regionOverride = opts.region;
    this.resolveKey = async () => '';
    this.timeoutMs = opts.timeoutMs ?? 180_000;

    const credentials = this.credentials;
    const profile = opts.profile;
    // Region resolution reads the environment and config files only — no
    // network — so doing it once here matches what the adapter did per call
    // without making the provider itself short-lived.
    const region = opts.region ?? credentials.region(profile);

    this.inner = createAmazonBedrock({
      region,
      credentialProvider: async () => {
        const resolved = await credentials.resolve(profile);
        return {
          accessKeyId: resolved.credentials.accessKeyId,
          secretAccessKey: resolved.credentials.secretAccessKey,
          ...(resolved.credentials.sessionToken ? { sessionToken: resolved.credentials.sessionToken } : {}),
        };
      },
      ...(opts.fetcher ? { fetch: opts.fetcher } : {}),
    })(opts.modelId);
  }

  private request(req: CompletionRequest) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = toSdkMessages(req);
    return {
      model: this.inner,
      // Some models — Bedrock's claude-sonnet-5, confirmed against the API —
      // reject any explicit temperature with a 400 rather than clamping it.
      // Omitting the field is the only value that works, and callers that want
      // deterministic output for the mechanical roles still get the closest
      // thing the model allows.
      ...(this.capabilities.fixedTemperature ? {} : { temperature: req.temperature ?? 0.7 }),
      maxOutputTokens: req.maxTokens ?? 2048,
      ...(req.stop?.length ? { stopSequences: req.stop.slice(0, 4) } : {}),
      ...(system ? { system } : {}),
      messages: (messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '...' }] }]) as ModelMessage[],
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      maxRetries: 0,
      providerOptions: {
        // Forced tool use obliges the model to emit arguments matching the
        // schema, which is the same guarantee `outputFormat` would give and the
        // one the hand-rolled adapter used.
        bedrock: { structuredOutputMode: 'jsonTool' },
      },
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base = this.request(req);

    // Streaming is prose-only: a forced tool call has nothing to emit
    // incrementally, and a partial arguments object cannot be validated.
    if (req.onToken && this.capabilities.streaming && !req.schema) {
      return streamProse(base, this.model, this.resolveKey, (chunk) => req.onToken?.(chunk));
    }

    try {
      const output =
        req.schema && this.capabilities.structuredOutput === 'native-schema'
          ? Output.object({ schema: jsonSchema(req.schema.schema), name: req.schema.name })
          : undefined;
      const result = await generateText({ ...base, ...(output ? { output } : {}) });

      // Forced tool use puts the answer in the tool call, not the text, so the
      // legacy adapter serialized `toolUse.input` itself. Doing the same here
      // keeps `text` meaning "the whole object" for `extractJson` downstream.
      let text = result.text;
      if (output) {
        const parsed = await readStructuredOutput(result);
        if (parsed !== undefined) text = JSON.stringify(parsed);
      }

      return {
        text,
        tokensIn: result.usage.inputTokens ?? 0,
        tokensOut: result.usage.outputTokens ?? 0,
        model: this.model,
        schemaEnforced: output !== undefined,
        finishReason: normalizeFinishReason(result.finishReason),
      };
    } catch (err) {
      // Bedrock's actionable diagnostics — model not enabled in the region,
      // expired token, wrong account — are worth more than a bare status.
      const mapped = asProviderError(err, '') as ProviderHttpError;
      if (typeof mapped.status === 'number') {
        mapped.message = `${mapped.message}${bedrockHint(mapped.status, mapped.body ?? '', this.model, this.regionOverride ?? '')}`;
      }
      throw mapped;
    }
  }
}
