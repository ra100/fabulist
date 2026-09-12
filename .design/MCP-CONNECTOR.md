# MCP + Connector — bring-your-own-chat as a third distribution channel

**Status: implemented and verified against a real WorkOS AuthKit account, not just
mocks.** A real browser flow (registered a real DCR client, signed in with a real
email, approved a real OAuth consent screen) produced a real access token, and that
exact token was verified by this repo's own unmodified `src/mcp/auth.ts` and accepted
by a real running `/mcp` server with a real `200 OK` `initialize` response — see
"Verified live against a real account" below for the full trace. Not yet deployed
anywhere real, and no `oauth_clients`/`oauth_tokens` schema or per-user web identity
exists yet — see "What's actually built" for the precise line.

Companion to `.design/SAAS-MULTIUSER.md`, not a replacement for it. That document
covers the hosted web app (login, shared canon, BYOK provider config,
Docker/npm distribution — no billing anywhere, see its §7). This one covers a different, additive surface: **Claude, ChatGPT, and
any other MCP-speaking chat client as the front end, with Fabulist exposed as a remote
MCP server that is purely the world-model backend.** Same engine, same schema, no new
storage model — a new transport, and one real new subsystem (OAuth as an authorization
server, not just a login page).

**Headline finding: this is real, standards-based, and not Claude-specific.** MCP is
an open protocol; both Anthropic (Claude custom connectors) and OpenAI (ChatGPT/Codex
MCP plugins) consume the same wire format. One server, not two integrations. The
economics are unusually good: the chat client's own model calls are billed to the
*user's* Claude/ChatGPT subscription, not to you — Fabulist's server makes zero LLM
calls on this channel (or optionally still makes cheap mechanical-role calls; see §3).
The genuinely new engineering is (a) a Streamable HTTP MCP transport wrapping the
existing API, which is mechanical, and (b) becoming a real OAuth 2.1 authorization
server, which is not optional per the MCP spec and is the one piece worth taking
seriously before starting.

---

## What's actually built · done

Implemented and verified — not just the plan below, real code with real tests:

