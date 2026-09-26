import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { encryptionKeys, invalidateProviderKeyReads, providerKeyKeys } from '../web/src/queries.ts';

test('saving or deleting a provider key invalidates the cached encryption bundle and provider key', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(encryptionKeys.keys, { providerKey: { keyId: 'old' } });
  queryClient.setQueryData(encryptionKeys.migration, { pending: 0 });
  queryClient.setQueryData(providerKeyKeys.all, { key: null });

  invalidateProviderKeyReads(queryClient);

  assert.equal(queryClient.getQueryState(encryptionKeys.keys)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(providerKeyKeys.all)?.isInvalidated, true);
  assert.equal(queryClient.getQueryState(encryptionKeys.migration)?.isInvalidated, false);
});
