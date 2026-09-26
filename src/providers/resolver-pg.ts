import type { SessionUser } from '../auth/config.ts';
import { EphemeralProviderKeyStore, type ProviderKeyGrant } from '../auth/ephemeral-provider-keys.ts';
import {
  deleteProviderKey,
  providerKeyFor,
  saveProviderKey,
  summarizeProviderKey,
  type ProviderKeyRow,
  type ProviderKeySummary,
  type ProviderModels,
} from '../auth/provider-keys-pg.ts';
import { openProviderKey, sealProviderKey } from '../crypto/provider-secret.ts';
import type { Queryable } from '../db/pg.ts';
import { RateLimiter } from '../server/rate-limit.ts';
import { recordUsage, type KeySource } from '../store/usage-pg.ts';
import { byokEndpoint, byokProvider, listModels, ProviderKeyLockedError, scrubSecrets } from './byok.ts';
export { ProviderKeyLockedError };
import { MECHANIC_ROLES } from './http.ts';
import { MeteredRegistry, type UsageSink } from './metered.ts';
import { MockProvider } from './mock.ts';
import { ProviderRegistry, type Registry } from './provider.ts';

export type ProviderStatus = 'own' | 'locked' | 'unavailable' | 'server' | 'none';

interface KeyBase {
  id: string;
  label: string;
  endpointId: string;
  models: ProviderModels;
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

// Short enough that a delete or replace made by another server process is seen within a minute.
const CACHE_TTL_MS = 60_000;

interface Cached {
  row: ProviderKeyRow | null;
  registry: Registry | null;
  at: number;
}

type Resolution = { registry: Registry; source: 'own' | 'server' | 'none'; row: ProviderKeyRow | null };

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
    const { source, row } = await this.resolve(user);
    if (source === 'own' || !row) return source;
    return row.trust === 'unlock' ? 'locked' : 'unavailable';
  }

  async summary(user: SessionUser): Promise<ProviderKeySummary | null> {
    const { row } = await this.cached(user.id);
    return row ? summarizeProviderKey(row) : null;
  }

  async unlockRecord(user: SessionUser): Promise<{ keyId: string; wrap: { nonce: string; ciphertext: string } } | null> {
    const { row } = await this.cached(user.id);
    if (row?.trust !== 'unlock') return null;
    return { keyId: row.id, wrap: { nonce: row.nonce.toString('base64'), ciphertext: row.ciphertext.toString('base64') } };
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
      wrapped = { nonce: Buffer.from(input.wrap.nonce, 'base64'), ciphertext: Buffer.from(input.wrap.ciphertext, 'base64') };
      if (wrapped.nonce.length !== 12 || wrapped.ciphertext.length <= 16 || wrapped.ciphertext.length > 528) throw new ProviderKeyInputError('invalid provider key wrap');
      keyHint = input.keyHint;
    }
    this.grants.lock(user.id);
    this.invalidate(user.id);
    await saveProviderKey(this.db, {
      id: input.id,
      userId: user.id,
      label: input.label,
      endpointId: input.endpointId,
      models: input.models,
      trust: input.trust,
      keyHint,
      ...wrapped,
    });
    // An unlock that read the old row while the write ran must not keep its grant.
    this.grants.lock(user.id);
    this.invalidate(user.id);
    const saved = await this.summary(user);
    if (!saved) throw new Error('provider key was not saved');
    return saved;
  }

  async remove(user: SessionUser): Promise<boolean> {
    this.grants.lock(user.id);
    this.invalidate(user.id);
    const removed = await deleteProviderKey(this.db, user.id);
    this.grants.lock(user.id);
    this.invalidate(user.id);
    return removed;
  }

  lock(userId: string): boolean {
    return this.grants.lock(userId);
  }

  async unlock(user: SessionUser, handoff: Array<{ keyId: string; key: string }>): Promise<ProviderKeyGrant[]> {
    const [first, ...rest] = handoff;
    if (!first) return [];
    const before = this.generation.get(user.id) ?? 0;
    const { row } = await this.cached(user.id);
    // A save or delete during the read means `row` may be gone; granting it would outlive the change.
    const stale = (this.generation.get(user.id) ?? 0) !== before;
    if (stale || rest.length || row?.trust !== 'unlock' || row.id !== first.keyId) throw new ProviderKeyForbiddenError();
    // Keyed by version so a same-id replace in another process cannot inherit this plaintext.
    return [{ ...this.grants.unlock(user.id, row.version, first.key), keyId: row.id }];
  }

  async test(
    user: SessionUser,
    input: { endpointId: string; model: string; key: string },
  ): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    const probe = new MeteredRegistry(
      new ProviderRegistry(byokProvider(endpoint, input.model, () => input.key, this.fetcher)),
      this.sink(user.id, undefined, 'own'),
    ).get('probe');
    try {
      const result = await probe.complete({
        role: 'probe',
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        maxTokens: 8,
        temperature: 0,
      });
      return { ok: true, model: result.model };
    } catch (err) {
      return { ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err), [input.key]) };
    }
  }

  async models(input: { endpointId: string; key: string }): Promise<string[]> {
    const endpoint = byokEndpoint(input.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    return listModels(endpoint, input.key, this.fetcher);
  }

  /**
   * List models for the caller's *saved* key — no plaintext in the request.
   *
   * Reuses the same liveness check as `build()`: a sealed key reads from the
   * server secret, an unlock key from the current grant. If the key was
   * deleted/replaced or the grant expired, this throws `ProviderKeyLockedError`
   * rather than silently falling back to the server provider.
   */
  async modelsForSaved(user: SessionUser): Promise<string[]> {
    const { row } = await this.cached(user.id);
    if (!row) return [];
    const registry = this.build(user.id, row);
    if (!registry) throw new ProviderKeyInputError('your saved key cannot be used on this server right now');
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    return listModels(endpoint, this.secretFor(user.id, row), this.fetcher);
  }

  /**
   * Probe the caller's *saved* key against a model — no plaintext in the request.
   */
  async testForSaved(user: SessionUser, model: string): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    const { row } = await this.cached(user.id);
    if (!row) throw new ProviderKeyInputError('no saved provider key to test');
    const registry = this.build(user.id, row);
    if (!registry) throw new ProviderKeyInputError('your saved key cannot be used on this server right now');
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) throw new ProviderKeyInputError('that provider endpoint is not allowed');
    const probe = new MeteredRegistry(
      new ProviderRegistry(byokProvider(endpoint, model, () => this.secretFor(user.id, row), this.fetcher)),
      this.sink(user.id, undefined, 'own'),
    ).get('probe');
    try {
      const result = await probe.complete({
        role: 'probe',
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        maxTokens: 8,
        temperature: 0,
      });
      return { ok: true, model: result.model };
    } catch (err) {
      return { ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err), []) };
    }
  }

  /** The live secret for a cached row, or throws if the key is no longer usable. */
  private secretFor(userId: string, row: ProviderKeyRow): string {
    if (this.cache.get(userId)?.row?.version !== row.version) throw new ProviderKeyLockedError('your provider key was removed or replaced');
    if (row.trust === 'sealed') {
      if (!this.secretsKey) throw new ProviderKeyLockedError('sealed provider keys are disabled on this server');
      return openProviderKey(this.secretsKey, userId, row.id, row);
    }
    const key = this.grants.get(userId, row.version);
    if (key === null) throw new ProviderKeyLockedError();
    return key;
  }

  takeKeyCall(userId: string): number | null {
    return this.keyCalls.take(userId);
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
  }

  private async resolve(user: SessionUser | null, storyId?: string): Promise<Resolution> {
    if (!user) return { registry: this.server, source: 'server', row: null };
    const own = await this.cached(user.id);
    if (own.row && own.registry && this.usable(user.id, own.row)) {
      return { registry: new MeteredRegistry(own.registry, this.sink(user.id, storyId, 'own', own.row.id)), source: 'own', row: own.row };
    }
    if (this.share() || user.isAdmin) {
      return { registry: new MeteredRegistry(this.server, this.sink(user.id, storyId, 'server')), source: 'server', row: own.row };
    }
    return { registry: new ProviderRegistry(new MockProvider()), source: 'none', row: own.row };
  }

  private usable(userId: string, row: ProviderKeyRow): boolean {
    return row.trust === 'sealed' ? this.secretsKey !== null : this.grants.get(userId, row.version) !== null;
  }

  private async cached(userId: string): Promise<Cached> {
    // An expired entry stays until the refill replaces it, so in-flight liveness checks keep passing meanwhile.
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit;
    const before = this.generation.get(userId) ?? 0;
    const row = await providerKeyFor(this.db, userId);
    const entry: Cached = { row, registry: row ? this.build(userId, row) : null, at: this.now() };
    // A save or delete that landed during this read wins; caching the older row would outlive it.
    // ponytail: one entry per user, evicted only by save/delete; add an LRU if the user count makes it matter.
    if ((this.generation.get(userId) ?? 0) === before) this.cache.set(userId, entry);
    return entry;
  }

  private build(userId: string, row: ProviderKeyRow): Registry | null {
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) return null;
    if (row.trust === 'sealed' && this.secretsKey) {
      // A wrong FABULIST_SECRETS_KEY must read as unavailable, not as 'own' with every call failing.
      try {
        openProviderKey(this.secretsKey, userId, row.id, row);
      } catch {
        return null;
      }
    }
    const provider = (model: string) => byokProvider(endpoint, model, () => this.secretFor(userId, row), this.fetcher);
    const registry = new ProviderRegistry(provider(row.models.narrate));
    const mechanic = provider(row.models.mechanics ?? row.models.narrate);
    for (const role of MECHANIC_ROLES) registry.route(role, mechanic);
    const extractor = provider(row.models.extract ?? row.models.narrate);
    registry.route('extract', extractor);
    registry.route('passb', extractor);
    return registry;
  }

  private sink(userId: string, storyId: string | undefined, keySource: KeySource, keyId?: string): UsageSink {
    return (call) => recordUsage(this.db, { userId, storyId: storyId ?? null, keySource, ...call, keyId });
  }
}
