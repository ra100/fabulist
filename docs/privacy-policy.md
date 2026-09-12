# Privacy Policy

**Effective date:** the date this document is published alongside a running
deployment. **Applies to:** any Fabulist instance operated by the project
maintainer (currently `fabulist.rast.io`) and to the Fabulist MCP server
("the Connector") when you link it from ChatGPT, Claude, or any other
MCP-speaking client. It does not apply to a copy of this open-source
software that you or someone else self-hosts — in that case the operator of
*that* instance is who to ask, and this document is only a template for
them (see `.design/SAAS-MULTIUSER.md` §7, "no monetization," and
`README.md` for what self-hosting looks like).

Fabulist takes no profit, runs no ads, and sells nothing. This policy
describes an honest, small footprint, not a compliance document written to
cover a business model that doesn't exist here.

---

## 1. Who we are

Fabulist is an open-source, single-maintainer project (`ra100`,
[github.com/ra100/fabulist](https://github.com/ra100/fabulist), MIT
licensed). There is no company behind it. Where this document says "we,"
it means the maintainer operating the deployment you connected to.

## 2. What data we collect, and why

| Data | Source | Why we have it |
|---|---|---|
| Email, first/last name | WorkOS (AuthKit) sign-in, or an MCP OAuth token issued by the same identity provider | To tell your stories apart from everyone else's, and nothing else — see §3 |
| A session cookie (browser) or a bearer token (MCP connector) | Set at login/authorization | Keeps you signed in; contains no password |
| Your stories: turns, character sheets, threads, facts, directives, illustrations you generate | Written by you, playing | This *is* the product — a story you're writing |
| Encryption rollout state and opaque browser-created key wraps | Fabulist app database (`encryption_rollout`, `user_encryption_keys`, `story_encryption_keys`) | Gradual per-user rollout. Key-wrap records contain salts, nonces, and ciphertext, not a passphrase, recovery code, master key, or story key |
| Which worlds you may access, and your role on each | `world_access` table, set by an admin or a world's owner | Access control — decides which shared canon you can read or ingest |
| A personal "prose blocklist" (phrases you never want to see) | Something you added | A per-user preference, nothing else |
| Token usage totals per story | Computed from your own turns | Informational only — lets you see what your own configured provider is costing you (§4). Never billed by us. |

We do **not** collect: payment information (there is nothing to pay),
analytics, telemetry, ad identifiers, or any tracking pixel — there is no
third-party analytics script anywhere in this codebase, and we did not add
one for this policy. We do not sell data, because there is no business
model that data would serve.

## 3. Identity

Sign-in (browser) and the MCP connector's OAuth flow both authenticate
against the same identity provider (WorkOS AuthKit), so a token's verified
subject *is* the same account whether you're on the web app or in a chat
client — see `src/auth/config.ts` and `src/mcp/auth.ts`. We only ever see
what that provider chooses to hand back: typically your email and name.
We do not receive or store your password — that lives with the identity
provider, not with us.

If login is switched off entirely (a private, single-operator install),
none of this applies: there is exactly one reader, and nothing is scoped to
an identity at all.

## 4. Your provider credentials never touch our database

Fabulist is bring-your-own-key (BYOK) by design (`.design/SAAS-MULTIUSER.md`
§4): whichever LLM or image-generation provider is configured (Bedrock,
Vertex, a Copilot-derived token, a local model, or a plain API key) is set
by the operator through environment/config files, never stored in the
application's own database, and never sent anywhere except directly to that
provider to generate your story's prose or illustrations. We do not mark up,
resell, or otherwise monetize your usage of that provider.

## 5. What we do with your story content, and how it is protected

Your turns, sheets, and everything else you write stay scoped to your
account (`stories.owner_user_id`) and are never shown to another user
unless you explicitly fork/share a story yourself. The shared "canon" a
world is built from (wiki-derived or authored) is, by contrast, meant to be
shared — that's the point of a world — but your *playthrough* on top of it
is yours alone.

When you send input to Fabulist — through the browser or through an MCP
tool call like `propose_turn` — that text and the assembled scene context
are sent to whichever LLM provider is configured for that deployment
(§4), the same way any AI writing tool works. We do not otherwise read,
review, or use your story content for any purpose beyond running the turn
you asked for.

Transport security is HTTPS/TLS when you use the hosted deployment, and OAuth
tokens for browser/MCP access are transmitted over that same encrypted
channel.

The private-storage pilot creates a random browser-held master key and lets the browser wrap it
independently with a passphrase and a recovery code. The database receives
only those encrypted wraps and public derivation metadata; there is no
maintainer recovery or escrow key. Losing both the passphrase and recovery
code makes future encrypted content unrecoverable.

Key enrollment alone is not content encryption. Until the owner-wide migration
has completed and verified every enrolled story, existing durable content remains
plaintext and is not cryptographically opaque to the operator. We therefore
do **not** claim a zero-knowledge design. Because a turn must be processed to
generate a response — and because the current pilot also decrypts reads on the
server — plaintext exists in application memory while an unlocked request is
handled.

When an enrolled user unlocks a private story in the browser, the browser may
send its random story key over HTTPS for a short-lived, owner-scoped processing
grant. The app keeps that key only in its running process memory; it is neither
written to Postgres, a cookie, a log, nor a cache, and is cleared on logout,
explicit lock, expiry, or process restart. The migration writes authenticated
ciphertext, verifies it, removes the corresponding legacy plaintext, and fails
closed if interrupted. Database and filesystem backups taken after successful
migration contain ciphertext plus structural metadata, not readable story prose.

While private storage is enrolled, operations that would create or adopt
another story are temporarily unavailable. This prevents a new plaintext story
from being created without a browser-wrapped story key.

## 6. What the MCP connector, specifically, can see and do

Connecting Fabulist as an MCP server to ChatGPT, Claude, or another client
grants that client the same tools a signed-in browser session has: it can
read and write your own stories, never anyone else's (see
`.design/MCP-CONNECTOR.md` and `test/mcp-e2e.test.ts`'s isolation tests).
The calling model sees exactly what a tool call returns — a story's turns,
a character sheet, a world's canon — and nothing about your account beyond
what it needs to run that tool. We do not log or retain the *prompts* the
calling client sends beyond ordinary request logging described in §8.

## 7. Data retention and deletion

Your stories, sheets, and account data persist until you delete them or ask
us to. There is no automatic expiry. To request deletion of your account
and everything scoped to it, contact us (see `docs/support.md`) — we will
remove your `users` row, every story you own, and revoke any grants tied to
your id, within a reasonable time and confirm when done. Shared world canon
you did not create is not deleted on your request, since it isn't yours
to delete (it may still be in use by other users' stories).

## 8. Logs

Ordinary web-server request logs (IP address, path, timestamp) may be kept
briefly for operational debugging and abuse prevention, the same as any
web server. We do not build an analytics profile from them.

## 9. Third parties

- **WorkOS/AuthKit** — identity provider for sign-in and MCP OAuth. See
  [WorkOS's own privacy policy](https://workos.com/privacy) for what they
  hold.
- **Whichever LLM/image provider the deployment is configured with** —
  receives your turn input/scene context to generate prose or an
  illustration, per §4/§5. Which provider that is, and its own data
  handling, is the operator's choice and disclosed in the deployment's own
  configuration; ask us if you want to know which one a specific instance
  uses.
- **No one else.** No analytics vendor, no ad network, no data broker.

## 10. Changes to this policy

If this policy changes, we will update the version in the repository
(`docs/privacy-policy.md`) and, for any material change, note it in the
project's release notes.

## 11. Contact

See [`docs/support.md`](./support.md) for how to reach us, including for
privacy questions or a deletion request.
