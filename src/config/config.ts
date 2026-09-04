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
}

export function defaultConfig(): Config {
  return {
    profile: 'mock',
    routes: {},
    providers: {},
    dbPath: 'data/fabulist.db',
    proseLintThreshold: 6,
    blocklist: [],
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
