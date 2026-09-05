# Plan: closing the gaps

Written after walking the app in a browser and checking each claim against the code.
Companion to `DESIGN.md` (the why) and `PLAN.md` (the build decisions).

## The organising insight

Most of what is missing is **not missing engine**. It is machinery that works, is
tested, and has no way to reach it. Compaction, branching, re-render, JIT deepening
and the frame budget view all exist and all pass tests; four of the five cannot be
triggered from the UI at all.

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

### 1.4 Re-render is unreachable · M

The headline consequence of "prose is a view of state": change the tone, re-render
chapter 4, nothing that happened changes. `setProse` and pinning both exist. No
route, no button.

Add a re-render endpoint that renders a stored beat through the current style
contract, skipping pinned turns, and a per-scene button. Must be visibly
non-destructive — show what will change and what is pinned before doing it.

### 1.5 Sheets are not editable · M

§11 says "editable, with lock toggles per field". Locks work; the text is read-only,
including vows — which is odd, because the vow list is the one thing the integrity
gate actually enforces. `PUT /api/sheet/:id` already accepts a full sheet.

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

### 2.2 No export · M

There is no way to get the book out — not text, not markdown, not anything. For a
writing tool that is a strange hole. Markdown and plain text cover it; scene and
chapter headings come from the compaction work.

### 2.3 No save management · M · backend done, API/UI pending

One `dbPath`, no way to list, open, name or delete a world. Branching writes files
that then cannot be opened. Ingesting a second fandom means editing config and
restarting.

`dbPath` is deliberately not runtime-patchable because the world is already open, so
this needs a re-open path: close the world, open another, rebuild the engine. Worth
doing properly rather than bolting on.

**Multi-story migration (backend complete):** the deeper version of this gap is one
level below file management — the app never supported more than one *story* per
world file at all, so trying two independent playthroughs of the same fandom meant
two separate server processes. That is fixed at the storage layer:

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
- `Engine`/`Compactor`/`SetupService` resolve `World` live per call rather than
  holding a captured reference — the same bug shape the SetupPlanner fix caught for
  providers, one level up, since which story is "current" can now change under a
  long-lived server process without a restart.
- `forkStory(world, { fromStoryId, atScene? })`: the same-file fork primitive. Omit
  `atScene` for a fresh, non-overlapping story sharing only canon ("start a new
  story in this world"); pass it to copy that story's chronicle up to the scene
  boundary first ("branch from here" / "continue from an earlier point"). Every
  copied row gets a fresh id with cross-references remapped — a real bug (copying
  with the original id, which collided with the still-live source row) was found
  and fixed with real regression tests, not assumed correct from the design.
  `branchSave` (cross-*file* fork, for handing off a save) sits on the same
  primitives.

**Still open:** none of this is reachable yet. `src/server/api.ts` has no
story-list/create/switch/rename/delete routes, and the web client has no save/story
browser — the topbar's "new" button is still the single, destructive, whole-file
reset it always was. That is the remaining work for this gap: routes, then UI.

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

### 3.1 No timeline view · M

§11 lists "Timeline — chronicle with the divergence points marked". The book is a
flat list of turns. Scenes, chapters and the divergence ledger all exist in the
database with nothing rendering them as a spine.

Most valuable once 1.2 makes scenes advance, so schedule it after.

### 3.2 No ingest depth panel · M

§3.1's per-subgraph depth is real in the engine and invisible in the UI: no way to
see what is skim versus deep, or to promote a region before playing there. Pairs
with 1.6 — one shows the state, the other acts on it.

### 3.3 Epistemics are read-only · S

The facts view shows who knows what. There is no way to grant or revoke knowledge,
which is the natural authoring move when the extractor gets it wrong — and getting
it wrong here is exactly what produces an NPC reacting to something they should not
know.

### 3.4 No thread authoring · S

Tension is draggable; you cannot create, retitle or close a thread by hand.

### 3.5 Divergence ledger is half-hidden · S

Appears in the book sidebar only when non-empty, nowhere else. It is the record of
how far this playthrough has left canon, and it deserves a real view — most likely
inside the timeline.

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

**Slice B — the authoring surface.** 1.4, 1.5, 3.3, 3.4.
Editing what the AI wrote: prose, sheets, knowledge, threads. This is the "inspect
and nudge" half of §11 that is currently mostly inspect.

**Slice C — worlds and continuity.** 2.3, 1.3, 2.2, 3.1, 3.5.
Save management first, because branching and export both need it. Then the timeline,
which needs 1.2 from Slice A to have scenes worth showing.

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

