import type { Thread } from './types.ts';

/** Active story threads are a scarce budget, not an unlimited hook list. */
export const ACTIVE_THREAD_BUDGET = 7;

/** Match exact titles despite case, punctuation, spacing, or Unicode form. */
export function threadTitleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Keep one representative for duplicate open titles; closed history remains visible. */
export function dedupeOpenThreads(threads: Thread[], limit = Number.POSITIVE_INFINITY): Thread[] {
  const seen = new Set<string>();
  const distinct = threads.filter((thread) => {
    if (thread.status !== 'open') return true;
    const key = threadTitleKey(thread.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return distinct.slice(0, limit);
}

/** Merge a repeated opening into its existing live thread without losing progress. */
export function mergeOpenThread(
  existing: Thread,
  incoming: {
    stakes?: string;
    tension?: number;
    tensionDelta?: number;
    parties?: Thread['parties'];
    resolutions?: Thread['resolutions'];
    status?: Thread['status'];
  },
): Omit<Thread, 'id'> {
  const tension = Math.max(existing.tension, incoming.tension ?? existing.tension) + (incoming.tensionDelta ?? 0);
  return {
    title: existing.title,
    stakes: existing.stakes.trim() || incoming.stakes?.trim() || '',
    tension: Math.max(0, Math.min(1, tension)),
    parties: [...new Set([...existing.parties, ...(incoming.parties ?? [])])],
    resolutions: [...new Set([...existing.resolutions, ...(incoming.resolutions ?? [])])],
    status: incoming.status ?? existing.status,
    createdScene: existing.createdScene,
  };
}
