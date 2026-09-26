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
import {
  MutationCache,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  api,
  setSelectedStoryId,
  type AppConfig,
  type CharacterSketch,
  type ConfigBundle,
  type IngestBudgetOverrides,
  type Job,
  type Knobs,
  type PatchResult,
  type ProviderSpec,
  type RollbackTarget,
  type Sheet,
  type Story,
  type StyleContract,
  type Thread,
  type VisualStyle,
  type WikiCandidate,
} from './api.ts';

/**
 * Shared by both entry points (`main.tsx`, `landing/main.tsx` — separate
 * `QueryClient`s, same policy).
 *
 * `retry: false` / `refetchOnWindowFocus: false`: the app this replaces was
 * a one-shot `fetch()` per action, with no retry and no refetch-on-focus.
 * Leaving these at TanStack Query's defaults (3 retries, refetch on window
 * focus) would be a real behavior change — a failing request would now
 * silently retry for several seconds before surfacing an error, and
 * switching back to the tab would trigger a wave of background refetches
 * the original app never did.
 *
 * `mutationCache.onError`: `useMutation`'s `mutate()` (as opposed to
 * `mutateAsync()`) deliberately swallows the rejection so a fire-and-forget
 * call site never produces a real unhandled-rejection event — several call
 * sites (world tick, knowledge grant/revoke, setup cancel, the inline
 * blocklist button) call bare `.mutate()` with no local error display. The
 * original app's only error-surfacing mechanism for an action with no local
 * recovery was exactly that global unhandled-rejection listener (see
 * `App.tsx`'s comment on it), so a mutation failure with no local handling
 * would otherwise now fail completely silently. `MutationCache`'s global
 * `onError` is guaranteed to run for every mutation regardless of any
 * per-mutation `onError` (unlike `defaultOptions`, which a call site can
 * override) — dispatching a DOM event keeps this file decoupled from
 * `App.tsx`'s React state; `App.tsx` listens for `fabulist:mutation-error`
 * alongside `unhandledrejection`/`error` in the same effect.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        window.dispatchEvent(new CustomEvent('fabulist:mutation-error', { detail: error }));
      },
    }),
  });
}

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

export const providerKeyKeys = { all: ['provider-key'] as const };
export const usageKeys = {
  all: ['usage'] as const,
  mine: (days: number) => ['usage', 'mine', days] as const,
  byUser: (days: number) => ['usage', 'by-user', days] as const,
};

export function useEncryptionKeysQuery(enabled: boolean) {
  return useQuery({ queryKey: encryptionKeys.keys, queryFn: api.encryption.keys, enabled });
}

export function useEncryptionMigrationQuery(enabled: boolean) {
  return useQuery({ queryKey: encryptionKeys.migration, queryFn: api.encryption.migration, enabled });
}

/**
 * These four don't invalidate the encryption reads on success: `App.tsx`'s
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.encryption.unlock,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useLockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.encryption.lock(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useMigrateMutation() {
  return useMutation({ mutationFn: api.encryption.migrate });
}

// ---------------------------------------------------------------- my provider

export function useProviderKeyQuery(enabled: boolean) {
  return useQuery({ queryKey: providerKeyKeys.all, queryFn: api.providerKey.get, enabled, retry: false });
}

export function useSaveProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.save,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useDeleteProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.remove,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: providerKeyKeys.all }),
  });
}

export function useTestProviderKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.providerKey.test,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: usageKeys.all }),
  });
}

export function useProviderModelsMutation() {
  return useMutation({ mutationFn: api.providerKey.models });
}

export function useMyUsageQuery(days: number, enabled: boolean) {
  return useQuery({ queryKey: usageKeys.mine(days), queryFn: () => api.usage.mine(days), enabled });
}

export function useUsageByUserQuery(days: number, enabled: boolean) {
  return useQuery({ queryKey: usageKeys.byUser(days), queryFn: () => api.usage.byUser(days), enabled });
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
 *
 * `addAnchor` is the exception: it still invalidates `['anchors']` below,
 * since `SettingsTab` (Task 10) now reads that key and would otherwise go
 * stale after `BookTab`'s "pin + add anchor" flow.
 */
export function useAddAnchorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { text: string; note: string }) => api.addAnchor(vars.text, vars.note),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: anchorsKeys.all }),
  });
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

// -------------------------------------------------------------- facts / causality

export const factsKeys = { all: ['facts'] as const };

export function useFactsQuery() {
  return useQuery({ queryKey: factsKeys.all, queryFn: api.facts });
}

