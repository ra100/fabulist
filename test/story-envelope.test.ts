import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptStoryValue, encryptStoryValue } from '../src/crypto/story-envelope.ts';

const key = Buffer.alloc(32, 42);
const context = { storyId: 'story-private', table: 'turns', recordId: 'turn-1', field: 'book_prose' };
const prose = 'A private sentence that must not survive as readable storage.';

test('a story value round-trips through authenticated encryption without preserving plaintext', () => {
  const envelope = encryptStoryValue(key, context, { prose, scene: 4 });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.ciphertext.includes(Buffer.from(prose)), false);
  assert.deepEqual(decryptStoryValue(key, context, envelope), { prose, scene: 4 });
});

test('story-value ciphertext fails closed with a wrong key or authenticated context', () => {
  const envelope = encryptStoryValue(key, context, prose);
  assert.throws(
    () => decryptStoryValue(Buffer.alloc(32, 9), context, envelope),
    /cannot be decrypted/,
  );
  assert.throws(
    () => decryptStoryValue(key, { ...context, field: 'raw_input' }, envelope),
    /cannot be decrypted/,
  );
  assert.throws(
    () => decryptStoryValue(key, { ...context, storyId: 'story-other' }, envelope),
    /cannot be decrypted/,
  );
});
