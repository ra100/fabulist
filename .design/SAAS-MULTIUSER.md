# Fabulist as a global, multi-user app — investigation

**Decision (recorded): no monetization.** This project takes no profit, sells no
subscription, and runs no paid tier — provide it as-is. If it is ever hosted for more
than one person, that is a free, BYOK (bring-your-own-key/account) shared instance, not
a business. Everything below that used to describe a pricing/billing layer (OpenRouter
markup, Stripe subscriptions, paid tiers) has been rewritten or removed to match —
see §4/§6/§7. This also collapses most of the residual legal exposure
`docs/legal-briefing-fandom-ingest.md` §4 flagged for models (b)/(c): with no
commercial purpose anywhere in the product, the posture stays squarely in the
low-risk (a)/(d) rows regardless of hosting shape.

Not a spec, not started otherwise. This is the "can it be done, what breaks, what would
it cost" pass requested before committing to it. Written the way `.design/GAPS.md` and
`.design/CRITIQUE.md` are: concrete, sequenced, and honest about what is genuinely
hard versus what the current design already half-solves.

**Headline finding: the hardest-sounding piece is mostly already built.** The
canon/chronicle split (`DESIGN.md` §2, `src/db/schema.sql`) already gives you "one
shared world, many independent stories" for free — that is what it was built for, just
for one person running many playthroughs rather than many people. The genuinely new
work is identity (who is asking) and authorization (are they allowed to see this world
or story). There is no money question: nothing here is billed.

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
| `users` | `id, email, password_hash (or oauth identity), created_at, ...` | Standard — no `plan`/tier column, since there is no plan. |
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
one process — or (b) move the control-plane (`users`, `world_access`) to a
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

## 4. LLM provider: bring your own key, no markup, no house-paid tokens

No profit motive anywhere in this layer. The app never pays for a user's model calls
and never marks anything up — every user (self-hosted or on a shared free instance)
supplies their own provider credentials, exactly as `src/providers/` already does for
Bedrock/Vertex/Copilot/local today. There is no "hosted, we-pay-for-the-tokens
product" to design for, so most of what used to live in this section (a recommended
default backend, a live pricing table, a per-turn cost estimate feeding a pricing
model) is gone — there is no pricing model.

If a shared multi-user instance is ever run, the simplest honest shape is:

- **Each user configures their own provider** (their own Bedrock/Vertex/Copilot
  credentials, their own API key for a `cheap`/`balanced`/`premium`-style profile, or
  the offline mock) through the same settings UI a self-hoster already uses — §3's
  `users` table just adds *whose* config a given request resolves, the provider layer
  itself is untouched.
- **Optionally, one shared OpenRouter (or similar) key for the free/mock-tier
  experience**, if a fully zero-setup trial matters — but capped at a small, fixed
  monthly ceiling the operator is personally willing to donate (OpenRouter's per-key
  `limit` API, §6, is still useful here purely as a safety backstop, not as billing
  infrastructure), never expanded into a paid tier, never recovering cost from users.
- **No spend markup, no subscription, no invoice.** If running the shared instance
  costs the operator real money (the donated free-tier allowance above, or
  infrastructure), that is treated as a gift, not a business — same spirit as any
  free, ad-free open-source hosted demo.

Bedrock/Vertex/Copilot/local/BYOK-API-key all stay exactly as they are for
self-hosters — nothing in `src/providers/` changes for this.

---

## 5. Canon sharing now, story sharing later

**Shared canon across users, unrelated stories (the immediate ask):** already the
native shape of the schema (§2). What's new is a *social* layer on top:

- A "browse worlds" page (public/unlisted worlds, keyed by `world_access.visibility`)
  — this is the "shared universe library" the ask describes.
