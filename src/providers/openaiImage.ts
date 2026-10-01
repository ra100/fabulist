/**
 * OpenAI Images API, used with a user's own saved OpenAI credential (#152).
 *
 * Image generation is one of the bespoke paths the transport migration kept
 * (`docs/ai-sdk-transport-decision.md`), so this is a direct `fetch` against
 * `/images/generations` rather than an SDK adapter. The key is read per call
 * through `apiKey()`, exactly like `byokProvider`, so locking private storage
 * or deleting the credential stops the next image rather than the next restart.
 *
 * Neither consistency lever from `image.ts` is available here: the endpoint
 * takes no seed and no reference image. The composer's restated `Appearance`
 * text is what carries a character across pictures.
 */
import { ProviderKeyRejectedError, providerErrorReason, scrubSecrets } from './byok.ts';
import type { ImageCapabilities, ImageProvider, ImageRequest, ImageResult } from './image.ts';

export interface OpenAIImageOptions {
  model: string;
  apiKey: () => string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  /** Identifies the credential for usage and errors, mirroring `Provider.usageKeyId`. */
  keyId?: string;
}

const REJECTED = new Set([401, 402, 403, 429]);

/** Each model family accepts a fixed set of sizes; pick the one matching the requested aspect. */
export function openAIImageSize(model: string, width?: number, height?: number): string {
  const aspect = width && height ? width / height : 1;
  const shape = aspect > 1.15 ? 'landscape' : aspect < 0.87 ? 'portrait' : 'square';
  if (model.startsWith('dall-e-2')) return '1024x1024';
  if (model.startsWith('dall-e-3')) {
    return shape === 'landscape' ? '1792x1024' : shape === 'portrait' ? '1024x1792' : '1024x1024';
  }
  return shape === 'landscape' ? '1536x1024' : shape === 'portrait' ? '1024x1536' : '1024x1024';
}

export class OpenAIImageProvider implements ImageProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly keyId: string | undefined;
  readonly capabilities: ImageCapabilities = {
    imageConditioning: false,
    seedControl: false,
    costTier: 'mid',
    qualityTier: 0.8,
  };
  private readonly apiKey: () => string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: OpenAIImageOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.keyId = opts.keyId;
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const apiKey = this.apiKey();
    // The endpoint has no negative prompt, so it rides along as plain instruction.
    const prompt = req.negativePrompt?.trim() ? `${req.prompt}\n\nAvoid: ${req.negativePrompt.trim()}` : req.prompt;
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      n: 1,
      size: openAIImageSize(this.model, req.width, req.height),
    };
    // DALL·E returns a URL unless asked otherwise; the GPT image models always
    // return base64 and reject the parameter.
    if (this.model.startsWith('dall-e')) body.response_format = 'b64_json';

    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        // A redirect would carry the key to wherever the Location points.
        redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        scrubSecrets(`OpenAI image request failed: ${err instanceof Error ? err.message : String(err)}`, [apiKey]),
      );
    }
    const text = await res.text();
    if (!res.ok) {
      const reason = providerErrorReason(text, [apiKey]);
      if (REJECTED.has(res.status)) throw new ProviderKeyRejectedError(res.status, reason);
      throw new Error(`OpenAI image generation failed (${res.status})${reason ? `: ${reason}` : ''}`);
    }
    let parsed: { data?: Array<{ b64_json?: unknown }>; output_format?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('OpenAI image generation returned a response that is not JSON');
    }
    const b64 = parsed.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) throw new Error('OpenAI image generation returned no image');
    // PNG is the default and the only format requested; the store names files by these two types.
    return {
      bytes: new Uint8Array(Buffer.from(b64, 'base64')),
      mimeType: parsed.output_format === 'jpeg' ? 'image/jpeg' : 'image/png',
      seed: null,
      model: this.model,
    };
  }
}

/** Saved credentials whose endpoint can serve the image role. Text-only providers are refused at assignment time. */
export const IMAGE_CAPABLE_ENDPOINTS: ReadonlySet<string> = new Set(['openai']);
