/**
 * TanStack Query hooks for the inspector.
 *
 * Mirrors `api.ts`'s grouping: one query-key factory plus one or more
 * `useQuery`/`useMutation`/`useInfiniteQuery` hooks per domain, in the order
 * `api.ts` defines them. Components call these instead of `api.*` directly —
 * `api.ts` itself stays the `queryFn`/`mutationFn` implementation layer.
 *
 * See `docs/superpowers/plans/2026-09-19-frontend-tanstack-query.md` for the
 * migration plan this file is built up task-by-task against.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type AppConfig, type ConfigBundle, type PatchResult, type ProviderSpec, type RollbackTarget, type Thread } from './api.ts';

// --------------------------------------------------------------- meta / auth

export const metaKeys = { all: ['meta'] as const };

/** `m.version` is optional (older servers predate the field) — callers read `data?.version`. */
export function useMetaQuery() {
  return useQuery({ queryKey: metaKeys.all, queryFn: api.meta });
}

export const authKeys = { me: ['auth', 'me'] as const };

/** `{ user: null }` (a 200, not an error) is the honest "not signed in" answer — see `api.auth.me`'s doc comment. */
export function useCurrentUserQuery() {
  return useQuery({ queryKey: authKeys.me, queryFn: api.auth.me });
}

/**
 * Clears the server-side session cookie. Callers must still hard-navigate
 * afterward (see `App.tsx`'s `signOut`) — this mutation does not touch any
 * client state itself.
 */
export function useLogoutMutation() {
  return useMutation({ mutationFn: api.auth.logout });
}

// ---------------------------------------------------------------- encryption

/** `all` is the shared prefix used to invalidate both reads together (see `App.tsx`'s `refreshAfterPrivateStorageChange`). */
export const encryptionKeys = {
  all: ['encryption'] as const,
  keys: ['encryption', 'keys'] as const,
  migration: ['encryption', 'migration'] as const,
};

export function useEncryptionKeysQuery(enabled: boolean) {
  return useQuery({ queryKey: encryptionKeys.keys, queryFn: api.encryption.keys, enabled });
}

export function useEncryptionMigrationQuery(enabled: boolean) {
  return useQuery({ queryKey: encryptionKeys.migration, queryFn: api.encryption.migration, enabled });
}

/**
 * These four don't invalidate on success themselves: `App.tsx`'s
 * `PrivateStoragePanel` already calls its `onChanged` prop at the exact
 * point each handler used to re-fetch (and, for `unlock`, only on some
 * outcomes — an empty grant list throws before ever re-fetching), so
 * duplicating that as a blanket `onSuccess` invalidate here would either
 * race it or invalidate on paths that today never re-fetch.
 */
export function useEnrollMutation() {
  return useMutation({ mutationFn: api.encryption.enroll });
}

export function useUnlockMutation() {
  return useMutation({ mutationFn: api.encryption.unlock });
}

export function useLockMutation() {
  return useMutation({ mutationFn: () => api.encryption.lock() });
}

export function useMigrateMutation() {
  return useMutation({ mutationFn: api.encryption.migrate });
}

// ------------------------------------------------------------- core story state

export const stateKeys = { all: ['state'] as const };

/**
 * `retry: false`: the old code fetched `api.state()` once per `refresh()`
 * call with no retry, and `App.tsx`'s locked-private-story handling needs
 * a failure to settle immediately rather than spend several seconds
 * retrying a 403 that will not go away until the story is unlocked.
 */
export function useStateQuery() {
  return useQuery({ queryKey: stateKeys.all, queryFn: api.state, retry: false });
}

export const setupStatusKeys = { all: ['setupStatus'] as const };

/**
 * Also one-shot: an older server without this route fails every time, and
 * `App.tsx` treats any error here as "setup routes disabled" (mirroring the
 * old `.catch(() => null)`) — retrying would only delay that decision.
 */
export function useSetupStatusQuery() {
  return useQuery({ queryKey: setupStatusKeys.all, queryFn: api.setup.status, retry: false });
}

