# Story engine

A creative-writing / role-play system where an AI game master runs a story inside an
existing fictional universe, keeps a real world-model behind the scenes, and stays
consistent when you do something unplanned.

`DESIGN.md` is the reasoning. `PLAN.md` is the implementation decisions. This is how to
run it.

---

## Quick start

```bash
pnpm install
pnpm build:web
pnpm serve                # http://127.0.0.1:4317
```

An empty save opens a setup wizard. It asks three things — where are we playing, where and
when in it, and who are you — and turns the answers into a world. Nothing is read or spent
until you have seen a page count and a cost.

Three routes through it:

- **An existing world.** Name a franchise; it finds the wiki, proposes which corner of it
  to read, and shows what that costs before committing.
- **A world you describe.** No wiki. Describe a premise and it invents the places,
  factions and cast, with a tension already under strain.
- **The built-in example.** Saint Verrow, a monastery under a secular garrison. Fastest
  way to see how this plays.

Everything runs offline on a deterministic mock provider by default — no API keys, no
network. The mock writes deliberately plain prose; it exists to prove the machinery, not to
write well. Point the engine at a real model when you want prose (see **Providers**).

Terminal is still there if you prefer it:

```bash
pnpm seed                 # the sample world
pnpm play                 # interactive session
```

```bash
pnpm test                 # 319 tests, offline
pnpm typecheck
```

---

## The idea in two sentences

Prose is a *view* of state, not the state itself: every narrated turn must emit a typed
state delta, and anything the prose implies but the delta omits did not happen. The game
master is split into three roles — Referee (what is true?), Director (what happens next?),
Narrator (how is it said?) — so no single prompt does three incompatible jobs.

---

## Playing

Type roughly. The book gets the worked version.

```
[s1t0] i try to talk him down, mention his sister, dont draw
```

Your exact words are kept forever as the record of intent; the rendered prose is a
separate register, and it can be re-rendered later without touching what happened.

Commands: `/look` `/sheet [name]` `/threads` `/facts` `/queue` `/why` `/direct <text>`
`/style k=v` `/knob k=v` `/pin` `/anchor <text>` `/tick` `/help` `/quit`

`/why` is the one worth knowing. It shows the frame that was assembled, the move that
fired, both verdicts, the lint score, and the token budget per slot.

### The character integrity gate

The seed character, Brother Anselm, has held a vow of nonviolence for thirty years. Try
to make him stab someone and the game master stops and asks, rather than writing it:

```
[s1t0] i stab the captain

Brother Anselm holds this: harm no living thing. Nothing in this scene forces it.
Taken straight, this is not a choice they have access to.

  a  Rewrite it — I want a different approach
  b  Something has broken in Brother Anselm. Establish what, and play the fallout.
  c  I meant a different character
  d  Override — deliberate heel turn, play it straight
```

Option **d** always exists. An author must be able to break their own character on
purpose; the gate exists to make it *cost* something, not to prevent it. Take it and the
break is recorded on the sheet, spawns the highest-tension thread in the story, and lands
in the divergence ledger.

Strictness is a dial: `permissive` narrates anything, `coaching` uses in-fiction
resistance only, `strict` (default) interrupts on genuine breach, `iron` also stops on
off-key.

World facts get the opposite default. Mention a tavern that does not exist and it is
quietly created and real from then on.

---

## Ingesting a fandom

The wizard does this for you. What follows is what it is doing underneath, and the CLI is
still the better tool for a scripted or repeated ingest:

```bash
pnpm ingest --wiki=https://elderscrolls.fandom.com \
            --seed="Skyrim" --seed="Civil War (Skyrim)" --mode=mid
```

Discovery runs first and commits nothing. It reports the page count, the cast and factions
it found, the hop distribution, and the estimated token spend. Add `--commit` when the
scope looks right.

Depth is **per-subgraph, not global** — you play in a small corner of a universe, so
`skim` is a viable permanent baseline with deep pockets only where you have been:

