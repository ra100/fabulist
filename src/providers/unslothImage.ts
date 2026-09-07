/**
 * Unsloth Studio — the local image path that also serves the text models.
 *
 * Why this exists alongside `comfyui.ts`, which already covers "local, free,
 * no cloud": Unsloth Studio runs LLMs *and* diffusion models behind one HTTP
 * server, so a machine that is already serving `narrate`/`mechanics`/`extract`
 * from it can illustrate from the same process with no second app to install,
 * start, or keep running. ComfyUI remains the right answer for anyone who
 * wants a hand-built graph; this is the right answer for "I already have
 * Unsloth open".
 *
 * The decisive difference from ComfyUI is not convenience, it is
 * `imageConditioning`. ComfyUI's bundled `defaultWorkflow()` is a plain
 * txt2img graph and honestly declares `imageConditioning: false`, which means
 * the `referenceImagePath` that `IllustrationService` computes for every
 * portrait and every revisited location is discarded — levers 1 and 2 of
 * `.design/ILLUSTRATIONS.md` only. Unsloth's native endpoint takes
 * `init_image` + `strength` directly, so lever 3 (the one that actually looks
 * at pixels) works without graph surgery. That is the whole reason to prefer
 * it.
 *
 * Wire format, read from the running server's own OpenAPI schema
 * (`GET /openapi.json`, 380 paths) rather than the published docs — the docs'
 * endpoint table lists only the three chat endpoints and omits the image API
 * entirely, which is misleading enough to be worth recording here:
 *
 *   POST /api/inference/images/generate        native; 17 fields, incl. init_image/strength
 *   POST /v1/images/generations                OpenAI-shaped; prompt/size/n only, no reference
 *   GET  /api/inference/images/gallery/{id}/file   the PNG bytes
 *   GET  /api/inference/images/status          which model is loaded
 *
 * We use the *native* endpoint, not the OpenAI-compatible one, precisely
 * because the OpenAI shape cannot express a reference image or a negative
 * prompt — adopting it would throw away the capability that justifies this
 * adapter.
 *
 * Two consequences of the real response shape, both handled below:
 *
 * 1. **Generation returns gallery records, not bytes.** A `GalleryImage` has a
 *    relative `url`; the bytes need a second authenticated GET. So one
 *    `generate()` is two round trips, unlike Bedrock's single base64 reply.
 * 2. **Auth is mandatory.** Every request needs `Authorization: Bearer
 *    sk-unsloth-…`, created in Settings → API. Unlike ComfyUI (genuinely
 *    keyless) there is nothing to fall back to, which is why
 *    `ImageProviderSpec` grows an `apiKeyEnv` for this kind.
 */
import type { ImageCapabilities, ImageProvider, ImageRequest, ImageResult } from './image.ts';
import { UnslothAuth, type UnslothAuthSource } from './unslothAuth.ts';

/**
 * Server-side generation limits, from the endpoint's own schema. Enforced here
 * rather than left to the server because a 422 mid-turn reads as "illustration
 * broke", while a clamped dimension reads as nothing at all — and the caller's
 * intent (a wide establishing shot) survives clamping fine.
 */
const MIN_DIM = 256;
const MAX_DIM = 2048;
/** The API requires a multiple of 16; 1024x640 (ComfyUI's default) already is. */
const DIM_STEP = 16;

function clampDim(value: number | undefined, fallback: number): number {
  const n = Math.round(value ?? fallback);
  const clamped = Math.min(MAX_DIM, Math.max(MIN_DIM, n));
  return Math.round(clamped / DIM_STEP) * DIM_STEP;
}

export interface UnslothImageOptions {
  baseUrl?: string;
  /** Informational: the loaded diffusion model is used regardless of what we send. */
  model?: string;
  /**
   * Explicit key, when one was configured. Optional on purpose: a desktop
   * install is authenticated from its own local secret instead (see
   * `unslothAuth.ts`), so a local Unsloth needs no trip to Settings → API.
   * Required in practice only for a *remote* instance, which has no local secret
   * this machine could read.
   */
  apiKey?: string;
  /** Documented fallback for a server installed without the desktop app. */
  username?: string;
  password?: string;
  /** Injectable for tests. */
  auth?: UnslothAuth;
  capabilities?: Partial<ImageCapabilities>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Denoising steps. The server's own default is 9, tuned for the distilled/GGUF models it recommends. */
  steps?: number;
  /** Guidance scale. Defaults to the server's 0.0, which is correct for distilled models and wrong for SDXL. */
  guidance?: number;
  /** Default canvas, matching ComfyUI's bundled graph so switching provider does not resize every illustration. */
  width?: number;
  height?: number;
}

