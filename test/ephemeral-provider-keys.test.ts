import assert from 'node:assert/strict';
import test from 'node:test';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';

test('a provider key grant is memory-only, user- and key-scoped, and expires', () => {
  let now = Date.parse('2026-09-26T10:00:00.000Z');
  const store = new EphemeralProviderKeyStore(() => now, 1_000);
  const grant = store.unlock('user:alice', 'key-1', 'sk-alice-0123456789');
  assert.deepEqual(grant, { keyId: 'key-1', expiresAt: '2026-09-26T10:00:01.000Z' });
  assert.equal(store.get('user:alice', 'key-1'), 'sk-alice-0123456789');
  assert.equal(store.get('user:alice', 'key-2'), null, 'a different key id is not unlocked');
  assert.equal(store.get('user:bob', 'key-1'), null, 'another user never reads it');
  now += 1_000;
  assert.equal(store.get('user:alice', 'key-1'), null);
  assert.deepEqual(store.list('user:alice'), []);
});

test("locking removes only that user's grant and a new unlock replaces the old one", () => {
  const store = new EphemeralProviderKeyStore();
  store.unlock('user:alice', 'key-1', 'sk-alice-0123456789');
  store.unlock('user:alice', 'key-2', 'sk-alice-new-0123456789');
  store.unlock('user:bob', 'key-3', 'sk-bob-0123456789');
  assert.equal(store.get('user:alice', 'key-1'), null);
  assert.equal(store.lock('user:alice'), true);
  assert.equal(store.lock('user:alice'), false);
  assert.equal(store.get('user:alice', 'key-2'), null);
  assert.equal(store.get('user:bob', 'key-3'), 'sk-bob-0123456789');
  assert.throws(() => store.unlock('user:bob', 'key-3', ''), /invalid provider key/);
});
