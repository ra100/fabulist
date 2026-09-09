# Plan: closing the gaps

Written after walking the app in a browser and checking each claim against the code.
Companion to `DESIGN.md` (the why) and `PLAN.md` (the build decisions).

## The organising insight

Most of what is missing is **not missing engine**. It is machinery that works, is
tested, and had no way to reach it. Compaction, branching, re-render, JIT deepening
and the frame budget view all exist and all pass tests; at the time this was
written, four of the five could not be triggered from the UI at all — re-render
and compaction have since been wired up (1.2, 1.4).

So the cheapest and highest-value work is not building features. It is connecting
ones already built. That ordering is the plan.

Sizes are rough: **S** under an hour, **M** a few hours, **L** a day or more.

---

## Tier 1 — reachability

Working engine, no route to it. Nothing here needs a design decision.

### 1.1 The why panel does not survive a reload — **bug** · S · done

Three turns played and it still reads *"Play a turn."* It is component state, so a
reload or a tab switch loses it.

This matters more than it looks. The why panel carries the frame budget, the
integrity verdict, the referee ruling and the lint findings — the entire
transparency argument of §11, which is what makes the engine trustworthy enough to
stop double-checking. Invisible unless you just played is close to absent.

Read the last turn's stored `meta` on mount instead of holding it in state. The data
is already persisted per turn; only the read is missing.

Fixed: `BookTab`'s `load()` now fetches the last turn's `meta` from `/api/turn/:id`
after loading the book, instead of only setting it from a fresh `play()` response.
Verified in the browser: play a turn, reload, the why panel still shows it.

### 1.2 No way to advance a scene — **compaction never runs** · S · done

Scene stays `1` forever unless the extractor happens to set `sceneAdvance`. The CLI
has `/scene`; the UI has nothing. So hierarchical compaction, chapter roll-up and
the scene-summary frame slot are all built, tested, and never exercised in normal
use.

A "close the scene" button in the book view calling the existing compaction path.
Show the summary it wrote, since that is also how you notice a bad one.

Fixed: `POST /api/scene/close` wraps the same `Compactor.onSceneClosed` path the CLI's
`/scene` uses, and a "close scene" button sits next to "play" in the composer. The
summary (or the reason there isn't one — too few turns) lands in "what followed".
Covered by `test/api.test.ts` and verified live: closing a one-turn scene correctly
produced no summary (below `minTurns`), closing a two-turn scene did.

### 1.3 Branching is unreachable · M

`POST /api/branch` works and is tested; there is no button. §11 lists it, and it is
the design's answer to retcon.

Needs a little more than a button: a scene picker, and — the real gap — **the
branch it writes is a file the UI cannot open**. Depends on 3.2 (save management) to
be genuinely useful, so ship the fork first and the switch with 3.2.

### 1.4 Re-render is unreachable · M · done

The headline consequence of "prose is a view of state": change the tone, re-render
chapter 4, nothing that happened changes. `setProse` and pinning both exist. No
route, no button.

Fixed: `POST /api/turn/:id/regenerate` renders the turn's stored delta through the
current style contract and refuses a pinned turn with 409 rather than a silent
no-op. The book view's reroll control (with an optional steering note — "shorter",
"more tension") calls it, and an MCP tool (`regenerate_turn`) exposes the same path
to a connector. Covered by `test/api.test.ts` (pinned-turn refusal, unknown-turn
404, delta left untouched) and `test/engine.test.ts`.

### 1.5 Sheets are not editable · M · done

§11 says "editable, with lock toggles per field". Locks work; the text is read-only,
including vows — which is odd, because the vow list is the one thing the integrity
gate actually enforces. `PUT /api/sheet/:id` already accepts a full sheet.

Fixed: a `SheetEditor` component (`web/src/views/SheetEditor.tsx`) covers contract
(vows — add/remove/retitle/re-rank/toggle-broken, breaking point, cost of break,
drives), identity (goals/wounds/fears/secrets/allegiances/competencies/arc) and
voice (diction, sample lines, tics, never-says) on blur, the same pattern
`AppearanceEditor` already used for the visual half. The route needed no changes —
only the UI was missing. Covered by `test/api.test.ts` (a full round-trip through
the exact shape the editor sends, including adding a vow by hand, and the 404 on an
unknown sheet) and verified live in the browser: added a vow to Brother Anselm,
reloaded, it survived.

