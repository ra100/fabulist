/**
 * Live configuration.
 *
 * Everything here used to be a hand-edited JSON file plus a restart, which is the
 * same failure the provider profile had: the app knows what you want and cannot
 * act on it. Two things follow from owning config at runtime rather than reading
 * it once at boot.
 *
 * Changes have side effects. Touching `providers` or `routes` has to rebuild the
 * registry, and touching the lint settings has to reach a prose gate that would
 * otherwise have captured them at construction. Those are wired here so a caller
 * cannot forget one.
 *
 * Changes are validated, not trusted. A malformed provider spec should come back
 * as a warning on the field, not as a broken engine three turns later.
 */
import {
  buildImageRegistry,
  buildRegistry,
  loadConfig,
  saveConfig,
  type Config,
} from './config.ts';
import { defaultAuth, PRESETS, profilesFor, type ProviderKind, type ProviderSpec } from '../providers/http.ts';
import { IMAGE_PRESETS, type ImageProviderKind, type ImageProviderSpec } from '../providers/imageConfig.ts';
import type { SwappableImageRegistry } from '../providers/image.ts';
import type { SwappableRegistry } from '../providers/provider.ts';

export interface ConfigServiceOptions {
  path?: string;
  registry?: SwappableRegistry;
  /** Swapped when an image provider spec changes, so edits need no restart. */
  imageRegistry?: SwappableImageRegistry;
  env?: Record<string, string | undefined>;
  /** Injected for tests, so nothing touches a real file. */
  load?: (path: string) => Config;
  save?: (cfg: Config, path: string) => void;
}

export interface ValidationIssue {
  field: string;
  message: string;
  /**
   * Absent means "error": the value was rejected. `warning` means the value was
   * kept and is legal, but deserves saying out loud — a remote image host over
   * plain http, for instance, works fine on a trusted LAN and still sends an
   * API key in clear text.
   */
  severity?: 'error' | 'warning';
}

export interface PatchResult {
  config: Config;
  issues: ValidationIssue[];
  /** True when the change also swapped the live registry. */
  registryRebuilt: boolean;
}

const KINDS: ProviderKind[] = ['openai-compat', 'anthropic', 'ollama', 'bedrock', 'google', 'copilot', 'mock'];
const IMAGE_KINDS: ImageProviderKind[] = ['mock', 'comfyui', 'unsloth', 'bedrock-stability'];

/** Roles the UI may route independently. */
export const ROUTABLE_ROLES = [
  'narrate',
  'extract',
  'passb',
  'classify',
  'integrity',
  'referee',
  'director',
  'summarize',
  'setup',
  'humanize',
] as const;

export class ConfigService {
  private cfg: Config;
  /**
   * Readable so callers that write config through the *module* functions rather
   * than through this service (`switchProfile`, `switchImageProfile` — they
   * predate it and take a path of their own) can be handed the same file. Their
   * defaults point at `fabulist.config.json`, so a server running on a throwaway
   * config would otherwise still write profile switches to the real one.
   */
  readonly path: string;
  private registry: SwappableRegistry | undefined;
  /**
   * The live image registry, so editing an image provider's host takes effect on
   * the next illustration instead of at the next restart — the same reasoning
   * that makes `registry` swappable here.
   */
  private imageRegistry: SwappableImageRegistry | undefined;
  private env: Record<string, string | undefined>;
  private saveFn: (cfg: Config, path: string) => void;

  constructor(opts: ConfigServiceOptions = {}) {
    this.path = opts.path ?? 'fabulist.config.json';
    this.registry = opts.registry;
    this.imageRegistry = opts.imageRegistry;
    this.env = opts.env ?? process.env;
    this.saveFn = opts.save ?? ((cfg, path) => saveConfig(cfg, path));
    this.cfg = (opts.load ?? ((p: string) => loadConfig(p)))(this.path);
  }

  get(): Config {
    return {
      ...this.cfg,
      providers: { ...this.cfg.providers },
      routes: { ...this.cfg.routes },
      blocklist: [...this.cfg.blocklist],
      imageProviders: { ...(this.cfg.imageProviders ?? {}) },
    };
  }