- **`src/loop/engine.ts`**: `TakeTurnOptions.narrateExternally` stops a turn right
  after Direct and returns `{ kind: 'awaiting-narration', resumeToken, system, user,
  maxTokens }` — the exact material the in-process Narrator role would have sent a
  provider (`roles.ts`'s new `buildNarratorPrompt`), without calling this engine's own
  configured provider at all. `Engine.commitExternalNarration(resumeToken, prose)`
  resumes with externally-written prose and runs the same prose-gate/extract/
  validate/commit steps a normal turn runs (`finishTurn`, shared code, not a
  parallel path that could drift). Pending state lives in an in-memory `Map` with a
  10-minute TTL, swept lazily — no new schema, no cross-process concern, because MCP
  tool calls hit the same long-lived server process the engine already lives in.
- **`src/mcp/tools.ts`**: every read tool from the table below (`list_worlds`
  through `get_book`), plus `propose_turn`/`commit_narration`/`resolve_interrupt`,
  as plain functions over `World`/`Engine` — no MCP protocol types, independently
  testable (`test/mcp-tools.test.ts`, 15 tests).
- **`src/mcp/auth.ts`**: two modes, resolved once from environment
  (`MCP_OAUTH_ISSUER`/`MCP_OAUTH_AUDIENCE` for real OAuth against any RFC
  8414-compliant issuer — AuthKit included; `MCP_DEV_TOKEN` for a single static
  bearer secret with a constant-time comparison, mapping to a fixed `dev` pseudo-user).
  Neither configured means `/mcp` is not mounted at all — never mounted-but-
  unauthenticated. Verified against a real local JWKS server and real signed JWTs
  (`test/mcp-auth.test.ts`, 13 tests: right issuer, wrong issuer, wrong audience,
  expired, missing subject claim, all independently checked).
- **`src/mcp/server.ts` / `src/mcp/server-pg.ts`**: wrap the tools in the official
  `@modelcontextprotocol/sdk`'s `McpServer` + `StreamableHTTPServerTransport`.
  PostgreSQL production retains the initialized server/transport by its random
  `Mcp-Session-Id`, because ChatGPT separates initialization and schema discovery
  from later tool calls. Sessions expire after four idle hours and remain bound to
  the bearer token's verified subject. The bearer token is still verified before
  the SDK sees every request.
- **`src/server/api.ts` / `src/cli/serve.ts`**: `/mcp` and
  `/.well-known/oauth-protected-resource` mounted only when `mcpAuth` *and* a real,
  externally-reachable `mcpResourceUrl` are both present. `serve.ts` refuses to guess
  a default resource URL under `--host=0.0.0.0` (the Docker default) — confirmed
  directly by running the built image and watching a real client get handed an
  unreachable `resource_metadata="http://0.0.0.0:.../..."` before this guard existed;
  `MCP_RESOURCE_URL` must be set explicitly for any non-localhost deployment, or
  `/mcp` does not mount, with a clear boot-log error explaining why.
- **`test/mcp-e2e.test.ts`**: the proof that the pieces above actually fit together —
  a real `createApiServer` on a real port, a real MCP client (the same SDK Claude/
  ChatGPT use) connecting over real Streamable HTTP, listing tools, calling
  `propose_turn` on both an ordinary action and a vow-breaching one, resolving the
  interrupt via `resolve_interrupt`, and completing via `commit_narration` — 7 tests,
  all passing. Also verified by hand against the actual built Docker image with curl:
  a missing token gets a 401 with a correct `WWW-Authenticate`, a correct token gets
  a real `initialize` response, and the protected-resource metadata reflects a real
  externally-reachable URL once `MCP_RESOURCE_URL` is set.
- **736 total tests pass** (up from 695 before this work), `tsc --noEmit` clean,
  zero new lint findings, Docker build verified end-to-end with the new dependencies
  (`@modelcontextprotocol/sdk`, `jose`, `zod`).

**Not built, and deliberately out of scope for this pass** (per §2/§6 below, both
require `SAAS-MULTIUSER.md`'s identity work first, which does not exist yet):

- Any real multi-user web identity — `MCP_DEV_TOKEN`'s `dev` pseudo-user is a
  single-operator stand-in, not a many-user auth system. Wiring a real AuthKit (or
  equivalent) account and setting `MCP_OAUTH_ISSUER` against it is an operational
  step, not code — the `buildOAuthAuth` path is already implemented and tested
  against a real JWKS/JWT flow, it has simply never been pointed at a real account.
- `oauth_clients`/`oauth_tokens` schema, and tying a verified token's `userId` to
  this app's own `world_access`/`stories.owner_user_id` rows (§2) — there is no
  `users` table yet for it to tie to.
- Deployment: `fabulist.rast.io`'s nginx config still IP-allowlists everything, and
  this work has not touched it. `/mcp` exists and works; nothing has exposed it
  publicly anywhere.

---

## Verified live against a real account · done

Not a mock JWKS server this time — an actual, complete, human-in-the-loop OAuth
authorization-code flow against the real `WORKOS_API_KEY`/`WORKOS_CLIENT_ID` in
`.env`, `MCP_OAUTH_ISSUER` pointed at the real AuthKit domain
`https://fastidious-attic-52.authkit.app`:

1. **Dynamic Client Registration was found disabled**, live: `POST /oauth2/register`
   returned `dynamic_client_registration_disabled` on first check. This is a WorkOS
   Dashboard → Connect → Configuration setting, not something fixable from code —
   flagged, then enabled by hand. Re-checked after: `registration_endpoint` and
   `client_id_metadata_document_supported: true` both now present in the metadata
   document, and `POST /oauth2/register` returns a real `client_id`/`client_secret`.
2. **A real browser** (Playwright, driving the actual hosted AuthKit UI) opened the
   real `/oauth2/authorize` URL with a freshly-registered client and a real PKCE
   challenge, entered a real email, received and entered a real emailed sign-in
   code, and approved a real OAuth consent screen ("fabulist-mcp-test would like
   access to your account"). This produced a real authorization code.
3. **That code was exchanged** at the real `/oauth2/token` endpoint for a real access
   token, `id_token`, and refresh token — a genuine 200 response, not a stub.
4. **The real access token's `aud` claim confirmed AuthKit's documented default
   exactly**: with no Resource Indicator configured, `aud` is the *environment's*
   client ID (`client_01M1YFPQ...`), distinct from both the DCR-registered app's
   client ID and `WORKOS_CLIENT_ID` in `.env` — a third identifier, matching the docs'
   description precisely rather than assumed.
5. **This repo's own, unmodified `buildOAuthAuth`** (`src/mcp/auth.ts`) was called
   directly against that real token with the real issuer and the real audience from
   step 4, and correctly returned `{ userId: 'user_01M1YPZ1...' }` — the real `sub`
   claim, extracted correctly.
6. **A real running server** (`createApiServer` with that same real `mcpAuth`) was
   sent that same real token as a real `Authorization: Bearer` header on a real
   `POST /mcp` `initialize` request, and returned a real `200 OK` with a correct MCP
   protocol response.

One environmental wrinkle, noted for anyone repeating this from the same kind of
sandboxed/proxied network: outbound HTTPS in this session's environment goes through
an intercepting proxy with a self-signed certificate, which Node's `undici`-based
`fetch` (and therefore `jose`'s `createRemoteJWKSet`) correctly refuses by default —
plain `curl` doesn't hit the same wall because it validates differently. Steps 5–6
above needed `NODE_TLS_REJECT_UNAUTHORIZED=0` to get past that proxy in *this*
diagnostic session; a normal deployment on ordinary network egress (which is what
`fabulist.rast.io` or any real host actually has) will not need it, and it must never
be set outside a throwaway diagnostic — it disables all TLS validation, not just for
the proxy in question.

Every temporary artifact from this check (the DCR-registered test client, the test
user created via the Management API, local callback-catcher processes, `.env`-like
scratch files) was deleted afterward; nothing from it persists in the repo or the
WorkOS account beyond the DCR-enabled setting and the one real user
(`fabulist@rast.io`) that completed the flow.

---




## 1. What MCP actually requires of the server — read this before estimating scope

Authorization is optional in the MCP spec *in general*, but both Claude's custom
connectors and ChatGPT's connector path require it in practice (nobody is exposing
their world-state mutation tools unauthenticated on the public internet). Once you
opt in, the current spec (`2025-06-18`) is specific and non-trivial:

- The MCP server **must** act as an OAuth 2.1 **resource server** and publish
  **OAuth 2.0 Protected Resource Metadata** (RFC 9728) at
  `/.well-known/oauth-protected-resource`, pointing at an authorization server.
- Returning a bare 401 is not enough — it **must** carry a `WWW-Authenticate` header
  naming that metadata URL, which is how the chat client discovers where to send the
  user to log in.
- The authorization server (which can be the *same* server, just a different role)
  **must** publish **OAuth 2.0 Authorization Server Metadata** (RFC 8414) and
  **should** support **Dynamic Client Registration** (RFC 7591) — this is what lets
  Claude or ChatGPT register itself as an OAuth client against your server the first
  time a user connects, with no manual "create an OAuth app" step on either side.
- Every request carries `Authorization: Bearer <token>`, checked on every call, no
  browser-session shortcut. The MCP session id correlates protocol lifecycle
  requests; it never replaces bearer authentication.

None of this is exotic — it's a documented, well-trodden OAuth 2.1 flow, and there are
small libraries for exactly this (`@modelcontextprotocol/sdk`'s auth helpers, or
`node-oidc-provider` if you want a fuller implementation) — but it is **more than a
login page**. It's the server taking on a role (issuing tokens, publishing discovery
documents, handling dynamic client registration) that the hosted web app in
`SAAS-MULTIUSER.md` never needed, because that app only ever had to *check* a session
cookie it created, not *be* an OAuth provider other software registers against.

---

## 2. Reusing, not duplicating, the identity work already planned

Good news: none of the *user* side of this is new. `SAAS-MULTIUSER.md` §3 already
plans a `users` table and login. What MCP adds is a second front door onto the same
identity, not a second identity system:

```
                         ┌── magic-link / OAuth login ──► web session cookie
        users table  ────┤
   (from Phase 0/1)      └── MCP OAuth authorize screen ──► MCP access token
```

Concretely:

- **The MCP "authorize" screen is the same login page**, reused. When Claude/ChatGPT
  redirects a user to your authorization endpoint, that endpoint is: "log in (magic
  link, same as the web app) → see a consent screen ('Fabulist wants to access your
  worlds and stories') → redirect back to the chat client with a code." The
  *authentication* step is identical to the web app's login; only the *consent +
  token-issuance* wrapper around it is new.
- **Issued tokens map to the same `users.id` and the same `world_access` /
  `stories.owner_user_id` rows** from `SAAS-MULTIUSER.md` §2. An MCP tool call and a
  web request hit the same permission checks — `propose_turn` as an MCP tool and
  `POST /api/turn` as a web route both resolve `(currentUser, world, story)` the same
  way, because it's the same underlying authorization logic wearing two transports.
- **Net new schema**: an `oauth_clients` table (dynamic client registrations —
  Claude's registration, ChatGPT's registration, each with their own client_id/secret)
  and an `oauth_tokens` table (access + refresh tokens, scoped to a user and,
  optionally, a specific world/story). Both small, both additive, same pattern as
  everything else in this app's schema.

This is the same relationship the MCP transport has to the *engine* (§4) — a new
front door onto something that already exists — applied one level up, to identity.

---

## 3. Tool design: what Referee/Director/Narrator becomes over MCP

The engine's existing role split (`DESIGN.md`: Referee decides what's true, Director
decides what happens next, Narrator decides how it's said) maps onto MCP tools more
cleanly than a from-scratch design would, because the roles were already separated
for a similar reason — "no single call does three incompatible jobs."

**Read tools** (thin wrappers over existing store reads / existing API routes):

| Tool | Mirrors | Returns |
|---|---|---|
| `list_worlds` | `GET /api/worlds` | Worlds this user can access (own + shared/public) |
| `switch_world` | `POST /api/worlds/:slug/switch` | Switches which world every subsequent tool call operates on, effective immediately |
| `list_stories` | `GET /api/stories` | This user's stories in the current world |
| `create_story` / `fork_story` / `switch_story` | `POST /api/stories`, `/fork`, `/:id/switch` | Start, branch, or switch which story every subsequent tool call operates on |
| `list_characters` / `start_story` | `GET /api/setup/characters`, `POST /api/setup/player` | Candidate protagonists, and adopting/inventing one plus an opening line — what turns a freshly ingested world into a playable one |
| `get_state` | `GET /api/state` | Session, counts, pending consequences, usage |
| `get_scene_frame` | `src/frame/` assembly | The budgeted frame a Narrator role would receive — entities, threads, recent turns in scope |
| `get_cast` / `get_entity` | `GET /api/cast`, entity detail | Sheets, locks, appearance |
| `get_threads` / `get_facts` | existing routes | Tension dials, epistemics |

**Write tools** (thin wrappers over existing write routes/services — every one has a REST equivalent):

| Tool | Mirrors | Notes |
|---|---|---|
| `pin_turn` / `regenerate_turn` | `POST /api/turn/:id/pin`, `/regenerate` | Re-render one turn's prose without changing what happened; refuses a pinned turn |
| `update_sheet` / `lock_sheet_field` | `PUT /api/sheet/:id`, `POST /api/sheet/:id/lock` | Edits identity/contract/voice/condition/appearance; never touches `appearance.referenceImagePath`/`seed` |
| `update_thread` | `PUT /api/thread/:id` | Tension, status, title, stakes |
| `add_directive` / `delete_directive` | `POST/DELETE /api/directive[/:id]` | Steers the future; reports the recalculation diff it triggers |
| `update_style` / `update_knobs` | `PUT /api/style`, `/knobs` | Partial patch, merged over the current values |
| `add_anchor` | `POST /api/anchor` | Records a style-anchor passage |
| `generate_portrait` / `generate_scene_illustration` / `delete_illustration` | `POST /api/illustrate/portrait/:id`, `/scene/:turnId`, `DELETE /api/illustration/:id` | Requires an image provider configured |
| `compose_illustration_prompt` | `GET /api/illustrate/portrait/:id/prompt`, `/scene/:turnId/prompt` | The copy-pasteable fallback — no provider call, works even with none configured; call this when the two tools above report "no image provider configured" |
| `tick` / `compact` / `close_scene` | `POST /api/tick`, `/compact`, `/scene/close` | World-clock advancement, scene summarisation, manual scene close |
| `branch_story_to_file` | `POST /api/branch` | Forks the *save file* at a scene to a different path on disk — distinct from `fork_story`, which stays in the same world file |
| `play` | `POST /api/play` | Server-narrated alternative to `propose_turn`/`commit_narration`: one call, this server's own provider writes the prose |
| `resolve_wiki` / `plan_world` / `preview_ingest` / `discover_world` / `commit_ingest` | `POST /api/setup/resolve`, `/plan`, `/preview`, `/discover`, `/ingest` | The wiki-ingest wizard; `discover_world`/`commit_ingest` return a job polled with `get_setup_job` |
| `create_custom_world` / `use_sample_world` | `POST /api/setup/custom`, `/sample` | No-wiki world creation paths |
| `get_setup_job` / `cancel_setup_job` | `GET /api/setup/job/:id`, `POST .../cancel` | Poll or cooperatively cancel a background setup job |
| `reset_world` | `POST /api/setup/reset` | Wipes the whole world file — genuinely destructive, no undo |

Excluded by design, same as the REST routes they'd mirror: anything gated by
`requireAdmin` (provider/image-provider config, blocklist, the ingest-health
admin panel) — server/deployment configuration, not story content.

**The one write tool that matters:**

`propose_turn(story_id, raw_input)` — runs the *existing* turn pipeline server-side:
classify → integrity gate → Referee verdict → Director move → delta extraction →
commit. Two output modes, and this is the one real design fork:

- **(a) Server narrates, chat relays.** The existing Narrator role (mock/local/
  whichever provider is configured) still produces prose; the tool returns finished
  text for Claude/ChatGPT to display verbatim. Fabulist pays for that one role's
  calls (cheap — see `SAAS-MULTIUSER.md` §4 for per-turn cost), everything else is free.
- **(b) Server referees, chat narrates.** The tool skips the Narrator role entirely
  and returns *scene material* — the same structured frame the Narrator would have
  received (`get_scene_frame`'s content, inlined) — and instructs the calling model
  (via the tool's description/response) to write the prose itself. **Fabulist makes
  zero LLM calls for this turn.** This is the option that fully realizes "use their
  chat for the main interaction" — the mechanical roles you actually care about
  staying deterministic (integrity gate, referee, delta extraction) still run
  server-side and are non-negotiable; only the *prose* — the one role the design
  already treats as a swappable "view of state, not the state itself" — moves to the
  chat client's own model.

Recommend **(b) as the default for this channel**, precisely because it's the
channel's whole value proposition: zero marginal LLM cost to you, and it's a
faithful extension of a decision the engine already made (prose is a view; the
Narrator is the one role explicitly designed to be swappable without touching state).
Mode (a) is worth keeping as a fallback for tool-poor clients, but ordering matters:
Claude/ChatGPT need the *tool call* to happen at all.

**The interrupt problem — the one genuinely new design work, not just wiring.**
The character-integrity gate's existing UI (a/b/c/d choice when a vow would be
broken) assumes a human clicking a button in the web app. Over MCP there's no modal —
there's only tool calls and text. The fix is a two-call exchange:

1. `propose_turn` detects the violation server-side (same integrity-gate logic,
   unchanged) and returns *not* a committed delta but a structured interrupt: the
   vow, the options (rewrite / break-and-establish / wrong-character / override), and
   an `interrupt_id`.
2. The chat client presents that to the user conversationally ("Brother Anselm has
   held a vow of nonviolence for thirty years — do you want to rewrite this, play the
   break, or override?"), gets their answer in the next message, and calls
   `resolve_interrupt(interrupt_id, choice)` — which then actually commits.

This is a real state machine to design (an interrupt has to be storable server-side,
expire sensibly, and not leave the story stuck if the user wanders off mid-conversation),
but it's a bounded one, and it reuses the integrity gate's existing decision logic
entirely — only the *presentation* of the choice changes shape.

---

## 4. Compatibility: Claude vs. ChatGPT specifics

Confirmed directly against both platforms' current docs, not assumed:

- **Claude custom connectors**: no required tool shape beyond standard MCP. Any tool
  set works, including the whole list above unmodified. Requires the server be
  reachable from Anthropic's cloud (public internet, not behind a VPN/firewall) — see
  Anthropic's published IP ranges if the deployment is ever locked down further.
- **ChatGPT / Codex MCP plugins**: general "connect a custom MCP server" works the
  same as Claude — any tool shape. The *specific* "deep research / company knowledge"
  connector surface in ChatGPT's UI additionally expects two compatibility tools:
  `search(query) → {results: [{id, title, url}]}` and `fetch(id) → {id, title, text,
  url, metadata}`, with a dual-encoded response (`structuredContent` plus a
  JSON-stringified copy in `content`, per OpenAI's documented shape). This is a thin,
  optional adapter — `search` maps onto "search entities/facts/threads by text,"
  `fetch` maps onto "return one entity's/turn's full detail" — worth adding only if
  that specific ChatGPT surface (rather than the general connector path) matters.

Net: build the tool list in §3 once; it works unmodified for Claude and for ChatGPT's
general connector path.

**The `search`/`fetch` pair turned out to be required, not polish, and is now
built.** Predicting it as optional was wrong in one specific way: a ChatGPT
connector that authenticates successfully but finds no tool named `search` or
`fetch` reports *no discoverable tools at all* rather than falling back to the
richer tool list. `search_entities` did not satisfy it — the lookup is by exact
name. Confirmed against OpenAI's own current docs ("should implement two
read-only tools: search and fetch") after ChatGPT hit exactly this, while
Claude, which accepts any tool shape, had connected fine throughout.

---

## 5. What's new to build, sized honestly

| Piece | Size | Status | Why |
|---|---|---|---|
| Streamable HTTP MCP transport (`/mcp` route) | S | **done** | Thin adapter over existing store reads / turn loop, using an off-the-shelf MCP server SDK for the wire protocol |
| Read tools (`list_worlds`, `get_state`, `get_cast`, etc.) | S | **done** | Each is a few lines calling code that already exists |
| `propose_turn` in mode (b) | M | **done** | The turn pipeline already exists; this is "run it, stop before the Narrator role, return the frame instead" — a real but bounded change to the loop's output shape |
| Interrupt-as-tool-exchange (§3) | M | **done, simpler than planned** | Turned out not to need durable server-side "pending interrupt" storage at all — the web UI's own resolution already works by resubmitting the original text with `overrideIntegrity: true` (no stored interrupt row exists there either), so `resolve_interrupt` does the same: the calling model hands the original text back, no new expiry/storage concern beyond what `narrateExternally`'s pending map already needed |
| OAuth 2.1 authorization server (§1) | M–L | **done, delegated rather than built** | Not hand-rolled RFC 7591/8414/9728 after all — `src/mcp/auth.ts`'s OAuth mode is a JWT-verification client against any RFC 8414-compliant issuer (AuthKit, confirmed against AuthKit's own docs), so this server never has to *be* the authorization server, only trust one. The dev-token mode is the genuinely small addition, for exercising everything before an AuthKit account exists |
| `oauth_clients` / `oauth_tokens` tables | S | not started | Needs `SAAS-MULTIUSER.md`'s `users` table to tie to first |
| ChatGPT `search`/`fetch` compatibility pair | S | **done** | `searchTool`/`fetchTool` in `src/mcp/tools.ts`. Not optional after all: without these exact names a ChatGPT connector discovers *zero* tools. `search` spans entities (via `graph.search`), facts and threads; `fetch` returns full text + metadata for an entity, fact, thread or turn. Ids pass through verbatim rather than wrapped, since `fact:`/`thread:`/`turn:` are already native id prefixes and entities carry a type prefix — an earlier draft added its own prefix and broke `fetch` on a bare turn id, caught by the round-trip test rather than by review |

Nothing here requires touching `entities`/`edges`/`sheets` or any canon/chronicle
logic. The turn loop, the integrity gate, the frame assembler, the consequence
graph — all reused as-is. This is new *edges* on an existing graph of subsystems, not
new subsystems, with the sole exception of the OAuth authorization-server role, which
is genuinely new work and the one place to budget real time.

---

## 6. Sequencing, relative to `SAAS-MULTIUSER.md`

This channel depends on identity existing (§2), but not on billing (there is none —
`SAAS-MULTIUSER.md` §7), sharing, or mobile from the other document — it can land in
parallel with, or even before, `SAAS-MULTIUSER.md` Phase 2 (per-user BYOK provider
config), since this channel has no provider spend of its own to configure.

**Turned out not to be strictly sequential in practice.** Phases A and B below are
both done, ahead of `SAAS-MULTIUSER.md` Phase 0, because the read tools and
`propose_turn`/`commit_narration`/`resolve_interrupt` needed no `users` table at all
— `McpToolContext` resolves world/story exactly the way every existing plain API
route does, with no per-caller identity threaded through it yet. What genuinely still
needs Phase 0 first is narrower than originally scoped: only tying a verified
`userId` to *this app's own* access-control rows (`world_access`,
`stories.owner_user_id`) — the auth *mechanism* (`buildOAuthAuth`) was buildable, and
built, without it.

1. ~~**Prerequisite: `SAAS-MULTIUSER.md` Phase 0**~~ — turned out not to block
   Phases A/B below; still required before tokens can be scoped to *this app's*
   per-user worlds/stories rather than "the one world this server happens to have
   open," which is everything today.
2. **MCP Phase A** · done: read-only tools + OAuth-mode auth (verifying against any
   RFC 8414 issuer, AuthKit included) + a dev-token mode for testing without one.
   Verified end to end against a real MCP client, not just unit-tested.
3. **MCP Phase B** · done: `propose_turn` (mode b) + the interrupt exchange, and
   `commit_narration`. Verified end to end, including the integrity-gate interrupt
   path, over a real MCP client connection.
4. **MCP Phase C**: ChatGPT `search`/`fetch` compatibility pair. **Done** — and it
   was a prerequisite for the ChatGPT channel working at all, not the optional
   polish §4 originally called it.
5. **Genuinely still blocked on `SAAS-MULTIUSER.md`**: tying `verified.userId` from
   `auth.ts` to a real `users` row and this app's own per-user world/story access
   control, rather than every valid token seeing whatever world the server has open
   — the one place identity is still notional rather than real.

Independent of `SAAS-MULTIUSER.md` Phases 2–4 (BYOK provider config, sharing,
mobile) entirely — those are about the hosted web UI; this channel has no UI and
no billing to speak of, since the chat client's own subscription absorbs the LLM
cost and this project charges nothing regardless.