### 1.6 JIT deepening is never called · M

`deepenOnDemand`, `promoteRegion` and `deepenTargets` are written and tested, and
nothing outside `depth.ts` calls them. The design's claim that skim is a viable
permanent baseline depends on this: walk into a skim-level location and it stays
thin forever.

Hook it into the turn loop after the referee resolves a location, and let the
director pre-deepen where threads point during idle time. Needs the ingest client
available at play time, which is currently only constructed during setup — that is
the actual work.

### 1.7 Graph has no search · S · done

`/api/search` exists and is unused by the graph view. On a 3,000-page ingest,
filtering by type and layer is not enough to find anything.

Fixed: a search box above the graph, debounced, results show name/type/layer,
clicking one selects the entity and clears the query. The client method
(`api.search`) already existed; only the UI was missing.

---

## Tier 2 — first run and trust

### 2.1 The wizard never offers a provider · S · done

Half-closed already: settings can switch profile live, but the wizard still builds a
world silently on the mock. So a first-time user meets deliberately plain prose at
precisely the moment they are deciding whether any of this is good.

Add a step, or a line on the first screen, when the probe finds something better
than the mock. Reuse the existing probe and switch endpoints.

Fixed: the wizard's first screen probes on mount, and when the live profile is
`mock` but something else is usable, offers to switch before any world gets built —
with a "stay on the mock" dismissal that does not touch the persisted config.
Verified live on this machine: it correctly offered `bedrock` (real `~/.aws`
credentials), and dismissing left `fabulist.config.json` untouched.

### 2.2 No export · M · done

There was no way to get the book out — not text, not markdown, not anything. For a
writing tool that was a strange hole. Markdown and plain text cover it; scene and
chapter headings come from the compaction work.

Fixed: `exportMarkdown`/`exportPlainText` (new, `src/loop/export.ts`) read only
what `GET /api/book`/`GET /api/chapters` already expose — `Turn.bookProse`,
`chronicle.scenes()`, `chronicle.chapters()` — rather than a second rendering
path, so a hand-edited or pinned turn's *current* prose is what gets exported,
never a stale copy. A scene groups under its chapter's heading (using the
chapter's own summary when compaction wrote one), each scene gets its own
heading plus its own summary when one exists, and each turn's prose follows
as a paragraph. Plain text is the same structure with `#`/`##`/`###`/
`*italic*` unwrapped to a reader-friendly heading style, since a markdown
file opened in a plain-text viewer would otherwise render the hash marks
literally. `GET /api/export?format=markdown|text` serves it with a
`content-disposition: attachment` filename derived from the world's title,
so a plain `<a href>` download link works with no client-side fetch-then-
blob dance — which is what the book view's new "export .md"/"export .txt"
links actually are. Covered by `test/export.test.ts` (heading structure,
chapter/scene grouping, summaries on/off, explicit title override, empty
book, plain-text stripping, hand-edited prose) and `test/api.test.ts` (the
route: headers, both formats, empty book). Verified live: downloaded both
formats against a real server, confirmed the markdown import correctly.

### 2.3 No save management · M · multi-story done, cross-file management still open

One `dbPath`, no way to list, open, name or delete a world. Branching writes files
that then cannot be opened. Ingesting a second fandom means editing config and
restarting.

`dbPath` is deliberately not runtime-patchable because the world is already open, so
listing/opening a *different world file* (a different fandom entirely) still needs a
re-open path — close the world, open another, rebuild the engine — and that part of
this gap is still open. What is fixed is the part one level below file management:
the app never supported more than one *story* per world file at all, so trying two
independent playthroughs of the *same* fandom meant two separate server processes.
Fixed end to end, backend through UI:

- Schema: a `stories` table replaces the old `session` singleton. Canon
  (`layer='canon'`) is unscoped and shared by every story in a world file; every
  mutable table (entities/edges at `layer='chronicle'`, sheets, relationships,
  facts/fact_knowledge, threads, events, consequences, turns, scenes, chapters,
  directives, divergences, style_anchors, illustrations) carries `story_id` and is
  isolated per story. `meta`, `ingest_pages` stay world-level.
