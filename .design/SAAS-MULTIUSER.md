# Fabulist as a global, multi-user app — investigation

Not a spec, not started. This is the "can it be done, what breaks, what would it cost"
pass requested before committing to it. Written the way `.design/GAPS.md` and
`.design/CRITIQUE.md` are: concrete, sequenced, and honest about what is genuinely
hard versus what the current design already half-solves.

**Headline finding: the hardest-sounding piece is mostly already built.** The
canon/chronicle split (`DESIGN.md` §2, `src/db/schema.sql`) already gives you "one
shared world, many independent stories" for free — that is what it was built for, just
for one person running many playthroughs rather than many people. The genuinely new
work is identity (who is asking), authorization (are they allowed to see this world or
story), and money (what does it cost and how do we stop it costing more than that).

---

## 1. What "global app" breaks today

Two facts about the current server, both load-bearing and both wrong for this:

- **One process, one open world, one open story, no concept of a caller.**
  `CurrentWorld`/`CurrentStory` (`src/store/index.ts`) are *server-level mutable
  singletons* — "the world/story currently open" is a property of the process, not of
  the request. `POST /api/worlds/:slug/switch` changes what *every* request sees,
  for *everyone hitting this server*, on the next request. That is precisely correct
  for "my laptop, my save file" and precisely wrong for "many people, at once, in
  different stories." This is the one change that is not optional and not additive —
  every route in `src/server/api.ts` (~60 of them) currently resolves world/story
  through that global, and each one needs to resolve it from *who is asking* instead.

- **No identity at all.** No `users` table, no session, no auth middleware, no
  concept of "mine" versus "yours" anywhere in the schema or the API. `fabulist.config.json`
  is a single file on disk that is *the* configuration, full stop.

Everything else — canon sharing, cost tracking, even most of the UI — sits on top of
those two facts and is comparatively easy once they're fixed.

---

## 2. The data model: what's already right, what's missing

`src/db/schema.sql` already encodes almost exactly the sharing model you're asking
for, one level down from users:

```
world file  →  canon (layer='canon', story_id NULL)   — shared by every story in the file
            →  N stories (layer='chronicle', story_id=X) — isolated from each other
```

That is "shared world graph/canon, unrelated stories on top of it" *already*, just
scoped to one file on one machine with no owner. The gap is one level up:

| Missing | Adds | Notes |
|---|---|---|
| `users` | `id, email, password_hash (or oauth identity), created_at, plan, ...` | Standard. |
| `world_access` | `world_slug, user_id, role (owner\|editor\|player), visibility (public\|unlisted\|private)` | Who may open/play a *world*; separates "can trigger an ingest / edit canon" (editor) from "can start a story in it" (player). This is also where a "browse public worlds" library page reads from. |
| `stories.owner_user_id` | one column | Whose story this is. Already story-scoped everywhere; just needs an owner. |
| `story_members` (later, §5) | `story_id, user_id, role (author\|collaborator\|viewer)` | The sharing feature, added after solo multi-tenancy works. |

Nothing about `entities`, `edges`, `sheets`, or any of the chronicle-layer tables
needs to change — they are already correctly scoped by `story_id`, and canon is
already correctly *unscoped* (shared). The migration is additive columns and two new
tables, not a schema rewrite.

**The real work is the request layer**, not the schema: every route handler needs a
resolved `(currentUser, requestedWorld, requestedStory)` and a permission check before
it does anything, replacing "there is one open world" with "which world is this user
allowed to touch." That's the `CurrentWorld`/`CurrentStory` singleton pattern
generalized to per-request resolution keyed by a session — mechanical, but touches
every route.

**Storage engine.** `node:sqlite` per-world-file is fine to *keep* for canon/chronicle
data even at real multi-user scale — WAL-mode SQLite handles many readers and one
writer per file well, and one file per world means writes to different worlds never
contend. What it does *not* do well is being opened from more than one server process
at once (no network protocol, a shared filesystem is required and still risky). So:
one app server process is fine well past MVP scale; the moment you want two server
processes (for uptime or load), either (a) shard by world — sticky-route each world to
one process — or (b) move the control-plane (`users`, `world_access`, billing) to a
real client-server database (Postgres, or libSQL/Turso if you want to keep the SQLite
mental model with network access) while leaving world files as-is. Recommend (b) plus
starting single-process — don't build for a scaling problem you don't have yet.

---

## 3. Auth

