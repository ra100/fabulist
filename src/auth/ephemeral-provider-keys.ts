const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export interface ProviderKeyGrant {
  keyId: string;
  expiresAt: string;
}

interface Grant extends ProviderKeyGrant {
  version: string;
  key: Buffer;
  expiresAtMs: number;
}

/** Process-memory-only grants for unlock-mode provider keys, with the same lifetime rules as story-key grants. */
export class EphemeralProviderKeyStore {
  private readonly grants = new Map<string, Map<string, Grant>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = DEFAULT_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  unlock(userId: string, keyId: string, version: string, apiKey: string): ProviderKeyGrant {
    this.prune();
    if (!userId || !keyId || !version || !apiKey) throw new Error('invalid provider key');
    const expiresAtMs = this.now() + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const userGrants = this.grants.get(userId) ?? new Map<string, Grant>();
    const previous = userGrants.get(keyId);
    previous?.key.fill(0);
    userGrants.set(keyId, { keyId, version, key: Buffer.from(apiKey, 'utf8'), expiresAt, expiresAtMs });
    this.grants.set(userId, userGrants);
    return { keyId, expiresAt };
  }

  get(userId: string, keyId: string, version: string): string | null {
    this.prune();
    const grant = this.grants.get(userId)?.get(keyId);
    return grant && grant.version === version ? grant.key.toString('utf8') : null;
  }

  list(userId: string): ProviderKeyGrant[] {
    this.prune();
    return [...(this.grants.get(userId)?.values() ?? [])].map(({ keyId, expiresAt }) => ({ keyId, expiresAt }));
  }

  lock(userId: string, keyId?: string): boolean {
    const userGrants = this.grants.get(userId);
    if (!userGrants) return false;
    if (keyId !== undefined) {
      const grant = userGrants.get(keyId);
      if (!grant) return false;
      grant.key.fill(0);
      userGrants.delete(keyId);
      if (!userGrants.size) this.grants.delete(userId);
      return true;
    }
    for (const grant of userGrants.values()) grant.key.fill(0);
    this.grants.delete(userId);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [userId, userGrants] of this.grants) {
      for (const [keyId, grant] of userGrants) {
        if (grant.expiresAtMs <= now) {
          grant.key.fill(0);
          userGrants.delete(keyId);
        }
      }
      if (!userGrants.size) this.grants.delete(userId);
    }
  }
}