/** Story/world switch: reload everything, matching today's `App.refresh()` broadcast. */
export function invalidateEverything(queryClient: QueryClient) {
  return queryClient.invalidateQueries();
}

// ------------------------------------------------------ graph / entity / search / cast

export const graphKeys = {
  list: (params: { layer?: string; type?: string; minWeight?: number }) => ['graph', params] as const,
};

export function useGraphQuery(params: { layer?: string; type?: string; minWeight?: number }) {
  return useQuery({ queryKey: graphKeys.list(params), queryFn: () => api.graph(params) });
}

export const entityKeys = { detail: (id: string) => ['entity', id] as const };

/** `enabled: id !== null` mirrors `GraphTab`'s old "selection cleared → clear detail" short-circuit. */
export function useEntityQuery(id: string | null) {
  return useQuery({ queryKey: entityKeys.detail(id ?? ''), queryFn: () => api.entity(id as string), enabled: id !== null });
}

export const searchKeys = { query: (q: string) => ['search', q] as const };

/** `enabled: query.length > 0` mirrors the old effect's early return on an empty/whitespace query. */
export function useSearchQuery(query: string) {
  return useQuery({ queryKey: searchKeys.query(query), queryFn: () => api.search(query), enabled: query.length > 0 });
}

export const castKeys = { all: ['cast'] as const };

export function useCastQuery() {
  return useQuery({ queryKey: castKeys.all, queryFn: api.cast });
}

// --------------------------------------------------------------- book / turn / play

export const bookKeys = { all: ['book'] as const };

/**
 * `BookTab` has no "load more" control — it always wants the whole book —
 * so it drives `fetchNextPage` itself in an effect until `hasNextPage` is
 * false, rather than exposing pagination to the UI. `nextOffset` doubles as
 * v5's "no more pages" sentinel (`null`).
 */
export function useBookInfiniteQuery() {
  return useInfiniteQuery({
    queryKey: bookKeys.all,
    queryFn: ({ pageParam }) => api.book({ offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });
}

export const turnKeys = { detail: (id: string) => ['turn', id] as const };

/** `enabled: id !== null` — `BookTab` only ever wants the last loaded turn's meta, for the why panel. */
export function useTurnQuery(id: string | null) {
  return useQuery({ queryKey: turnKeys.detail(id ?? ''), queryFn: () => api.turn(id as string), enabled: id !== null });
}

/** Internals (the `onStage`/`onToken`/`onDone`/`onError` callbacks, the abort signal) stay in `BookTab` — this only wraps the call. */
export function usePlayStreamMutation() {
  return useMutation({
    mutationFn: (vars: { input: string; overrideIntegrity: boolean; handlers: Parameters<typeof api.playStream>[2] }) =>
      api.playStream(vars.input, vars.overrideIntegrity, vars.handlers),
  });
}

export function useCloseSceneMutation() {
  return useMutation({ mutationFn: api.closeScene });
}

export const chaptersKeys = { all: ['chapters'] as const };

/** A GET, not a write: `BookTab` fetches this on demand when the rollback panel opens, not on every book load. */
export function useChaptersQuery(enabled: boolean) {
  return useQuery({ queryKey: chaptersKeys.all, queryFn: api.chapters, enabled });
}

export function useRollbackMutation() {
  return useMutation({ mutationFn: (target: RollbackTarget & { mode?: 'fork' | 'destructive' }) => api.rollback(target) });
}

export function useSplitSceneMutation() {
  return useMutation({ mutationFn: (turnId: string) => api.splitScene(turnId) });
}

export function useRegenerateMutation() {
  return useMutation({ mutationFn: (vars: { id: string; note?: string }) => api.regenerate(vars.id, vars.note) });
}

export function usePinMutation() {
  return useMutation({ mutationFn: (vars: { id: string; pinned: boolean }) => api.pin(vars.id, vars.pinned) });
}

/**
 * None of these six invalidate `['book']` themselves: `BookTab`'s handlers
 * already call `reloadBook()`/`onChanged()` at the exact points the old code
 * called `load()`/`onChanged()`, each with its own per-action notes/error
 * message — duplicating that as a blanket `onSuccess` here would either
 * race it or invalidate on paths (e.g. `regenerate`, which never calls
 * `onChanged()`) that today don't broadcast a change.
 */
export function useAddAnchorMutation() {
  return useMutation({ mutationFn: (vars: { text: string; note: string }) => api.addAnchor(vars.text, vars.note) });
}

// ------------------------------------------------------------------ timeline

export const timelineKeys = { all: ['timeline'] as const };

export function useTimelineQuery() {
  return useQuery({ queryKey: timelineKeys.all, queryFn: api.timeline });
}

// ------------------------------------------------------------------- threads

export const threadsKeys = { all: ['threads'] as const };

export function useThreadsQuery() {
  return useQuery({ queryKey: threadsKeys.all, queryFn: api.threads });
}

export function useCreateThreadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { title: string; stakes: string }) => api.createThread(vars.title, vars.stakes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadsKeys.all }),
  });
}