The codebase's own style is "implement the protocol directly, no framework" (see
`src/providers/sigv4.ts`, `google.ts`, `copilot.ts` — hand-rolled SigV4 and OAuth
rather than an SDK). Consistent with that:

- **Password auth**: `users(email, password_hash)`, hashed with `node:crypto.scrypt`
  (built into Node, zero new dependency — matches the "no native deps" stack
  decision in `PLAN.md`). Signed, httpOnly session cookie; sessions table or a
  signed-cookie-only scheme (no server-side session storage) both work at this scale.
- **OAuth ("sign in with Google/GitHub")**: same shape as `copilot.ts`/`google.ts`
  already do for provider auth — a small hand-rolled OAuth2 code-exchange, no library.
  Worth doing early because it removes password-reset/email-verification flows from
  scope entirely for most users.
- **Don't build 2FA, SSO, org management, etc. up front.** Not needed until there's
  a reason.

If at any point this needs to move faster than in-house auth can be trusted (SOC2,
enterprise SSO, etc.), Clerk/Auth0/WorkOS are the standard drop-ins — but given the
project's demonstrated comfort implementing exactly this class of protocol itself,
and that requirements here are simple (email+password, maybe OAuth), in-house is
consistent with everything else in this codebase and avoids a recurring per-user fee.

---

## 4. LLM provider and pricing

### Recommendation: OpenRouter as the default hosted backend

Not because the app should stop supporting Bedrock/Vertex/local — those stay exactly
as they are for self-hosters and BYOK users, that adapter layer (`src/providers/`) is
good work and shouldn't be thrown away. But for a **hosted, multi-user, "we pay for
the tokens" product**, OpenRouter solves the two hardest new problems for free:

1. **One integration, ~430 models, live pricing, no per-vendor contract.** Today's
   `profile` table (`mock/local/vllm/bedrock/google/copilot/cheap/balanced/premium`)
   is six different auth schemes and five different wire formats to maintain
   (`bedrock.ts`, `google.ts`, `copilot.ts`, `http.ts`...). One OpenRouter key behind
   `http.ts`'s existing OpenAI-compatible path replaces most of that *for the hosted
   product specifically*.

2. **Per-key spend limits are a first-class API feature, not something to build.**
   `POST /api/v1/keys` takes `limit` (a dollar cap) and `limit_reset` (`monthly` /
   `weekly` / never); `GET /api/v1/key` reports `limit_remaining`. Mint one
   provisioning key per user (or per subscription tier), set its limit from the
   user's plan, and the *provider itself* returns HTTP 402 once they'd exceed it —
   enforcement that cannot be bypassed by an app-level bug, because it isn't app-level
   at all. This is the answer to "make sure users don't use more than they should" —
   see §6.

Live pricing pulled just now (`openrouter.ai/api/v1/models`, USD per 1M tokens,
in/out):

| Model | in | out | context | fits vs role |
|---|---|---|---|---|
| `deepseek/deepseek-chat` (v3.2) | $0.32 | $0.89 | 164k | **narrator default** — cheap, clears the 64k floor comfortably, strong prose-to-cost ratio |
| `deepseek/deepseek-chat-v3.1` | $0.55 | $1.65 | 164k | narrator, slightly pricier |
| `anthropic/claude-haiku-4.5` | $1.00 | $5.00 | 200k | narrator upgrade tier — noticeably more consistent voice/steerability |
| `anthropic/claude-sonnet-5` | $2.00 | $10.00 | 1M | premium narrator tier (already the app's `bedrock`/`premium` default) |
| `google/gemini-2.5-flash-lite` | $0.10 | $0.40 | 1M | **mechanics/extractor default** — cheapest capable JSON-mode model |
| `openai/gpt-4o-mini` | $0.15 | $0.60 | 128k | mechanics alt, matches today's `balanced` profile |
| `qwen/qwen3-30b-a3b-instruct-2507` | $0.05 | $0.19 | 262k | cheapest usable tier, free-tier candidate |

This maps almost exactly onto the app's existing profile table (`cheap` = deepseek,
`balanced` = sonnet + gpt-4o-mini, `premium` = sonnet + gpt-4o) — the recommendation
is not "change the model choices," it's **"route the hosted product's calls through
one OpenRouter key instead of five vendor SDKs, and use that key's spend-limit API as
the enforcement backbone."** Bedrock/Vertex/Copilot/local stay as-is for self-hosters.