export function useRevokeKnowledgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { factId: string; entityId: string }) => api.revokeKnowledge(vars.factId, vars.entityId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: factsKeys.all }),
  });
}

export function useGrantKnowledgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { factId: string; entityId: string; level: string }) =>
      api.grantKnowledge(vars.factId, vars.entityId, vars.level),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: factsKeys.all }),
  });
}

export const consequencesKeys = { all: ['consequences'] as const };

export function useConsequencesQuery() {
  return useQuery({ queryKey: consequencesKeys.all, queryFn: api.consequences });
}

export function useTickMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.tick,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: consequencesKeys.all }),
  });
}

// -------------------------------------------------------------------- settings

export const styleKeys = { all: ['style'] as const };

export function useStyleQuery() {
  return useQuery({ queryKey: styleKeys.all, queryFn: api.style });
}

export function useSetStyleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<StyleContract>) => api.setStyle(patch),
    onSuccess: (result) => queryClient.setQueryData(styleKeys.all, result),
  });
}

export const knobsKeys = { all: ['knobs'] as const };

export function useKnobsQuery() {
  return useQuery({ queryKey: knobsKeys.all, queryFn: api.knobs });
}

export function useSetKnobsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Knobs>) => api.setKnobs(patch),
    onSuccess: (result) => queryClient.setQueryData(knobsKeys.all, result),
  });
}

export const anchorsKeys = { all: ['anchors'] as const };

export function useAnchorsQuery() {
  return useQuery({ queryKey: anchorsKeys.all, queryFn: api.anchors });
}

// ------------------------------------------------------------- stories / worlds

export const storiesKeys = {
  all: ['stories'] as const,
  unowned: ['stories', 'unowned'] as const,
};

export function useStoriesQuery() {
  return useQuery({ queryKey: storiesKeys.all, queryFn: api.stories.list });
}

/** Swallows a failed fetch into an empty list, same as the old `.catch(() => [])` at the call site. */
export function useUnownedStoriesQuery() {
  return useQuery({ queryKey: storiesKeys.unowned, queryFn: () => api.stories.unowned().catch(() => [] as Story[]) });
}

export const worldsKeys = { all: ['worlds'] as const };

export function useWorldsQuery() {
  return useQuery({ queryKey: worldsKeys.all, queryFn: api.worlds.list });
}

export function useCreateStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => api.stories.create(title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: storiesKeys.all }),
  });
}

/** Branches a story without switching to it — `StoriesTab`'s old handler only ever re-fetched the story list. */
export function useForkStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { fromStoryId: string; title?: string; atScene?: number }) =>
      api.stories.fork(vars.fromStoryId, vars.title, vars.atScene),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: storiesKeys.all }),
  });
}

/** Pattern D: a story switch changes what every cached view means, so this reloads everything, matching today's `App.refresh()` broadcast. */
export function useSwitchStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) => api.stories.switchTo(storyId),
    onSuccess: (_data, storyId) => {
      setSelectedStoryId(storyId);
      return invalidateEverything(queryClient);
    },
  });
}

export function useRenameStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; title: string }) => api.stories.rename(vars.id, vars.title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: storiesKeys.all }),
  });
}

export function useRemoveStoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.stories.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: storiesKeys.all }),
  });
}

/** Backs both the single-book and "claim all" buttons — `id` omitted claims every unowned book. */
export function useClaimStoriesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) => api.stories.claim(id),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: storiesKeys.all }),
        queryClient.invalidateQueries({ queryKey: storiesKeys.unowned }),
      ]),
  });
}

/**
 * Changes which worlds this story reads — i.e. its canon — so every cached
 * view is stale afterward, "the same thing a world switch used to require"
 * (see `App.tsx`'s `toggleSource`, which this replaces).
 */
export function useSetSourcesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slugs: string[]) => api.story.setSources(slugs),
    onSuccess: () => invalidateEverything(queryClient),
  });
}

export function useCreateWorldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => api.worlds.create(title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: worldsKeys.all }),
  });
}

export function useRenameWorldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; title: string }) => api.worlds.rename(vars.slug, vars.title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: worldsKeys.all }),
  });
}

export function useRemoveWorldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.worlds.remove(slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: worldsKeys.all }),
  });
}

export function useSetWorldVisibilityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; visibility: 'public' | 'private' }) =>
      api.worlds.setVisibility(vars.slug, vars.visibility),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: worldsKeys.all }),
  });
}

// ------------------------------------------------------------------- setup