  /**
   * Live lint settings, read per call rather than captured. This is what lets the
   * blocklist grow during a session and affect the very next turn.
   */
  lintOptions(): { threshold: number; blocklist: string[] } {
    return { threshold: this.cfg.proseLintThreshold, blocklist: [...this.cfg.blocklist] };
  }

  /** Every provider key the UI can offer: presets plus anything configured. */
  providerKeys(): string[] {
    return [...new Set([...Object.keys(PRESETS), ...Object.keys(this.cfg.providers)])].sort();
  }

  /** The same, for images. */
  imageProviderKeys(): string[] {
    return [...new Set([...Object.keys(IMAGE_PRESETS), ...Object.keys(this.cfg.imageProviders ?? {})])].sort();
  }

  /** A spec by key, preset or override, for the UI to prefill an editor from. */
  resolveImageSpec(key: string): ImageProviderSpec | undefined {
    return this.cfg.imageProviders?.[key] ?? IMAGE_PRESETS[key];
  }

  /** Built-in profiles plus the one each configured provider is worth on its own. */
  profileNames(): string[] {
    return Object.keys(profilesFor(this.cfg.providers));
  }

  // ------------------------------------------------------------------ patch

  patch(partial: Partial<Config>): PatchResult {
    const issues: ValidationIssue[] = [];
    const next: Config = this.get();

    if (partial.proseLintThreshold !== undefined) {
      const value = Number(partial.proseLintThreshold);
      if (!Number.isFinite(value) || value < 0) {
        issues.push({ field: 'proseLintThreshold', message: 'must be a number of 0 or more' });
      } else {
        next.proseLintThreshold = value;
      }
    }

    if (partial.mockTokenDelayMs !== undefined) {
      const value = Number(partial.mockTokenDelayMs);
      if (!Number.isFinite(value) || value < 0 || value > 2000) {
        issues.push({ field: 'mockTokenDelayMs', message: 'must be between 0 and 2000' });
      } else {
        next.mockTokenDelayMs = value;
      }
    }

    if (partial.blocklist !== undefined) {
      next.blocklist = normaliseBlocklist(partial.blocklist);
    }

    if (partial.routes !== undefined) {
      const known = new Set(this.providerKeys());
      const routes: Record<string, string> = {};
      for (const [role, key] of Object.entries(partial.routes)) {
        if (!key) continue; // an empty value clears the override
        if (!known.has(key)) {
          issues.push({ field: `routes.${role}`, message: `unknown provider "${key}"` });
          continue;
        }
        routes[role] = key;
      }
      next.routes = routes;
    }

    if (partial.providers !== undefined) {
      const providers: Record<string, ProviderSpec> = {};
      for (const [key, spec] of Object.entries(partial.providers)) {
        const checked = validateSpec(key, spec);
        issues.push(...checked.issues);
        if (checked.spec) providers[key] = checked.spec;
      }
      next.providers = providers;
    }

    if (partial.imageProviders !== undefined) {
      // Was missing entirely, which is why ComfyUI and Unsloth were stuck on
      // their loopback preset defaults: `PUT /api/config` accepted the field,
      // dropped it on the floor, and reported success.
      const imageProviders: Record<string, ImageProviderSpec> = {};
      for (const [key, spec] of Object.entries(partial.imageProviders)) {
        const checked = validateImageSpec(key, spec);
        issues.push(...checked.issues);
        if (checked.spec) imageProviders[key] = checked.spec;
      }
      next.imageProviders = imageProviders;
    }

    // dbPath is deliberately not patchable: the world is already open, so
    // changing it at runtime would leave the UI talking to a database the engine
    // is not using.
    if (partial.dbPath !== undefined && partial.dbPath !== this.cfg.dbPath) {
      issues.push({ field: 'dbPath', message: 'cannot be changed while a world is open' });
    }

    const touchesRegistry =
      partial.routes !== undefined || partial.providers !== undefined || partial.mockTokenDelayMs !== undefined;
    // The image registry holds one built provider, so a spec edit only reaches
    // illustration if it is rebuilt — otherwise changing a host would appear to
    // save and then keep calling the old one until a restart.
    const touchesImageRegistry = partial.imageProviders !== undefined || partial.imageProfile !== undefined;

    this.cfg = next;
    this.saveFn(this.cfg, this.path);

    let registryRebuilt = false;
    if (touchesRegistry && this.registry) {
      const { registry } = buildRegistry(this.cfg, this.env);
      this.registry.swap(registry, this.cfg.profile);
      registryRebuilt = true;
    }

    if (touchesImageRegistry && this.imageRegistry) {
      const { registry: rebuilt, notes } = buildImageRegistry(this.cfg, this.env);
      // `buildImageRegistry` reports a spec that would not build (a missing API
      // key, say) as a note rather than throwing, and that is exactly the
      // feedback the editor needs — surfaced as an issue on the provider rather
      // than swallowed into a server log nobody is reading.
      for (const note of notes) issues.push({ field: 'imageProviders', message: note, severity: 'warning' });
      this.imageRegistry.swap(rebuilt.get(), this.cfg.imageProfile ?? 'none');
    }

    return { config: this.get(), issues, registryRebuilt };
  }

