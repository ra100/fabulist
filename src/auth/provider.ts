/**
 * The seam between web login's *mechanism* and its *policy*.
 *
 * Everything policy-shaped — is login required at all, which origin the
 * callback lives at, who counts as an admin, how long the cookie lives — stays
 * in `src/auth/config.ts` and is identical whoever authenticates the user.
 * Everything mechanism-shaped — where to send the browser, how to turn an
 * authorization code into a session, how to read a sealed session back — is
 * behind this interface, because it is the only part that differs between
 * WorkOS AuthKit (`workos-provider.ts`, the hosted default) and a generic
 * OpenID Connect issuer (`oidc-provider.ts`, e.g. Authelia, Keycloak,
 * Authentik, Zitadel — a self-hoster's own identity provider).
 *
 * The interface is deliberately three methods wide, one per step of the
 * authorization-code flow this server already ran against AuthKit, so the
 * WorkOS path is a direct wrapping of the three SDK calls it always made
 * rather than a re-implementation. Note what is *not* here: nothing takes an
 * `IncomingMessage`. A provider is handed values the caller has already
 * decided on (the redirect URI from configuration, a freshly generated state
 * and nonce), never a request to read them out of — the Host-header injection
 * fixed in `AuthConfig.callbackOrigin` stays fixed by construction.
 */

/** Who the provider says this is. Mapped to a `SessionUser` (adding `isAdmin` from the shared allowlist) by `src/auth/config.ts` — the admin decision is policy, so no provider gets to make it. */
export interface AuthIdentity {
  /**
   * The provider's stable subject id. This becomes `SessionUser.id`, which is
   * what `owner_user_id` stores — so it is the name every story a user owns is
   * filed under. Switching a live deployment from one provider to another (or
   * one issuer to another) therefore changes who owns what: the new ids simply
   * do not match the rows, and each user lands on a fresh empty story rather
   * than someone else's. That is the safe direction, and worth saying out loud
   * because the tempting "fix" — matching on email instead — would make story
   * ownership transferable by anyone who can set an email claim.
   */
  id: string;
  /** Empty when the issuer published no email claim. Only the admin allowlist reads it; ownership never does. */
  email: string;
  /**
   * True only when the issuer asserted that `email` is verified. The admin
   * allowlist requires it: an issuer with open self-registration would otherwise
   * make admin anyone who signs up with an admin's address.
   */
  emailVerified?: boolean;
  firstName: string | null;
  lastName: string | null;
}

/** One login attempt's inputs, all of them decided by the caller before the provider is consulted. */
export interface AuthorizationRequest {
  /** Always `${AuthConfig.callbackOrigin}/auth/callback` — configuration, never a request header. */
  redirectUri: string;
  /** Random per attempt, bound to the browser by the short-lived login-attempt cookie and consumed once (`src/auth/routes.ts`). */
  state: string;
  /**
   * Random per attempt. OIDC's replay binding for the ID token (OIDC Core
   * §3.1.2.1): the issuer echoes it into `id_token.nonce`, and a provider that
   * issues ID tokens must reject one whose nonce is not the one it asked for.
   * AuthKit's SDK does not expose a nonce parameter and verifies the code
   * exchange itself, so its provider ignores this — hence "may ignore" rather
   * than "must use".
   */
  nonce: string;
}

export interface StartedLogin {
  /** Where to redirect the browser. Must already carry `state` (and `nonce`, where the provider uses one). */
  url: string;
  /** PKCE verifier for this attempt, handed back for the login-attempt cookie and replayed on the exchange. */
  codeVerifier: string;
}

export interface CodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** The nonce from the same attempt, for providers that must check the ID token echoes it. */
  nonce: string;
}

export interface ResolvedSession {
  identity: AuthIdentity;
  /**
   * A freshly sealed cookie value, when resolving the session also renewed it
   * (the access token had expired and a refresh succeeded). The caller writes
   * it back to the browser so the stored cookie advances too, rather than
   * re-running the refresh on every subsequent request.
   */
  resealed?: string;
}

export interface AuthProvider {
  /** Step 1: where to send the browser to sign in. */
  authorize(request: AuthorizationRequest): Promise<StartedLogin>;
  /**
   * Step 2: exchange the authorization code for a session, returning the
   * sealed cookie value to set. Throws on any failure — the route turns that
   * into "try again", never a stack trace shown to the visitor.
   */
  exchangeCode(exchange: CodeExchange): Promise<{ sealedSession: string }>;
  /**
   * Step 3: read a sealed cookie back. `null` means "not signed in" for any
   * reason the caller has no use in distinguishing (absent, tampered, expired
   * beyond refresh). May throw on a provider/network failure; the caller
   * catches and degrades to "not signed in" rather than letting one bad
   * session take the process down.
   */
  resolveSession(sealed: string): Promise<ResolvedSession | null>;
  /** One line for the boot log, so a misconfiguration is visible at startup rather than on the first failed login. */
  describe(): string;
}