export const providersKeys = { all: ['providers'] as const };

/** `enabled` defaults to `true` for `SetupWizard.tsx`'s eager use; `App.tsx`'s `ProvidersPanel` passes `false` since its probe is deliberately on-demand (touches local ports/credential helpers) and triggers via `refetch()` instead. */
export function useProvidersQuery(enabled = true) {
  return useQuery({ queryKey: providersKeys.all, queryFn: api.providers, enabled });
}

/** Text-model profile switch — shared by `SetupWizard.tsx` and `App.tsx`'s `ProvidersPanel`. */
export function useSetProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: string) => api.setProfile(profile),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersKeys.all }),
  });
}

// ------------------------------------------------------------------ images

export const imageProvidersKeys = { all: ['images', 'providers'] as const };

export function useImageProvidersQuery() {
  return useQuery({ queryKey: imageProvidersKeys.all, queryFn: api.images.providers });
}

export function useSetImageProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: string | null) => api.images.setProfile(profile),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: imageProvidersKeys.all }),
  });
}

export const setupJobKeys = { detail: (id: string) => ['setup', 'job', id] as const };

/**
 * Polls while `status === 'running'`; `'done' | 'failed' | 'cancelled'` all
 * stop it. Matches both manual `setInterval(tick, 700)` loops it replaces
 * (`SetupWizard.tsx`'s job effect and `App.tsx`'s `IngestHealthPanel`) —
 * same 700ms cadence, same stop condition, shared by both call sites since
 * they poll the identical `/setup/job/:id` resource.
 */
export function useSetupJobQuery(jobId: string | null) {
  return useQuery({
    queryKey: setupJobKeys.detail(jobId ?? ''),
    queryFn: () => api.setup.job(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 700 : false),
  });
}

/** Seeds the job cache with a start-mutation's own response, so the first render shows real progress instead of an empty state until the first poll lands. */
function seedJob(queryClient: QueryClient, job: Job) {
  queryClient.setQueryData(setupJobKeys.detail(job.id), job);
}

export function useSetupResolveMutation() {
  return useMutation({ mutationFn: (query: string) => api.setup.resolve(query) });
}

export function useSetupPlanMutation() {
  return useMutation({
    mutationFn: (vars: { wish: string; wiki: WikiCandidate }) => api.setup.plan(vars.wish, vars.wiki),
  });
}

export function useSetupDiscoverMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      baseUrl: string;
      seeds: string[];
      mode: string;
      character: CharacterSketch;
      excludeCategories: string[];
      title: string;
      budgets: IngestBudgetOverrides;
    }) =>
      api.setup.discover(vars.baseUrl, vars.seeds, vars.mode, vars.character, vars.excludeCategories, vars.title, vars.budgets),
    onSuccess: (job) => seedJob(queryClient, job),
  });
}

export function useSetupIngestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { previewKey: string; character: CharacterSketch; style: Partial<StyleContract>; opening: string }) =>
      api.setup.ingest(vars.previewKey, vars.character, vars.style, vars.opening),
    onSuccess: (job) => seedJob(queryClient, job),
  });
}

export function useSetupCustomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (description: string) => api.setup.custom(description),
    onSuccess: (job) => seedJob(queryClient, job),
  });
}

export const setupPacksKeys = { all: ['setup', 'packs'] as const };

/** Fetched on demand, not on mount: most sessions never open the gallery, and it's static content for the session. */
export function useSetupPacksQuery(enabled: boolean) {
  return useQuery({ queryKey: setupPacksKeys.all, queryFn: api.setup.packs, enabled });
}

export function useSetupPackMutation() {
  return useMutation({
    mutationFn: (vars: { packId: string; scenarioId?: string }) => api.setup.pack(vars.packId, vars.scenarioId),
  });
}

export function useSetupCancelMutation() {
  return useMutation({ mutationFn: (id: string) => api.setup.cancel(id) });
}

export const setupCharactersKeys = { all: ['setup', 'characters'] as const };

export function useSetupCharactersQuery(enabled: boolean) {
  return useQuery({ queryKey: setupCharactersKeys.all, queryFn: api.setup.characters, enabled });
}

export function useSetupPlayerMutation() {
  return useMutation({ mutationFn: (sketch: Partial<CharacterSketch>) => api.setup.setPlayer(sketch) });
}

export function useSetupResetMutation() {
  return useMutation({ mutationFn: () => api.setup.reset() });
}

export function useRebuildCanonMutation() {
  return useMutation({ mutationFn: () => api.setup.rebuildCanon() });
}

