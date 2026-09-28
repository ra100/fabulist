import assert from 'node:assert/strict';
import test from 'node:test';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';

test('provider grants are memory-only, scoped by user/key/version, and expire', () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const store = new EphemeralProviderKeyStore(() => now, 1_000);
  const grant = store.unlock('user:alice', 'key-1', 'version-1', 'sk-alice-0123456789');
  assert.deepEqual(grant, { keyId: 'key-1', expiresAt: '2026-09-26T10:00:01.000Z' });
  assert.equal(store.get('user:alice', 'key-1', 'version-1'), 'sk-alice-0123456789');
  assert.equal(store.get('user:alice', 'key-1', 'version-2'), null, 'replacement rows do not inherit the old grant');
  assert.equal(store.get('user:alice', 'key-2', 'version-1'), null, 'a different key id is not unlocked');
  assert.equal(store.get('user:bob', 'key-1', 'version-1'), null, 'another user never reads it');
  now += 1_000;
  assert.equal(store.get('user:alice', 'key-1', 'version-1'), null);
  assert.deepEqual(store.list('user:alice'), []);
});

test('multiple provider grants coexist and can be locked independently or together', () => {
  const store = new EphemeralProviderKeyStore();
  store.unlock('user:alice', 'key-1', 'v1', 'sk-alice-0123456789');
  store.unlock('user:alice', 'key-2', 'v2', 'sk-alice-new-0123456789');
  store.unlock('user:bob', 'key-3', 'v3', 'sk-bob-0123456789');
  assert.equal(store.get('user:alice', 'key-1', 'v1'), 'sk-alice-0123456789');
  assert.equal(store.get('user:alice', 'key-2', 'v2'), 'sk-alice-new-0123456789');
  assert.equal(store.lock('user:alice', 'key-1'), true);
  assert.equal(store.lock('user:alice', 'key-1'), false);
  assert.equal(store.get('user:alice', 'key-1', 'v1'), null);
  assert.equal(store.get('user:alice', 'key-2', 'v2'), 'sk-alice-new-0123456789');
  assert.equal(store.lock('user:alice'), true);
  assert.equal(store.lock('user:alice'), false);
  assert.equal(store.get('user:alice', 'key-2', 'v2'), null);
  assert.equal(store.get('user:bob', 'key-3', 'v3'), 'sk-bob-0123456789');
  assert.throws(() => store.unlock('user:bob', 'key-3', 'v3', ''), /invalid provider key/);
});