- Separating **world editor** (can trigger ingest, edit canon, spend the ingest
  budget) from **player** (can start their own story against that canon, cannot
  mutate it). Ingest is the one operation with a real, potentially large one-time
  cost against whichever provider the editor has configured (§4 — their own key,
  never the app's) — `SetupService` already shows a page-count-and-cost preview
  before committing; keep that, and gate the "commit" step to editors, and probably
  track it separately from per-turn play cost in the usage display, since one
  ingest run can be an order of magnitude more expensive than a turn. None of this
  is app revenue or a billed quantity — it's purely informational, same as §6.2.
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

## 6. Usage enforcement — abuse prevention, not billing

There is no plan, no quota tied to money, and nothing to bill — so "enforcement"
here means only *protecting the operator of a shared instance from abuse*, not
metering anyone's spend against a price:

1. **If a shared free instance donates a provider key (§4), cap it at the
   provider.** A fixed, small `limit` on that one shared key (OpenRouter's per-key
   `limit`/`limit_reset` API, or the equivalent on whatever provider is used) is
   still the right backstop — it protects the *operator's own donated budget* from
   a bug or an abusive client, not a customer's bill. Once it trips, that shared
   free path degrades to the mock provider rather than anyone being charged
   anything.
2. **App-level visibility**, building on what already exists:
   `ChronicleStore.usageTotals()` already sums tokens per story; extend it to sum
   *across all of a user's stories* and surface it as a running total in the
   topbar (the existing `formatTokens`/usage UI in `App.tsx` is most of this
   already) — purely informational, so a user can see what their *own* BYOK
   provider is actually costing them, not a limit the app enforces for revenue.
3. **Request-rate limiting**, independent of any provider spend — a runaway
   client loop or a scripted abuse case should be caught by requests/minute on the
   shared instance, not by money running out. A basic token-bucket per user in the
   app server; move to something shared (Redis) only once there's more than one
   app process.
4. **Ingest kept visible and separately confirmable from play** (§5) — it's the
   one action whose cost can spike by 10–100x a normal session on whichever
   provider a user configured, and `SetupService`'s existing page-count-and-cost
   preview before committing is the right control; nothing here changes because
   there is no billing to protect.

---

## 7. Payment model: there isn't one

No subscriptions, no paid tiers, no Stripe integration, no markup on model spend —
this section previously proposed exactly that shape and it has been deliberately
dropped, not deferred. The project's policy is: **provide it as-is.**

What that means concretely for anyone running this beyond their own laptop:

- **Self-hosted (the default, unaffected).** Nothing changes — configure your own
  provider, pay your own provider directly, nothing routes through this project.
- **A shared multi-user instance, if one is ever run, is free and BYOK.** Each user
  supplies their own provider credentials (§4); the operator pays nothing on their
  behalf and charges nothing in return. If the operator chooses to donate a small
  shared key for a zero-setup mock/cheap-tier trial, that is a gift with a fixed,
  capped ceiling (§6.1), never recovered from users, never expanded into a paid
  product.
- **No metering, no invoice, no "upgrade" prompt anywhere in the UI.** Any
  usage-total display (§6.2) is informational only.

This also resolves the one thing the previous version of this section flagged as
needing legal review before shipping: `docs/legal-briefing-fandom-ingest.md` §4(c)
identifies **"paid access / hosted fandom-as-a-service"** as the highest-risk
configuration found — a ShareAlike conflict, loss of fair-use footing once
commercial, and trademark exposure, closely matching the *Harry Potter Lexicon*
case. With no commercial purpose anywhere in this product, model (c) is off the
table entirely rather than merely mitigated, and fandom ingest stays exactly what
§4(d) of that briefing already recommends: a self-serve, BYOK, "you ran this
against your own account" feature — never something distributed or sold as
pre-built canon.

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

**Phase 2 — BYOK provider config per user, plus optional donated free tier.**
Each user points their own request at their own provider credentials (§4) through
the existing settings UI, now resolved per-user instead of from one process-wide
config. If a zero-setup shared trial is wanted, wire the one small, capped, donated
key from §6.1 — informational usage totals (§6.2) only, no billing anywhere.

**Phase 3 — sharing and mobile.**
`story_members` + turn-based collaboration (§5), mobile play layout (§8). Independent
of each other; can run in parallel.

**Phase 4 — only if scale actually demands it.**
Move the control-plane (and, if needed, world storage) off single-process SQLite to a
networked database for multi-instance horizontal scaling. Not needed to launch; the
current storage model comfortably supports one solid server handling many worlds and
a meaningful number of concurrent users first.