export const ingestHealthKeys = { all: ['setup', 'ingestHealth'] as const };

export function useIngestHealthQuery() {
  return useQuery({ queryKey: ingestHealthKeys.all, queryFn: api.setup.ingestHealth });
}

export function useSetupContinueMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (overrides: Parameters<typeof api.setup.continue>[0]) => api.setup.continue(overrides),
    onSuccess: (job) => seedJob(queryClient, job),
  });
}

// ------------------------------------------------------- illustrate / sheet

export const imageStatusKeys = { all: ['images', 'status'] as const };

export function useImageStatusQuery() {
  return useQuery({ queryKey: imageStatusKeys.all, queryFn: api.images.status });
}

export const illustrationKeys = {
  forEntity: (entityId: string) => ['illustrations', 'entity', entityId] as const,
  forTurn: (turnId: string) => ['illustrations', 'turn', turnId] as const,
};

export function useIllustrationsForEntityQuery(entityId: string) {
  return useQuery({ queryKey: illustrationKeys.forEntity(entityId), queryFn: () => api.illustrate.forEntity(entityId) });
}

export function useIllustrationsForTurnQuery(turnId: string) {
  return useQuery({ queryKey: illustrationKeys.forTurn(turnId), queryFn: () => api.illustrate.forTurn(turnId) });
}

export function usePortraitMutation(entityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visualStyle: VisualStyle) => api.illustrate.portrait(entityId, visualStyle),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: illustrationKeys.forEntity(entityId) }),
  });
}

export function useIllustrateSceneMutation(turnId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visualStyle: VisualStyle) => api.illustrate.scene(turnId, visualStyle),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: illustrationKeys.forTurn(turnId) }),
  });
}

/** On-demand prompt fetches (no persistent loading UI): `enabled: false` + the caller's own `.refetch()` on click. */
export function usePortraitPromptQuery(entityId: string, visualStyle: VisualStyle) {
  return useQuery({
    queryKey: ['illustrate', 'portraitPrompt', entityId, visualStyle],
    queryFn: () => api.illustrate.portraitPrompt(entityId, visualStyle),
    enabled: false,
  });
}

export function useScenePromptQuery(turnId: string, visualStyle: VisualStyle) {
  return useQuery({
    queryKey: ['illustrate', 'scenePrompt', turnId, visualStyle],
    queryFn: () => api.illustrate.scenePrompt(turnId, visualStyle),
    enabled: false,
  });
}

/** No built-in invalidation: portrait/scene discard each refetch their own gallery query afterward, so this stays a bare wrapper. */
export function useRemoveIllustrationMutation() {
  return useMutation({ mutationFn: (illustrationId: string) => api.illustrate.remove(illustrationId) });
}

type CastEntry = Awaited<ReturnType<typeof api.cast>>[number];

/**
 * Pattern H: serializes writes via `scope` so concurrent saves for the same
 * entity (portrait discard, appearance blur, vow edits — all three panels
 * are mounted together in `CastTab`) queue instead of racing, and each
 * patch is built from the *currently cached* sheet (`['cast']`, the only
 * place a `Sheet` lives client-side) rather than a stale closed-over prop,
 * reproducing `createSheetSaveQueue`'s `latest`-tracking without the queue.
 */
export function useSaveSheetMutation(entityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `sheet-save-${entityId}` },
    mutationFn: (buildPatch: (sheet: Sheet) => Partial<Sheet>) => {
      const current = queryClient.getQueryData<CastEntry[]>(castKeys.all)?.find((c) => c.sheet.entityId === entityId)?.sheet;
      if (!current) throw new Error(`no cached sheet for entity ${entityId}`);
      return api.saveSheet(entityId, buildPatch(current));
    },
    onSuccess: (updated) =>
      queryClient.setQueryData<CastEntry[]>(castKeys.all, (old) =>
        old?.map((c) => (c.sheet.entityId === entityId ? { ...c, sheet: updated } : c)),
      ),
  });
}

/**
 * `api.lock`'s response is untyped (`post<unknown>`), so unlike
 * `useSaveSheetMutation` there is no returned sheet to write into the cache
 * — `CastTab`'s call site keeps its existing explicit `load()` afterward,
 * same as several other mutations in this file that don't self-invalidate.
 */
export function useLockSheetFieldMutation() {
  return useMutation({
    mutationFn: (vars: { id: string; path: string; locked: boolean }) => api.lock(vars.id, vars.path, vars.locked),
  });
}
