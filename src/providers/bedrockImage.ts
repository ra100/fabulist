/**
 * AWS Bedrock — Stability AI image models, via InvokeModel (not Converse:
 * Converse is a text-chat abstraction and has no image-generation shape).
 *
 * Every `stability.*` Bedrock model shares one request/response contract
 * regardless of which specific model — documented publicly and consistent
 * across the family: JSON in, `{ prompt, negative_prompt?, seed?,
 * aspect_ratio?, output_format? }`, JSON out, `{ images: [base64, ...],
 * seeds: [number, ...] }`. The `modelId` is the only thing that changes
 * between "generate from a text prompt" and "generate guided by a sketch/
 * reference image" — the latter add an image field to the same body shape.
 *
 * Model-access reality, checked directly against this account rather than
 * assumed from the docs: `aws bedrock list-foundation-models` in this
 * account/region returns only Stability's *editing* tools (control-sketch,
 * style-guide, inpaint, search-and-replace, the upscalers, ...) plus the
 * legacy, access-denied `amazon.nova-canvas-v1:0` — no plain text-to-image
 * "Ultra"/"Core"/SD3 id is entitled here, and every `stability.*` id returned
 * a Marketplace-subscription `AccessDeniedException` on invocation. That is
 * an account entitlement fact, not a code fact.
 *
 * **Not verified live.** The Marketplace block above meant every invocation
 * attempted in this session — including a deliberately empty body, to read
 * the validation error ahead of the entitlement check — came back with the
 * *same* Marketplace `AccessDeniedException` before any request-shape
 * feedback was possible. The body below is built from Stability's publicly
 * documented Platform REST API (`prompt` / `negative_prompt` / `seed` /
 * `aspect_ratio` / `output_format` in, base64 `images[]` + `seeds[]` out),
 * which Bedrock's own docs describe as a pass-through, not translated from a
 * successful call against this specific model. Treat this adapter as
 * unverified until one real call succeeds, and prefer the ComfyUI or mock
 * path until then. `style-guide` doubles as a genuine reference-image-
 * conditioning path if the shape holds — feed it the character's own
 * portrait as the style reference and it inherits `imageConditioning: true`
 * honestly, unlike a plain txt2img id — but that too is unverified here.
 */
import { signRequest } from './sigv4.ts';
import { bedrockHint } from './bedrock.ts';
import { AwsCredentialProvider, type AwsEnvironment } from './aws.ts';
import type { ImageCapabilities, ImageProvider, ImageRequest, ImageResult } from './image.ts';

export interface BedrockImageOptions {
  /** e.g. 'stability.stable-image-style-guide-v1:0', or a future plain txt2img id once one is entitled. */
  modelId: string;
  capabilities: ImageCapabilities;
  profile?: string;
  region?: string;
  credentials?: AwsCredentialProvider;
  awsEnvironment?: AwsEnvironment;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface StabilityResponse {
  images?: string[];
  seeds?: number[];
  finish_reasons?: (string | null)[];
}

export class BedrockStabilityProvider implements ImageProvider {
  readonly id = 'bedrock-stability';
  readonly model: string;
  readonly capabilities: ImageCapabilities;
  private credentials: AwsCredentialProvider;
  private profile: string | undefined;
  private regionOverride: string | undefined;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(opts: BedrockImageOptions) {
    this.model = opts.modelId;
    this.capabilities = opts.capabilities;
    this.credentials = opts.credentials ?? new AwsCredentialProvider(opts.awsEnvironment);
    this.profile = opts.profile;
    this.regionOverride = opts.region;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const resolved = await this.credentials.resolve(this.profile);
    const region = this.regionOverride ?? resolved.region;

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      output_format: 'png',
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed != null) body.seed = req.seed;
    if (req.width && req.height) body.aspect_ratio = aspectRatio(req.width, req.height);
    // The style-conditioning models take the reference as base64 under
    // `image`; this is the honest form of `imageConditioning` for a family
    // that has no dedicated img2img endpoint of its own.
    if (this.capabilities.imageConditioning && req.referenceImagePath) {
      const { readFileSync } = await import('node:fs');
      body.image = readFileSync(req.referenceImagePath).toString('base64');
      if (req.referenceStrength != null) body.fidelity = req.referenceStrength;
    }

    const payload = JSON.stringify(body);
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(this.model)}/invoke`;
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
    try {
      const res = await this.fetcher(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Shares `bedrockHint` with the text adapter so expired credentials are
        // never misreported as a model-access or Marketplace problem — the same
        // 403 ambiguity, and the Marketplace advice below is expensive to chase
        // when the real cause is a stale token. The Stability-specific note is
        // appended only once the generic hint has had no better explanation.
        const generic = bedrockHint(res.status, text, this.model, region);
        const hint =
          generic ||
          (res.status === 403
            ? ` — check Bedrock model access and, for Stability models specifically, the AWS Marketplace subscription for ${this.model}`
            : '');
        throw new Error(`bedrock-stability ${res.status}${hint}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as StabilityResponse;
      const b64 = json.images?.[0];
      if (!b64) throw new Error(`bedrock-stability: no image in response (finish_reason: ${json.finish_reasons?.[0] ?? 'unknown'})`);
      return {
        bytes: new Uint8Array(Buffer.from(b64, 'base64')),
        mimeType: 'image/png',
        seed: json.seeds?.[0] ?? req.seed ?? null,
        model: this.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Stability's Bedrock endpoint accepts a fixed enum of ratios, not arbitrary pixels. Nearest match. */
function aspectRatio(width: number, height: number): string {
  const ratios: Array<[string, number]> = [
    ['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['21:9', 21 / 9], ['9:21', 9 / 21],
    ['2:3', 2 / 3], ['3:2', 3 / 2], ['4:5', 4 / 5], ['5:4', 5 / 4],
  ];
  const target = width / height;
  return ratios.reduce((best, r) => (Math.abs(r[1] - target) < Math.abs(best[1] - target) ? r : best))[0];
}
