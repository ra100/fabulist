import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEncryptionEnrollment,
  eraseUnlockedStoryKeys,
  storyKeyHandoff,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
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
