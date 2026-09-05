/**
 * Image provider abstraction. Mirrors `provider.ts` deliberately — same shape,
 * same reasoning: a thin interface plus a capability matrix, not a heavyweight
 * abstraction library, because the value is in owning the degradation path,
 * not in hiding the providers from each other.
 *
 * What differs for images specifically is the *consistency* problem (see
 * `.design/ILLUSTRATIONS.md`): a text model can be told "the same character as
 * before" and mostly comply from context; a diffusion model has no context
 * across calls unless something is fed back in. Two levers exist and neither
 * is universal, which is why `ImageCapabilities` names them explicitly rather
 * than assuming both:
 *
 * - `imageConditioning`: accepts a reference image and stays close to it
 *   (img2img / IP-Adapter-style). ComfyUI graphs can do this if built to.
 * - `seedControl`: accepts and returns a seed; reusing one is the cheapest
 *   lever a pure text-to-image model offers, and it is *not* a consistency
 *   guarantee — same seed plus a changed prompt can still drift. It is the
 *   floor, not the solution.
 *
 * A provider with neither still works: the composer's job is to make the
 * *prompt* carry consistency (the durable `Appearance` text, restated every
 * time) when the model cannot be conditioned any other way.
 */

export interface ImageCapabilities {
  /** Accepts a reference image and returns something visually anchored to it. */
  imageConditioning: boolean;
  /** Accepts a seed and returns the seed actually used. */
  seedControl: boolean;
  costTier: 'free' | 'cheap' | 'mid' | 'premium';
  /** Subjective, like `ProviderCapabilities.proseQuality` — benchmarks do not predict this either. */
  qualityTier: number;
}

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number | null;
  /** Absolute path to a reference image, honoured only when `imageConditioning` is true. */
  referenceImagePath?: string | null;
  /** How strongly to follow the reference vs. the prompt, 0..1. Ignored without conditioning. */
  referenceStrength?: number;
}

export interface ImageResult {
  /** Raw image bytes. The caller decides where to persist them. */
  bytes: Uint8Array;
  mimeType: string;
  /** The seed actually used, when the provider reports one. */
  seed: number | null;
  model: string;
}

export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ImageCapabilities;
  generate(req: ImageRequest): Promise<ImageResult>;
}

/** Per-role routing is unnecessary here — there is one role, "illustrate" — but the swap story matters just as much. */
export interface ImageRegistry {
  get(): ImageProvider | null;
}

/**
 * Same reasoning as `SwappableRegistry` for text providers: held for the
 * process lifetime, swapped without a restart when the UI picks a different
 * image profile. `get()` returns null rather than throwing when no image
 * provider is configured, because unlike narration — which always has the
 * mock to fall back to — illustration is optional and "off" is a normal state.
 */
export class SwappableImageRegistry implements ImageRegistry {
  private current: ImageProvider | null;
  private label: string;

  constructor(initial: ImageProvider | null = null, label = 'none') {
    this.current = initial;
    this.label = label;
  }

  get(): ImageProvider | null {
    return this.current;
  }

  swap(next: ImageProvider | null, label: string): void {
    this.current = next;
    this.label = label;
  }

  profile(): string {
    return this.label;
  }
}
