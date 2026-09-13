import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryRequestGate } from '../web/src/history-request-gate.ts';

test('the latest timeline refresh wins after the previous effect cleans up', () => {
  const gate = new HistoryRequestGate();
  const oldTimelineRequest = gate.beginRequest();

  gate.invalidate();
  const latestTimelineRequest = gate.beginRequest();

  assert.equal(gate.isCurrent(oldTimelineRequest), false, 'the cleaned-up request cannot update the timeline');
  assert.equal(gate.isCurrent(latestTimelineRequest), true, 'the current refresh can update the timeline');
});

test('a post-mutation top-level state refresh wins over an in-flight poll', () => {
  const gate = new HistoryRequestGate();
  const poll = gate.beginRequest();

  gate.invalidate();
  const authoritativeRefresh = gate.beginRequest();

  assert.equal(gate.isCurrent(poll), false, 'the pre-mutation poll cannot write state or errors');
  assert.equal(gate.isCurrent(authoritativeRefresh), true, 'the post-mutation refresh is authoritative');
});