- Every store class takes a `storyId` and filters by it. `World.open()` auto-resolves
  for the ~75 existing call sites that never think about multiple stories (a file
  with exactly one story just binds to it); `World.withStory()` switches stories in
  an already-open file with no reopen.
- `Engine`/`Compactor`/`SetupService`/`IllustrationService` resolve `World` live per
  call rather than holding a captured reference — the same bug shape the
  SetupPlanner fix caught for providers, one level up, since which story is
  "current" can now change under a long-lived server process without a restart.
  `CurrentStory` (`src/store/index.ts`) is the server-level version of the same
  pattern: `createApiServer` resolves it fresh per request, so
  `POST /api/stories/:id/switch` takes effect on the very next request.
- `forkStory(world, { fromStoryId, atScene? })`: the same-file fork primitive. Omit
  `atScene` for a fresh, non-overlapping story sharing only canon ("start a new
  story in this world"); pass it to copy that story's chronicle up to the scene
  boundary first ("branch from here" / "continue from an earlier point"). Every
  copied row gets a fresh id with cross-references remapped — a real bug (copying
  with the original id, which collided with the still-live source row) was found
  and fixed with real regression tests, not assumed correct from the design.
  `branchSave` (cross-*file* fork, for handing off a save) sits on the same
  primitives.
- Routes: `GET/POST /api/stories`, `POST /api/stories/fork` (accepts an explicit
  `fromStoryId` so the save browser can branch a story other than the one
  currently open, no switch-then-fork-then-switch-back needed), `POST
  /api/stories/:id/switch`, `PUT /api/stories/:id/title`, `DELETE
  /api/stories/:id` (409 on the currently-open story, 400 on the last story in a
  file — `POST /api/setup/reset`'s job).
- UI: a "stories" tab replaces the old topbar "new" button (which only ever
  offered "discard everything, canon included"). Lists every story, and offers
  open/rename/branch/delete per story, "start a new story", and — still, at the
  bottom, clearly separated — "discard this world" for when that really is what
  is wanted. Verified in a real browser against a live server, not only through
  the test suite: create, rename, open (switch), play a turn, branch a
  non-current story without switching to it, delete, and the 409 refusal on
  deleting the currently-open story all round-tripped correctly.

### 2.4 No session cost or token total · S · done

Per-turn provider calls are logged and shown; nothing accumulates. On a paid
provider that is the number you actually want, and it is a sum over data already
stored.

Fixed: `ChronicleStore.usageTotals()` sums every turn's `providerCalls`, by role and
in total. `/api/state` reports it; the topbar shows a running token count with a
per-role tooltip, and a "session usage" card in settings shows the full breakdown.
Covered by a store test (`test/store.test.ts`) and an API test.

---

## Tier 3 — genuine holes

### 3.1 No timeline view · M · done

§11 lists "Timeline — chronicle with the divergence points marked". The book was a
flat list of turns. Scenes, chapters and the divergence ledger all existed in the
database with nothing rendering them as a spine.

Fixed, absorbing 3.5 in the same pass: `GET /api/timeline` (new,
`src/server/api.ts`) assembles `chronicle.scenes()`, `chronicle.chapters()`
and `chronicle.divergences()` into one connected view — every scene grouped
under its chapter heading, with its own title/summary and turn count, and
every divergence recorded at that scene attached to it directly rather than
living only in a sidebar. The union handles three cases a naive `scenes()`
join misses: a scene with turns but no `scenes` row yet (the current,
still-open scene), a row with no turns (closed too early to summarise), and
— the case that matters most for this route specifically — a divergence
recorded at the current scene before any turn in it has committed (a
directive/override can fire mid-turn). A new `TimelineTab` renders it as a
vertical spine: one chapter head, one row per scene beneath it marked
`current` where relevant, and every divergence inline with a "vs. canon"
toggle to reveal what it actually diverged from. Covered by `test/api.test.ts`
(the assembly, the exact-scene attribution, the empty-book case) and
verified live: played two turns including a vow-break override, closed the
scene, and watched the divergence stay correctly attached to scene 1 while
scene 2 appeared as the current, not-yet-played scene under the same
chapter.

### 3.2 No ingest depth panel · M

§3.1's per-subgraph depth is real in the engine and invisible in the UI: no way to
see what is skim versus deep, or to promote a region before playing there. Pairs
with 1.6 — one shows the state, the other acts on it.

### 3.3 Epistemics are read-only · S · done

The facts view shows who knows what. There is no way to grant or revoke knowledge,
which is the natural authoring move when the extractor gets it wrong — and getting
it wrong here is exactly what produces an NPC reacting to something they should not
know.

Fixed: `POST /api/fact/:id/knowledge` grants or updates an entity's knowledge level
(`knows`/`suspects`/`wrong`), `DELETE /api/fact/:id/knowledge/:entityId` revokes it
— a new `ChronicleStore.revokeKnowledge` that deletes the row outright rather than
overwriting with a level, so a revoked entity goes back to "never told" rather than
to a fourth state meaning "explicitly does not know". The facts view now shows a ×
next to every knower and a "grant to…" picker (excluding existing knowers) per
fact. Covered by `test/store.test.ts` and `test/api.test.ts` (grant, bad-level 400,
unknown-fact 404, revoke) and verified live: granted the route fact to Novice Tem,
revoked it, both round-tripped and the candidate list updated each time.

### 3.4 No thread authoring · S · done

Tension is draggable; you cannot create, retitle or close a thread by hand.

Fixed: `POST /api/threads` creates a thread (title required, everything else
defaulted — tension 0.5, empty stakes/parties/resolutions, status `open`); retitle
and close were already one call away since `PUT /api/thread/:id` already accepted
`title`/`status`, only the UI was missing. The threads view got a "start a thread"
panel and, per thread, a click-to-retitle title and resolve/abandon/reopen buttons.
Covered by `test/api.test.ts` and verified live: created "who told the garrison",
retitled it, resolved it (status flipped, controls swapped to a single "reopen"),
all surviving a reload.

### 3.5 Divergence ledger is half-hidden · S · done, folded into 3.1

Used to appear in the book sidebar only when non-empty, nowhere else. It is the
record of how far this playthrough has left canon, and deserved a real view.

Fixed as part of 3.1's timeline: every divergence now appears inline against
the exact scene it happened at, always — not gated on non-emptiness — plus a
running total in the timeline's own sidebar. The book sidebar's own ledger
card is untouched (still useful as "what just happened" context beside the
most recent turn); the timeline is now the place for "the whole record".

### 3.6 No way to roll back a scene, chapter or part in place · M · done

You can go forward and you can branch sideways. Now you can also go back.

Every reason an author wants to: the last chapter went somewhere you did not
mean, a model wrote three turns of drift before you noticed, an override you
allowed turned out to break the character after all, a consequence fired that
you want to un-fire, or you simply want to replay a stretch differently without
carrying a second save around.

**The engine for this already existed and was tested.** `truncateToScene(world,
scene)` in `src/loop/branch.ts` deletes every chronicle row at or after a scene
boundary — turns, events, consequences, facts, threads, directives, divergences,
illustrations — restores edges retired after that point, and resets the session
to that scene. `test/branch.test.ts` covers it directly (a dozen assertions) and
`checkIntegrity` is run against the result, because it deletes rows other tables
reference.

What was missing was only that **nothing could reach it on the story you were
reading**. Fixed:

1. **Chapter/part granularity.** `firstSceneOfChapter(world, chapter)` (new,
   `src/loop/branch.ts`) reads `scenes.chapter` — the actual, authoritative
   record `Compactor` writes as scenes close — rather than recomputing
   `Compactor.chapterOf(scene)`, which depends on a runtime-configurable
   `chapterSize` this module has no access to. `rollback(world, { chapter })`
   resolves it and calls straight into `truncateToScene`. Parts never became
   a real level, so there is nothing to map there yet.
2. **A reachable surface.** `POST /api/rollback`, a `rollback` MCP tool, and a
   "roll back…" control in the book view next to the existing scene-close
   button. The panel offers chapter granularity when any chapters have
   closed, scene granularity always, and shows both outcomes side by side
   (see decision 4 below) rather than one button whose behaviour depends on
   a mode nobody remembers setting.
3. **Ownership and confirmation.** `ownsStoryOrRespond` (REST) /
   `assertOwned` (MCP) gate it, same as every other story-scoped write. The
   destructive path additionally requires a confirm dialog naming the exact
   scene/chapter and stating it cannot be undone; the fork path needs no
   confirm, since nothing is destroyed. Both report exactly what happened —
   `removed` (per-table counts, from `truncateToScene`) for destructive,
   `forkedStory` for fork.
4. **The recoverability decision, settled.** Fork-under-the-hood by default,
   with an explicit destructive option — the safer of the two designs this
   section used to leave open. `mode: 'fork'` (default) is `forkStory` with
   `atScene` set to the target: a new sibling story that stops exactly at
   the rollback point, and the route/tool switches to it immediately (unlike
   `POST /api/stories/fork`, which deliberately does not switch — a
   rollback's whole point is "go there now"). The long version survives
   completely untouched as a story you can still open. `mode: 'destructive'`
   truncates the current story in place, no sibling, no way back except a
   save you already had.

**A login-on subtlety the implementation had to get right, not just the
happy path:** switching on a fork must never mutate the shared, server-wide
`CurrentStory` pointer when a real signed-in caller is behind the request —
that pointer is process-wide, and dragging every other user onto one
caller's rollback would be exactly the bug `switchStoryTool`'s own
`selectStory` distinction already exists to prevent. So the REST route and
MCP tool only call `currentStory.switchTo(...)` in the login-off/legacy
shape; with login on, `forkStory`'s own `createStory` already stamps the new
story's `last_played_at` as now, so `worldFor(user)`'s "most recently played
of *this user's* stories" resolution lands on it naturally on the caller's
very next request, with no shared state touched at all. Verified with a
dedicated test (`POST /api/rollback with login on never moves the shared
server-wide pointer, only worldFor resolution`) since this is exactly the
kind of bug fixture tests against a single caller cannot show.

Covered by `test/branch.test.ts` (the primitive: fork mode leaves the
original untouched, destructive mode truncates in place with no sibling,
chapter resolution, ambiguous/out-of-range input refused) and
`test/api.test.ts` (the route: both modes, the 503 a fork-mode call gets
with no `CurrentStory` to switch through, the 400s, the login-on pointer
test above). Verified live in the browser against a real server: played a
turn, rolled back in fork mode (switched to a new empty sibling book, the
original untouched and still openable with its turn intact in the Stories
tab), then rolled back the original in destructive mode (confirm dialog
named the exact scene, accepting it emptied that book in place with no
third sibling created).

---

## Tier 4 — the honest ones

These are in the README already. Listing them so the plan is complete, with what I
actually think.

### 4.1 Pass B has never met a real wiki · **done — the session, and two real bugs it found**

Tested hard against fixtures and adversarial model output. Predicate quality on live
Fandom prose is unmeasured, and the mock cheerfully emits `ALLIED_WITH` for "is the
Warden of" — which the gate accepts, because it checks provenance, not semantics.

**No amount of code closes this.** It needs one real ingest against one real wiki
with a real model, and then judgement about what came back. The drop counters exist
for exactly that.

Ran it: `witcher.fandom.com`, "Kaer Morhen" arc, skim mode, real AWS Bedrock
(`us.anthropic.claude-sonnet-4-5` narrating, `us.anthropic.claude-haiku-4-5`
for mechanics — the presets' pinned model IDs had aged out of Bedrock's
catalog since they were written; both needed a cross-region inference
profile ID, set live through the config UI rather than a restart).

The session found two bugs in the engine itself, both now fixed and covered by
regression tests, neither of which any fixture-based test could have caught
because both required the exact shape of a real provider's real wire response:

- **Bedrock streaming was silently producing empty prose on every turn.**
  `readAwsEventStream` was scanning for a different AWS service's event-stream
  convention (`{"bytes":"<base64>"}`, which is Kinesis / S3 Select) instead of
  Bedrock's own frame format (a length-prefixed binary prelude, then headers,
  then the raw JSON payload — no base64, no `bytes` field). Nothing threw; the
  turn committed normally with `bookProse: ""`. Caught only because the
  identical prompt through the non-streaming path produced good prose
  immediately, which made the two paths visibly disagree.
- **The setup wizard's "you have Bedrock, use it" button (built in Slice A)
  didn't actually reach the planner.** `SetupService` resolved
  `providers.get('setup')` once at construction and handed `SetupPlanner` that
  fixed `Provider`. Switching the live profile afterwards replaced what the
  registry returns without replacing what the planner had already captured, so
  every plan kept silently running on the profile that was live when the
  server started. `/api/play` never had this bug — `Engine` holds the
  `Registry` itself and calls `.get(role)` fresh every turn.

What the session found about ingest quality, once both were fixed and real
prose was flowing: Pass A's wikitext parsing leaks raw infobox markup into a
real fraction of character summaries on template-heavy pages (confirmed on
Lambert, Vesemir, Yennefer, Alzur — all rendered `{{Infobox Character
|name = ...` as their entire summary), and the discovery/candidate stage
surfaces species pages, game mechanics, and the book's real-world author
("Human", "XP", "Andrzej Sapkowski") as playable-character candidates. Both
are real, both are Pass A's problem (deterministic wikitext parsing and
discovery scoring, not model judgement) and neither blocked play — they
degraded the character-adoption list, not the turn loop. Worth a Pass A pass,
not urgent.

What the session found about play quality: real bedrock prose is
substantially better than the mock at the things the mock cannot fake —
specific sensory detail, an NPC with a legible tactic instead of a genre
gesture, dialogue that carries subtext. The prose lint also correctly tripped
on `portentous-one-liner-pattern` five times in one turn's output (short
punchy closers: "Then stop." "Then nothing.") — a real, mild AI-tell the gate
is right to flag, not a false positive.

