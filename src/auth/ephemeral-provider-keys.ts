const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export interface ProviderKeyGrant {
  keyId: string;
  expiresAt: string;
}

interface Grant extends ProviderKeyGrant {
  key: Buffer;
  expiresAtMs: number;
}

/** Process-memory-only grants for unlock-mode provider keys, with the same lifetime rules as story-key grants. */
export class EphemeralProviderKeyStore {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = DEFAULT_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  unlock(userId: string, keyId: string, apiKey: string): ProviderKeyGrant {
    this.prune();
    if (!userId || !keyId || !apiKey) throw new Error('invalid provider key');
    this.lock(userId);
    const expiresAtMs = this.now() + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.grants.set(userId, { keyId, key: Buffer.from(apiKey, 'utf8'), expiresAt, expiresAtMs });
    return { keyId, expiresAt };
  }

  get(userId: string, keyId: string): string | null {
    this.prune();
    const grant = this.grants.get(userId);
    return grant && grant.keyId === keyId ? grant.key.toString('utf8') : null;
  }

  list(userId: string): ProviderKeyGrant[] {
    this.prune();
    const grant = this.grants.get(userId);
    return grant ? [{ keyId: grant.keyId, expiresAt: grant.expiresAt }] : [];
  }

  lock(userId: string): boolean {
    const grant = this.grants.get(userId);
    if (!grant) return false;
    grant.key.fill(0);
    this.grants.delete(userId);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [userId, grant] of this.grants) {
      if (grant.expiresAtMs <= now) {
        grant.key.fill(0);
        this.grants.delete(userId);
      }
    }
  }
}
