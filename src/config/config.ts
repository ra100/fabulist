/**
 * Configuration and registry assembly.
 *
 * Config is a plain JSON file next to the save, so a playthrough stays one
 * portable artifact.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MockProvider } from '../providers/mock.ts';
import { ProviderRegistry, type Provider } from '../providers/provider.ts';
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
    return { registry: new ProviderRegistry(new MockProvider()), notes: ['using the deterministic mock provider'] };
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
