# Fabulist

*A state-first fiction engine: the prose is a view, the world is the graph underneath.*

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
pnpm backup               # a safe copy of a save (not cp — see below)
pnpm integrity            # check a save for dangling references
```

```bash
pnpm test                 # 561 tests, offline
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

Stored quotes are capped at ~25 words (`maxQuoteWords`). The page check runs against the
model's full quote and only the trimmed span is kept, so shortening never turns a real
citation into an apparent hallucination. A sentence supports the same traceability claim as
a paragraph at a fraction of the stored-text exposure, which matters if a world is ever
shared — see `docs/legal-briefing-fandom-ingest.md`.

The crawl identifies itself. Fandom's `robots.txt` grants `User-agent: *` an explicit
`Allow: /api.php?` while blocking GPTBot, ClaudeBot and CCBot by name, so that generic
allowance is the permission this relies on — and it holds only while the client is honestly
generic. Set `userAgent` to something with your own contact details for a large crawl; an
operator who can reach you sends mail before blocking a range. Never a browser-spoofing
string: the Terms bar forged headers separately from the crawl rules.

---

## Providers

Start here:

```bash
pnpm providers        # what is usable on this machine, and the fix for what is not
```

It probes local ports, AWS profiles, gcloud logins and API keys, then prints a one-line
remedy for anything unavailable. The same report is in the UI under **settings → models
available here**. Worth running first, because every one of these fails differently and
most of them fail hours into a session rather than at startup.

Then set a profile in `fabulist.config.json`:

```json
{ "profile": "bedrock", "dbPath": "data/fabulist.db", "proseLintThreshold": 6, "blocklist": [] }
```

| profile | auth | narrator | mechanics + extractor |
|---|---|---|---|
| `mock` | none | deterministic, offline | — |
| `local` | none | ollama qwen2.5 | ollama llama3.1 |
| `vllm` | none | vLLM | vLLM |
| `llamacpp` | none | llama-server | llama-server |
| `bedrock` | AWS profile | claude sonnet | claude haiku |
| `google` | gcloud OAuth | gemini pro | gemini flash |
| `copilot` | Copilot OAuth | gpt-4o | gpt-4o |
| `cheap` | API key | deepseek | deepseek |
| `balanced` | API key | anthropic sonnet | gpt-4o-mini |
| `premium` | API key | anthropic sonnet | gpt-4o |

An unavailable profile falls back to the mock with a note rather than failing — an
unconfigured provider should not stop you playing.

**Everything here is editable in the UI.** Settings covers the whole of
`fabulist.config.json`: which profile is active, which model handles each role, provider
specs including local base URLs and model ids, the lint threshold, and your blocklist.
Changes apply to the next turn — no restart, and no hand-edited file.

Two lists in settings, doing different jobs. **models available here** is a diagnostic: it
probes every service the build knows how to speak to and reports the one-line fix for the
ones it cannot reach. **models** is configuration, and lists only what you have added — it
starts empty, because the built-in profiles cover the common cases and nothing needs adding
until you want a specific server, model id or account. `add` gives a blank form (name, then
`kind`, then only the fields that kind uses); *start from a known service* pre-fills it from
one of the built-in specs, which is usually what you want, since the profiles refer to those
names.

Switching profile refuses rather than silently degrading, because discovering three turns
later that the mock is writing is worse than being told a profile is unavailable. Provider
specs can be **tested before they are kept**, which matters most for local servers: the
defaults guess port 8000 and a model id of `default`, and both are usually wrong.

Illustration is configured in the same place, under **settings → illustration**. It probes
on open, lists which image providers are reachable, and is **off** until you choose one —
nothing generates images before that, and every illustration control falls back to handing
you the composed prompt to paste elsewhere.

Two fields are deliberately not editable at runtime. `dbPath` would leave the UI talking to
a database the engine is not using, and a context window below 64k is refused outright
rather than accepted into a frame budget that assumes it.

