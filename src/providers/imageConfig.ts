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

export type ImageProviderKind = 'mock' | 'comfyui' | 'bedrock-stability';

export interface ImageProviderSpec {
  kind: ImageProviderKind;
  /** Local server URL (comfyui) or Bedrock model id (bedrock-stability). Meaningless for mock. */
  model: string;
  baseUrl?: string;
  profile?: string;
  region?: string;
  capabilities?: Partial<ImageCapabilities>;
}

function caps(over: Partial<ImageCapabilities> = {}): ImageCapabilities {
  return { imageConditioning: false, seedControl: true, costTier: 'free', qualityTier: 0.5, ...over };
}

export const IMAGE_PRESETS: Record<string, ImageProviderSpec> = {
  mock: { kind: 'mock', model: 'mock-image-1', capabilities: caps({ imageConditioning: true, qualityTier: 0.2 }) },
  'comfyui:local': {
    kind: 'comfyui',
    model: 'default', // the checkpoint filename ComfyUI's model directory sees; almost always wrong until set, same trap as vllm:local's model id
    baseUrl: 'http://127.0.0.1:8188',
    capabilities: caps({ costTier: 'free', qualityTier: 0.6 }),
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
  const capabilities = caps(spec.capabilities);
  switch (spec.kind) {
    case 'mock':
      return new MockImageProvider({ capabilities });
    case 'comfyui':
      return new ComfyUIProvider({ baseUrl: spec.baseUrl, checkpoint: spec.model, capabilities });
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
}

/** Same shape as `providers/probe.ts`'s text-provider probe, purpose-built for the two-preset image catalog rather than sharing the function directly — the auth stories genuinely differ (no api-key path exists for images yet). */
export async function probeImageProviders(
  extra: Record<string, ImageProviderSpec> = {},
  opts: { fetcher?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ImageProbeResult[]> {
  const specs = { ...IMAGE_PRESETS, ...extra };
  const results = await Promise.all(
    Object.entries(specs).map(async ([key, spec]): Promise<ImageProbeResult> => {
      const base = { key, kind: spec.kind, model: spec.model };
      if (spec.kind === 'mock') return { ...base, status: 'ready', detail: 'always available, deterministic placeholder images', fix: '' };
      if (spec.kind === 'comfyui') {
        const up = await comfyReachable(spec.baseUrl, opts.fetcher ?? fetch);
        return up
          ? { ...base, status: 'ready', detail: `listening at ${spec.baseUrl}`, fix: '' }
          : { ...base, status: 'unavailable', detail: `nothing listening at ${spec.baseUrl}`, fix: 'start it: python main.py  (then set the checkpoint filename in settings)' };
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
