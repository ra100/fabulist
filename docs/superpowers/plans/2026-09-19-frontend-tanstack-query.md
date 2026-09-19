# Frontend TanStack Query Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every hand-rolled `fetch`/`api.*` call-site data-fetching pattern in `web/src` with `@tanstack/react-query` (queries for reads, mutations for writes), with zero behavior regressions, verified by unit tests plus a real local browser walkthrough.

**Architecture:** One new file, `web/src/queries.ts`, holds query-key factories and typed `useQuery`/`useMutation`/`useInfiniteQuery` wrapper hooks, grouped by domain exactly the way `web/src/api.ts`'s `api` object is already grouped (`api.auth` → `authQueries`/`authMutations`, `api.stories` → `storiesQueries`/`storiesMutations`, etc.) — this mirrors the existing single-large-file convention (`api.ts`, `App.tsx`) rather than fragmenting into a new directory. Each view/component keeps its JSX and local UI state; only the data-fetching plumbing (the `useState`/`useEffect`/try-catch/promise-chain triplets cataloged below) is replaced by hook calls. Two hand-rolled correctness mechanisms — `HistoryRequestGate` (stale-response guarding) and `createSheetSaveQueue` (serialized writes) — are subsumed by real TanStack Query v5 features (query invalidation/cancellation, and `mutation.scope`) and are deleted once their call sites convert.

**Tech Stack:** `@tanstack/react-query` (add as a new dependency — none of react-query/swr/urql is currently installed), React 19, Vite 7, TypeScript, `zod` for response validation (already used in `api.ts`, unchanged). Testing stays on the house style: Node's built-in `node:test`/`node:assert`, no jsdom/RTL/vitest added (verified: none exist in this repo today; component-level correctness is verified by local browser check instead, per explicit user requirement).

**Spec:** User request (verbatim): "convert all frontend call to tanstack query (except websocket, if there are any, only if tanstack query supports it), start in new worktree from origin/main branch, all functionality needs to be preserved, not new bugs introduced, new bugs identified fixed, application is tested by unit tests and tested running locally, with browser check. don't hallucinate, validate with real documentation." No actual WebSocket usage exists in this codebase (confirmed by full-repo grep) — the one streaming call (`api.playStream`, SSE-over-fetch) is in scope and is discussed in Task 6.

## Global Constraints

- Package manager: `pnpm` (pnpm@11.5.2, per `package.json`). Use `pnpm add @tanstack/react-query` (latest, `5.103.1` as of this plan — confirmed via `npm view`, real peer dep `react: ^18 || ^19`, compatible with this repo's React `^19.0.0`).
- No new test framework. Reuse `node:test` + `node:assert` for anything pure/testable (query-key factories, the pagination `getNextPageParam` function, the streaming chunk reducer). React rendering correctness is verified by `pnpm dev:web` + a real browser (Playwright MCP tools), not by adding jsdom/RTL.
- Every existing route/behavior in `web/src/api.ts` stays as-is — `api.ts` is the `queryFn`/`mutationFn` implementation layer and is not rewritten, only *called from* `queries.ts` instead of directly from components. Exceptions: `api.exportUrl(...)` and `api.illustrate.imageUrl(...)` are URL builders used as plain `href`/`src`, not fetch calls — do not touch them.
- Query keys: array form, first element is a domain tag matching the `api.*` grouping (e.g. `['state']`, `['graph', params]`, `['entity', id]`, `['stories']`, `['worlds']`, `['setup', 'job', id]`). No `storyId` embedded in keys — this repo's existing pattern is "reload everything on story/world switch" (confirmed: `StoriesTab`'s switch/fork/claim/create handlers all call `App.refresh()` afterward, which reloads `api.state()`), so the migration mirrors that with an unfiltered `queryClient.invalidateQueries()` on story/world switch, exactly matching current behavior rather than introducing per-story cache partitioning that doesn't exist today.
- Delete on completion (do not delete until the last call site using them is converted): `web/src/history-request-gate.ts`, `test/history-request-gate.test.ts`, `web/src/views/sheetSaveQueue.ts`, `test/sheet-save-queue.test.ts`.
- Run after every task: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Fix any failure before moving to the next task — do not accumulate breakage.
- Component/line references below come from a full-repo catalog taken before any edits. Line numbers shift as earlier tasks edit `App.tsx` — **re-read the current file before editing in every task**, do not trust a stale line number over the file's actual current content.

---

## Canonical Patterns (worked examples — apply the matching shape to every call site listed in each task)

### Pattern A — simple GET → `useQuery`

