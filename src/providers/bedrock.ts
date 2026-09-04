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
        temperature: req.temperature ?? 0.7,
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
        // 403 here is nearly always model access rather than bad credentials, and
        // saying so saves a long detour through the IAM console.
        const hint =
          res.status === 403
            ? ` — check that model access is enabled for ${this.model} in region ${region}`
            : '';
        throw new Error(`bedrock ${res.status}${hint}: ${text.slice(0, 300)}`);
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
