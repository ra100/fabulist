import type { SessionUser } from '../auth/config.ts';
import { EphemeralProviderKeyStore, type ProviderKeyGrant } from '../auth/ephemeral-provider-keys.ts';
import {
  deleteProviderKey,
  providerKeyFor,
  saveProviderKey,
  summarizeProviderKey,
  touchProviderKey,
  type ProviderKeyRow,
  type ProviderKeySummary,
  type ProviderModels,
} from '../auth/provider-keys-pg.ts';
import { openProviderKey, sealProviderKey } from '../crypto/provider-secret.ts';
import type { Queryable } from '../db/pg.ts';
import { RateLimiter } from '../server/rate-limit.ts';
import { recordUsage, type KeySource } from '../store/usage-pg.ts';
import { byokEndpoint, byokProvider, listModels, ProviderKeyLockedError, scrubSecrets } from './byok.ts';
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
}

interface Cached {
  row: ProviderKeyRow | null;
  registry: Registry | null;
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

  constructor(opts: ProviderResolverOptions) {
    this.db = opts.db;
    this.server = opts.server;
    this.share = opts.shareServerProvider;
    this.secretsKey = opts.secretsKey;
    this.grants = opts.grants ?? new EphemeralProviderKeyStore();
    this.fetcher = opts.fetcher;
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
      if (wrapped.nonce.length !== 12 || wrapped.ciphertext.length <= 16) throw new ProviderKeyInputError('invalid provider key wrap');
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
    this.invalidate(user.id);
    const saved = await this.summary(user);
    if (!saved) throw new Error('provider key was not saved');
    return saved;
  }

  async remove(user: SessionUser): Promise<boolean> {
    this.grants.lock(user.id);
    this.invalidate(user.id);
    const removed = await deleteProviderKey(this.db, user.id);
    this.invalidate(user.id);
    return removed;
  }

  lock(userId: string): boolean {
    return this.grants.lock(userId);
  }

  async unlock(user: SessionUser, handoff: Array<{ keyId: string; key: string }>): Promise<ProviderKeyGrant[]> {
    const [first, ...rest] = handoff;
    if (!first) return [];
    const { row } = await this.cached(user.id);
    if (rest.length || row?.trust !== 'unlock' || row.id !== first.keyId) throw new ProviderKeyForbiddenError();
    return [this.grants.unlock(user.id, row.id, first.key)];
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
    return row.trust === 'sealed' ? this.secretsKey !== null : this.grants.get(userId, row.id) !== null;
  }

  private async cached(userId: string): Promise<Cached> {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    const before = this.generation.get(userId) ?? 0;
    const row = await providerKeyFor(this.db, userId);
    const entry: Cached = { row, registry: row ? this.build(userId, row) : null };
    // A save or delete that landed during this read wins; caching the older row would outlive it.
    // ponytail: one entry per user, never evicted; add an LRU if the user count makes it matter.
    if ((this.generation.get(userId) ?? 0) === before) this.cache.set(userId, entry);
    return entry;
  }

  private build(userId: string, row: ProviderKeyRow): Registry | null {
    const endpoint = byokEndpoint(row.endpointId);
    if (!endpoint) return null;
    const secret = (): string => {
      // The cache entry is the liveness check, so a key deleted or replaced mid-turn is never sent again.
      if (this.cache.get(userId)?.row?.id !== row.id) throw new ProviderKeyLockedError('your provider key was removed or replaced');
      if (row.trust === 'sealed') {
        if (!this.secretsKey) throw new ProviderKeyLockedError('sealed provider keys are disabled on this server');
        return openProviderKey(this.secretsKey, userId, row.id, row);
      }
      const key = this.grants.get(userId, row.id);
      if (key === null) throw new ProviderKeyLockedError();
      return key;
    };
    const provider = (model: string) => byokProvider(endpoint, model, secret, this.fetcher);
    const registry = new ProviderRegistry(provider(row.models.narrate));
    const mechanic = provider(row.models.mechanics ?? row.models.narrate);
    for (const role of MECHANIC_ROLES) registry.route(role, mechanic);
    const extractor = provider(row.models.extract ?? row.models.narrate);
    registry.route('extract', extractor);
    registry.route('passb', extractor);
    return registry;
  }

  private sink(userId: string, storyId: string | undefined, keySource: KeySource, keyId?: string): UsageSink {
    return async (call) => {
      await recordUsage(this.db, { userId, storyId: storyId ?? null, keySource, ...call });
      if (keyId) await touchProviderKey(this.db, userId, keyId);
    };
  }
}
