import assert from 'node:assert/strict';
import test from 'node:test';
import { MutationObserver, QueryClient } from '@tanstack/react-query';

/**
 * Replaces `sheet-save-queue.test.ts`. `createSheetSaveQueue` hand-rolled a
 * promise chain so concurrent saves for one entity queue up and each patch
 * builds on the *previous save's result*, not a stale closed-over value —
 * `useSaveSheetMutation` (`web/src/queries.ts`) reproduces this with a real
 * `mutation.scope` (same-scope mutations run in serial) plus reading the
 * live cache at execution time instead of a closure. These tests drive the
 * actual `MutationObserver`/`QueryClient` `useMutation` is built on
 * directly — no React needed, same as `story-switch-invalidation.test.ts`.
 */

interface FakeSheet {
  entityId: string;
  drives: string;
}

test('same-scope mutations run in serial, each reading the previous one\'s result from the cache', async () => {
  const queryClient = new QueryClient();
  const cacheKey = ['cast'];
  queryClient.setQueryData<FakeSheet>(cacheKey, { entityId: 'char:one', drives: 'original' });

  const applied: string[] = [];
  const inFlight: string[] = [];
  let maxConcurrent = 0;

  function makeSaveObserver() {
    return new MutationObserver(queryClient, {
      scope: { id: 'sheet-save-char:one' },
      // Mirrors `useSaveSheetMutation`'s mutationFn: read the *current*
      // cached sheet at execution time, not a value captured at call time.
      mutationFn: async (buildPatch: (sheet: FakeSheet) => Partial<FakeSheet>) => {
        inFlight.push('start');
        maxConcurrent = Math.max(maxConcurrent, inFlight.length);
        const current = queryClient.getQueryData<FakeSheet>(cacheKey)!;
        const patch = buildPatch(current);
        // A real save has network latency; without serialization, two
        // concurrent saves would both read `current` before either wrote
        // back, and the second write would silently lose the first's patch.
        await new Promise((resolve) => setTimeout(resolve, 10));
        const updated = { ...current, ...patch };
        queryClient.setQueryData(cacheKey, updated);
        inFlight.pop();
        applied.push(patch.drives ?? '');
        return updated;
      },
    });
  }

  const first = makeSaveObserver().mutate((sheet) => ({ drives: `${sheet.drives}+first` }));
  const second = makeSaveObserver().mutate((sheet) => ({ drives: `${sheet.drives}+second` }));

  await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1, 'the two saves must never run concurrently — that is what scope is for');
  assert.deepEqual(applied, ['original+first', 'original+first+second'], 'the second save must build on the first save\'s result, not the value cached before either ran');
  assert.deepEqual(queryClient.getQueryData<FakeSheet>(cacheKey), {
    entityId: 'char:one',
    drives: 'original+first+second',
  });
});

test('mutations with different scope ids run concurrently, not serially', async () => {
  const queryClient = new QueryClient();
  const started: string[] = [];
  const order: string[] = [];

  function makeObserver(scopeId: string) {
    return new MutationObserver(queryClient, {
      scope: { id: scopeId },
      mutationFn: async () => {
        started.push(scopeId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(scopeId);
        return scopeId;
      },
    });
  }

  await Promise.all([
    makeObserver('sheet-save-char:one').mutate(undefined),
    makeObserver('sheet-save-char:two').mutate(undefined),
  ]);

  assert.deepEqual(
    new Set(started),
    new Set(['sheet-save-char:one', 'sheet-save-char:two']),
    'both mutations must have started — different entities never block each other',
  );
});
