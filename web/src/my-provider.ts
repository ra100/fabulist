import type { ProviderStatus } from './api.ts';

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

export function keyHintFor(apiKey: string): string {
  return apiKey.slice(-4);
}