**Estimated cost per turn**, worked from the app's own token-budget assumptions
(64k context floor, DESIGN.md's role split): a typical turn is one narrator call
(~2–4k tokens in, ~400–800 out) plus one or two cheap mechanical calls (~1–2k in,
~200–400 out each). On deepseek-chat + gemini-flash-lite, that's roughly
**$0.002–$0.006 per turn** at raw provider cost. A session of 100 turns costs about
$0.20–$0.60 in raw model spend. This is the number the whole pricing model in §7 is
built from.

---

## 5. Canon sharing now, story sharing later

**Shared canon across users, unrelated stories (the immediate ask):** already the
native shape of the schema (§2). What's new is a *social* layer on top:

- A "browse worlds" page (public/unlisted worlds, keyed by `world_access.visibility`)
  — this is the "shared universe library" the ask describes.
- Separating **world editor** (can trigger ingest, edit canon, spend the ingest
  budget) from **player** (can start their own story against that canon, cannot
  mutate it). Ingest is the one operation with a real, potentially large one-time
  cost (`SetupService` already shows a page-count-and-cost preview before committing —
  keep that, and gate the "commit" step to editors, and probably to a separate
  budget from per-turn play spend, since one ingest run can be an order of magnitude
  more expensive than a turn).
- Nothing about canon itself needs to change — an ingested Witcher world's canon rows
  are already exactly as shareable as they are today; what's missing is *letting more
  than one account see them*.

**Sharing individual stories (explicitly "later" in the ask):** add `story_members`
per §2. Two shapes worth distinguishing, because they're very different amounts of
work:

- **Turn-based collaboration** (cheap, fits the existing model): the story is
  already a strict sequence of turns; letting a second author submit the next turn
  is a permission check plus `turns.author_user_id`, no new concurrency model needed
  — it's play-by-post, which this already structurally is.
- **Live co-presence / simultaneous editing** (expensive, don't build first):
  Google-Docs-style "two people typing at once" needs websockets/CRDT-ish
  coordination that nothing here has. Not needed for v1 sharing; the turn-based
  version delivers "share a story" without it.

---

## 6. Usage enforcement — layered, not a single mechanism

"Make sure users don't use more than they should" wants defense in depth, because any
single layer can have a bug:

1. **Provider-side hard cap (the backstop).** Per-user OpenRouter key with `limit` set
   from their plan, `limit_reset: monthly`. This is enforced by OpenRouter regardless
   of what the app does — a bug in app-level metering cannot cause an unbounded bill,
   only a premature block, which is the safe failure direction.
2. **Plan → limit sync.** On signup/renewal/upgrade (Stripe webhook, §7), call
   `PATCH` on that user's OpenRouter key to set the new limit. One integration point.
3. **App-level visibility and soft warnings**, building on what already exists:
   `ChronicleStore.usageTotals()` already sums tokens per story; extend it to sum
   *across all of a user's stories* and surface it as "$X of $Y this month" in the
   topbar (the existing `formatTokens`/usage UI in `App.tsx` is most of this
   already) — plus a warning banner at ~80% and a friendly block-with-upgrade-CTA
   before the provider's own 402 would otherwise surprise them.
4. **Request-rate limiting**, independent of dollars — a runaway client loop or a
   scripted abuse case should be caught by requests/minute, not just by the money
   running out. A basic token-bucket per user in the app server; move to something
   shared (Redis) only once there's more than one app process.
5. **Ingest costed and gated separately from play** (§5) — it's the one action whose
   cost can spike by 10–100x a normal session, and it benefits every future player of
   that world, not just the one who ran it, so it shouldn't share a budget with
   ordinary per-turn spend.

---

## 7. Payment model

Costs are small and variable per use (§4: fractions of a cent per turn, real money
only for ingest). That points at **subscription with a hard monthly quota**, not
metered/pay-per-token billing — metered invoices are the wrong feel for a creative
writing tool and add real billing complexity (Stripe's usage-based billing works, but
"here's your bill, it depends how much you played this month" is a bad surprise for
this kind of product).

Proposed shape:

- **Free tier**: mock provider only, or a small hard-capped allowance (e.g. $0.50 of
  real-model spend/month) on the cheapest model — a genuine hands-on trial with zero
  payment friction, and the cost to you is capped to the cent by the OpenRouter key
  limit regardless of anything else.
- **Paid tiers**, subscription, each mapping to an OpenRouter key limit:
  - e.g. **$8/mo** → ~$2–3 of underlying model spend (roughly 500–1000 turns at
    §4's estimate) on the cheap/default models.
  - e.g. **$20/mo** → a larger allowance, plus access to the premium narrator tier
    (Sonnet-class) and a per-month ingest allowance.
  - Markup of roughly 3–4x raw provider cost is standard for AI-wrapper products at
    this scale and needs to cover: the free tier, mechanical-role calls (billed
    but invisible to the user), infra, and margin.
- **Overage**: hard-stop at quota by default (predictable, no surprise bill); optional
  one-off credit top-ups via Stripe Checkout for people who want to keep going
  mid-month, rather than metered auto-billing.
- **Processor**: Stripe — subscriptions + customer portal (self-serve plan
  change/cancel) + one-off top-ups. Standard choice, nothing exotic needed here.

**One thing to flag loudly before monetizing any of this**, because the codebase
already did the legal research and it points straight at this exact scenario:
`docs/legal-briefing-fandom-ingest.md` §4(c) identifies **"paid access / hosted
fandom-as-a-service"** as the highest-risk configuration found — combining a
ShareAlike conflict (can't contractually restrict redistribution of CC BY-SA text you
charge for), loss of fair-use footing once commercial, and trademark exposure, closely
matching the *Harry Potter Lexicon* case (commercial, wiki-derived, verbatim-quotation
reference — held not fair use). Concretely: **selling a subscription that includes
access to pre-built canon ingested from a fandom wiki is the one part of this whole
plan that needs real legal review before shipping**, separate from everything else
here which is ordinary SaaS engineering. Safer defaults until that review happens:
keep any *official/bundled* fandom worlds free-tier only, and treat paid tiers as
paying for compute + your own original/user-authored worlds, with fandom ingest
staying a self-serve, BYOK, "you ran this against your own account" feature rather
than something the product itself sells access to.

---

## 8. Mobile view

`web/src/styles.css` already has three breakpoints (1180/960/640px, lines ~2181–2203)
that do real work — collapsing the side panel, hiding topbar metadata, shrinking tab
padding — so this isn't starting from nothing. But the app's actual shape (seven
tabs, a force-directed graph view, always-visible wide side panels) is a desktop
inspector, and no amount of breakpoint-shrinking turns a drag-to-pan graph into a good
touch experience.

Recommended approach, using the existing tier-1/tier-2 CSS token architecture
(`.design/TOKENS.md`) rather than fighting it:

- **Keep the desktop inspector as-is.** It's good, and power users on desktop are a
  real audience regardless of mobile support.
- **Add a narrow-viewport "play" layout**, not just narrower versions of the same
  panels: bottom tab bar (book / cast / world / more) instead of the top `nav.tabs`
  row; the input box pinned to the bottom like a chat app instead of inline in the
  scroll; `graph`/`causality`/`facts` collapsed into simple filtered lists on touch
  widths rather than the force-directed canvas (which genuinely doesn't work well
  with a thumb); side panels become slide-in sheets rather than always-visible
  columns.
- This is CSS/layout work against an existing, well-organized token system — a good,
  self-contained follow-up task once the direction above is agreed, and one that
  doesn't depend on any of the multi-user/auth work landing first.

---

## 9. Phased plan

Ordered so each phase is shippable and doesn't require the later ones to have value.

**Phase 0 — request-scoped identity (no user-visible change).**
Add `users`, `world_access`, `stories.owner_user_id`. Introduce a resolved
`(currentUser, world, story)` per request in `api.ts`, replacing direct reliance on
the `CurrentWorld`/`CurrentStory` globals for anything that isn't the sole
self-hosted admin path. Ship behind a flag so today's single-user `pnpm serve` keeps
working unauthenticated exactly as now. This is the load-bearing phase; everything
else is additive once it's done.

**Phase 1 — login and shared canon.**
Email/OAuth login (§3), "browse worlds" library scoped by `world_access`, per-user
story list. Still one server process, still SQLite world files. This alone delivers
the headline ask: separate users, shared canon, unrelated private stories.

**Phase 2 — money.**
OpenRouter as the hosted provider backend (§4), Stripe subscriptions (§7),
per-user OpenRouter key + limit sync (§6), usage dashboard built on the existing
`usageTotals()` extended across a user's stories.

**Phase 3 — sharing and mobile.**
`story_members` + turn-based collaboration (§5), mobile play layout (§8). Independent
of each other; can run in parallel.

**Phase 4 — only if scale actually demands it.**
Move the control-plane (and, if needed, world storage) off single-process SQLite to a
networked database for multi-instance horizontal scaling. Not needed to launch; the
current storage model comfortably supports one solid server handling many worlds and
a meaningful number of concurrent users first.