If the page and the server disagree — `dist/` rebuilt while an older `pnpm serve` kept
running — a banner says so and names a missing route, rather than leaving you with a control
that 404s. `GET /api/meta` reports the route inventory the running build actually serves.

Narration **streams**. Prose arrives as it is written, with the current stage shown while
the gates run — for a writing tool that is the difference between watching and waiting.
Only the narrator streams: the mechanical roles return structured output, where a partial
result is worthless. To see it without a real model attached, set `"mockTokenDelayMs": 45`,
since the mock otherwise emits a whole passage faster than a browser can paint.

### Running without API keys

**Local servers** need no key at all, and no `Authorization` header is sent (vLLM and
llama.cpp reject a bogus bearer; Ollama has no concept of one). They agree on the chat
format and disagree on constrained decoding, which is the part that matters for delta
extraction, so each has its own dialect:

```bash
vllm serve Qwen/Qwen2.5-14B-Instruct --port 8000 --max-model-len 65536
llama-server -m model.gguf --port 8080 --ctx-size 65536
ollama serve
```

Unsloth models are served through vLLM, so `unsloth:local` is the same endpoint and dialect
with a different label. Set `model` to whatever id the server was launched with.

**AWS Bedrock** uses `AWS_PROFILE`, not a key. SigV4 is signed here rather than pulled from
the AWS SDK, and it is checked against AWS's own published test vector. The credential
chain is the one a work laptop actually needs, first hit wins:

1. environment variables
2. static keys in `~/.aws/credentials`
3. `credential_process` — covers aws-vault, saml2aws, and most enterprise tooling
4. IAM Identity Center via the cached SSO token
5. `role_arn` + `source_profile`, assumed through STS

```bash
export AWS_PROFILE=work
pnpm providers          # confirms which profile resolved, and how
```

Credentials resolving is not the same as model entitlement: Bedrock access is granted per
model per region, so a 403 here points you at the Bedrock console rather than at IAM.
Requests go through the **Converse** API, which is one body shape for every model family,
and structured output uses a forced tool call since Bedrock has no `response_format`.