Before (typical shape seen throughout, e.g. `TimelineView.tsx`):
```tsx
const [timeline, setTimeline] = useState<Timeline | null>(null);
const [error, setError] = useState<string | null>(null);
useEffect(() => {
  api.timeline().then(setTimeline).catch((e) => setError(String(e)));
}, []);
```
After:
```tsx
// web/src/queries.ts
export const timelineKeys = { all: ['timeline'] as const };
export function useTimelineQuery() {
  return useQuery({ queryKey: timelineKeys.all, queryFn: api.timeline });
}

// TimelineView.tsx
const { data: timeline, error, isLoading } = useTimelineQuery();
```
`error` is now an `Error` object (React Query wraps any thrown value; `api.ts`'s `req()` already throws `Error` instances), so `error.message` replaces `String(e)` call sites that did that. `isLoading`/`isPending` replaces manual `loading` state.

### Pattern B — GET with params → `useQuery` with params in the key

```tsx
export function useGraphQuery(params: { layer?: string; type?: string; limit?: number; minWeight?: number }) {
  return useQuery({ queryKey: ['graph', params], queryFn: () => api.graph(params) });
}
```

### Pattern C — write → `useMutation` + invalidate

Before (`FactsView.tsx` shape):
```tsx
async function revoke(factId: string, entityId: string) {
  await api.revokeKnowledge(factId, entityId);
  await loadFacts();
}
```
After:
```tsx
export function useRevokeKnowledgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ factId, entityId }: { factId: string; entityId: string }) => api.revokeKnowledge(factId, entityId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['facts'] }),
  });
}
// component:
const revokeKnowledge = useRevokeKnowledgeMutation();
revokeKnowledge.mutate({ factId, entityId });
```

### Pattern D — story/world switch → unfiltered invalidate (replaces `stateRequestGate`/App.refresh() broadcast)

```tsx
export function useSwitchStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) => api.stories.switchTo(storyId),
    onSuccess: (_data, storyId) => {
      setSelectedStoryId(storyId);
      return queryClient.invalidateQueries(); // no filter: re-fetch everything, matching today's App.refresh() broadcast
    },
  });
}
```
React Query's own request de-duplication/cancellation on `invalidateQueries` is what replaces `HistoryRequestGate`: an in-flight query for a key that's superseded by a newer render is not raced against — the last observer for a query key always wins, and `invalidateQueries` marks the old data stale and triggers exactly one refetch per active key. No manual revision counter needed.

### Pattern E — paginated GET → `useInfiniteQuery` (replaces `BookTab`'s manual `offset` state + `historyRequestGate`)

`api.book({limit, offset})` returns `{ scenes, turns, nextOffset: number | null }` — a direct fit:
```tsx
export function useBookInfiniteQuery(limit: number) {
  return useInfiniteQuery({
    queryKey: ['book', limit],
    queryFn: ({ pageParam }) => api.book({ limit, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset, // v5 accepts `null` as "no more pages"
  });
}
```
Flatten `data.pages.flatMap(p => p.turns)` where the component currently reads its accumulated `turns` array.

### Pattern F — polling GET → `useQuery({ refetchInterval })` (replaces `SetupWizard`/`IngestHealthPanel`'s manual `setInterval`)

```tsx
export function useSetupJobQuery(jobId: string | null) {
  return useQuery({
    queryKey: ['setup', 'job', jobId],
    queryFn: () => api.setup.job(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false), // stop polling once done/failed/cancelled
  });
}
```

### Pattern G — debounced search GET → debounce the input, not the fetch

```tsx
const [query, setQuery] = useState('');
const [debounced, setDebounced] = useState('');
useEffect(() => {
  const t = setTimeout(() => setDebounced(query), 300);
  return () => clearTimeout(t);
}, [query]);
const { data: results } = useQuery({
  queryKey: ['search', debounced],
  queryFn: () => api.search(debounced),
  enabled: debounced.length > 0,
});
```

### Pattern H — serialized writes → `mutation.scope` (replaces `createSheetSaveQueue`)

```tsx
export function useSaveSheetMutation(entityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `sheet-save-${entityId}` }, // real v5 feature: same-scope mutations run in serial, queued, not parallel
    mutationFn: (patch: Partial<Sheet>) => api.saveSheet(entityId, patch),
    onSuccess: (updated) => queryClient.setQueryData(['sheet', entityId], updated),
  });
}
```
Each call's `mutationFn` must read the *current* cached sheet via `queryClient.getQueryData(['sheet', entityId])` rather than a closed-over stale value, so that serialized saves build each patch on top of the previous save's result — this is the exact behavior `createSheetSaveQueue.save()`'s `latest`-tracking gave, reproduced without the hand-rolled queue.

### Pattern I — streaming mutation (`api.playStream`) → `useMutation`, internals unchanged

`playStream` is a one-shot, mutation-shaped action (submits player input, server advances game state), not a cacheable/refetchable query — TanStack Query v5 does have a real streaming primitive, `streamedQuery` (in `@tanstack/query-core`), but it is `queryFn`-shaped (stable key, refetchable, accumulates into `data`), which is the wrong fit for a one-shot submit-and-stream action. Wrap the *call*, not the internals:
```tsx
export function usePlayStreamMutation() {
  return useMutation({
    mutationFn: (vars: { input: string; overrideIntegrity: boolean; handlers: PlayStreamHandlers }) =>
      api.playStream(vars.input, vars.overrideIntegrity, vars.handlers),
  });
}
```
The existing `onStage`/`onToken`/`onDone`/`onError` callback handlers stay exactly as they are (they drive incremental UI, which isn't query-cache-shaped data); `usePlayStreamMutation().isPending` replaces whatever manual "is playing" boolean currently gates the input form.

---

## Task 0: Install dependency and wire up `QueryClientProvider`

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `web/src/main.tsx`
- Modify: `web/src/landing/main.tsx`
- Create: `web/src/queries.ts` (empty skeleton with just the `QueryClient`-adjacent imports for now — domains added task by task)

**Interfaces:**
- Produces: nothing consumed by later tasks except the `@tanstack/react-query` import being available and both app entry points being wrapped.

- [ ] **Step 1:** `pnpm add @tanstack/react-query`
- [ ] **Step 2:** Confirm baseline is clean: `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 3:** Edit `web/src/main.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { bootPalette } from './palette.ts';
import './styles.css';

bootPalette();

const queryClient = new QueryClient();

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
```
- [ ] **Step 4:** Same pattern for `web/src/landing/main.tsx` (separate, independent `QueryClient` — landing and app are different HTML entry points, never mounted together).
- [ ] **Step 5:** `pnpm typecheck && pnpm build:web` — confirm it still builds.
- [ ] **Step 6:** Commit: `git add package.json pnpm-lock.yaml web/src/main.tsx web/src/landing/main.tsx && git commit -m "chore(web): add @tanstack/react-query and wire up QueryClientProvider"`

## Task 1: Auth/session domain — `web/src/queries.ts` skeleton + `api.meta`, `api.auth.*`, Landing's direct fetch

**Files:**
- Modify: `web/src/queries.ts` (add real content: imports, `useQueryClient` re-export convenience if useful, `metaKeys`/`useMetaQuery`, `authKeys`/`useCurrentUserQuery`/`useLogoutMutation`)
- Modify: `web/src/App.tsx` (L225 `api.meta()`, L231 `api.auth.me()`, L290 `api.auth.logout()` — re-read file first, these lines are pre-edit references)
- Modify: `web/src/landing/Landing.tsx` (L495 direct `fetch('/api/auth/me')` — convert to the same `useCurrentUserQuery` hook, reusing `web/src/api.ts`'s `api.auth.me()` instead of a raw fetch, since that's what it's already doing minus the wrapper)
- Test: no new test file needed (no pure logic to extract here beyond the key constants, which are trivial); covered by the Task 15 browser check.

**Interfaces:**
- Produces: `useMetaQuery()`, `useCurrentUserQuery()`, `useLogoutMutation()` from `web/src/queries.ts`, used by later tasks that need `currentUser`/`isAdmin`.

- [ ] **Step 1:** Read current `web/src/App.tsx` around the (pre-edit) L220-295 region and `web/src/landing/Landing.tsx` around L490-500 to get exact current code.
- [ ] **Step 2:** Add to `web/src/queries.ts`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';

export const metaKeys = { all: ['meta'] as const };
export function useMetaQuery() {
  return useQuery({ queryKey: metaKeys.all, queryFn: api.meta });
}

export const authKeys = { me: ['auth', 'me'] as const };
export function useCurrentUserQuery() {
  return useQuery({ queryKey: authKeys.me, queryFn: api.auth.me });
}
export function useLogoutMutation() {
  return useMutation({ mutationFn: api.auth.logout });
}
```
- [ ] **Step 3:** In `App.tsx`, replace the `api.meta()` effect (Pattern A) and `api.auth.me()` effect (Pattern A) with `useMetaQuery()`/`useCurrentUserQuery()`; replace the logout `onClick` handler's `api.auth.logout()` + `window.location.href = '/'` with `useLogoutMutation()`'s `.mutate(undefined, { onSuccess: () => { window.location.href = '/'; } })` (the full-navigation-after is existing, documented-in-code behavior — preserve it verbatim).
- [ ] **Step 4:** In `Landing.tsx`, wrap `<Landing />`'s render (already done in Task 0 Step 4) and replace the raw `fetch('/api/auth/me')` + manual `.then`/`.catch` with `useCurrentUserQuery()`.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 2: Encryption domain — `api.encryption.*`

**Files:**
- Modify: `web/src/queries.ts` (add `encryptionKeys`, `useEncryptionKeysQuery`, `useEncryptionMigrationQuery`, `useEnrollMutation`, `useUnlockMutation`, `useLockMutation`, `useMigrateMutation`)
- Modify: `web/src/App.tsx` — call sites at (pre-edit) L242 (`keys()`), L243 (`migration()`), L562 (`enroll()`), L581 (`unlock()`), L600 (`lock()`), L614 (`migrate()`). These live in the private-storage enrollment component embedded in `App.tsx` (reported as spanning roughly L457-804, containing `PrivateStorageIndicator`/`PrivateStorageBanner`/`PrivateStoragePanel`) — confirm the exact enclosing component by reading the file, the earlier component-boundary scan had some imprecision here.

**Interfaces:**
- Consumes: none new.
- Produces: `useEncryptionKeysQuery()`, `useEncryptionMigrationQuery()`, mutations above — not consumed elsewhere.

- [ ] **Step 1:** Read `web/src/App.tsx` L440-805 (current line numbers) in full to get exact current shapes for all 6 call sites and confirm the enclosing component(s).
- [ ] **Step 2:** Add the 2 queries (Pattern A) and 4 mutations (Pattern C, each invalidating `['encryption', 'keys']` and/or `['encryption', 'migration']` on success, matching whatever the current code re-fetches after each action — check this precisely per call site, don't assume).
- [ ] **Step 3:** `L600`'s `lock()` handler currently does `window.location.reload()` afterward (confirmed via grep) — preserve that exactly; it doesn't need query invalidation since the page is reloading anyway.
- [ ] **Step 4:** Convert all 6 call sites.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 3: Core story state — `api.state`, `api.setup.status`, delete `stateRequestGate`

**Files:**
- Modify: `web/src/queries.ts` (add `stateKeys`, `useStateQuery`, `setupStatusKeys`, `useSetupStatusQuery`)
- Modify: `web/src/App.tsx` — `App.refresh()` (currently guards L174/L175 with `stateRequestGate`), `selectStory()` (currently calls `stateRequestGate.invalidate()`)
- Delete (only after this task confirms no other file still imports it — grep first): none yet, `historyRequestGate` in `BookTab`/`TimelineView` still needs Tasks 5 and 7 first.

**Interfaces:**
- Produces: `useStateQuery()` (the big `State` object BookTab/CastTab/SettingsTab/ThreadsView currently receive as a prop) and `useSetupStatusQuery()`.
- Consumes: `useSwitchStoryMutation`-style invalidation pattern (Pattern D) — introduce a shared `invalidateEverything(queryClient)` helper in `queries.ts` used by every story/world-mutating mutation from Task 3 onward, so later tasks (StoriesTab in Task 11) call the same helper instead of duplicating `queryClient.invalidateQueries()`.

- [ ] **Step 1:** Read current `App.tsx` around `App.refresh()`/`selectStory()` (currently ~L120-200) in full.
- [ ] **Step 2:** Add `useStateQuery()`/`useSetupStatusQuery()` (Pattern A) and the shared helper:
```tsx
export function invalidateEverything(queryClient: QueryClient) {
  return queryClient.invalidateQueries();
}
```
- [ ] **Step 3:** Replace the `stateRequestGate`-guarded effect with the two queries; `App` now gets `state`/`setupStatus` from hooks instead of `useState`+manual fetch. Replace `selectStory()`'s `stateRequestGate.invalidate()` call with `invalidateEverything(queryClient)` (called from wherever `selectStory` currently triggers a reload — this may need to move to the mutation `onSuccess` sites in Task 11 once those exist; if `selectStory` is a plain setter with no mutation yet, keep a `queryClient.invalidateQueries()` call at the same call site for now).
- [ ] **Step 4:** Remove the `stateRequestGate` field/import from `App.tsx` (but leave `web/src/history-request-gate.ts` itself until Task 7, since `BookTab`/`TimelineView` still use the class).
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 4: Graph/Entity/Search/Cast — `GraphTab`, `CastTab`

**Files:**
- Modify: `web/src/queries.ts` (add `useGraphQuery` (Pattern B), `useEntityQuery(id)` (Pattern B), `useSearchQuery(debounced)` (Pattern G), `useCastQuery` (Pattern A))
- Modify: `web/src/views/GraphView.tsx` and/or `App.tsx`'s `GraphTab`/`EntityPanel` (L1678 `entity()`, L1691 debounced `search()`) — confirm exact file: catalog says these are in `App.tsx`'s `GraphTab`/`EntityPanel`, not `views/GraphView.tsx`; `views/GraphView.tsx` and `views/graphLayout.ts` are presentational/layout-only per the earlier full-repo grep (0 api call sites found there) — re-verify with a quick grep before editing.
- Modify: `App.tsx`'s `CastTab` (L1921 `cast()`, L1985 — re-check, catalog flagged this as "cast list display logic", confirm it's actually a call site or just a render of already-fetched data before converting).

**Interfaces:**
- Consumes: none new.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1:** `rg -n "api\." web/src/App.tsx web/src/views/GraphView.tsx` to get exact current line numbers for this task (earlier catalog lines have likely shifted from Tasks 0-3's edits).
- [ ] **Step 2:** Read the exact current code around each hit.
- [ ] **Step 3:** Add the 4 hooks to `queries.ts`.
- [ ] **Step 4:** Convert each call site; for the debounced search, keep the existing `setTimeout`-based input debounce exactly as Pattern G describes (only the fetch moves into `useQuery`).
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 5: Book/turn/play pagination and streaming — `BookTab`

**Files:**
- Modify: `web/src/queries.ts` (add `useBookInfiniteQuery` (Pattern E), `useTurnQuery(id)` (Pattern B), `usePlayMutation` (Pattern C, non-streaming `api.play`), `usePlayStreamMutation` (Pattern I), `useCloseSceneMutation`, `useChaptersQuery`, `useRollbackMutation`, `useSplitSceneMutation`, `useRegenerateMutation`, `usePinMutation`, `useAddAnchorMutation` — all Pattern C, each invalidating `['book', ...]` and/or `['state']` per what the current handler re-fetches)
- Modify: `App.tsx`'s `BookTab` (the largest single task: 12 call sites — re-grep for current lines, was L890-1259 pre-edit) and `RollbackPanel`/`WhyPanel` if `api.chapters()`/`api.rollback()` live there instead (re-verify boundaries by reading, the earlier scan put `RollbackPanel` at a separate line range from `BookTab`).

**Interfaces:**
- Consumes: `invalidateEverything` helper is NOT used here — book/turn mutations should invalidate narrowly (`['book']`, `['state']`, `['timeline']` as applicable), not everything, since these are frequent in-story actions, not story switches. Check each handler's current post-mutation re-fetch calls precisely before deciding invalidation scope.
- Produces: nothing consumed elsewhere except by Task 7 (TimelineView invalidates `['timeline']` on rollback from its own view, but `BookTab`'s rollback should also invalidate `['timeline']` since both views show timeline data).

- [ ] **Step 1:** `rg -n "api\.(book|turn|play|closeScene|chapters|rollback|splitScene|regenerate|pin|addAnchor)" web/src/App.tsx` for current lines.
- [ ] **Step 2:** Read the full current `BookTab` function body.
- [ ] **Step 3:** Add all hooks to `queries.ts`, applying Pattern E for `book`, Pattern I for `playStream`, Pattern C for the rest.
- [ ] **Step 4:** Convert all 12 call sites. `historyRequestGate` becomes dead in `BookTab` once its two guarded call sites (`api.book()` pagination) convert to `useInfiniteQuery` — remove the `useRef(new HistoryRequestGate())` and the `beginRequest`/`isCurrent` checks from `BookTab`, but do not delete `history-request-gate.ts` yet (Task 7 still uses it in `TimelineView`).
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 6: Blocklist inline toggle (`api.config.block` in `BookTab`) + full `ConfigPanels.tsx`

**Files:**
- Modify: `web/src/queries.ts` (add `configKeys`, `useConfigQuery` (Pattern A), `useConfigPatchMutation`, `useBlockMutation`, `useUnblockMutation`, `useRemoveProviderMutation`, `useTestProviderMutation` (this one does NOT invalidate — it's a probe, not a write), `usePutProviderMutation` — Pattern C for the writes)
- Modify: `web/src/App.tsx` (blocklist toggle in `BookTab`'s turn footer, re-grep for current line — was L1601 pre-edit)
- Modify: `web/src/views/ConfigPanels.tsx` (10 call sites)

**Interfaces:**
- Produces: `useConfigQuery()` consumed by both `App.tsx`'s inline blocklist toggle and `ConfigPanels.tsx` — same query key `['config']`, so a block/unblock from the turn footer correctly invalidates what `ConfigPanels.tsx` shows too, and vice versa (this is new-for-free correctness: today these are two independent fetches with no cross-sync, which is a real latent inconsistency — note it as a "bug fixed by this migration" in the final report, don't silently skip mentioning it).

- [ ] **Step 1:** Read `web/src/views/ConfigPanels.tsx` in full and re-grep `App.tsx` for the current blocklist call site line.
- [ ] **Step 2:** Add hooks to `queries.ts`. `ConfigPanels.tsx`'s "custom apply fn" state (noted in the catalog for several call sites) — read exactly what that does before assuming it's just loading/error state; it may be doing local optimistic merging that needs to move into `onMutate`/`onSuccess`.
- [ ] **Step 3:** Convert all 11 call sites (10 in `ConfigPanels.tsx` + 1 in `App.tsx`).
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 5:** Commit.

## Task 7: `TimelineView.tsx` + delete `HistoryRequestGate`

**Files:**
- Modify: `web/src/queries.ts` (add `useTimelineQuery` (Pattern A, shown above), `useRollbackMutation` — reuse the one from Task 5 if `TimelineView`'s rollback call has identical semantics; if not identical, name it distinctly and note the difference)
- Modify: `web/src/views/TimelineView.tsx` (2 call sites; remove `useRef(new HistoryRequestGate())` entirely)
- Delete: `web/src/history-request-gate.ts`, `test/history-request-gate.test.ts` (only after confirming via `rg -n "HistoryRequestGate|history-request-gate" web/src test` that zero references remain)

**Interfaces:**
- Consumes: `useTimelineQuery`/rollback mutation should invalidate `['timeline']` and `['book']` together on rollback (rollback changes both).

- [ ] **Step 1:** Read `web/src/views/TimelineView.tsx` in full.
- [ ] **Step 2:** Convert both call sites.
- [ ] **Step 3:** `rg -n "HistoryRequestGate|history-request-gate"` across the repo — if the only remaining hits are the files being deleted, delete `web/src/history-request-gate.ts` and `test/history-request-gate.test.ts`. If other references remain, stop and report rather than deleting.
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 5:** Commit.

## Task 8: `ThreadsView.tsx` + directives

**Files:**
- Modify: `web/src/queries.ts` (add `useThreadsQuery`, `useUpdateThreadMutation`, `useCreateThreadMutation`, `useAddDirectiveMutation`, `useRetireDirectiveMutation`)
- Modify: `web/src/views/ThreadsView.tsx` (5 call sites, including the one wrapped in a `useAction`-style hook at L22 — read what that wrapper does before converting; it may need to stay as a thin adapter around the mutation rather than being deleted outright)

- [ ] **Step 1:** Read `web/src/views/ThreadsView.tsx` in full.
- [ ] **Step 2:** Add hooks, convert 5 call sites.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4:** Commit.

## Task 9: `FactsView.tsx` + `CausalityView.tsx`

**Files:**
- Modify: `web/src/queries.ts` (add `useFactsQuery`, `useGrantKnowledgeMutation` (already have `useRevokeKnowledgeMutation` from the canonical example — add it here for real, the example above wasn't yet added to the file), `useConsequencesQuery`, `useTickMutation`)
- Modify: `web/src/views/FactsView.tsx` (4 call sites), `web/src/views/CausalityView.tsx` (3 call sites)

- [ ] **Step 1:** Read both files in full.
- [ ] **Step 2:** Add hooks (Pattern A/C), convert 7 call sites total. `FactsView.tsx` also calls `api.cast()` (L13) — reuse `useCastQuery` from Task 4, don't redefine it.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4:** Commit.

## Task 10: Style/knobs/anchors — `SettingsTab`

**Files:**
- Modify: `web/src/queries.ts` (add `useStyleQuery`, `useKnobsQuery`, `useAnchorsQuery` (Pattern A each), `useSetStyleMutation`, `useSetKnobsMutation` (Pattern C))
- Modify: `App.tsx`'s `SettingsTab` (3 reads + 2 writes, re-grep current lines, was L2077-2087 pre-edit)

Note: `api.frames()` has zero call sites anywhere in `web/src` (confirmed by grep) — do not add a hook for it; it's dead client-side code, out of scope for this migration (not a call site to convert since nothing calls it).

- [ ] **Step 1:** Re-grep, read current `SettingsTab` code.
- [ ] **Step 2:** Add hooks, convert 5 call sites. `useAddAnchorMutation` already exists from Task 5 — invalidate `['anchors']` from it too now that `SettingsTab` reads that key (go back and add this invalidation to Task 5's mutation definition).
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4:** Commit.

## Task 11: Stories & Worlds — `StoriesTab` (largest single-file task: 17 call sites)

**Files:**
- Modify: `web/src/queries.ts` (add `useStoriesQuery`, `useUnownedStoriesQuery`, `useWorldsQuery`, `useCreateStoryMutation`, `useForkStoryMutation`, `useSwitchStoryMutation` (Pattern D, shown above), `useRenameStoryMutation`, `useRemoveStoryMutation`, `useClaimStoriesMutation`, `useSetSourcesMutation`, `useCreateWorldMutation`, `useRenameWorldMutation`, `useRemoveWorldMutation`, `useSetWorldVisibilityMutation`, `useWorldAccessQuery`, `useGrantWorldAccessMutation`, `useRevokeWorldAccessMutation`)
- Modify: `App.tsx`'s `StoriesTab` (re-grep current lines, was L2333-2790 pre-edit — the biggest block)

**Interfaces:**
- Consumes: `invalidateEverything` (Task 3) for every mutation that currently triggers `App.refresh()`/`load()`-everything (switch, fork, create, claim, remove — verify each individually, some may only need `['stories']`/`['worlds']` invalidated rather than everything; check what each current handler actually re-fetches before choosing scope).

- [ ] **Step 1:** Re-grep for current lines; this is the biggest single read — budget for reading the whole `StoriesTab` function in one pass rather than piecemeal.
- [ ] **Step 2:** Add all 17 hooks to `queries.ts`.
- [ ] **Step 3:** Convert all 17 call sites, choosing narrow vs. `invalidateEverything` per the note above.
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 5:** Commit.

## Task 12: Setup wizard + ingest health — `SetupWizard.tsx` + `IngestHealthPanel`

**Files:**
- Modify: `web/src/queries.ts` (add `useSetupResolveMutation`, `useSetupPlanMutation`, `useSetupPreviewMutation`, `useSetupDiscoverMutation`, `useSetupIngestMutation`, `useSetupCustomMutation`, `useSetupSampleMutation`, `useSetupPacksQuery`, `useSetupPackMutation`, `useSetupJobQuery` (Pattern F, shown above — the polling one), `useSetupCancelMutation`, `useSetupCharactersQuery`, `useSetupPlayerMutation`, `useSetupResetMutation`, `useRebuildCanonMutation`, `useIngestHealthQuery`, `useSetupContinueMutation`)
- Modify: `web/src/views/SetupWizard.tsx` (18 call sites)
- Modify: `App.tsx`'s `IngestHealthPanel` (3 call sites: `ingestHealth()`, the job-polling one, `continue()`)

**Interfaces:**
- Produces: `useSetupJobQuery` is the key deliverable — it replaces manual polling in both files with the same `refetchInterval` hook. Confirm the stop condition (`status !== 'running'`) matches exactly what the current manual poll loop checks before assuming Pattern F's example condition is correct — re-read `Job['status']`'s type (`'running' | 'done' | 'failed' | 'cancelled'`) and each poll site's current stop check.

- [ ] **Step 1:** Read `web/src/views/SetupWizard.tsx` in full and re-grep `App.tsx`'s `IngestHealthPanel`.
- [ ] **Step 2:** Add all 17 hooks.
- [ ] **Step 3:** Convert all 21 call sites (18 + 3).
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 5:** Commit.

## Task 13: Providers & images — `ImageProvidersPanel`, `ProvidersPanel`

**Files:**
- Modify: `web/src/queries.ts` (add `useImageStatusQuery`, `useImageProvidersQuery`, `useSetImageProfileMutation`, `useProvidersQuery`, `useSetProfileMutation`)
- Modify: `App.tsx`'s `ImageProvidersPanel` (3 call sites) and `ProvidersPanel` (3 call sites)

- [ ] **Step 1:** Re-grep for current lines, read both panel functions.
- [ ] **Step 2:** Add 5 hooks, convert 6 call sites.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4:** Commit.

## Task 14: Illustration + Sheet editing — `Illustration.tsx`, `SheetEditor.tsx`, delete `createSheetSaveQueue`

**Files:**
- Modify: `web/src/queries.ts` (add `useIllustrationsForTurnQuery`, `useIllustrationsForEntityQuery`, `usePortraitMutation`, `useScenePortraitPromptQuery` or mutation as appropriate (re-check: `portraitPrompt`/`scenePrompt` are `req()` i.e. GET-shaped, not `post()` — Pattern A/B, not C, despite being triggered by a button click; a query triggered on-click is still a query, just gate it with `enabled`/manual `refetch()` rather than forcing it into `useMutation`), `useIllustrateSceneMutation`, `useRemoveIllustrationMutation`, `useSaveSheetMutation` (Pattern H, shown above))
- Modify: `web/src/views/Illustration.tsx` (13 call sites)
- Modify: `web/src/views/SheetEditor.tsx` (1 call site — but it's the one wired through `createSheetSaveQueue`, so this is where the queue actually gets deleted)
- Delete: `web/src/views/sheetSaveQueue.ts`, `test/sheet-save-queue.test.ts` (after confirming zero remaining references)

**Interfaces:**
- Consumes: Pattern H exactly. `Illustration.tsx`'s L152/L212 `api.saveSheet` calls and `SheetEditor.tsx`'s L107 call must all go through the *same* `useSaveSheetMutation(entityId)` (same `scope.id`) so that a save triggered from the illustration panel and one triggered from the sheet editor for the same entity still serialize against each other — check whether that cross-component serialization is actually needed today (i.e., can both panels be open/saving the same entity at once currently?) before assuming it; if `createSheetSaveQueue` instances were always local to `SheetEditor.tsx` alone (not shared with `Illustration.tsx`), a shared scope id is still correct (it can only add safety, never remove it) — verify this reasoning holds by reading both files' current code, don't just assume.

- [ ] **Step 1:** Read `web/src/views/Illustration.tsx` and `web/src/views/SheetEditor.tsx` in full.
- [ ] **Step 2:** Add hooks; note two of the `portraitPrompt`/`scenePrompt` call sites are on-click "compute a prompt" actions with `state: no` per the catalog (no loading/error UI currently) — a `useQuery` with `enabled: false` + manual `.refetch()` matches "fetch on click, no persistent loading UI" better than forcing a `useMutation`; pick whichever reads more naturally once you see the actual click handler, and note the choice.
- [ ] **Step 3:** Convert all 14 call sites (13 + 1).
- [ ] **Step 4:** `rg -n "createSheetSaveQueue|sheetSaveQueue"` — if only the files being deleted remain, delete `web/src/views/sheetSaveQueue.ts` and `test/sheet-save-queue.test.ts`.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** Commit.

## Task 15: Final integration pass — full verification

**Files:** none (verification-only task; fix whatever `git diff` review or testing turns up, wherever it lives)

- [ ] **Step 1:** `rg -n "api\." web/src --glob '!api.ts' --glob '!queries.ts'` — this should now return **zero** hits (every direct `api.*` call from a component should be gone; only `queries.ts` calls `api.*` directly). Any remaining hit is a missed call site — go fix it in the relevant task above before continuing.
- [ ] **Step 2:** `rg -n "useState.*loading|useState.*Loading" web/src` — sanity-check for leftover dead loading-state variables that Pattern A/C's `isLoading`/`isPending` should have replaced; remove any that are now unused (a stale unused `useState` is a lint error anyway, so `pnpm lint` should already catch most of these).
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test` — full green run.
- [ ] **Step 4:** `pnpm dev:web` (and separately, if needed, the backend `pnpm serve` or `pnpm serve-sqlite` per README/dev setup) to run the app locally.
- [ ] **Step 5:** Browser walkthrough via Playwright MCP tools, covering every domain touched above: sign-in/session banner, private-storage/encryption enroll+unlock+lock, pick/switch/fork/create/delete a story, switch/create/rename/delete a world, play a turn (both streaming and the non-streaming path if reachable), paginate the book view (scroll/load-more), open the graph tab and search an entity, view cast, rollback/split a scene, view timeline, threads (create/update/retire directive), facts (grant/revoke knowledge), causality view + tick, settings (style/knobs/anchors), config panels (patch config, block/unblock a phrase, add/remove/test a provider), setup wizard end-to-end for a fresh world (resolve → plan → preview/discover → ingest, watching the job-polling UI update live), image/text provider probes, illustration (generate a portrait/scene, view prompt, remove), sheet editor (save a field, confirm no lost/overwritten edits under rapid successive saves — this exercises the mutation-scope replacement for the save queue directly).
- [ ] **Step 6:** For every regression found during the walkthrough: fix it immediately (this is explicitly in scope per the user's request — "not new bugs introduced, new bugs identified fixed"), re-test, re-walk that specific flow.
- [ ] **Step 7:** Final commit, then report: summary of what changed, the "config/blocklist cross-sync" behavior improvement noted in Task 6, any regressions found+fixed during the walkthrough, and confirmation that `pnpm typecheck && pnpm lint && pnpm test` are green.