Also incidentally hit and fixed, unrelated to the app: this machine's Node
`fetch` needed `NODE_EXTRA_CA_CERTS` pointed at the corporate TLS bundle for
outbound wiki requests to work at all (`curl` respects `SSL_CERT_FILE`
already; undici does not) — an environment note for next time, not a code fix.

### 4.2 Prose quality and the interrupt copy are unmeasured · needs a session

Same shape. No test can tell you whether the integrity interrupt reads as a
collaborator or a nag. 4.1's session did not trigger an integrity interrupt —
the trainee played cautiously — so this specific question is still open.

### 4.3 No vector retrieval · L, low value

The design calls embeddings the garnish and graph traversal the meal. I would not
build this until something concrete is failing without it.

### 4.4 Tokenizer is a heuristic · S, low value

Over-estimates on purpose, and the interface is pluggable. Worth doing only if the
frame budget starts visibly under-filling.


### 4.5 Streaming stops at the narrator · won't do

The mechanical roles return structured output, where a partial result is worthless.
The silent stretch before prose starts is the cost of that, and the stage labels
already tell you what is happening.

### 4.6 In-place retcon · won't do

Deliberate. Rewriting history means recomputing every downstream consequence;
branching gets most of the value for a fraction of the cost. Revisit only if
branching proves too coarse in practice.