**Google Gemini** uses OAuth via Vertex AI:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id
```

That writes an `authorized_user` record which is exchanged for access tokens directly, so
gcloud is not needed at run time. A service account key works too
(`GOOGLE_APPLICATION_CREDENTIALS`), signed as a JWT assertion. `gcloud auth
print-access-token` is the fallback for impersonation and external account types.

Gemini's `responseSchema` is OpenAPI-flavoured rather than JSON Schema — it rejects
`additionalProperties` and union types like `["string","null"]`, both of which the engine's
schemas use — so schemas are translated on the way out.

**GitHub Copilot** reuses the OAuth token your editor already stored, and is **off by
default**:

```json
{ "providers": { "copilot:gpt-4o": { "kind": "copilot", "model": "gpt-4o", "allowUnofficial": true } } }
```

Read that flag as what it says. Copilot's chat endpoint is an internal API for GitHub's own
editor extensions: undocumented, unversioned, and using it from a third-party client is
very likely outside the Copilot terms of service. It can break without notice and in
principle could put your GitHub account at risk. It is implemented because it is your
credential on your machine, but nothing reaches it unless you opt in explicitly. If you
want a supported keyless option, Bedrock and Vertex are both first-class here.

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

## Illustration

Optional, off by default. Turn it on in **settings → illustration** and every character
sheet gets a portrait generator, every turn in the book gets an "illustrate this scene"
button. Five styles — realistic, drawing, sketch, draft, animation — independent of the
prose register, so a noir mystery can still be drawn as `drawing` rather than forced into
`realistic` because the tone is grim.

Three levers solve the consistency problem that breaks most illustrated interactive
fiction, stacked rather than assumed alone sufficient:

- **The description is restated every time.** `visualAnchor` (one paragraph describing
  the whole world) and each character's `appearance` (build, attire, distinguishing
  marks — a slow field on the sheet, next to voice and identity) get appended to every
  prompt, never re-derived. A location gets the identical treatment through its own
  summary.
- **A portrait's seed is reused** on regeneration, when the provider supports it — the
  cheapest lever a seed-based model offers, and not a guarantee: the same seed with a
  changed prompt can still drift.
- **A generated image becomes a reference** for everything after it, when the provider
  can condition on one: a character's own portrait anchors every later portrait and every
  scene they appear in; a location's last scene image anchors the next scene set there.

None of this is a guarantee — see `.design/ILLUSTRATIONS.md` for the honest account of
what each lever actually does and does not solve, and for which of the three built-in
image providers were verified against a real account in this environment (mock: yes and
extensively; ComfyUI: implemented against its documented API, not reachable to test live
here; Bedrock Stability: implemented against Stability's documented contract, blocked by
an AWS Marketplace entitlement before any live call could be confirmed).

**No vision model available?** Nothing breaks. Every "generate" button has a "copy
prompt" sibling that composes the identical prompt with no provider call at all — positive
and negative, ready to paste into Midjourney, a local ComfyUI, or whatever you already
have open. On a server with illustration entirely unconfigured, the prompt routes still
work; only the actual generation needs a provider.

**Going local:** point **settings → illustration** at a running ComfyUI
(`python main.py`, default `127.0.0.1:8188`) the same way a local text model works —
nothing is bundled, the wire format is documented (`src/providers/comfyui.ts`), and the
default graph is a plain txt2img workflow. Bring your own workflow JSON (an img2img graph
with a real IP-Adapter node, say) to upgrade past prompt-only consistency; the adapter
fills the same named placeholders into whatever graph you supply.

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
the lint does. Keep a personal blocklist; it becomes the most valuable thing in the project within a
month, because it is calibrated to your ear rather than to a general rule. It is editable in
settings, and every lint finding in the **why** panel has a `block` button — the moment a
phrase annoys you is the only moment you will reliably bother, so that is where the button
is.

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

## Checking and copying a save

```bash
pnpm integrity              # or: pnpm integrity data/other-world.db
```

Every foreign key in the schema points at `stories(id)`. Not one entity reference is
constrained, and that cannot be fixed with a foreign key: an id is valid if *either* a
canon row or this story's chronicle row exists, and SQL cannot express "either of these
two rows, one of which is scoped by a column in another table". Constraining it would
mean either rejecting legitimate chronicle-only entities or collapsing canon and
chronicle into one unscoped table — losing the property the whole design rests on.

So the constraint moves out of the engine into a check you can run. It resolves through
the overlay rather than asking `entities` flatly, which is what catches the interesting
failure: an id that exists only as *another* story's chronicle row is dangling here even
though a bare `WHERE id = ?` finds it. That is the shape a bad fork produces. It is
whole-file rather than per-story for the same reason — a per-story check looks clean on
both sides of a cross-story leak.

It reports and never repairs; a dangling reference means something upstream is wrong, and
deleting the evidence removes the signal. Exit code is 1 when anything dangles, so it
also works as a gate in a script. Worth running after an ingest, a fork, a truncate, or
any hand-editing of a save.

### Copying a save

```bash
pnpm backup                          # data/backups/<stamp>.db (+ -images/)
pnpm backup --to=data/before-ingest  # an explicit name
pnpm backup path/to/other.db         # a save other than the configured one
```

**Do not use `cp`.** A save in WAL mode is three files while open — `.db`, `-wal`, `-shm`
— and the main file can be arbitrarily stale. This is not a stale-by-a-few-rows problem:
with a live connection open, copying the `.db` alone produces a database with **no tables
at all**, because the schema itself is still in the sidecar. There is a test that asserts
exactly that, because it is too surprising to leave as a comment.

That is not hypothetical here. The first real run of `pnpm integrity` found three orphaned
portraits in a save; probing the same save through a `cp`-made copy reported it clean,
because 4.1 MB of committed rows — including those three — were in the `-wal`.

`pnpm backup` checkpoints, then uses `VACUUM INTO`, which is transactional (a reader sees
either no file or a complete one, never a torn one) and emits a single defragmented file
with no sidecars. Images are copied alongside, because illustration rows store relative
paths to files that live *outside* the database, so a database-only backup restores to rows
pointing at nothing. Destinations are stamped and never overwritten — a backup command that
silently replaces the previous backup is a footgun, not a safety net.

The result is a save in its own right, not just bytes: `pnpm integrity` passes on it and
`World.open` will play it.

---

## Layout

```
src/domain/       types; the delta contract lives here
src/db/           schema.sql and the connection
src/store/        canon/chronicle overlay, cast, chronicle, threads, consequences, illustrations,
                  referential integrity check, safe backup
