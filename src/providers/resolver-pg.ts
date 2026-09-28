import type { SessionUser } from '../auth/config.ts';
import { EphemeralProviderKeyStore, type ProviderKeyGrant } from '../auth/ephemeral-provider-keys.ts';
import {
  deleteProviderKey,
  providerKeyFor,
  providerKeysFor,
  providerModelAssignmentsFor,
  saveProviderKey,
  saveProviderModelAssignments,
  summarizeProviderKey,
  type ProviderKeyRow,
  type ProviderKeySummary,
  type ProviderModelAssignment,
} from '../auth/provider-keys-pg.ts';
import { openProviderKey, sealProviderKey } from '../crypto/provider-secret.ts';
import type { Queryable } from '../db/pg.ts';
import { RateLimiter } from '../server/rate-limit.ts';
import { recordUsage, type KeySource } from '../store/usage-pg.ts';
import {
  byokEndpoint,
  byokProvider,
  discoverModels,
  ProviderKeyLockedError,
  ProviderKeyRejectedError,
} from './byok.ts';
export { ProviderKeyLockedError };
import { MeteredRegistry, type UsageSink } from './metered.ts';
import { MockProvider } from './mock.ts';
import {
  ProviderRegistry,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type Registry,
} from './provider.ts';

export type ProviderStatus = 'own' | 'locked' | 'unavailable' | 'server' | 'none';
export type ProviderCredentialStatus = 'ready' | 'locked' | 'unavailable';

interface KeyBase {
  id: string;
  label: string;
  endpointId: string;
}

export type SaveProviderKeyInput =
  | (KeyBase & { trust: 'sealed'; key: string })
  | (KeyBase & { trust: 'unlock'; wrap: { nonce: string; ciphertext: string }; keyHint: string });

export class ProviderKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeyInputError';
  }
}

export class ProviderKeyForbiddenError extends Error {
  constructor() {
    super('can only unlock your own provider key');
    this.name = 'ProviderKeyForbiddenError';
  }
}

export interface ProviderResolverOptions {
  db: Queryable;
  server: Registry;
  shareServerProvider: () => boolean;
  secretsKey: Buffer | null;
  grants?: EphemeralProviderKeyStore;
  fetcher?: typeof fetch;
  keyCallLimit?: { burst: number; perMinute: number };
  now?: () => number;
}

const CACHE_TTL_MS = 60_000;

interface Cached {
  keys: ProviderKeyRow[];
  assignments: ProviderModelAssignment[];
  at: number;
}

type Resolution = {
  registry: Registry;
  source: 'own' | 'server' | 'none';
  assignments: ProviderModelAssignment[];
  keys: ProviderKeyRow[];
};

class ProviderOverlayRegistry implements Registry {
  private readonly fallback: Registry;
  private readonly routes: Map<string, Provider>;
  private readonly fallbackSource: 'server' | 'none';

  constructor(fallback: Registry, routes: Map<string, Provider>, fallbackSource: 'server' | 'none') {
    this.fallback = fallback;
    this.routes = routes;
    this.fallbackSource = fallbackSource;
  }

  private sourceProvider(provider: Provider): Provider {
    if (this.fallbackSource !== 'server' || provider.usageKeySource === 'server') return provider;
    return { ...provider, usageKeySource: 'server' };
  }

  get(role: string): Provider {
    return this.routes.get(role) ?? this.sourceProvider(this.fallback.get(role));
  }

  getOptional(role: string): Provider | undefined {
    const assigned = this.routes.get(role);
    if (assigned) return assigned;
    const optional = this.fallback.getOptional?.(role);
    return optional ? this.sourceProvider(optional) : undefined;
  }

  all(): Provider[] {
    const providers = new Set([
      ...this.fallback.all().map((provider) => this.sourceProvider(provider)),
      ...this.routes.values(),
    ]);
    return [...providers];
  }
}

export type ProviderKeyTestResult =
  | { status: 'verified'; message: string }
  | { status: 'rejected'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'unavailable'; message: string };

