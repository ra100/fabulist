/**
 * AWS Bedrock via the Converse API.
 *
 * Converse rather than InvokeModel: InvokeModel takes a different body shape per
 * model family, so supporting Claude, Llama and Nova through it would mean three
 * adapters. Converse is one shape for all of them, which is the whole reason the
 * capability matrix can describe Bedrock as a single provider.
 *
 * Structured output goes through forced tool use. Bedrock has no `response_format`,
 * but `toolChoice: {tool: {name}}` obliges the model to emit arguments matching a
 * schema — which is the same guarantee, reached differently.
 */
import { signRequest } from './sigv4.ts';
import { readAwsEventStream, parseJsonSafe } from './stream.ts';
import { AwsCredentialProvider, type AwsEnvironment } from './aws.ts';
import type { CompletionRequest, CompletionResult, Provider, ProviderCapabilities } from './provider.ts';

export interface BedrockOptions {
  modelId: string;
  capabilities: ProviderCapabilities;
  /** Overrides AWS_PROFILE. */
  profile?: string;
  /** Overrides the resolved region. */
  region?: string;
  credentials?: AwsCredentialProvider;
  awsEnvironment?: AwsEnvironment;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string; toolUse?: { input?: unknown } }> } };
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

export class BedrockProvider implements Provider {
  readonly id = 'bedrock';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private credentials: AwsCredentialProvider;
  private profile: string | undefined;
  private regionOverride: string | undefined;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(opts: BedrockOptions) {
    this.model = opts.modelId;
    this.capabilities = opts.capabilities;
    this.credentials = opts.credentials ?? new AwsCredentialProvider(opts.awsEnvironment);
    this.profile = opts.profile;
    this.regionOverride = opts.region;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const resolved = await this.credentials.resolve(this.profile);
    const region = this.regionOverride ?? resolved.region;

    // Converse takes the system prompt as its own top-level field, and requires
    // messages to alternate starting with user.
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => ({ text: m.content }));
    const messages = collapse(
      req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ text: m.content }] })),
    );

    const body: Record<string, unknown> = {
      messages: messages.length ? messages : [{ role: 'user', content: [{ text: '...' }] }],
      inferenceConfig: {
        maxTokens: req.maxTokens ?? 2048,
        // Some models (Bedrock's claude-sonnet-5, confirmed directly against
        // the API) reject any explicit temperature with a 400, rather than
        // clamping it — omitting the field is the only value that works.
        ...(this.capabilities.fixedTemperature ? {} : { temperature: req.temperature ?? 0.7 }),
        ...(req.stop?.length ? { stopSequences: req.stop.slice(0, 4) } : {}),
      },
    };
    if (system.length) body.system = system;

    if (req.schema) {
      const toolName = req.schema.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      body.toolConfig = {
        tools: [
          {
            toolSpec: {
              name: toolName,
              description: 'Return the result using this schema.',
              inputSchema: { json: req.schema.schema },
            },
          },
        ],
        toolChoice: { tool: { name: toolName } },
      };
    }

    // Streaming is prose-only: a forced tool call has nothing useful to emit
    // incrementally, and a partial arguments object cannot be validated.
    const wantsStream = !!req.onToken && this.capabilities.streaming && !req.schema;
    const payload = JSON.stringify(body);
    const operation = wantsStream ? 'converse-stream' : 'converse';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(this.model)}/${operation}`;

    const signed = signRequest({
      method: 'POST',
      url,
      region,
      service: 'bedrock',
      body: payload,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: resolved.credentials,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json: ConverseResponse;
    try {
      const res = await this.fetcher(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal: controller.signal,
      });
      if (res.ok && wantsStream) {
        return await this.consumeStream(res, req.onToken!);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`bedrock ${res.status}${bedrockHint(res.status, text, this.model, region)}: ${text.slice(0, 300)}`);
      }
      json = (await res.json()) as ConverseResponse;
    } finally {
      clearTimeout(timer);
    }

    const parts = json.output?.message?.content ?? [];
    const toolUse = parts.find((p) => p.toolUse)?.toolUse;
    const text = toolUse
      ? JSON.stringify(toolUse.input ?? {})
      : parts.map((p) => p.text ?? '').join('').trim();

    return {
      text,
      tokensIn: json.usage?.inputTokens ?? 0,
      tokensOut: json.usage?.outputTokens ?? 0,
      model: this.model,
      schemaEnforced: !!toolUse,
    };
  }

  /**
   * Reads a ConverseStream response. AWS frames these as a binary event stream
   * rather than SSE, so the payloads are extracted and then interpreted here.
   */
  private async consumeStream(res: Response, onToken: (chunk: string) => void): Promise<CompletionResult> {
    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const payload of readAwsEventStream(res.body)) {
      const event = parseJsonSafe(payload);
      if (!event) continue;
      const delta = event.delta as { text?: string } | undefined;
      if (delta?.text) {
        text += delta.text;
        onToken(delta.text);
      }
      const usage = event.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (usage) {
        tokensIn = usage.inputTokens ?? tokensIn;
        tokensOut = usage.outputTokens ?? tokensOut;
      }
    }
    return { text, tokensIn, tokensOut, model: this.model, schemaEnforced: false };
  }

  /** Reports which identity would be used, for the provider doctor. */
  async whoami(): Promise<{ region: string; source: string; profile: string }> {
    const resolved = await this.credentials.resolve(this.profile);
    return {
      region: this.regionOverride ?? resolved.region,
      source: resolved.credentials.source,
      profile: this.profile ?? 'default',
    };
  }
}

/**
 * Turns a Bedrock error into the one-line fix it actually calls for.
 *
 * This used to assume every 403 meant "model access is not enabled", on the
 * reasoning that it saves a detour through the IAM console. That assumption is
 * wrong often enough to be actively harmful: **expired credentials also return
 * 403**, and the resulting message sent us hunting model entitlement in the
 * Bedrock console while the real cause was a stale `aws_session_token` in
 * `~/.aws/credentials`. Confirmed directly against the API rather than guessed
 * — an expired token answers with:
 *
 *   UnrecognizedClientException: The security token included in the request is invalid
 *
 * so the *error code in the body*, not the status, is what distinguishes the two.
 * AWS uses several codes for this depending on credential kind, hence the set
 * below; `InvalidClientTokenId` is the STS spelling of the same thing, and
 * `ExpiredToken`/`ExpiredTokenException` is what a lapsed SSO session returns.
 */
export function bedrockHint(status: number, body: string, model: string, region: string): string {
  // The body is JSON with `message`, and often an `__type`/`code` naming the
  // exception; the CLI surfaces the same string. Matching on the text keeps
  // this robust across both shapes without parsing.
  const expired =
    /UnrecognizedClientException|InvalidClientTokenId|ExpiredToken|InvalidSecurityToken|security token included in the request is invalid|token.{0,20}expired/i.test(
      body,
    );
  if (expired) {
    return ' — AWS credentials are invalid or expired, not a model-access problem: refresh them (aws sso login) and check AWS_PROFILE points at the profile you meant';
  }

  // A genuinely unauthorised *identity* is different again from an unentitled
  // model: the first needs an IAM policy, the second a console opt-in.
  if (/AccessDeniedException/i.test(body) && /not authorized to perform/i.test(body)) {
    return ` — this identity lacks bedrock:InvokeModel for ${model}; the credentials are valid, so this is an IAM policy gap rather than model access`;
  }

  if (status === 403) {
    return ` — check that model access is enabled for ${model} in region ${region}`;
  }

  // The other status worth naming: an id that needs a cross-region inference
  // profile fails as a 400 with a very specific instruction, and the `us.`
  // prefix in this file's presets exists precisely because of it.
  if (status === 400 && /inference profile/i.test(body)) {
    return ` — ${model} cannot be invoked on demand; use the cross-region inference profile id (prefix it with "us.")`;
  }

  if (status === 429 || /ThrottlingException/i.test(body)) {
    return ' — throttled by Bedrock; retry, or request a quota increase for this model';
  }

  return '';
}

/**
 * Converse rejects consecutive messages with the same role, which is easy to
 * produce once system prompts have been folded in for other providers.
 */
function collapse(messages: Array<{ role: string; content: Array<{ text: string }> }>): Array<{ role: string; content: Array<{ text: string }> }> {
  const out: Array<{ role: string; content: Array<{ text: string }> }> = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...message.content);
    } else {
      out.push({ role: message.role, content: [...message.content] });
    }
  }
  // Converse also requires the first message to be from the user.
  if (out.length && out[0]!.role !== 'user') out.unshift({ role: 'user', content: [{ text: '...' }] });
  return out;
}