  // -------------------------------------------------------------- providers

  putProvider(key: string, spec: ProviderSpec): PatchResult {
    const trimmed = key.trim();
    if (!trimmed) {
      return { config: this.get(), issues: [{ field: 'key', message: 'a name is required' }], registryRebuilt: false };
    }
    return this.patch({ providers: { ...this.cfg.providers, [trimmed]: spec } });
  }

  removeProvider(key: string): PatchResult {
    const providers = { ...this.cfg.providers };
    delete providers[key];
    // Drop any route that pointed at it, or the registry would fail to build.
    const routes = Object.fromEntries(Object.entries(this.cfg.routes).filter(([, v]) => v !== key));
    return this.patch({ providers, routes });
  }

  /** The spec behind a key, preset or configured, for the editor to prefill. */
  resolveSpec(key: string): ProviderSpec | undefined {
    return this.cfg.providers[key] ?? PRESETS[key];
  }

  // -------------------------------------------------------- image providers

  /**
   * Saves one image provider spec. This is what makes a ComfyUI or Unsloth on
   * another machine reachable: override the preset key with the same kind and a
   * different `baseUrl`, and `buildImageProvider` picks it up on the rebuild
   * that `patch` performs.
   */
  putImageProvider(key: string, spec: ImageProviderSpec): PatchResult {
    const trimmed = key.trim();
    if (!trimmed) {
      return { config: this.get(), issues: [{ field: 'key', message: 'a name is required' }], registryRebuilt: false };
    }
    return this.patch({ imageProviders: { ...(this.cfg.imageProviders ?? {}), [trimmed]: spec } });
  }

  removeImageProvider(key: string): PatchResult {
    const imageProviders = { ...(this.cfg.imageProviders ?? {}) };
    delete imageProviders[key];
    // No route map to clean up here, unlike text. If the active `imageProfile`
    // pointed at this key and no preset shares the name, the rebuild below
    // reports "unknown image provider key … illustration stays off" as a
    // warning — which is the honest outcome and is surfaced rather than hidden.
    // Deleting an override that shadows a preset simply reverts to the preset.
    return this.patch({ imageProviders });
  }

  // -------------------------------------------------------------- blocklist

  /**
   * Adds a phrase. The design expects this list to become the most valuable file
   * in the project, which only happens if adding to it costs one click at the
   * moment the phrase annoys you.
   */
  addBlocked(phrase: string): PatchResult {
    const value = phrase.trim();
    if (value.length < 2) {
      return { config: this.get(), issues: [{ field: 'blocklist', message: 'too short to be useful' }], registryRebuilt: false };
    }
    if (this.cfg.blocklist.some((p) => p.toLowerCase() === value.toLowerCase())) {
      return { config: this.get(), issues: [], registryRebuilt: false };
    }
    return this.patch({ blocklist: [...this.cfg.blocklist, value] });
  }

