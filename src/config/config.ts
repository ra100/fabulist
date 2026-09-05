/**
 * Configuration and registry assembly.
 *
 * Config is a plain JSON file next to the save, so a playthrough stays one
 * portable artifact.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MockProvider } from '../providers/mock.ts';
import { ProviderRegistry, SwappableRegistry, type Provider } from '../providers/provider.ts';
import { buildProvider, MECHANIC_ROLES, PRESETS, PROFILES, type ProviderSpec } from '../providers/http.ts';
import { buildImageProvider, IMAGE_PRESETS, type ImageProviderSpec } from '../providers/imageConfig.ts';
import { SwappableImageRegistry } from '../providers/image.ts';

export interface Config {
  /** Named profile, or 'mock' to run entirely offline. */
  profile: string;
  /** Per-role overrides, keyed by role name, valued by preset key. */
  routes: Record<string, string>;
  /** Extra provider specs beyond the presets. */
  providers: Record<string, ProviderSpec>;
  dbPath: string;
  proseLintThreshold: number;
  /** Personal blocklist. The design expects this to become the most valuable file here. */
  blocklist: string[];
  /**
   * Slows the mock provider's streaming, in milliseconds per fragment. Only
   * useful for seeing the streaming view render without a real model attached.
   */
  mockTokenDelayMs?: number;
  /**
   * Named image-provider preset key, or absent for "no illustration". Unlike
   * `profile`, there is no non-empty default — a fresh install has
   * illustration off, not pointed at the mock, because turning image
   * generation on is a choice with a cost (even the mock writes files to
   * disk) that a text-only session should never pay without asking.
   */
  imageProfile?: string;
  /** Extra image-provider specs beyond `IMAGE_PRESETS`, same override shape as `providers`. */
  imageProviders?: Record<string, ImageProviderSpec>;
}

export function defaultConfig(): Config {
  return {
    profile: 'mock',
    routes: {},
    providers: {},
    dbPath: 'data/fabulist.db',
    proseLintThreshold: 6,
    blocklist: [],
    imageProviders: {},
  };
}

export function loadConfig(path = 'fabulist.config.json'): Config {
  if (!existsSync(path)) return defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    return { ...defaultConfig(), ...raw };
  } catch (err) {
    throw new Error(`could not read ${path}: ${String(err)}`);
  }
}

