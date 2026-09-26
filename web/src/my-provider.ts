import type { ProviderKeySummary, ProviderModels, ProviderStatus } from './api.ts';

export function providerStatusLine(status: ProviderStatus | undefined): string {
  switch (status) {
    case 'own':
      return 'Using your key.';
    case 'locked':
      return 'Locked — unlock private storage to use your key.';
    case 'unavailable':
      return 'Your saved key cannot be used on this server right now.';
    case 'server':
      return 'Using the server provider.';
    case 'none':
      return 'No provider — your agent keeps the world.';
    default:
      return 'Checking…';
  }
}

export const TRUST_COPY = {
  unlock:
    'Only you can decrypt it. It works while private storage is unlocked (up to 4 hours); when it locks, MCP and background jobs stop using it. Needs private storage.',
  sealed:
    'The server encrypts it with its own secret. Always usable, including MCP and background jobs, but whoever runs this server can decrypt it.',
} as const;

/** The protection a save will use: an unenrolled user cannot pick unlock, and null means neither mode is open. */
export function effectiveTrust(
  chosen: 'unlock' | 'sealed',
  enrolled: boolean,
  sealedAvailable: boolean,
): 'unlock' | 'sealed' | null {
  if (enrolled) return chosen;
  return sealedAvailable ? 'sealed' : null;
}

/** The note after a saved unlock-mode key: the handoff can fail (e.g. the key-call limit) without undoing the save. */
export async function unlockHandoffNote(handoff: () => Promise<unknown>): Promise<string> {
  try {
    await handoff();
    return 'saved';
  } catch (e) {
    return `saved — key stays locked until you next unlock: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function keyHintFor(apiKey: string): string {
  return apiKey.slice(-4);
}

/**
 * Permanent info line under a saved key. States that the narrate/mechanics/
 * extract fields shown here are authoritative — they are what your key is
 * actually used for — so editing them and saving updates that, and reloading
 * the page restores them from the saved row.
 */
export function savedKeyInfo(key: ProviderKeySummary): string {
  const models = key.models as ProviderModels;
  const parts = [models.narrate, models.mechanics, models.extract].filter(
    (m): m is string => typeof m === 'string' && m.trim().length > 0,
  );
  return `These model settings are what your key is used for (${parts.length} role${parts.length === 1 ? '' : 's'} set). Edit them and save to change it; reloading this page restores them from your saved key.`;
}
