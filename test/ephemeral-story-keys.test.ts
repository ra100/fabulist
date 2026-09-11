import assert from 'node:assert/strict';
import test from 'node:test';
import { EphemeralStoryKeyStore } from '../src/auth/ephemeral-story-keys.ts';

test('a story key is memory-only, user-scoped, and expires', () => {
  let now = Date.parse('2026-09-11T19:00:00.000Z');
  const store = new EphemeralStoryKeyStore(() => now, 1_000);
  const original = Buffer.alloc(32, 7);
  const grant = store.unlock('user-a', [{ storyId: 'story-a', key: original }])[0];

  assert.equal(grant?.storyId, 'story-a');
  assert.deepEqual(store.list('user-a').map((item) => item.storyId), ['story-a']);
  assert.equal(store.get('user-b', 'story-a'), null);
  const read = store.get('user-a', 'story-a');
  assert.deepEqual(read, original);
  read?.fill(0);
  assert.deepEqual(store.get('user-a', 'story-a'), original);

  now += 1_000;
  assert.equal(store.get('user-a', 'story-a'), null);
  assert.deepEqual(store.list('user-a'), []);
});

test('locking one story or an entire user removes grants without affecting another user', () => {
  const store = new EphemeralStoryKeyStore();
  store.unlock('user-a', [
    { storyId: 'story-a', key: Buffer.alloc(32, 1) },
    { storyId: 'story-b', key: Buffer.alloc(32, 2) },
  ]);
  store.unlock('user-b', [{ storyId: 'story-c', key: Buffer.alloc(32, 3) }]);

  assert.deepEqual(store.lock('user-a', 'story-a'), ['story-a']);
  assert.equal(store.get('user-a', 'story-a'), null);
  assert.ok(store.get('user-a', 'story-b'));
  assert.deepEqual(store.lock('user-a'), ['story-b']);
  assert.ok(store.get('user-b', 'story-c'));
});

test('the key store rejects keys that are not 256 bits', () => {
  const store = new EphemeralStoryKeyStore();
  assert.throws(
    () => store.unlock('user-a', [{ storyId: 'story-a', key: Buffer.alloc(31) }]),
    /invalid private-story key/,
  );
});