export function useUpdateThreadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Thread> }) => api.updateThread(vars.id, vars.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadsKeys.all }),
  });
}

/** Raising/lowering threads is exactly what a directive can do — the old handler's `await load()` re-fetch becomes an invalidate here too. */
export function useAddDirectiveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { text: string; strength: string }) => api.addDirective(vars.text, vars.strength),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: threadsKeys.all }),
  });
}

/** The old handler never re-fetched threads on retire (only `onChanged()`, which refreshes `state.directives`) — no invalidate here either. */
export function useRetireDirectiveMutation() {
  return useMutation({ mutationFn: (directiveId: string) => api.retireDirective(directiveId) });
}

// -------------------------------------------------------------------- config

export const configKeys = { all: ['config'] as const };

export function useConfigQuery() {
  return useQuery({ queryKey: configKeys.all, queryFn: api.config.get });
}

/**
 * Shared by every config write below. Writes it to the cache immediately
 * (this is server-confirmed data from the response, not a guess) so a
 * blocklist toggle or patch is visible without waiting on a round trip, then
 * invalidates to pick up anything `PatchResult` doesn't carry — e.g. a
 * provider add/remove also changes `providerKeys`/`presets`. This is what
 * `ConfigPanels.tsx`'s old `apply()` did by hand with a second
 * `api.config.get()` call after every write.
 *
 * `App.tsx`'s `WhyPanel` block button and `ConfigPanels.tsx` share this one
 * `['config']` cache entry via `useBlockMutation`, so a blocklist toggle from
 * either place is now reflected in the other — previously these were two
 * independent, un-synced fetches.
 */
function onConfigWriteSuccess(queryClient: QueryClient, result: PatchResult) {
  queryClient.setQueryData(configKeys.all, (prev: ConfigBundle | undefined) =>
    prev ? { ...prev, config: result.config } : prev,
  );
  void queryClient.invalidateQueries({ queryKey: configKeys.all });
}

export function useConfigPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (partial: Partial<AppConfig>) => api.config.patch(partial),
    onSuccess: (result) => onConfigWriteSuccess(queryClient, result),
  });
}

export function useBlockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phrase: string) => api.config.block(phrase),
    onSuccess: (result) => onConfigWriteSuccess(queryClient, result),
  });
}

export function useUnblockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phrase: string) => api.config.unblock(phrase),
    onSuccess: (result) => onConfigWriteSuccess(queryClient, result),
  });
}

export function useRemoveProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.config.removeProvider(key),
    onSuccess: (result) => onConfigWriteSuccess(queryClient, result),
  });
}

export function usePutProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; spec: ProviderSpec }) => api.config.putProvider(vars.key, vars.spec),
    onSuccess: (result) => onConfigWriteSuccess(queryClient, result),
  });
}

/** A probe, not a write: it contacts the provider to check reachability/credentials but never touches saved config, so nothing to invalidate. */
export function useTestProviderMutation() {
  return useMutation({
    mutationFn: (vars: { key: string; spec: ProviderSpec }) => api.config.testProvider(vars.key, vars.spec),
  });
}