| | pages | hops | pass B | voice cards |
|---|---|---|---|---|
| `skim` | ~150 | 1 | no | no |
| `mid` | ~600 | 2 | core entities | main cast |
| `deep` | ~3000 | 3 | everything | all speakers |

Deep is a strict superset of mid, so `--upgrade=deep` is a diff over nodes below target.
Nothing is re-extracted.

Pass A (infoboxes, categories, links) needs no model and produces a playable cast on its
own. Pass B adds what only prose contains — typed relations, timeline events, and voice
cards — and runs automatically at `mid` and `deep`.

Pass B refuses more than it accepts, on purpose. Every relation must carry a verbatim
quote that is then checked against the page; predicates come from a closed vocabulary; and
targets must be entities Pass A already created, so one bad extraction cannot seed a
subgraph of fiction. Voice samples get the same treatment, because invented dialogue is
worse than none. Each run reports its drop counts:

```
pass B: 12 pages, 18 relations, 17 events, 2 voice cards
dropped: 18 unevidenced, 12 off-vocabulary, 11 unknown target
```

Watch that second line. A suspiciously low drop rate usually means the extractor is
inventing, not that the wiki is unusually clean.

---

## Providers

Edit `story.config.json`:

```json
{ "profile": "balanced", "dbPath": "data/story.db", "proseLintThreshold": 6, "blocklist": [] }
```

| profile | narrator | mechanics | extractor |
|---|---|---|---|
| `mock` | deterministic, offline | — | — |
| `local` | ollama qwen2.5 | ollama llama3.1 | ollama qwen2.5 |
| `cheap` | deepseek | deepseek | deepseek |
| `balanced` | anthropic sonnet | gpt-4o-mini | gpt-4o-mini |
| `premium` | anthropic sonnet | gpt-4o | gpt-4o |

Keys come from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`).
An unset key falls back to the mock with a note rather than failing — an unconfigured key
should not stop you playing.

The engine assumes a **64k floor**. That is what makes the role split load-bearing rather
than merely tidy: no single call needs the whole picture, so each frame is assembled to a
hard token budget with a fixed eviction order. The extractor is pinned separately from the
narrator on purpose — swapping the model that writes your graph mid-campaign yields a
subtly inconsistent world with no obvious cause.

Adding a provider means describing its capabilities, not writing an adapter: context
window, whether structured output is native / json-mode / absent, whether it has a system
role. The degradation path follows from that.

---

## What the inspector shows

Seven views, all of it a debugger for the world model.

- **book** — both registers per turn, pin passages you like
- **graph** — canon vs chronicle, emergent nodes ringed, edge weight rendered as proximity
- **cast** — sheets with per-field lock toggles; a locked field is ground truth the AI may not overwrite
- **threads** — tension dials, plus a directive panel that reports its recalculation diff
- **causality** — what your acts set in motion, indented by depth, with a spoiler curtain
- **facts** — who knows what, who merely suspects, and who believes a distorted version
- **settings** — style contract, knobs, style anchors

Plus the setup wizard, which replaces the top bar until a world exists. `new` in the top
bar discards the current world and reopens it.

---

## Consequences

Acting on someone ripples outward through people you are not watching. Consequences are a
queue seeded from committed deltas, travelling the same typed edges that keep the world
consistent — the consistency graph doubles as the causality substrate.

Three things make it feel like a world rather than a stage set:

- **Information has to travel.** Nobody reacts until they learn. News moves along social
  edges with latency *and distortion*; by the third hop the story is wrong, and people act
  on the wrong version. Suppression is a real tactic, because killing a witness cuts an
  edge in the transmission graph.
- **Hidden consequences are still committed.** Not "maybe" — true, you just do not know.
- **An ignorance budget.** Once too much has matured unseen, the Director starts steering
  traces toward you. The failure mode here is not incoherence but *invisible* coherence:
  machinery that runs perfectly and is never felt is indistinguishable from randomness.

`/tick` advances it by hand. Otherwise it runs between scenes, mostly as deterministic
graph work rather than model calls.

---

## The prose gate

Deterministic lint first; a model rewrite only when it trips, which is what makes it
affordable on every turn.

Two profiles share one engine, because the standard AI-tell lists are calibrated for
expository prose and several of their rules are **wrong** for fiction. Em dashes are
legitimate in dialogue. Curly quotes are correct book typography. Passive voice can be
deliberate narrative distance. So the `fiction` profile hunts what actually gives away
machine fiction instead: somatic clichés, emotions named rather than shown, sensory
triads, non-events, portentous closers, uniform dialogue.

```bash
echo "He let out a breath he didn't know he was holding." | pnpm lint:prose
```

The knob to be careful with is strictness. Anti-AI lint pushes toward the *absence* of
tells, which is not the same as the presence of style, and an over-tuned gate produces
careful characterless prose. The style anchors in `settings` do more against drift than
the lint does. Keep a personal blocklist in the config; it becomes the most valuable file
in the project within a month.

---

## Repeatable sessions

```bash
pnpm exec node --disable-warning=ExperimentalWarning src/cli/script.ts turns.txt
```

One turn per line, `#` for comments, leading `!` to override the integrity gate. It prints
a state fingerprint at the end, which doubles as the provider conformance suite: the same
script against a different provider should end with the same graph state even though the
prose differs.

