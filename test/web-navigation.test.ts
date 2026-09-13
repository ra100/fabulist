import assert from 'node:assert/strict';
import test from 'node:test';
import { appTabs, pathForTab, tabForPath } from '../web/src/navigation.ts';

test('browser routes select every app tab and preserve the legacy book home', () => {
  assert.equal(tabForPath('/'), 'book');
  for (const tab of appTabs) {
    assert.equal(tabForPath(pathForTab(tab)), tab);
    assert.equal(tabForPath(`${pathForTab(tab)}/`), tab);
  }
  assert.equal(tabForPath('/not-a-page'), 'book');
});