/** The subset of `GalleryImage` this adapter reads. */
interface GalleryImage {
  id: string;
  url: string;
  seed: number;
  model?: string | null;
  width: number;
  height: number;
}

interface GenerateResponse {
  images?: GalleryImage[];
}

interface StatusResponse {
  loaded?: boolean;
  repo_id?: string | null;
  family?: string | null;
  workflows?: string[];
}

export class UnslothImageProvider implements ImageProvider {
  readonly id = 'unsloth';
  readonly model: string;
  readonly capabilities: ImageCapabilities;
  private baseUrl: string;
  private auth: UnslothAuth;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private steps: number;
  private guidance: number;
  private width: number;
  private height: number;

  constructor(opts: UnslothImageOptions) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:8888').replace(/\/$/, '');
    this.model = opts.model ?? 'loaded';
    this.auth =
      opts.auth ??
      new UnslothAuth({
        baseUrl: this.baseUrl,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.username ? { username: opts.username } : {}),
        ...(opts.password ? { password: opts.password } : {}),
        ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
      });
    this.fetcher = opts.fetcher ?? fetch;
    // Diffusion on a laptop is slow, and a first call also pays for loading
    // weights. Longer than ComfyUI's 180s for the same reason its own comment
    // gives: the failure we care about is "not running", not "still working".
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.steps = opts.steps ?? 9;
    this.guidance = opts.guidance ?? 0;
    this.width = clampDim(opts.width, 1024);
    this.height = clampDim(opts.height, 640);
    this.capabilities = {
      // Both true, and both honestly earned rather than declared: `init_image`
      // + `strength` is real pixel conditioning, and `seed` round-trips (the
      // response reports the seed actually used, which is what
      // `IllustrationService` records for portrait regeneration).
      imageConditioning: true,
      seedControl: true,
      costTier: 'free',
      qualityTier: 0.7,
      ...opts.capabilities,
    };
  }

  /**
   * Auth headers, resolved per request rather than captured at construction:
   * a desktop-derived token is exchanged lazily and cached inside `UnslothAuth`,
   * so the first illustration pays for the login and the rest do not.
   */
  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { ...(await this.auth.authHeader()), ...extra };
  }

  /**
   * Turns a failed response into a message that names the fix. 401 is the
   * likeliest first failure, and the right advice depends on *why* there was no
   * usable credential — an explicit key that is wrong needs different action
   * from a remote instance that never had one to try.
   */
  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = this.auth.hasExplicitKey()
        ? ' — the configured API key was rejected; check it matches a key in Unsloth (Settings → API)'
        : ' — could not authenticate: a local desktop install is used automatically, so for a remote Unsloth set an API key (Settings → API) in this provider\'s apiKeyEnv';
    } else if (res.status === 404) {
      hint = ' — this Unsloth build may predate the image API; update Unsloth Studio';
    }
    throw new Error(`unsloth ${what} returned ${res.status}${hint}: ${body.slice(0, 300)}`);
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      width: clampDim(req.width, this.width),
      height: clampDim(req.height, this.height),
      steps: this.steps,
      guidance: this.guidance,
      batch_size: 1,
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    // Seed is optional and the server randomises when omitted; sending null
    // explicitly is also accepted, but omitting keeps the request minimal and
    // matches "no seed reuse requested" (scenes) exactly.
    if (req.seed != null) body.seed = req.seed;

    // Lever 3. `init_image` wants base64/data-URL content, not a path, so the
    // file is read here — the same shape `bedrockImage.ts` uses for its
    // `image` field, and gated on the same capability flag so a spec that
    // turns conditioning off genuinely stops sending it.
    if (this.capabilities.imageConditioning && req.referenceImagePath) {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(req.referenceImagePath);
      body.init_image = `data:image/png;base64,${raw.toString('base64')}`;
      // `strength` is img2img *denoise* strength: low stays close to the
      // source. `referenceStrength` is documented the same way round in
      // `image.ts` ("how strongly to follow the reference"), so it maps
      // directly rather than inverted.
      if (req.referenceStrength != null) body.strength = req.referenceStrength;
    }

    const json = (await this.postJson('/api/inference/images/generate', body)) as GenerateResponse;
    const image = json.images?.[0];
    if (!image) throw new Error('unsloth: generation returned no images — is a diffusion model loaded? (Images → Select image model)');

    const bytes = await this.fetchBytes(image);
    return {
      bytes,
      mimeType: 'image/png',
      // The record reports the seed actually used, including when we sent none.
      seed: typeof image.seed === 'number' ? image.seed : (req.seed ?? null),
      // Prefer the real repo id the server recorded over our informational label.
      model: image.model ?? this.model,
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: await this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) await this.fail(res, path);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Second round trip: the generate call hands back a gallery record, and the
   * PNG lives behind its own authenticated route. `url` is server-relative, so
   * it is joined onto `baseUrl` rather than trusted as absolute.
   */
  private async fetchBytes(image: GalleryImage): Promise<Uint8Array> {
    const path = image.url.startsWith('http')
      ? image.url
      : `${this.baseUrl}${image.url.startsWith('/') ? '' : '/'}${image.url}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(path, { headers: await this.headers(), signal: controller.signal });
      if (!res.ok) await this.fail(res, `image fetch for ${image.id}`);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Liveness + readiness probe, same shape as `comfyReachable` but answering a
 * strictly more useful question: ComfyUI has a checkpoint or it fails at
 * request time, whereas Unsloth can be running happily with *no diffusion
 * model loaded* — the single most likely reason a first illustration fails on
 * a machine where everything looks fine. Distinguishing "not running" from
 * "running, no image model" from "no key" is the whole point.
 */
export async function unslothImageStatus(
  baseUrl = 'http://127.0.0.1:8888',
  apiKey = '',
  fetcher: typeof fetch = fetch,
  timeoutMs = 2500,
  auth?: UnslothAuth,
): Promise<{ up: boolean; authed: boolean; loaded: boolean; detail: string; source: UnslothAuthSource }> {
  const base = baseUrl.replace(/\/$/, '');
  // Resolves the same way the adapter does, so the probe cannot report "no key"
  // for an instance the provider would in fact authenticate against via the
  // local desktop secret. Reporting *which* credential worked matters too: the
  // difference between "keyless, using this machine's desktop login" and "using
  // the configured key" is exactly what someone debugging wants to see.
  const resolver =
    auth ?? new UnslothAuth({ baseUrl: base, ...(apiKey ? { apiKey } : {}), fetcher, timeoutMs });
  const resolved = await resolver.token().catch(() => null);
  const source: UnslothAuthSource = resolved?.source ?? 'none';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${base}/api/inference/images/status`, {
      headers: resolved ? { authorization: `Bearer ${resolved.token}` } : {},
      signal: controller.signal,
    });
    // A 401 still proves something is listening, which is a materially
    // different fix from nothing being there ("start it").
    if (res.status === 401 || res.status === 403) {
      return {
        up: true,
        authed: false,
        loaded: false,
        source,
        detail:
          source === 'none'
            ? 'running, but no usable credential: no API key set and no local desktop secret found'
            : `running, but the ${source === 'api-key' ? 'API key' : 'desktop login'} was rejected`,
      };
    }
    if (!res.ok) return { up: true, authed: true, loaded: false, source, detail: `status endpoint returned ${res.status}` };
    const json = (await res.json()) as StatusResponse;
    const via = source === 'desktop-secret' ? ' (keyless: this machine\u2019s desktop login)' : '';
    if (!json.loaded) {
      return { up: true, authed: true, loaded: false, source, detail: `running and authenticated${via}, but no diffusion model is loaded` };
    }
    const workflows = json.workflows?.length ? `, workflows: ${json.workflows.join('/')}` : '';
    return { up: true, authed: true, loaded: true, source, detail: `${json.repo_id ?? json.family ?? 'a model'} loaded${workflows}${via}` };
  } catch {
    return { up: false, authed: false, loaded: false, source, detail: `nothing listening at ${base}` };
  } finally {
    clearTimeout(timer);
  }
}
