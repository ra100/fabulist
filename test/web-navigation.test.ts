import assert from 'node:assert/strict';
import test from 'node:test';
import { appTabs, pathForTab, primaryMobileTabs, secondaryMobileTabs, tabForPath } from '../web/src/navigation.ts';

test('browser routes select every app tab and preserve the legacy book home', () => {
  assert.equal(tabForPath('/'), 'book');
  for (const tab of appTabs) {
    assert.equal(tabForPath(pathForTab(tab)), tab);
    assert.equal(tabForPath(`${pathForTab(tab)}/`), tab);
  }
  assert.equal(tabForPath('/not-a-page'), 'book');
});

test('the phone bottom bar reaches every tab, each exactly once, in at most five slots', () => {
  const reachable = [...primaryMobileTabs, ...secondaryMobileTabs];
  assert.deepEqual([...reachable].sort(), [...appTabs].sort());
  assert.equal(new Set(reachable).size, appTabs.length);
  // four destinations plus "more"
  assert.ok(primaryMobileTabs.length + 1 <= 5);
  assert.equal(primaryMobileTabs[0], 'book');
});