  removeBlocked(phrase: string): PatchResult {
    return this.patch({ blocklist: this.cfg.blocklist.filter((p) => p.toLowerCase() !== phrase.trim().toLowerCase()) });
  }

  /** Called by switchProfile so the in-memory copy does not go stale. */
  reload(): Config {
    this.cfg = loadConfig(this.path);
    return this.get();
  }
}

function normaliseBlocklist(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const value = String(item).trim();
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Validates one provider spec. Errors are per-field so the UI can point at the
 * thing that is wrong rather than rejecting the whole form.
 */
export function validateSpec(key: string, raw: unknown): { spec: ProviderSpec | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    return { spec: null, issues: [{ field: key, message: 'not an object' }] };
  }
  const s = raw as Record<string, unknown>;
  const kind = String(s.kind ?? '');
  if (!KINDS.includes(kind as ProviderKind)) {
    issues.push({ field: `${key}.kind`, message: `must be one of ${KINDS.join(', ')}` });
    return { spec: null, issues };
  }

  const model = String(s.model ?? '').trim();
  if (!model) issues.push({ field: `${key}.model`, message: 'a model id is required' });

  const spec: ProviderSpec = { kind: kind as ProviderKind, model };

  if (s.baseUrl !== undefined && String(s.baseUrl).trim()) {
    const value = String(s.baseUrl).trim();
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
      spec.baseUrl = value.replace(/\/$/, '');
    } catch {
      issues.push({ field: `${key}.baseUrl`, message: 'must be an http or https URL' });
    }
  }

  if (s.auth !== undefined && String(s.auth).trim()) {
    const auth = String(s.auth);
    const allowed = ['none', 'api-key', 'aws-profile', 'google-oauth', 'copilot-oauth'];
    if (!allowed.includes(auth)) issues.push({ field: `${key}.auth`, message: `must be one of ${allowed.join(', ')}` });
    else spec.auth = auth as ProviderSpec['auth'];
  }

  for (const field of ['apiKeyEnv', 'dialect', 'profile', 'region', 'project', 'location', 'note'] as const) {
    const value = s[field];
    if (value !== undefined && String(value).trim()) {
      (spec as unknown as Record<string, unknown>)[field] = String(value).trim();
    }
  }

  if (s.allowUnofficial === true) spec.allowUnofficial = true;

  if (s.capabilities && typeof s.capabilities === 'object') {
    const capabilities = s.capabilities as Record<string, unknown>;
    const window = Number(capabilities.contextWindow ?? 0);
    // The engine's frame budgets assume the 64k floor the design commits to;
    // silently accepting less would truncate prompts rather than fail loudly.
    if (window && window < 64_000) {
      issues.push({ field: `${key}.capabilities.contextWindow`, message: 'the engine assumes at least 64000' });
    } else {
      spec.capabilities = capabilities as ProviderSpec['capabilities'];
    }
  }

  // A keyless kind with auth api-key and no variable named is a common slip.
  const auth = spec.auth ?? defaultAuth(spec.kind);
  if (auth === 'api-key' && !spec.apiKeyEnv) {
    issues.push({ field: `${key}.apiKeyEnv`, message: 'api-key auth needs the environment variable name' });
  }
  if (spec.kind === 'copilot' && !spec.allowUnofficial) {
    issues.push({ field: `${key}.allowUnofficial`, message: 'Copilot uses an undocumented endpoint; set this to acknowledge it' });
  }

  return { spec: issues.some((i) => i.field.endsWith('.kind') || i.field.endsWith('.model')) ? null : spec, issues };
}

