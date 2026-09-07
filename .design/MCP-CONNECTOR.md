# MCP + Connector — bring-your-own-chat as a third distribution channel

Companion to `.design/SAAS-MULTIUSER.md`, not a replacement for it. That document
covers the hosted web app (login, shared canon, OpenRouter billing, Docker/npm
distribution). This one covers a different, additive surface: **Claude, ChatGPT, and
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
  session-cookie shortcut — MCP is stateless-per-request by design here.

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
| `list_stories` | `GET /api/stories` | This user's stories in the current world |
| `get_state` | `GET /api/state` | Session, counts, pending consequences, usage |
| `get_scene_frame` | `src/frame/` assembly | The budgeted frame a Narrator role would receive — entities, threads, recent turns in scope |
| `get_cast` / `get_entity` | `GET /api/cast`, entity detail | Sheets, locks, appearance |
| `get_threads` / `get_facts` | existing routes | Tension dials, epistemics |

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
general connector path. Add the `search`/`fetch` pair only for the extra ChatGPT
deep-research polish, as a follow-up, not a blocker.

---

## 5. What's new to build, sized honestly

| Piece | Size | Why |
|---|---|---|
| Streamable HTTP MCP transport (`/mcp` route) | S | Thin adapter over existing store reads / turn loop, using an off-the-shelf MCP server SDK for the wire protocol |
| Read tools (`list_worlds`, `get_state`, `get_cast`, etc.) | S | Each is a few lines calling code that already exists |
| `propose_turn` in mode (b) | M | The turn pipeline already exists; this is "run it, stop before the Narrator role, return the frame instead" — a real but bounded change to the loop's output shape |
| Interrupt-as-tool-exchange (§3) | M | The one genuinely new state machine; reuses the integrity gate's decision logic, needs new storage for pending interrupts and expiry handling |
| OAuth 2.1 authorization server (§1) | M–L | Protected Resource Metadata, Authorization Server Metadata, Dynamic Client Registration, token issuance/refresh. Use an existing library for the OAuth mechanics rather than hand-rolling RFC 7591/8414/9728 — this is the one place "implement the protocol directly" (this codebase's usual style, per `sigv4.ts`/`google.ts`) is the wrong call, because the surface is large and security-sensitive in a way SigV4 signing is not |
| `oauth_clients` / `oauth_tokens` tables | S | Additive schema, same pattern as everything else |
| ChatGPT `search`/`fetch` compatibility pair | S | Optional, thin wrapper over existing entity/fact/turn reads |

Nothing here requires touching `entities`/`edges`/`sheets` or any canon/chronicle
logic. The turn loop, the integrity gate, the frame assembler, the consequence
graph — all reused as-is. This is new *edges* on an existing graph of subsystems, not
new subsystems, with the sole exception of the OAuth authorization-server role, which
is genuinely new work and the one place to budget real time.

---

## 6. Sequencing, relative to `SAAS-MULTIUSER.md`

This channel depends on identity existing (§2), but not on billing, sharing, or
mobile from the other document — it can land in parallel with, or even before,
`SAAS-MULTIUSER.md` Phase 2 (money), since this channel has no money to move.

1. **Prerequisite: `SAAS-MULTIUSER.md` Phase 0** (users, per-request identity) must
   exist first — MCP tokens map onto the same `users` rows.
2. **MCP Phase A**: read-only tools + OAuth authorization server + Dynamic Client
   Registration. Gets a user from "nothing" to "Claude can browse my world" with no
   write path yet — the safest possible first slice, and the natural point to verify
   the OAuth flow actually works against real Claude/ChatGPT clients before trusting
   it with mutations.
3. **MCP Phase B**: `propose_turn` (mode b) + the interrupt exchange. This is where
   the channel becomes actually playable, not just inspectable.
4. **MCP Phase C**: ChatGPT `search`/`fetch` compatibility pair, if wanted.

Independent of `SAAS-MULTIUSER.md` Phases 2–4 (money, sharing, mobile) entirely —
those are about the hosted web UI; this channel has no UI and no per-token billing
to speak of, since the chat client's own subscription absorbs the LLM cost.
