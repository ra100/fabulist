import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearTimelineRefreshState } from '../web/src/timeline-refresh-state.ts';

test('refresh starts with no prior timeline or accordion state', () => {
  const cleared = clearTimelineRefreshState();

  assert.equal(cleared.timeline, null);
  assert.deepEqual(cleared.reveal, new Set<number>());
});