/**
 * Validates one image-provider spec: the mirror of `validateSpec` for text.
 *
 * Worth its own function rather than a shared one, because the field sets
 * genuinely differ (no dialect, no context window, an `apiKeyEnv` only one kind
 * uses) — and because the *reason* `baseUrl` matters is different. For a text
 * provider a local server is a convenience. For images it is the point of this
 * function: ComfyUI and Unsloth Studio usually run on whichever machine has the
 * GPU, which is frequently not this one, and until this existed both were
 * effectively pinned to their `127.0.0.1` preset defaults because `patch()`
 * ignored `imageProviders` entirely.
 */
export function validateImageSpec(
  key: string,
  raw: unknown,
): { spec: ImageProviderSpec | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    return { spec: null, issues: [{ field: key, message: 'not an object' }] };
  }
  const s = raw as Record<string, unknown>;
  const kind = String(s.kind ?? '');
  if (!IMAGE_KINDS.includes(kind as ImageProviderKind)) {
    issues.push({ field: `${key}.kind`, message: `must be one of ${IMAGE_KINDS.join(', ')}` });
    return { spec: null, issues };
  }

  // `model` means something different per kind — a ComfyUI checkpoint filename,
  // a Bedrock model id, an informational label for Unsloth — but every kind
  // needs *something*, and an unset ComfyUI checkpoint is its #1 failure mode.
  const model = String(s.model ?? '').trim();
  if (!model) issues.push({ field: `${key}.model`, message: 'a model id, checkpoint filename or label is required' });

  const spec: ImageProviderSpec = { kind: kind as ImageProviderKind, model };

  if (s.baseUrl !== undefined && String(s.baseUrl).trim()) {
    const value = String(s.baseUrl).trim();
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
      // Only a trailing slash is stripped, never a path: a reverse-proxied
      // Unsloth or ComfyUI can legitimately live at
      // `https://gpu.example.com/comfy`, and dropping that prefix would send
      // every request to the wrong host root.
      spec.baseUrl = value.replace(/\/$/, '');
    } catch {
      issues.push({ field: `${key}.baseUrl`, message: 'must be an http or https URL, e.g. http://192.168.1.40:8188' });
    }
  }

  // A remote host over plain http is flagged, not refused: it is entirely
  // normal on a trusted LAN, and for Unsloth it also means the bearer key
  // crosses the network in clear text — worth knowing, not worth blocking.
  if (spec.baseUrl) {
    try {
      const url = new URL(spec.baseUrl);
      const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(url.hostname);
      if (!loopback && url.protocol === 'http:') {
        issues.push({
          field: `${key}.baseUrl`,
          message:
            spec.kind === 'unsloth'
              ? 'remote host over plain http: requests and the API key travel unencrypted'
              : 'remote host over plain http: requests travel unencrypted',
          severity: 'warning',
        });
      }
    } catch {
      // Unreachable: the URL parsed above.
    }
  }

  for (const field of ['apiKeyEnv', 'profile', 'region', 'note'] as const) {
    const value = s[field];
    if (value !== undefined && String(value).trim()) {
      (spec as unknown as Record<string, unknown>)[field] = String(value).trim();
    }
  }

  if (s.capabilities && typeof s.capabilities === 'object') {
    spec.capabilities = s.capabilities as ImageProviderSpec['capabilities'];
  }

  // Unsloth authenticates a *local* desktop install from its own on-disk secret,
  // so a missing key is no longer an error — only a remote instance genuinely
  // needs one. Warned rather than errored, because the loopback case is the
  // common one and works without any key at all.
  if (spec.kind === 'unsloth' && !spec.apiKeyEnv) {
    let loopback = true;
    try {
      if (spec.baseUrl) loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(new URL(spec.baseUrl).hostname);
    } catch {
      // Already reported above.
    }
    if (!loopback) {
      issues.push({
        field: `${key}.apiKeyEnv`,
        message: 'a remote Unsloth cannot use this machine\u2019s desktop login: name the env var holding its API key',
        severity: 'warning',
      });
    }
  }

  return {
    spec: issues.some((i) => i.severity !== 'warning' && (i.field.endsWith('.kind') || i.field.endsWith('.model'))) ? null : spec,
    issues,
  };
}
