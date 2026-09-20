import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

/**
 * Replaces `history-request-gate.test.ts`. `HistoryRequestGate` hand-rolled
 * "discard a response if a newer request has started since" — TanStack
 * Query's own fetch supersession does the same job now (see
 * `web/src/history-request-gate.ts`'s deletion, Task 7 of
 * `docs/superpowers/plans/2026-09-19-frontend-tanstack-query.md`). These
 * tests exercise the *real* `QueryClient`/`QueryObserver` behavior directly
 * (no React needed — both have zero React dependency; `QueryObserver` is
 * exactly what `useQuery` builds internally, and subscribing one is what
 * keeps a query "active" for `invalidateQueries`' default `refetchType:
 * 'active'` — a query with no subscriber, as in a first draft of this file,
 * is invisible to it and only gets marked stale, not refetched immediately;
 * it refetches on next mount instead, which is the correct behavior but not
 * what these tests are checking). This exercises the specific pattern
 * `web/src/App.tsx`'s `selectStory` uses: update a "current story" ref,
 * then `invalidateQueries()` with no filter — while `BookTab` (i.e. an
 * active observer on `['book']`) is mounted, matching the real scenario a
 * story switch happens while the book tab is open.
 */

/** Mirrors `getSelectedStoryId()`/`setSelectedStoryId()` (`web/src/api.ts`) without the sessionStorage plumbing. */
function makeStorySelection(initial: string) {
  let current = initial;
  return {
    get: () => current,
    set: (id: string) => {
      current = id;
    },
  };
}

/** Subscribes a `QueryObserver` (what `useQuery` does) so the query counts as "active". Returns an unsubscribe function. */
function subscribeActive<T>(queryClient: QueryClient, queryKey: unknown[], queryFn: () => Promise<T>) {
  const observer = new QueryObserver(queryClient, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

test('switching the selected story before invalidating refetches under the new story, not the old one', async () => {
  const selection = makeStorySelection('story-a');
  const queryKey = ['state'];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // The queryFn reads the "current story" the same way `api.ts`'s
  // `withStoryId()` does: at call time, not at query-definition time.
  const queryFn = () => Promise.resolve({ storyId: selection.get() });
  const { observer, unsubscribe } = subscribeActive(queryClient, queryKey, queryFn);

  await observer.refetch();
  assert.deepEqual(queryClient.getQueryData(queryKey), { storyId: 'story-a' });

  // The bug this guards against: if `invalidateQueries()` fires before the
  // selection is updated, the refetch's queryFn would still read the old
  // story id. Correct order (matching the fixed `selectStory` in
  // `web/src/App.tsx`) is select-then-invalidate.
  selection.set('story-b');
  await queryClient.invalidateQueries({ queryKey });

  assert.deepEqual(
    queryClient.getQueryData(queryKey),
    { storyId: 'story-b' },
    'a query invalidated after switching stories must refetch under the new story id',
  );
  unsubscribe();
});

test('a slow in-flight refetch for the old story is superseded, not merged, by the refetch a switch triggers', async () => {
  // Superseding only happens once the query already has data — TanStack
  // Query's very first fetch for a key has no data to compare against, so a
  // concurrent invalidate just dedupes onto that same in-flight promise
  // instead of starting a new one (confirmed directly: an earlier version of
  // this test raced the switch against the *first-ever* fetch and deadlocked
  // for exactly this reason). So this simulates the realistic case instead:
  // data already loaded once, then a slow *background* refetch is in flight
  // when the switch happens.
  const selection = makeStorySelection('story-a');
  const queryKey = ['book'];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  let resolveSlowRefetch!: (value: { storyId: string }) => void;
  let fetchCount = 0;
  const queryFn = () => {
    fetchCount += 1;
    if (fetchCount === 2) {
      // The second fetch (the slow background refetch for story-a) hangs
      // until explicitly resolved below, simulating a real slow network
      // request that's still in flight when the switch happens.
      return new Promise<{ storyId: string }>((resolve) => {
        resolveSlowRefetch = resolve;
      });
    }
    return Promise.resolve({ storyId: selection.get() });
  };
  const { observer, unsubscribe } = subscribeActive(queryClient, queryKey, queryFn);

  // Fetch #1: the mount-triggered fetch, resolves immediately with story-a.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(queryClient.getQueryData(queryKey), { storyId: 'story-a' });

  // Fetch #2: a slow background refetch (data already exists now, so this
  // one is genuinely supersedable), still for story-a, kicked off but not
  // awaited — it won't resolve until `resolveSlowRefetch` is called below.
  const slowRefetch = observer.refetch();

  selection.set('story-b');
  // Fetch #3: the switch's own invalidate-triggered refetch. `cancelRefetch`
  // (default true) cancels fetch #2's retryer here, so fetch #3 is the one
  // that actually lands.
  await queryClient.invalidateQueries({ queryKey });
  assert.deepEqual(queryClient.getQueryData(queryKey), { storyId: 'story-b' }, "the switch's own refetch must land story-b's data immediately");

  // Now let the slow, superseded story-a response land.
  resolveSlowRefetch({ storyId: 'story-a' });
  await slowRefetch.catch(() => {
    // A cancelled retryer's promise may reject depending on version
    // internals; either way, the cache state asserted below is what matters.
  });

  assert.deepEqual(
    queryClient.getQueryData(queryKey),
    { storyId: 'story-b' },
    "the old story's slow, superseded response must not overwrite the new story's data once it lands",
  );
  unsubscribe();
});
