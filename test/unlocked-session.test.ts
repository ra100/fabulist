import assert from 'node:assert/strict';
import test from 'node:test';
import {
  earliestGrantExpiry,
  forgetMasterKey,
  rememberMasterKey,
  unlockedMasterKey,
} from '../web/src/crypto/session.ts';

async function aKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

test('the unlocked master key is available only to its user and only until lock', async () => {
  const key = await aKey();
  rememberMasterKey('user-a', key, Date.now() + 60_000);
  assert.equal(unlockedMasterKey('user-a'), key);
  assert.equal(unlockedMasterKey('user-b'), null);
  forgetMasterKey();
  assert.equal(unlockedMasterKey('user-a'), null);
});

test('the unlocked master key expires with its grant', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  rememberMasterKey('user-a', await aKey(), 1_000 + 5_000);
  assert.ok(unlockedMasterKey('user-a'));
  t.mock.timers.tick(5_000);
  assert.equal(unlockedMasterKey('user-a'), null);
  forgetMasterKey();
});

test('an unlock with no usable grant expiry remembers nothing', async () => {
  rememberMasterKey('user-a', await aKey(), Number.NaN);
  assert.equal(unlockedMasterKey('user-a'), null);
  rememberMasterKey('user-a', await aKey(), Date.now() - 1);
  assert.equal(unlockedMasterKey('user-a'), null);
});

test('the earliest grant expiry wins and unparseable ones are ignored', () => {
  assert.equal(
    earliestGrantExpiry([
      { expiresAt: '2026-10-01T12:00:00Z' },
      { expiresAt: 'not a date' },
      { expiresAt: '2026-10-01T11:00:00Z' },
    ]),
    Date.parse('2026-10-01T11:00:00Z'),
  );
  assert.ok(Number.isNaN(earliestGrantExpiry([])));
});
