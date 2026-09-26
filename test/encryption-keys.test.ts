import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEncryptionEnrollment,
  eraseUnlockedStoryKeys,
  providerKeyHandoff,
  storyKeyHandoff,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  wrapProviderKey,
} from '../web/src/crypto/keys.ts';

const userId = 'user_private_test';
const storyIds = ['story-one', 'story-two'];
const passphrase = 'a durable private passphrase';

test('browser-generated passphrase and recovery wraps unlock identical story keys', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  assert.equal(enrollment.userKey.passphraseKdf, 'pbkdf2-sha256');
  assert.equal(enrollment.userKey.passphraseKdfParams.iterations, 600_000);
  assert.notEqual(enrollment.recoveryCode, passphrase);
  assert.equal(enrollment.storyKeys.length, storyIds.length);

  const byPassphrase = await unlockWithPassphrase(
    userId,
    enrollment.userKey,
    enrollment.storyKeys,
    passphrase,
  );
  const byRecovery = await unlockWithRecoveryCode(
    userId,
    enrollment.userKey,
    enrollment.storyKeys,
    enrollment.recoveryCode,
  );

  assert.deepEqual([...byPassphrase.masterKey], [...byRecovery.masterKey]);
  for (const storyId of storyIds) {
    assert.deepEqual(
      [...(byPassphrase.storyKeys.get(storyId) ?? [])],
      [...(byRecovery.storyKeys.get(storyId) ?? [])],
    );
  }
  const handoff = storyKeyHandoff(byPassphrase.storyKeys);
  assert.deepEqual(handoff.map((item) => item.storyId), storyIds);
  assert.ok(handoff.every((item) => Buffer.from(item.key, 'base64').length === 32));
  eraseUnlockedStoryKeys(byPassphrase);
  assert.equal(byPassphrase.storyKeys.size, 0);
});

test('a wrong passphrase, recovery code, or authenticated context cannot decrypt a master key', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  await assert.rejects(
    unlockWithPassphrase(userId, enrollment.userKey, enrollment.storyKeys, 'a wrong private passphrase'),
    /incorrect passphrase or recovery code/,
  );
  await assert.rejects(
    unlockWithRecoveryCode(userId, enrollment.userKey, enrollment.storyKeys, `${enrollment.recoveryCode}x`),
    /incorrect passphrase or recovery code/,
  );
  await assert.rejects(
    unlockWithPassphrase('another-user', enrollment.userKey, enrollment.storyKeys, passphrase),
    /incorrect passphrase or recovery code/,
  );
});

test('a malformed key envelope is reported as corruption rather than incorrect credentials', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  const malformed = {
    ...enrollment.userKey,
    passphraseWrap: { ...enrollment.userKey.passphraseWrap, nonce: '' },
  };

  await assert.rejects(
    () => unlockWithPassphrase(userId, malformed, enrollment.storyKeys, passphrase),
    /invalid encrypted-key envelope/,
  );
});

test('a corrupt story key is skipped without blocking healthy private stories', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  const corruptStoryKeys = enrollment.storyKeys.map((storyKey) =>
    storyKey.storyId === 'story-two'
      ? {
          ...storyKey,
          wrap: {
            ...storyKey.wrap,
            ciphertext: `${storyKey.wrap.ciphertext.slice(0, -1)}${storyKey.wrap.ciphertext.endsWith('A') ? 'B' : 'A'}`,
          },
        }
      : storyKey,
  );

  const unlocked = await unlockWithPassphrase(userId, enrollment.userKey, corruptStoryKeys, passphrase);

  assert.deepEqual([...unlocked.storyKeys.keys()], ['story-one']);
  assert.deepEqual(unlocked.failedStoryKeys.map((item) => item.storyId), ['story-two']);
  assert.match(unlocked.failedStoryKeys[0]?.error ?? '', /incorrect passphrase or recovery code/);
});

test('a provider key wrap round-trips only for the same user and key id', async () => {
  const enrollment = await createEncryptionEnrollment(userId, passphrase, storyIds);
  const unlocked = await unlockWithPassphrase(userId, enrollment.userKey, [], passphrase);
  const apiKey = 'sk-live-provider-secret-0123';
  const wrap = await wrapProviderKey(userId, unlocked.masterKey, 'key-1', apiKey);
  assert.equal(Buffer.from(wrap.ciphertext, 'base64').includes(Buffer.from(apiKey)), false);
  assert.deepEqual(await providerKeyHandoff(userId, unlocked.masterKey, [{ keyId: 'key-1', wrap }]), [
    { keyId: 'key-1', key: apiKey },
  ]);
  assert.deepEqual(await providerKeyHandoff(userId, unlocked.masterKey, [{ keyId: 'key-2', wrap }]), []);
  assert.deepEqual(await providerKeyHandoff('another-user', unlocked.masterKey, [{ keyId: 'key-1', wrap }]), []);
  const bad = await wrapProviderKey(userId, unlocked.masterKey, 'key-3', ' sk-leading-space');
  assert.deepEqual(await providerKeyHandoff(userId, unlocked.masterKey, [{ keyId: 'key-3', wrap: bad }]), [], 'a key the server rejects is not handed off');
  eraseUnlockedStoryKeys(unlocked);
});
