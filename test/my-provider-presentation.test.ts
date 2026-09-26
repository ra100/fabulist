import assert from 'node:assert/strict';
import test from 'node:test';
import { keyHintFor, providerStatusLine, TRUST_COPY } from '../web/src/my-provider.ts';

test('every provider status reads as a plain-words line', () => {
  assert.equal(providerStatusLine('own'), 'Using your key.');
  assert.match(providerStatusLine('locked'), /unlock private storage/i);
  assert.match(providerStatusLine('unavailable'), /cannot be used/);
  assert.match(providerStatusLine('server'), /server provider/);
  assert.match(providerStatusLine('none'), /agent keeps the world/);
  assert.equal(providerStatusLine(undefined), 'Checking…');
});

test('the trust copy says who can decrypt the key', () => {
  assert.match(TRUST_COPY.unlock, /only you can decrypt/i);
  assert.match(TRUST_COPY.sealed, /runs this server can decrypt/i);
});

test('the key hint is the last four characters only', () => {
  assert.equal(keyHintFor('sk-abcdefgh1234'), '1234');
});
