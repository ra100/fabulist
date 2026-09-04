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

### 1.1 The why panel does not survive a reload — **bug** · S

Three turns played and it still reads *"Play a turn."* It is component state, so a
reload or a tab switch loses it.

This matters more than it looks. The why panel carries the frame budget, the
integrity verdict, the referee ruling and the lint findings — the entire
transparency argument of §11, which is what makes the engine trustworthy enough to
stop double-checking. Invisible unless you just played is close to absent.

Read the last turn's stored `meta` on mount instead of holding it in state. The data
is already persisted per turn; only the read is missing.

### 1.2 No way to advance a scene — **compaction never runs** · S

Scene stays `1` forever unless the extractor happens to set `sceneAdvance`. The CLI
has `/scene`; the UI has nothing. So hierarchical compaction, chapter roll-up and
the scene-summary frame slot are all built, tested, and never exercised in normal
use.

A "close the scene" button in the book view calling the existing compaction path.
Show the summary it wrote, since that is also how you notice a bad one.

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

### 1.7 Graph has no search · S

`/api/search` exists and is unused by the graph view. On a 3,000-page ingest,
filtering by type and layer is not enough to find anything.

---

## Tier 2 — first run and trust

### 2.1 The wizard never offers a provider · S

Half-closed already: settings can switch profile live, but the wizard still builds a
world silently on the mock. So a first-time user meets deliberately plain prose at
precisely the moment they are deciding whether any of this is good.

Add a step, or a line on the first screen, when the probe finds something better
than the mock. Reuse the existing probe and switch endpoints.

### 2.2 No export · M

There is no way to get the book out — not text, not markdown, not anything. For a
writing tool that is a strange hole. Markdown and plain text cover it; scene and
chapter headings come from the compaction work.

### 2.3 No save management · M

One `dbPath`, no way to list, open, name or delete a world. Branching writes files
that then cannot be opened. Ingesting a second fandom means editing config and
restarting.

`dbPath` is deliberately not runtime-patchable because the world is already open, so
this needs a re-open path: close the world, open another, rebuild the engine. Worth
doing properly rather than bolting on.

### 2.4 No session cost or token total · S

Per-turn provider calls are logged and shown; nothing accumulates. On a paid
provider that is the number you actually want, and it is a sum over data already
stored.

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

### 4.1 Pass B has never met a real wiki · needs a session, not code

Tested hard against fixtures and adversarial model output. Predicate quality on live
Fandom prose is unmeasured, and the mock cheerfully emits `ALLIED_WITH` for "is the
Warden of" — which the gate accepts, because it checks provenance, not semantics.

**No amount of code closes this.** It needs one real ingest against one real wiki
with a real model, and then judgement about what came back. The drop counters exist
for exactly that.

### 4.2 Prose quality and the interrupt copy are unmeasured · needs a session

Same shape. No test can tell you whether the integrity interrupt reads as a
collaborator or a nag.

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

**Slice A — make what exists reachable.** 1.1, 1.2, 1.7, 2.1, 2.4.
All small, all high-value, no design decisions. Fixes the transparency bug, makes
compaction run, and stops the first run being narrated by the mock.

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
you whether the engine is any good.

---

## What I would actually do

If I were choosing: **Slice A now**, because 1.1 is a bug and 1.2 means a tested
subsystem currently never runs. Then **4.1 before Slice B** — a real session will
probably reorder everything below it, and there is a real risk of polishing an
authoring surface for a game that turns out to need something else entirely.