---

## Long sessions and second chances

Only the current scene stays verbatim. `/scene` closes a scene and summarises it,
chapters roll up automatically at the boundary, and `/compact` catches up anything that
closed unsummarised. Summaries deliberately keep entity ids (`char:brother-anselm`), which
looks ugly and is the point: it keeps the graph reachable from the summary, so the Referee
can still check things that happened twenty scenes ago.

`/branch <scene> <file>` forks the save and leaves the current one untouched:

```
/branch 12 data/what-if.db
branched at scene 12 -> data/what-if.db
  discarded 6 turn(s), 14 event(s), 9 consequence(s); restored 2 relation(s)
  this session is untouched
```

Two things the branch undoes that are easy to forget. A relation that *ended* during the
discarded scenes is restored, because it was still live at the fork point. And a vow broken
in the discarded future is unbroken, so the integrity gate defends it again.

---

## Layout

```
src/domain/       types; the delta contract lives here
src/db/           schema.sql and the connection
src/store/        canon/chronicle overlay, cast, chronicle, threads, consequences
src/providers/    adapter interface, capability matrix, mock + http providers
src/frame/        tokenizer and budgeted per-role frame assembly
src/loop/         roles, three-tier validator, commit, engine, compaction, branching
src/consequence/  propagation queue, rumours, world tick
src/lint/         rule engine, two profiles, the prose gate
src/ingest/       mediawiki client, parsers, scope, pass A, pass B, depth modes
src/setup/        wiki discovery, planner, jobs, world building
src/seed/         hand-authored canon for Saint Verrow
src/cli/          play, seed, serve, ingest, script, lintprose
src/server/       http api
web/              vite + react inspector
```

Node 24 runs TypeScript directly, so there is no backend build step. That rules out
`enum` and constructor parameter properties, which `tsconfig` enforces via
`erasableSyntaxOnly`.

---

## Known gaps

- **No vector store.** The Scene Frame uses graph traversal and fixed slots, which is the
  meal; embeddings were always the garnish and are not wired up.
- **In-place retcon is not implemented, by choice.** Directives steer the future; changing
  the past means branching. Rewriting history in place would require recomputing every
  downstream consequence, and the design argues branching gets most of that value for a
  fraction of the cost.
- **The tokenizer is a calibrated heuristic**, not real BPE. It over-estimates on purpose;
  the interface is pluggable if that stops being good enough.
- **Inbound link counts come only from crawled pages**, so ingest ranking under-counts a
  genuinely wiki-famous entity. A hub penalty compensates for index pages.
- **Pass B has never met a real wiki.** It is tested hard against fixtures and against
  adversarial model output, but predicate quality on live Fandom prose is unmeasured. The
  drop counters exist so you can judge a first real run rather than trust it.
