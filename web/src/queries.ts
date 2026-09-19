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
import { useMutation, useQuery } from '@tanstack/react-query';
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
