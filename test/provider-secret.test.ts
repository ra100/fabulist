import assert from 'node:assert/strict';
import test from 'node:test';
import { openProviderKey, sealProviderKey, secretsKeyFromEnv } from '../src/crypto/provider-secret.ts';

const secret = Buffer.alloc(32, 7);
const apiKey = 'sk-test-0123456789abcdefghij';

test('a sealed provider key round-trips without its plaintext in the ciphertext', () => {
  const sealed = sealProviderKey(secret, 'user:alice', 'key-1', apiKey);
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.ciphertext.includes(Buffer.from(apiKey)), false);
  assert.equal(openProviderKey(secret, 'user:alice', 'key-1', sealed), apiKey);
});

test('a sealed key is bound to its user, key id and server secret', () => {
  const sealed = sealProviderKey(secret, 'user:alice', 'key-1', apiKey);
  for (const [s, user, id] of [
    [Buffer.alloc(32, 8), 'user:alice', 'key-1'],
    [secret, 'user:bob', 'key-1'],
    [secret, 'user:alice', 'key-2'],
  ] as const) {
    assert.throws(() => openProviderKey(s, user, id, sealed), /sealed provider key cannot be decrypted/);
  }
});

test('FABULIST_SECRETS_KEY unset disables sealing; malformed or wrong length fails loudly', () => {
  assert.equal(secretsKeyFromEnv({}), null);
  assert.equal(secretsKeyFromEnv({ FABULIST_SECRETS_KEY: '  ' }), null);
  assert.deepEqual(secretsKeyFromEnv({ FABULIST_SECRETS_KEY: secret.toString('base64') }), secret);
  assert.throws(
    () => secretsKeyFromEnv({ FABULIST_SECRETS_KEY: Buffer.alloc(16, 1).toString('base64') }),
    /must decode to 32 bytes, got 16/,
  );
  assert.throws(() => secretsKeyFromEnv({ FABULIST_SECRETS_KEY: 'not base64!' }), /must be base64/);
});
