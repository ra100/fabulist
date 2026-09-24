/**
 * WorkOS AuthKit as an `AuthProvider` — the hosted default, and what this
 * server did directly before there was an interface to sit behind.
 *
 * Every line here was previously inline in `config.ts`/`routes.ts`; the three
 * methods are the three SDK calls those two files made, moved and not
 * otherwise changed. The session cookie stays WorkOS's own sealed session
 * (`sealSession`/`loadSealedSession`), so an existing deployment's live cookies
 * keep working across this refactor — that is the point of wrapping the SDK
 * rather than reimplementing AuthKit as "just another OIDC issuer", which it
 * very nearly is but not quite: the SDK owns the cookie format, the refresh
 * dance, and the organization/impersonation claims a hand-rolled exchange
 * would silently drop.
 *
 * `workos` is injected rather than constructed here so tests can drive the
 * three seams (`test/auth-redirect.test.ts`, `test/auth-config.test.ts`)
 * without a WorkOS account, and so `resolveAuthConfig` stays the one place
 * that reads credentials out of the environment.
 */
import type { WorkOS } from '@workos-inc/node';
import type { AuthIdentity, AuthProvider, AuthorizationRequest, CodeExchange, ResolvedSession } from './provider.ts';

export interface WorkosProviderOptions {
  workos: WorkOS;
  clientId: string;
  cookiePassword: string;
}

function toIdentity(user: {
  id: string;
  email: string;
  emailVerified?: boolean;
  firstName: string | null;
  lastName: string | null;
}): AuthIdentity {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified === true,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

export function createWorkosProvider({ workos, clientId, cookiePassword }: WorkosProviderOptions): AuthProvider {
  return {
    async authorize({ redirectUri, state }: AuthorizationRequest) {
      // `state` is appended to the URL the SDK builds rather than passed in:
      // `getAuthorizationUrlWithPKCE` has no state parameter, and this server
      // generates and consumes its own one-use state anyway (see
      // `routes.ts`) — AuthKit round-trips whatever is in the query.
      const { url, codeVerifier } = await workos.userManagement.getAuthorizationUrlWithPKCE({
        clientId,
        provider: 'authkit',
        redirectUri,
      });
      const authorizationUrl = new URL(url);
      authorizationUrl.searchParams.set('state', state);
      return { url: authorizationUrl.toString(), codeVerifier };
    },

    async exchangeCode({ code, codeVerifier }: CodeExchange) {
      const result = await workos.userManagement.authenticateWithCode({
        clientId,
        code,
        codeVerifier,
        session: { sealSession: true, cookiePassword },
      });
      if (!result.sealedSession) throw new Error('WorkOS did not return a sealed session');
      return { sealedSession: result.sealedSession };
    },

    /**
     * `invalid_jwt` is the one failure that is not "signed out": it means the
     * *access* token sealed inside the cookie has expired, which WorkOS does on
     * the order of an hour, while the cookie itself is good for
     * `SESSION_MAX_AGE_SECONDS` (14 days) because it also carries a refresh
     * token. Refreshing and re-sealing is what makes the cookie's stated
     * lifetime what a user actually experiences, rather than "logged out
     * roughly every hour because nothing ever called `session.refresh()`".
     * Every other failure reason — a tampered or unsealable cookie, a revoked
     * or expired refresh token — is just "not signed in".
     */
    async resolveSession(sealed: string): Promise<ResolvedSession | null> {
      const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
      const result = await session.authenticate();
      if (!result.authenticated) {
        if (result.reason !== 'invalid_jwt') return null;
        const refreshed = await session.refresh();
        if (!refreshed.authenticated) return null;
        // RefreshSessionSuccessResponse omits `accessToken` (it hands back a
        // new sealed cookie instead, per the SDK's own Omit<…, 'accessToken'>
        // type), so its `user` is read on its own branch rather than folded
        // into the success shape above — similar types, not the same one.
        return { identity: toIdentity(refreshed.user), resealed: refreshed.sealedSession ?? undefined };
      }
      return { identity: toIdentity(result.user) };
    },

    /** The session id is inside the sealed access token, so an expired one is refreshed first to read it. */
    async revoke(sealed: string): Promise<void> {
      const session = workos.userManagement.loadSealedSession({ sessionData: sealed, cookiePassword });
      let result: { authenticated: boolean; sessionId?: string } = await session.authenticate();
      if (!result.authenticated && 'reason' in result && result.reason === 'invalid_jwt') result = await session.refresh();
      if (result.authenticated && result.sessionId) await workos.userManagement.revokeSession({ sessionId: result.sessionId });
    },

    describe() {
      return `login required (WorkOS AuthKit, client ${clientId})`;
    },
  };
}
