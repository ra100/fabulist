import assert from 'node:assert/strict';
import test from 'node:test';
import {
  privateStoragePresentation,
  type PrivateStorageSnapshot,
} from '../web/src/private-storage.ts';

function snapshot(
  enrolled: boolean,
  migration: PrivateStorageSnapshot['migration'],
  unlocked = false,
): PrivateStorageSnapshot {
  return {
    keys: {
      enrolled,
      userKey: null,
      storyKeys: [],
      grants: unlocked
        ? [{ storyId: 'story:one', expiresAt: '2030-01-01T12:00:00.000Z' }]
        : [],
    },
    migration,
  };
}

test('private-storage presentation makes every required action explicit', () => {
  assert.equal(privateStoragePresentation(null, null).state, 'loading');
  assert.equal(privateStoragePresentation(snapshot(false, null), null).state, 'setup');
  assert.equal(privateStoragePresentation(snapshot(true, null), null).label, 'unlock to migrate');
  assert.equal(privateStoragePresentation(snapshot(true, null, true), null).state, 'action');
  assert.equal(
    privateStoragePresentation(snapshot(true, { status: 'complete', error: null, blocklist_done: true }), null).state,
    'locked',
  );
  assert.equal(
    privateStoragePresentation(
      snapshot(true, { status: 'complete', error: null, blocklist_done: true }, true),
      null,
    ).state,
    'unlocked',
  );
  assert.equal(
    privateStoragePresentation(snapshot(true, { status: 'failed', error: 'retry me', blocklist_done: false }), null)
      .detail,
    'retry me',
  );
  assert.equal(privateStoragePresentation(null, 'status unavailable').state, 'error');
});
