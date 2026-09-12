import type { EncryptionKeyBundle, PrivateStoryMigrationStatus } from './api.ts';

export interface PrivateStorageSnapshot {
  keys: EncryptionKeyBundle;
  migration: PrivateStoryMigrationStatus | null;
}

export interface PrivateStoragePresentation {
  state: 'loading' | 'setup' | 'locked' | 'action' | 'unlocked' | 'error';
  label: string;
  detail: string;
}

export function privateStoragePresentation(
  snapshot: PrivateStorageSnapshot | null,
  error: string | null,
): PrivateStoragePresentation {
  if (error) return { state: 'error', label: 'attention needed', detail: error };
  if (!snapshot) return { state: 'loading', label: 'checking…', detail: 'Checking private-storage status.' };
  if (!snapshot.keys.enrolled) {
    return {
      state: 'setup',
      label: 'set up',
      detail: 'Protect existing stories from readable database and filesystem storage.',
    };
  }
  if (snapshot.migration?.status === 'failed') {
    return {
      state: 'error',
      label: 'migration failed',
      detail: snapshot.migration.error ?? 'Unlock every story and resume the migration.',
    };
  }
  if (snapshot.migration?.status !== 'complete') {
    return snapshot.keys.grants.length
      ? {
          state: 'action',
          label: 'ready to migrate',
          detail: 'Your stories are unlocked and ready for verified encryption.',
        }
      : {
          state: 'locked',
          label: 'unlock to migrate',
          detail: 'Unlock every story, then run the verified migration.',
        };
  }
  if (!snapshot.keys.grants.length) {
    return {
      state: 'locked',
      label: 'locked',
      detail: 'Your stories are encrypted at rest. Unlock them to read, write, or use MCP.',
    };
  }
  const expiry = snapshot.keys.grants
    .map(({ expiresAt }) => Date.parse(expiresAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const until = expiry
    ? new Date(expiry).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  return {
    state: 'unlocked',
    label: 'unlocked',
    detail: until
      ? `Encrypted stories are available in this server process until ${until}.`
      : 'Encrypted stories are available in this server process.',
  };
}