export class ProviderResolver {
  readonly grants: EphemeralProviderKeyStore;
  private readonly db: Queryable;
  private readonly server: Registry;
  private readonly share: () => boolean;
  private readonly secretsKey: Buffer | null;
  private readonly fetcher: typeof fetch | undefined;
  private readonly keyCalls: RateLimiter;
  private readonly cache = new Map<string, Cached>();
  private readonly generation = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: ProviderResolverOptions) {
    this.db = opts.db;
    this.server = opts.server;
    this.share = opts.shareServerProvider;
    this.secretsKey = opts.secretsKey;
    this.grants = opts.grants ?? new EphemeralProviderKeyStore();
    this.fetcher = opts.fetcher;
    this.now = opts.now ?? Date.now;
    this.keyCalls = new RateLimiter(opts.keyCallLimit?.burst ?? 5, opts.keyCallLimit?.perMinute ?? 5);
  }

  get sealedAvailable(): boolean {
    return this.secretsKey !== null;
  }

  async forRequest(user: SessionUser | null, storyId?: string): Promise<Registry> {
    return (await this.resolve(user, storyId)).registry;
  }

  async status(user: SessionUser): Promise<ProviderStatus> {
    const { source, assignments, keys } = await this.resolve(user);
    if (source !== 'own') return source;
    const byId = new Map(keys.map((row) => [row.id, row]));
    for (const assignment of assignments) {
      const row = byId.get(assignment.providerKeyId);
      if (!row) return 'unavailable';
      if (row.trust === 'unlock' && !this.grants.get(user.id, row.id, row.version)) return 'locked';
      if (row.trust === 'sealed' && !this.sealedKeyAvailable(user.id, row)) return 'unavailable';
    }
    return 'own';
  }

  async summaries(user: SessionUser): Promise<Array<{ key: ProviderKeySummary; status: ProviderCredentialStatus }>> {
    const { keys } = await this.cached(user.id);
    return keys.map((row) => ({ key: summarizeProviderKey(row), status: this.keyStatus(user.id, row) }));
  }

  async assignments(user: SessionUser): Promise<ProviderModelAssignment[]> {
    return (await this.cached(user.id)).assignments;
  }

  async unlockRecords(
    user: SessionUser,
  ): Promise<Array<{ keyId: string; wrap: { nonce: string; ciphertext: string } }>> {
    const { keys } = await this.cached(user.id);
    return keys
      .filter((row) => row.trust === 'unlock')
      .map((row) => ({
        keyId: row.id,
        wrap: { nonce: row.nonce.toString('base64'), ciphertext: row.ciphertext.toString('base64') },
      }));
  }

  async save(user: SessionUser, input: SaveProviderKeyInput): Promise<ProviderKeySummary> {
    if (!byokEndpoint(input.endpointId)) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    let wrapped: { nonce: Buffer; ciphertext: Buffer };
    let keyHint: string;
    if (input.trust === 'sealed') {
      if (!this.secretsKey) throw new ProviderKeyInputError('sealed keys are disabled on this server');
      wrapped = sealProviderKey(this.secretsKey, user.id, input.id, input.key);
      keyHint = input.key.slice(-4);
    } else {
      wrapped = {
        nonce: Buffer.from(input.wrap.nonce, 'base64'),
        ciphertext: Buffer.from(input.wrap.ciphertext, 'base64'),
      };
      if (wrapped.nonce.length !== 12 || wrapped.ciphertext.length <= 16 || wrapped.ciphertext.length > 528) {
        throw new ProviderKeyInputError('invalid provider key wrap');
      }
      keyHint = input.keyHint;
    }
    this.invalidate(user.id);
    await saveProviderKey(this.db, {
      id: input.id,
      userId: user.id,
      label: input.label,
      endpointId: input.endpointId,
      trust: input.trust,
      keyHint,
      ...wrapped,
    });
    this.invalidate(user.id);
    const saved = await providerKeyFor(this.db, user.id, input.id);
    if (!saved) throw new Error('provider key was not saved');
    return summarizeProviderKey(saved);
  }

  async remove(user: SessionUser, keyId: string): Promise<boolean> {
    this.grants.lock(user.id, keyId);
    this.invalidate(user.id);
    const removed = await deleteProviderKey(this.db, user.id, keyId);
    this.grants.lock(user.id, keyId);
    this.invalidate(user.id);
    return removed;
  }

  async saveAssignments(user: SessionUser, assignments: ProviderModelAssignment[]): Promise<ProviderModelAssignment[]> {
    if (assignments.some((assignment) => assignment.role === 'jev-fastpath')) {
      const keys = new Map((await providerKeysFor(this.db, user.id)).map((row) => [row.id, row]));
      for (const assignment of assignments) {
        if (assignment.role !== 'jev-fastpath') continue;
        const key = keys.get(assignment.providerKeyId);
        if (key && key.endpointId !== 'openrouter') {
          throw new ProviderKeyInputError('Jev fast checks require an OpenRouter provider');
        }
      }
    }
    try {
      await saveProviderModelAssignments(this.db, user.id, assignments);
    } catch (err) {
      if ((err as { code?: string }).code === '23503') {
        throw new ProviderKeyInputError('each model assignment must use one of your saved providers');
      }
      throw err;
    }
    this.invalidate(user.id);
    return this.assignments(user);
  }

  lock(userId: string, keyId?: string): boolean {
    return this.grants.lock(userId, keyId);
  }

  async unlock(user: SessionUser, handoff: Array<{ keyId: string; key: string }>): Promise<ProviderKeyGrant[]> {
    if (!handoff.length) return [];
    const ids = new Set(handoff.map(({ keyId }) => keyId));
    if (ids.size !== handoff.length) throw new ProviderKeyForbiddenError();
    const before = this.generation.get(user.id) ?? 0;
    const { keys } = await this.cached(user.id);
    if ((this.generation.get(user.id) ?? 0) !== before) throw new ProviderKeyForbiddenError();
    const byId = new Map(keys.map((row) => [row.id, row]));
    const rows = handoff.map(({ keyId }) => byId.get(keyId));
    if (rows.some((row) => !row || row.trust !== 'unlock')) throw new ProviderKeyForbiddenError();
    return handoff.map(({ keyId, key }, index) => {
      const row = rows[index]!;
      return this.grants.unlock(user.id, keyId, row.version, key);
    });
  }

  async test(user: SessionUser, input: { endpointId: string; key: string }): Promise<ProviderKeyTestResult> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    try {
      const result = await discoverModels(endpoint, input.key, this.fetcher);
      if (result.status === 'verified')
        return {
          status: 'verified',
          message: 'Provider access verified (' + result.models.length + ' models listed).',
        };
      if (result.status === 'unsupported')
        return {
          status: 'unsupported',
          message: 'This provider does not offer a model-list endpoint, so access could not be verified.',
        };
      return {
        status: 'unavailable',
        message: 'Could not reach the provider. The key was not verified; try again later.',
      };
    } catch (err) {
      if (err instanceof ProviderKeyRejectedError) return { status: 'rejected', message: err.message };
      return { status: 'unavailable', message: 'The provider could not verify this key right now.' };
    }
  }

  async models(input: { endpointId: string; key: string }): Promise<string[]> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    return (await discoverModels(endpoint, input.key, this.fetcher)).models;
  }

  async modelsForSaved(user: SessionUser, keyId: string): Promise<string[]> {
    const { keys } = await this.cached(user.id);
    const row = keys.find((candidate) => candidate.id === keyId);
    if (!row) throw new ProviderKeyInputError('that saved provider was not found');
    return this.listModelsForRow(user.id, row);
  }

  takeKeyCall(userId: string): number | null {
    return this.keyCalls.take(userId);
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
  }

  private async listModelsForRow(userId: string, row: ProviderKeyRow): Promise<string[]> {
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    const catalog = await discoverModels(endpoint, this.secretFor(userId, row), this.fetcher);
    return catalog.models;
  }

  private secretFor(userId: string, row: ProviderKeyRow): string {
    const cached = this.cache.get(userId);
    if (!cached?.keys.some((key) => key.id === row.id && key.version === row.version)) {
      throw new ProviderKeyLockedError('your provider key was removed or replaced');
    }
    if (row.trust === 'sealed') {
      if (!this.secretsKey) throw new ProviderKeyLockedError('sealed provider keys are disabled on this server');
      try {
        return openProviderKey(this.secretsKey, userId, row.id, row);
      } catch {
        throw new ProviderKeyLockedError('the assigned provider key cannot be decrypted on this server');
      }
    }
    const key = this.grants.get(userId, row.id, row.version);
    if (key === null) throw new ProviderKeyLockedError();
    return key;
  }

  private sealedKeyAvailable(userId: string, row: ProviderKeyRow): boolean {
    if (!this.secretsKey) return false;
    try {
      openProviderKey(this.secretsKey, userId, row.id, row);
      return true;
    } catch {
      return false;
    }
  }

  private keyStatus(userId: string, row: ProviderKeyRow): ProviderCredentialStatus {
    if (row.trust === 'unlock') return this.grants.get(userId, row.id, row.version) ? 'ready' : 'locked';
    return this.sealedKeyAvailable(userId, row) ? 'ready' : 'unavailable';
  }

  private fallback(user: SessionUser): { registry: Registry; source: 'server' | 'none' } {
    if (this.share() || user.isAdmin) return { registry: this.server, source: 'server' };
    return { registry: new ProviderRegistry(new MockProvider()), source: 'none' };
  }

  private async resolve(user: SessionUser | null, storyId?: string): Promise<Resolution> {
    if (!user) return { registry: this.server, source: 'server', assignments: [], keys: [] };
    const own = await this.cached(user.id);
    if (!own.assignments.length) {
      const fallback = this.fallback(user);
      return {
        registry:
          fallback.source === 'server'
            ? new MeteredRegistry(fallback.registry, this.sink(user.id, storyId, 'server'))
            : fallback.registry,
        source: fallback.source,
        assignments: [],
        keys: own.keys,
      };
    }
    const fallback = this.fallback(user);
    const registry = this.build(user.id, own, fallback.registry, fallback.source);
    return {
      registry: new MeteredRegistry(registry, this.sink(user.id, storyId, 'own')),
      source: 'own',
      assignments: own.assignments,
      keys: own.keys,
    };
  }

  private async cached(userId: string): Promise<Cached> {
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit;
    const before = this.generation.get(userId) ?? 0;
    const [keys, assignments] = await Promise.all([
      providerKeysFor(this.db, userId),
      providerModelAssignmentsFor(this.db, userId),
    ]);
    const entry: Cached = { keys, assignments, at: this.now() };
    if ((this.generation.get(userId) ?? 0) === before) this.cache.set(userId, entry);
    return entry;
  }

  private build(userId: string, config: Cached, fallback: Registry, fallbackSource: 'server' | 'none'): Registry {
    const keys = new Map(config.keys.map((row) => [row.id, row]));
    const assignments = new Map(config.assignments.map((assignment) => [assignment.role, assignment]));
    const narration = assignments.get('narrate');
    const routes = new Map<string, Provider>();
    for (const role of [
      'narrate',
      'classify',
      'integrity',
      'referee',
      'jev-fastpath',
      'director',
      'humanize',
      'summarize',
      'setup',
      'extract',
      'passb',
    ] as const) {
      const assignment =
        assignments.get(role) ?? (role === 'narrate' || role === 'jev-fastpath' ? undefined : narration);
      if (!assignment) continue;
      const row = keys.get(assignment.providerKeyId);
      routes.set(
        role,
        row ? this.providerFor(userId, row, assignment.model, role) : this.unavailableProvider(role, assignment.model),
      );
    }
    return new ProviderOverlayRegistry(fallback, routes, fallbackSource);
  }

  private providerFor(userId: string, row: ProviderKeyRow, model: string, role: string): Provider {
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint || (role === 'jev-fastpath' && endpoint.id !== 'openrouter')) {
      return this.unavailableProvider(role, model);
    }
    return {
      ...byokProvider(endpoint, model, () => this.secretFor(userId, row), this.fetcher),
      usageKeyId: row.id,
    };
  }

  private unavailableProvider(id: string, model: string): Provider {
    const capabilities = this.server.get('narrate').capabilities;
    return {
      id: id || 'unavailable',
      model,
      capabilities,
      async complete(_req: CompletionRequest): Promise<CompletionResult> {
        throw new ProviderKeyLockedError('the credential assigned to this model is missing or unavailable');
      },
    };
  }

  private sink(userId: string, storyId: string | undefined, keySource: KeySource): UsageSink {
    return (call) => {
      const { keySource: source, ...usage } = call;
      return recordUsage(this.db, { userId, storyId: storyId ?? null, keySource: source ?? keySource, ...usage });
    };
  }
}
