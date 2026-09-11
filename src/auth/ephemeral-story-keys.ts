const KEY_BYTES = 32;
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export interface UnlockedStoryKey {
  storyId: string;
  key: Buffer;
}

export interface StoryKeyGrant {
  storyId: string;
  expiresAt: string;
}

interface Grant extends StoryKeyGrant {
  key: Buffer;
  expiresAtMs: number;
}

/**
 * Process-memory-only story-key grants.
 *
 * This is intentionally not a session, cache, database record, cookie, or
 * loggable token. A restart or expiration makes encrypted stories unavailable
 * until their owner unlocks them again in the browser. The short-lived grant
 * is what lets the API and authenticated MCP connection process an encrypted
 * story without ever retaining its key durably.
 */
export class EphemeralStoryKeyStore {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = DEFAULT_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  unlock(userId: string, keys: UnlockedStoryKey[]): StoryKeyGrant[] {
    this.prune();
    const expiresAtMs = this.now() + this.ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    for (const { storyId, key } of keys) {
      if (!storyId || key.length !== KEY_BYTES) throw new Error('invalid private-story key');
      this.grants.set(this.id(userId, storyId), { storyId, key: Buffer.from(key), expiresAt, expiresAtMs });
    }
    return keys.map(({ storyId }) => ({ storyId, expiresAt }));
  }

  get(userId: string, storyId: string): Buffer | null {
    this.prune();
    const grant = this.grants.get(this.id(userId, storyId));
    return grant ? Buffer.from(grant.key) : null;
  }

  list(userId: string): StoryKeyGrant[] {
    this.prune();
    const prefix = `${userId}\u0000`;
    return [...this.grants]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, grant]) => ({ storyId: grant.storyId, expiresAt: grant.expiresAt }))
      .sort((a, b) => a.storyId.localeCompare(b.storyId));
  }

  lock(userId: string, storyId?: string): string[] {
    this.prune();
    if (storyId) {
      const id = this.id(userId, storyId);
      const grant = this.grants.get(id);
      if (!grant) return [];
      grant.key.fill(0);
      this.grants.delete(id);
      return [storyId];
    }
    const prefix = `${userId}\u0000`;
    const removed: string[] = [];
    for (const [id, grant] of this.grants) {
      if (id.startsWith(prefix)) {
        grant.key.fill(0);
        this.grants.delete(id);
        removed.push(grant.storyId);
      }
    }
    return removed.sort();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, grant] of this.grants) {
      if (grant.expiresAtMs <= now) {
        grant.key.fill(0);
        this.grants.delete(id);
      }
    }
  }

  private id(userId: string, storyId: string): string {
    return `${userId}\u0000${storyId}`;
  }
}