### 4.7 Ingest ranking under-counts famous entities · S, deferred

Inbound counts come only from crawled pages. Fixing it properly needs the
`linkshere` API, one request per page. The hub penalty covers the pathology that
actually bit. Wait for evidence.

### 4.8 Ingest pulls in distribution metadata as if it were world canon · M

**TODO.** A fandom wiki documents two different things under one namespace: the
fictional world, and the products the world shipped in. The crawl cannot tell
them apart, so authors, publishers, episode lists, issue numbers, release dates,
voice actors, box sets, cut content and "making of" pages all become canon
entities with canon edges — and then compete with the world for salience, for
frame budget, and for the player's own character list.

Not hypothetical. Measured on the Mass Effect ingest in this repo's own
`data/worlds/mass-effect-wiki`:

- The highest-yield source pages were **Bonus Content Disc** (164 entities),
  **Mass Effect Cut Content** (123), **Mass Effect: Foundation** (a comic, 79),
  **The Final Hours of…** (77), **Shadow Broker Dossiers** (49), plus
  **Redemption** / **Invasion** / **Evolution** (comics) and **ME2 Cut Content**.
  Nine of the top twelve provenances by entity count were distribution, not world.
- A DVD became a **Faction**: `fac:bonus-content-disc`, with `MENTIONS` edges
  radiating out of it into real canon.