export function saveConfig(cfg: Config, path = 'fabulist.config.json'): void {
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/**
 * Builds the registry from config. Falls back to the mock provider with a
 * warning rather than failing: an unconfigured key should not stop you playing.
 */
export function buildRegistry(cfg: Config, env = process.env): { registry: ProviderRegistry; notes: string[] } {
  const notes: string[] = [];

  if (cfg.profile === 'mock') {
    const mock = new MockProvider(cfg.mockTokenDelayMs ? { tokenDelayMs: cfg.mockTokenDelayMs } : {});
    return { registry: new ProviderRegistry(mock), notes: ['using the deterministic mock provider'] };
  }

  const specs = { ...PRESETS, ...cfg.providers };
  const resolve = (key: string): Provider | null => {
    const spec = specs[key];
    if (!spec) {
      notes.push(`unknown provider key "${key}"`);
      return null;
    }
    try {
      return buildProvider(spec, env);
    } catch (err) {
      notes.push(String(err instanceof Error ? err.message : err));
      return null;
    }
  };

  const profile = PROFILES[cfg.profile];
  if (!profile) {
    notes.push(`unknown profile "${cfg.profile}", falling back to mock`);
    return { registry: new ProviderRegistry(new MockProvider()), notes };
  }

  const narrator = resolve(profile.narrate);
  const mechanic = resolve(profile.mechanics);
  const extractor = resolve(profile.extract);

  if (!narrator) {
    notes.push('narrator provider unavailable, falling back to mock');
    return { registry: new ProviderRegistry(new MockProvider()), notes };
  }

  const registry = new ProviderRegistry(narrator);
  if (mechanic) for (const role of MECHANIC_ROLES) registry.route(role, mechanic);
  // Pinned independently: swapping the model that writes the graph mid-campaign
  // is how a world drifts out of consistency with no obvious cause. Pass B is
  // routed with it rather than with the cheap mechanics, because it also writes
  // canon and extraction quality caps everything downstream.
  if (extractor) {
    registry.route('extract', extractor);
    registry.route('passb', extractor);
  }

  for (const [role, key] of Object.entries(cfg.routes)) {
    const p = resolve(key);
    if (p) registry.route(role, p);
  }

  return { registry, notes };
}

/**
 * Builds a registry that can be swapped later, and persists the chosen profile.
 *
 * Switching profile used to mean hand-editing JSON and restarting, which meant a
 * machine with a perfectly good provider would sit on the mock and write
 * deliberately plain prose. The app knew the answer and could not act on it.
 */
export function buildSwappableRegistry(cfg: Config, env = process.env): { registry: SwappableRegistry; notes: string[] } {
  const { registry, notes } = buildRegistry(cfg, env);
  return { registry: new SwappableRegistry(registry, cfg.profile), notes };
}

export interface SwitchResult {
  profile: string;
  ok: boolean;
  notes: string[];
}

/**
 * Points a live registry at a different profile. Refuses rather than silently
 * degrading: being told "that profile is not available and here is why" beats
 * discovering three turns later that the mock is writing.
 */
export function switchProfile(
  registry: SwappableRegistry,
  profile: string,
  configPath = 'fabulist.config.json',
  env = process.env,
): SwitchResult {
  const cfg = { ...loadConfig(configPath), profile };
  const { registry: next, notes } = buildRegistry(cfg, env);

  const fellBack = profile !== 'mock' && next.get('narrate').id === 'mock';
  if (fellBack) return { profile: registry.profile(), ok: false, notes };

  registry.swap(next, profile);
  saveConfig(cfg, configPath);
  return { profile, ok: true, notes };
}

// ------------------------------------------------------------------- images

/**
 * Builds an image registry from config. No fallback-to-mock here, unlike
 * text: absent or unknown `imageProfile` means "illustration is off" is the
 * correct, silent, expected outcome, not a degraded state worth a console note.
 */
export function buildImageRegistry(cfg: Config, env = process.env): { registry: SwappableImageRegistry; notes: string[] } {
  const notes: string[] = [];
  if (!cfg.imageProfile) return { registry: new SwappableImageRegistry(null, 'none'), notes };

  const specs = { ...IMAGE_PRESETS, ...cfg.imageProviders };
  const spec = specs[cfg.imageProfile];
  if (!spec) {
    notes.push(`unknown image provider key "${cfg.imageProfile}", illustration stays off`);
    return { registry: new SwappableImageRegistry(null, 'none'), notes };
  }
  try {
    return { registry: new SwappableImageRegistry(buildImageProvider(spec, env), cfg.imageProfile), notes };
  } catch (err) {
    notes.push(`image provider "${cfg.imageProfile}" failed to build: ${err instanceof Error ? err.message : String(err)}`);
    return { registry: new SwappableImageRegistry(null, 'none'), notes };
  }
}

export interface ImageSwitchResult {
  profile: string;
  ok: boolean;
  notes: string[];
}

/** Same refuse-rather-than-degrade discipline as `switchProfile`, minus the mock-fallback special case: "off" (`profile: null`) is always a valid, explicit target here. */
export function switchImageProfile(
  registry: SwappableImageRegistry,
  profile: string | null,
  configPath = 'fabulist.config.json',
  env = process.env,
): ImageSwitchResult {
  const cfg = { ...loadConfig(configPath), imageProfile: profile ?? undefined };
  const { registry: next, notes } = buildImageRegistry(cfg, env);

  if (profile && !next.get()) return { profile: registry.profile(), ok: false, notes };

  registry.swap(next.get(), profile ?? 'none');
  saveConfig(cfg, configPath);
  return { profile: profile ?? 'none', ok: true, notes };
}
