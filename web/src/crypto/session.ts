import { useSyncExternalStore } from 'react';

/**
 * The master key from the last private-storage unlock, held in this tab only.
 *
 * One passcode unlocks both stories and passphrase-protected provider keys, so
 * the provider panel reuses this instead of asking for the passcode again. The
 * handle is a non-extractable CryptoKey: it can encrypt and decrypt, but its
 * bytes cannot be read back. It is dropped when the server grant it was issued
 * with expires, on lock, and on reload.
 */
export interface UnlockedSession {
  userId: string;
  masterKey: CryptoKey;
  expiresAt: number;
}

let current: UnlockedSession | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Remember the unlocked master key until `expiresAt` (epoch ms); a past or invalid expiry stores nothing. */
export function rememberMasterKey(userId: string, masterKey: CryptoKey, expiresAt: number): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const ttl = expiresAt - Date.now();
  if (!Number.isFinite(ttl) || ttl <= 0) {
    forgetMasterKey();
    return;
  }
  current = { userId, masterKey, expiresAt };
  // setTimeout overflows past ~24.8 days; grants are hours, but clamp anyway.
  timer = setTimeout(forgetMasterKey, Math.min(ttl, 2_147_483_647));
  emit();
}

export function forgetMasterKey(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!current) return;
  current = null;
  emit();
}

/** The unlocked master key for this user, or null when private storage is locked in this tab. */
export function unlockedMasterKey(userId: string): CryptoKey | null {
  // Pure, because React reads it during render; the timer does the forgetting.
  if (!current || current.userId !== userId || current.expiresAt <= Date.now()) return null;
  return current.masterKey;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUnlockedMasterKey(userId: string): CryptoKey | null {
  return useSyncExternalStore(subscribe, () => unlockedMasterKey(userId));
}

/** The earliest expiry among the grants an unlock returned, in epoch ms, or NaN when there are none. */
export function earliestGrantExpiry(grants: Array<{ expiresAt: string }>): number {
  const times = grants.map(({ expiresAt }) => Date.parse(expiresAt)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : Number.NaN;
}