- `appearances` (580 pages) and `voiceactor` (208) are among the most common
  infobox fields on the wiki. Both are pure distribution metadata. They are
  currently ignored by `RELATION_FIELDS`, which is right, but the *pages* they
  point at are still crawled and ingested as entities.
- The discovery preview's `topEntities` for a Shepard-seeded crawl included
  `Mass Effect 2`, `Mass Effect Trilogy` and `Mass Effect 3 Multiplayer`
  scoring above most actual characters — see also the note at the end of §4.1
  about "real-world pages as character candidates", which this is the concrete
  form of.

What it costs: the Director and Referee are shown a world in which a game
edition is an entity of the same kind as a person; `list_characters` offers
products as protagonists; and pass B spends a model call per page on pages that
describe a print run.

Sketch, cheapest first, none of it committed to yet:

1. **Category-based exclusion at scope time.** These pages are almost always
   categorised as such (`Category:Comics`, `Category:Cut content`,
   `Category:Real-world articles`, `Category:Voice actors`, `Category:Media`).
   `prune`'s `excludeCategories` already exists and is already plumbed through
   the wizard, the REST routes and the MCP tools — this may be mostly a matter
   of shipping a sensible default list per wiki family rather than new code.
2. **A hub-penalty sibling for out-of-world pages.** The existing penalty
   catches index pages by title shape and outbound breadth. A "distribution"
   signal is similar in kind: an infobox template like `Infobox media`/`game`/
   `comic`, a `released`/`publisher`/`isbn`/`developer`/`writer` field, a title
   matching a known product naming pattern.
