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
import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api.ts';

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
