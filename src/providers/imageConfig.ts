/**
 * Image provider presets and config wiring. Mirrors `providers/http.ts` +
 * `config/config.ts` deliberately: same preset-catalog shape, same
 * build-from-spec function, same "unavailable falls back rather than
 * throws" discipline — but the fallback here is *off*, not a mock provider,
 * because unlike narration (which always needs *a* provider, even the
 * deterministic one) illustration is genuinely optional. A world with no
 * image provider configured is a completely normal, fully playable state.
 */
import { BedrockStabilityProvider } from './bedrockImage.ts';
import { ComfyUIProvider, comfyReachable } from './comfyui.ts';
import type { ImageCapabilities, ImageProvider } from './image.ts';
import { MockImageProvider } from './mockImage.ts';
import { UnslothImageProvider, unslothImageStatus } from './unslothImage.ts';

export type ImageProviderKind = 'mock' | 'comfyui' | 'bedrock-stability' | 'unsloth';

export interface ImageProviderSpec {
  kind: ImageProviderKind;
  /** Local server URL (comfyui, unsloth) or Bedrock model id (bedrock-stability). Meaningless for mock. */
  model: string;
  baseUrl?: string;
  profile?: string;
  region?: string;
  /**
   * Env var holding the API key, for the one image kind that needs one.
   * Mirrors `ProviderSpec.apiKeyEnv` for text rather than inventing a second
   * convention — but the failure mode differs on purpose: an unset key here
   * means illustration stays *off* (`buildImageRegistry` catches the throw and
   * surfaces it as a note), whereas the text path falls back to the mock.
   */
  apiKeyEnv?: string;
  capabilities?: Partial<ImageCapabilities>;
  /** Human note shown by the provider doctor, same role as `ProviderSpec.note`. */
  note?: string;
}

function caps(over: Partial<ImageCapabilities> = {}): ImageCapabilities {
  return { imageConditioning: false, seedControl: true, costTier: 'free', qualityTier: 0.5, ...over };
}

/**
 * Per-kind capability floors, applied under the spec's own overrides.
 *
 * `caps()` defaults `imageConditioning` to false, which is the right
 * conservative answer when the truth depends on a user's ComfyUI graph — but
 * it is simply *wrong* for a kind whose endpoint always accepts a reference
 * image. Without this, a hand-written `{ kind: 'unsloth', ... }` spec with no
 * `capabilities` block silently lost `imageConditioning`, and
 * `IllustrationService` would then stop passing the reference paths it had
 * already computed: the one capability that justifies this adapter, disabled by
 * a default meant for a different provider. Caught by a test asserting a bare
 * spec still conditions.
 */
const KIND_CAPABILITY_FLOOR: Partial<Record<ImageProviderKind, Partial<ImageCapabilities>>> = {
  // Both are properties of the wire format, not of the loaded model:
  // `init_image`/`strength` and a round-tripped `seed` are always accepted.
  unsloth: { imageConditioning: true, seedControl: true },
};

export const IMAGE_PRESETS: Record<string, ImageProviderSpec> = {
  mock: { kind: 'mock', model: 'mock-image-1', capabilities: caps({ imageConditioning: true, qualityTier: 0.2 }) },
  'comfyui:local': {
    kind: 'comfyui',
    model: 'default', // the checkpoint filename ComfyUI's model directory sees; almost always wrong until set, same trap as vllm:local's model id
    baseUrl: 'http://127.0.0.1:8188',
    capabilities: caps({ costTier: 'free', qualityTier: 0.6 }),
  },
  'unsloth:local': {
    kind: 'unsloth',
    // Informational only: the endpoint uses whichever diffusion model Studio
    // has loaded, so unlike `comfyui:local`'s checkpoint filename this value
    // cannot be "wrong" in a way that breaks a request. Load the model in the
    // UI (Images → Select image model); `unsloth:status` reports what is live.
    model: 'loaded',
    baseUrl: 'http://127.0.0.1:8888',
    apiKeyEnv: 'UNSLOTH_API_KEY',
    note: 'Unsloth Studio serves text and images on one port. A local desktop install needs no key; set UNSLOTH_API_KEY only for a remote instance. Load a diffusion model in Images.',
    // The only local preset with honest `imageConditioning: true` — the native
    // endpoint takes `init_image`/`strength`, so the reference images
    // `IllustrationService` already computes are actually used rather than
    // discarded as they are on ComfyUI's bundled txt2img graph.
    capabilities: caps({ imageConditioning: true, costTier: 'free', qualityTier: 0.7 }),
  },
  'bedrock:stability-style-guide': {
    kind: 'bedrock-stability',
    // Cross-region inference profile id, matching the `us.` prefix
    // `bedrock:sonnet` already needed for text — Bedrock refuses on-demand
    // invocation of several model families without one. UNVERIFIED in this
    // account: every Stability model here returned a Marketplace
    // AccessDeniedException before any request-shape feedback was possible.
    // See `bedrockImage.ts`'s file comment for the full account.
    model: 'us.stability.stable-image-style-guide-v1:0',
    capabilities: caps({ imageConditioning: true, costTier: 'mid', qualityTier: 0.75 }),
  },
};

