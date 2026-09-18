import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sheet } from '../web/src/api.ts';
import { createSheetSaveQueue } from '../web/src/views/sheetSaveQueue.ts';

function sheet(overrides: Partial<Sheet> = {}): Sheet {
  return {
    entityId: 'char:one',
    identity: {
      goals: [],
      wounds: [],
      fears: [],
      secrets: [],
      allegiances: [],
      competencies: [],
      arc: '',
    },
    contract: {
      vows: [],
      drives: [],
      breakingPoint: '',
      costOfBreak: '',
    },
    voice: {
      diction: '',
      samples: [],
      tics: [],
      never: [],
    },
    condition: {
      locationId: null,
      mood: '',
      injuries: [],
      inventory: [],
      intent: '',
      presentWith: [],
    },
    appearance: {
      description: '',
      attire: '',
      markers: [],
      referenceImagePath: null,
      seed: null,
    },
    locks: [],
    isPlayer: false,
    ...overrides,
  };
}

test('sheet save queue serializes saves and builds each patch from the latest saved sheet', async () => {
  const persisted: Partial<Sheet>[] = [];
  const saved: Sheet[] = [];
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const queue = createSheetSaveQueue(
    sheet(),
    async (_entityId, patch) => {
      call++;
      if (call === 1) await firstCanFinish;
      persisted.push(patch);
      return sheet({
        contract: {
          ...sheet().contract,
          ...(patch.contract ?? {}),
        },
      });
    },
    (next) => saved.push(next),
  );

  const first = queue.save(() => ({ contract: { ...sheet().contract, breakingPoint: 'first' } }));
  const second = queue.save((current) => ({ contract: { ...current.contract, costOfBreak: 'second' } }));

  await Promise.resolve();
  assert.equal(persisted.length, 0, 'the second save waits for the first');
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(persisted.map((patch) => patch.contract), [
    { ...sheet().contract, breakingPoint: 'first' },
    { ...sheet().contract, breakingPoint: 'first', costOfBreak: 'second' },
  ]);
  assert.equal(saved.length, 2);
});
