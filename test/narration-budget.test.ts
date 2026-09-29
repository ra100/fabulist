import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultStyleContract } from '../src/domain/types.ts';
import {
  narrationOutputReserve,
  narrationOutputTokenBudget,
  narrationWordRange,
} from '../src/loop/narration-budget.ts';
import { narratorSystem as narratorSystemSqlite } from '../src/loop/roles.ts';
import { narratorSystem as narratorSystemPg } from '../src/loop/roles-pg.ts';

test('the default narrator asks softly for roughly 250–300 words', () => {
  const style = defaultStyleContract();
  assert.equal(style.sceneTarget, 275);
  assert.deepEqual(narrationWordRange(style.sceneTarget), { min: 250, max: 300 });

  for (const prompt of [narratorSystemSqlite(style, false), narratorSystemPg(style, false)]) {
    assert.match(prompt, /target: about 275 words \(roughly 250–300; a soft range, not a hard cap\)/);
    assert.match(prompt, /Finish the current beat with a complete sentence/);
  }
});

test('custom narration targets adjust the soft range and leave output headroom', () => {
  assert.deepEqual(narrationWordRange(150), { min: 136, max: 164 });
  assert.equal(narrationOutputTokenBudget(275), 2200);
  assert.equal(narrationOutputTokenBudget(500), 4000);
  assert.equal(narrationOutputTokenBudget(100), 2048);
  assert.equal(narrationOutputReserve(500), narrationOutputTokenBudget(500) * 2 + 1024);
});