export function buildImageProvider(spec: ImageProviderSpec, env: Record<string, string | undefined> = process.env): ImageProvider {
  // Spec overrides win over the kind's floor, which wins over the generic
  // default — so an author can still turn conditioning off deliberately.
  const capabilities = caps({ ...KIND_CAPABILITY_FLOOR[spec.kind], ...spec.capabilities });
  switch (spec.kind) {
    case 'mock':
      return new MockImageProvider({ capabilities });
    case 'comfyui':
      return new ComfyUIProvider({ baseUrl: spec.baseUrl, checkpoint: spec.model, capabilities });
    case 'unsloth': {
      // No longer throws on a missing key. A desktop install authenticates from
      // its own local secret (`unslothAuth.ts`), verified against a running
      // instance, so requiring `UNSLOTH_API_KEY` up front turned the *common*
      // case — Unsloth on this machine — into a configuration errand for no
      // reason. A remote instance genuinely needs a key, and that failure now
      // surfaces at probe time with an accurate explanation instead of blocking
      // construction here.
      const apiKey = spec.apiKeyEnv ? (env[spec.apiKeyEnv] ?? '') : '';
      return new UnslothImageProvider({
        baseUrl: spec.baseUrl,
        model: spec.model,
        ...(apiKey ? { apiKey } : {}),
        capabilities,
      });
    }
    case 'bedrock-stability':
      return new BedrockStabilityProvider({ modelId: spec.model, profile: spec.profile, region: spec.region, capabilities });
    default:
      throw new Error(`unknown image provider kind: ${String(spec.kind)}`);
  }
}

export interface ImageProbeResult {
  key: string;
  kind: ImageProviderKind;
  model: string;
  status: 'ready' | 'unavailable' | 'unknown';
  detail: string;
  fix: string;
  /** Carried through from the spec, same as `ProbeResult.note` for text. */
  note?: string;
}

/** Same shape as `providers/probe.ts`'s text-provider probe, purpose-built for the image catalog rather than sharing the function directly — the auth stories genuinely differ (Unsloth is the only api-key kind, and it has a readiness state beyond "reachable"). */
export async function probeImageProviders(
  extra: Record<string, ImageProviderSpec> = {},
  opts: { fetcher?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ImageProbeResult[]> {
  const specs = { ...IMAGE_PRESETS, ...extra };
  const env = opts.env ?? process.env;
  const results = await Promise.all(
    Object.entries(specs).map(async ([key, spec]): Promise<ImageProbeResult> => {
      const base = { key, kind: spec.kind, model: spec.model, ...(spec.note ? { note: spec.note } : {}) };
      if (spec.kind === 'mock') return { ...base, status: 'ready', detail: 'always available, deterministic placeholder images', fix: '' };
      if (spec.kind === 'comfyui') {
        const up = await comfyReachable(spec.baseUrl, opts.fetcher ?? fetch);
        return up
          ? { ...base, status: 'ready', detail: `listening at ${spec.baseUrl}`, fix: '' }
          : { ...base, status: 'unavailable', detail: `nothing listening at ${spec.baseUrl}`, fix: 'start it: python main.py  (then set the checkpoint filename in settings)' };
      }
      if (spec.kind === 'unsloth') {
        // Genuinely different failures with different one-line fixes, which is
        // why this kind gets a richer probe than a reachability check: not
        // running, running with no usable credential, and running with no
        // diffusion model loaded look identical from outside and are fixed in
        // completely different places.
        //
        // The credential check is delegated rather than repeated: a local
        // desktop install authenticates from its own secret, so testing
        // `apiKeyEnv` here would report "no key" for an instance that works
        // perfectly. `unslothImageStatus` resolves exactly as the provider does
        // and reports which credential it used.
        const apiKey = spec.apiKeyEnv ? (env[spec.apiKeyEnv] ?? '') : '';
        const status = await unslothImageStatus(spec.baseUrl, apiKey, opts.fetcher ?? fetch);
        if (!status.up) {
          return { ...base, status: 'unavailable', detail: status.detail, fix: 'start it: unsloth studio' };
        }
        if (!status.authed) {
          // Which fix applies depends on what was actually tried.
          const fix =
            status.source === 'none'
              ? `for a local Unsloth, start the desktop app (its login is used automatically); for a remote one, create a key in Settings → API and export ${spec.apiKeyEnv ?? 'UNSLOTH_API_KEY'}=…`
              : status.source === 'api-key'
                ? `check ${spec.apiKeyEnv ?? 'the API key'} matches a key in Unsloth (Settings → API)`
                : 'the desktop login was rejected; restart Unsloth Studio or set an API key instead';
          return { ...base, status: 'unavailable', detail: status.detail, fix };
        }
        if (!status.loaded) {
          return { ...base, status: 'unavailable', detail: status.detail, fix: 'load one in Unsloth: Images → Select image model' };
        }
        return { ...base, status: 'ready', detail: status.detail, fix: '' };
      }
      // bedrock-stability shares credential resolution with the text bedrock
      // presets, but confirming that resolution here would duplicate
      // `AwsCredentialProvider` wiring for a status line the text probe
      // already reports — the UI shows both under one "providers" panel, so
      // "unknown, check the bedrock text provider status above" is honest
      // rather than a second, redundant SSO round-trip.
      return { ...base, status: 'unknown', detail: 'shares AWS credentials with the bedrock text providers; unverified for image models in this account (see bedrockImage.ts)', fix: '' };
    }),
  );
  return results;
}