src/providers/    adapter interface, capability matrix, mock, http, bedrock,
                  google, copilot, sigv4, aws credential chain, probe;
                  image: mock, comfyui, bedrock stability
src/illustration/ prompt composer, generation service (see .design/ILLUSTRATIONS.md)
src/frame/        tokenizer and budgeted per-role frame assembly
src/loop/         roles, three-tier validator, commit, engine, compaction, branching
src/consequence/  propagation queue, rumours, world tick
src/lint/         rule engine, two profiles, the prose gate
src/ingest/       mediawiki client, parsers, scope, pass A, pass B, depth modes
src/setup/        wiki discovery, planner, jobs, world building
src/seed/         hand-authored canon for Saint Verrow
src/cli/          play, seed, serve, ingest, script, lintprose, integrity, backup
src/server/       http api
web/              vite + react inspector
```

Node 24 runs TypeScript directly, so there is no backend build step. That rules out
`enum` and constructor parameter properties, which `tsconfig` enforces via
`erasableSyntaxOnly`.

---

## Known gaps

- **Streaming stops at the narrator.** The mechanical roles are not streamed and should not
  be, but that means a turn still has a silent stretch before prose starts.

- **No vector store, and no full-text search yet.** The Scene Frame uses graph traversal and
  fixed slots, which is the meal; embeddings were always the garnish and are not wired up.
  Measured since: 1–2 hop temporal traversal over 200k edges runs in 0.01–0.03 ms, so scale
  is not the argument for adding one. FTS5 *is* already compiled into `node:sqlite` and is
  the cheaper next step, but nothing persists section text for it to index yet. See
  `.design/DBFIXES.md` and `docs/research/sqlite-search-vector-graph-briefing.md`.
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
  Update: run once, against `witcher.fandom.com` on real Bedrock. Found and fixed two real
  bugs — Bedrock's streaming path was silently producing empty prose (it was decoding the
  wrong AWS event-stream wire format), and the setup wizard's live provider switch never
  reached the planner (`SetupService` captured a fixed `Provider` at construction instead of
  a live lookup). Real prose is now flowing end to end; see `.design/GAPS.md` §4.1 for the
  full account, including what Pass A itself still gets wrong (infobox markup leaking into
  summaries; species and real-world pages surfacing as character candidates).
- **Multiple stories per world.** A world file can hold more than one independent
  playthrough — canon shared, everything else isolated per `story_id` — with a
  same-file fork primitive (`forkStory`) for both a fresh new story and a
  scene-boundary continuation of an existing one, reachable end to end: a "stories"
  tab in the UI replaces the old destructive "new" button, and `POST
  /api/stories/:id/switch` takes effect on the very next request with no restart.
  What is not fixed: opening a *different world file* (a different fandom entirely)
  still means editing config and restarting. See `.design/GAPS.md` §2.3 for the full
  account, including a real id-collision bug found and fixed in the fork's
  copy-forward (nothing had tested that path before it shipped).
