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

/**
 * The gitignored sibling that holds a *personal* override of `path`, the same
 * way `.env.local` sits beside `.env`. Inserted before the final extension —
 * `fabulist.config.json` → `fabulist.config.local.json` — so a `--config=`
 * override (the throwaway `--memory` server, a test fixture) gets its own
 * local sibling too, rather than every server on the machine sharing one.
 */
export function localPathFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? `${path}.local` : `${path.slice(0, dot)}.local${path.slice(dot)}`;
}

/**
 * Layers a personal override on top of the tracked file: `defaultConfig()` <
 * `path` < `localPathFor(path)`. `path` is meant to be committed with safe
 * defaults (`profile: "mock"`) and never edited by the running app again —
 * `saveConfig` below always writes the local layer instead. Before this
 * existed, every runtime write (a profile switch, a kept provider spec)
 * landed on the tracked file itself, so the committed default drifted to
 * whatever the last person to run the app locally happened to be using, and
 * showed up as a permanently dirty file with nothing meaningful to commit.
 */
export function loadConfig(path = 'fabulist.config.json'): Config {
  let cfg = defaultConfig();
  if (existsSync(path)) {
    try {
      cfg = { ...cfg, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>) };
    } catch (err) {
      throw new Error(`could not read ${path}: ${String(err)}`);
    }
  }
  const localPath = localPathFor(path);
  if (existsSync(localPath)) {
    try {
      cfg = { ...cfg, ...(JSON.parse(readFileSync(localPath, 'utf8')) as Partial<Config>) };
    } catch (err) {
      throw new Error(`could not read ${localPath}: ${String(err)}`);
    }
  }
  return cfg;
}

/**
 * Always writes the local override, never `path` itself — the point of the
 * split above. A first write with no local file yet creates one rather than
 * touching the tracked default, so cloning the repo and running the app even
 * once is enough to permanently stop `git status` from showing a dirty
 * `fabulist.config.json`.
 */
export function saveConfig(cfg: Config, path = 'fabulist.config.json'): void {
  writeFileSync(localPathFor(path), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
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