3. **Drop the fields too, not just the pages.** `appearances`, `voiceactor`,
   `released`, `publisher`, `developer`, `issue`, `runtime` should be excluded
   from `props` as well, so they never reach a prompt. Today they are kept as
   attributes and `renderProps` can put them in front of the Narrator.

The one thing to be careful about, and the reason this is M and not S: **an
in-world book, film or record is legitimate canon.** *The Codex*, a Shadow
Broker dossier as an in-fiction document, a play a character performs — these
must survive. The filter has to key on "this page describes how the fiction was
published" and not on "this page mentions a book". Getting that backwards
deletes real world material, which is worse than the current noise. So: needs a
measured pass over a real ingest with the filter on and off, counting what each
rule removes, before any of it becomes a default.

---

## Sequence

Grouped so each slice is independently shippable and leaves the app green.

**Slice A — make what exists reachable.** 1.1, 1.2, 1.7, 2.1, 2.4. **Done.**
All small, all high-value, no design decisions. Fixed the transparency bug, made
compaction run, and stopped the first run being narrated by the mock. 440 tests
(437 + 3 new), typecheck clean, verified live in the browser: reload-persistence,
scene close (both the no-summary and summary-produced cases), graph search and
selection, the wizard's provider offer with a real `bedrock` probe, and the topbar
token total after a played turn.

**Slice B — the authoring surface.** 1.4, 1.5, 3.3, 3.4. **Done.**
Editing what the AI wrote: prose, sheets, knowledge, threads. This is the "inspect
and nudge" half of §11 that is currently mostly inspect. 1.4 landed earlier than
this doc had recorded (`regenerate_turn`, already routed and MCP-exposed); 1.5,
3.3 and 3.4 landed together: a `SheetEditor` for identity/contract/voice including
vows, grant/revoke on the facts view, and create/retitle/close on the threads view.
963 tests (952 + 11 new), typecheck and lint clean (0 errors, same 24 pre-existing
warnings), verified live in the browser: added and reloaded a vow, created →
retitled → resolved a thread, granted and revoked a fact's knowledge — every one
surviving a reload.

