import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoryActivity } from '../src/application/activity.ts';

test('story activity tracks concurrent stories without losing aggregate compatibility', () => {
  const activity = new StoryActivity();
  const storyA = activity.begin();
  storyA.scope('story:a');
  const storyB = activity.begin();
  storyB.scope('story:b');

  assert.equal(activity.busy, true);
  assert.equal(activity.isBusy('story:a'), true);
  assert.equal(activity.isBusy('story:b'), true);

  storyA.end();
  assert.equal(activity.busy, true, 'one completion must not hide another active story');
  assert.equal(activity.isBusy('story:a'), false);
  assert.equal(activity.isBusy('story:b'), true);

  storyB.end();
  assert.equal(activity.busy, false);
});

test('story activity counts overlapping work on the same story', () => {
  const activity = new StoryActivity();
  const first = activity.begin();
  const second = activity.begin();
  first.scope('story:a');
  second.scope('story:a');

  assert.equal(activity.activeCount('story:a'), 2);
  first.end();
  assert.equal(activity.isBusy('story:a'), true);
  assert.equal(activity.activeCount('story:a'), 1);
  second.end();
  assert.equal(activity.isBusy('story:a'), false);
});
