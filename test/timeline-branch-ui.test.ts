import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBranchFromTimelineScene } from '../web/src/timeline-branching.ts';

test('timeline branch affordance is only offered for prior scenes', () => {
  const timeline = { currentScene: 3 };

  assert.equal(canBranchFromTimelineScene(timeline, { scene: 1 }), true);
  assert.equal(canBranchFromTimelineScene(timeline, { scene: 2 }), true);
  assert.equal(canBranchFromTimelineScene(timeline, { scene: 3 }), false);
  assert.equal(canBranchFromTimelineScene(timeline, { scene: 4 }), false);
});