**Slice C — worlds and continuity.** 2.3, 1.3, 3.6, 2.2, 3.1, 3.5. **Everything
except 1.3's own UI is done.**
Save management first, because branching and export both need it — 2.3's
multi-story backend is what made 3.6's default (fork-under-the-hood) nearly
free once it was built. 3.6 landed ahead of 1.3's own UI (the cross-file
branch button proper is still unreached) because rollback's fork mode only
needed `forkStory` and `CurrentStory`, both already in place; 2.2 turned out
to need nothing from either — it only ever needed `chronicle.scenes()`/
`chapters()`, already there for the book view's own scene breaks. 3.1 landed
absorbing 3.5 in the same pass, exactly as planned, once it turned out 1.2's
scenes were already worth showing. Remaining: 1.3's own scene-picker/button
for `POST /api/branch` — the one item in this slice with a genuine UI gap
left.

**Slice D — depth.** 1.6, 3.2.
Play-time deepening and the panel that shows it. Deliberately last of the build
work: it is the most invasive change to the turn loop, and it is only worth it once
you are playing in a real ingested world — which means 4.1 should come first.

**Then, not last in importance:** 4.1 and 4.2. One real session against one real
wiki with a real model. Everything above is craft; this is the only thing that tells
you whether the engine is any good. **4.1 is now done** — see below.

---

## What I would actually do

Slice A and 4.1 are done. 4.1 was worth doing before anything else: it found two
real bugs no fixture-based test could reach (Bedrock streaming decoding the
wrong wire format; the wizard's live-provider-switch button not reaching the
setup planner), and it did reorder the picture somewhat, though less than I
expected — the turn loop, referee, integrity gate and consequence propagation
all held up against real prose and a real ingest without a single change.
What needs work is upstream of all that: Pass A's wikitext parsing (infobox
leakage) and discovery scoring (species and real-world pages as character
candidates), not the engine's own reasoning.

Next: **Slice B**, on the strength that 4.1 didn't turn up a reason to detour
into Pass A first — the two bugs it found are fixed, and the two ingest-quality
issues it found degrade the character list, not play. 4.2 (interrupt copy)
remains genuinely open: the 4.1 session never triggered one, so it needs either
a deliberately provocative session or targeted testing, not a repeat of this one.

**Slice B is now done.** All four items (1.4 turned out to already be done; 1.5,
3.3, 3.4 landed together) were reachability-shaped in the same sense Slice A was:
the write routes mostly already existed (`PUT /api/sheet/:id`, `PUT
/api/thread/:id`) or needed one small, obvious addition (`POST /api/threads`,
grant/revoke on `fact_knowledge`) — the actual gap was UI. No design decisions
needed, unlike Slice C's rollback question, now settled below.

**Added since:** 4.8, distribution metadata ingested as canon. It is the
concrete, measured form of the "real-world pages as character candidates" note
two paragraphs up, and it belongs with the ingest-quality work rather than in a
play slice. Worth doing before any further real-wiki session, because it changes
what a crawl of the same seeds produces — and therefore what such a session is
actually testing.

**3.6 (rollback), 2.2 (export) and 3.1+3.5 (timeline) are now done too**,
ahead of the rest of Slice C. 3.6's design question (destructive vs.
fork-under-the-hood) is settled in favour of fork by default, exactly the
lean this doc already had, with an explicit destructive option. Doing it
before 1.3's own UI turned out fine: rollback's fork mode only needed
`forkStory` and `CurrentStory`, both already built for 2.3, so nothing about
1.3's still-missing scene-picker/button was actually a prerequisite. 2.2 and
3.1 needed even less: no design decisions at all, and no dependency on 2.3,
1.3 or 3.6 — both only ever needed `chronicle.scenes()`/`chapters()`, already
there for the book view's own scene breaks. 3.1 absorbed 3.5 in the same
pass, as planned from the start.

**Slice C is now down to one item: 1.3's own UI** — a scene picker and button
for `POST /api/branch`, the cross-*file* handoff case, distinct from the
same-file fork the Stories tab and rollback already use. Everything else in
this repository's own plan for the near term is either done or is Slice D
(1.6, 3.2 — deliberately last, and 4.1 already argued for scheduling them
after a real ingest session, which happened).

