# Fandom RP Engine — design ideation

A creative-writing / role-play system where an AI game master runs a story inside an
existing fictional universe, keeps a real world-model behind the scenes, and stays
consistent even when the player does something unplanned.

---

## 1. The two ideas everything else hangs off

### Prose is a *view* of state, not the state itself

Every GM turn must emit two things: the narration, and a typed **state delta**
(entities touched, events that occurred, relationships changed, facts learned by whom).
If the prose implies something the delta does not record, **it did not happen**. The
delta is the contract. This single inversion is what separates a story engine from a
chatbot with a long prompt, because it means continuity is a database property rather
than something you hope the model remembers.

### Split the GM into three roles

Most AI role-play degrades because one prompt is asked to do three incompatible jobs.
Separate them:

| Role | Question it answers | Cares about |
|---|---|---|
| **Referee** | What is true? Is this allowed? | Graph state, canon, physics, who knows what |
| **Director** | What should happen next? | Pacing, tension, open threads, dramatic pressure |
| **Narrator** | How is it said? | Voice, POV, prose density, fandom register |

They can be three calls to the same model with different prompts and different context.
The Narrator never invents world facts; it renders what the Referee and Director agreed on.

---

## 2. State model: three layers over one graph

```
CANON      immutable, ingested from the wiki. Never written to at play time.
CHRONICLE  what happened in *this* playthrough. Overlays canon (copy-on-write).
CAST       per-character sheets: static identity + volatile condition.
```

A read is always `chronicle ?? canon`. So canon says a character is alive; the
chronicle can shadow that node after scene 12 and every later read sees the death.
Canon stays pristine, which means you can fork a new playthrough from the same ingest
and you can always answer "what did the source material actually say?"

### Nodes

```
Entity
  id, type: Character | Location | Faction | Item | Concept | Event | Thread
  layer: canon | chronicle
  provenance: wiki:<page>#<rev> | authored | emergent:<scene>
  confidence: 0..1          # extraction certainty, surfaced in the UI
  salience: 0..1            # decays; drives what stays hot in context
  props: {...}
```

### Edges

Typed and **temporally scoped**, which is the part naive graphs miss:

```
Edge
  subject, predicate, object
  valid_from / valid_to    (in story time, by scene)
  layer, provenance, confidence
```

`ALLIED_WITH(A, B) valid 1..14`, then `BETRAYED(A, B) at 14`. Nothing is deleted;
relations expire. Querying "who is A's ally *now*" is a time-filtered traversal, and
you keep the full history for free.

Worth being explicit that there are **two clocks**: story time (scene / in-world date)
and session time (when you played it). Retcons need both.

### Character sheets

Three parts, because they behave differently:

- **Identity (slow):** goals, wounds, fears, allegiances, competencies, secrets, arc.
- **Contract (slow, enforced):** ranked vows, drives, breaking point, cost of breaking.
  Unlike the rest of the sheet this is *checked* against player actions, not just used as
  context — see §5.3. It's what lets the GM say "he wouldn't do that".
- **Voice card (slow):** diction level, verbal tics, sample lines, what they never say.
  This is the single highest-leverage artifact for fandom fidelity — far more than plot.
- **Condition (fast):** location, mood, injuries, inventory, current intent, who they're
  with, per-character relationship values.

Each field is either **inferred** (AI may overwrite) or **locked** (player set it; AI
must treat it as ground truth). Locking is how "nudging parameters" actually works.

Relationship values are **directional and asymmetric** — A trusts B while B despises A is
the normal case, not an edge case, and it's what makes the propagation in §6 produce
interesting rather than uniform reactions.

### Epistemic state — who knows what

Underrated and cheap to add. Attach a knower-set to facts:

```
Fact  "the envoy is a double agent"
  known_by: [player_char, spymaster]
  suspected_by: [captain]
```

Without this, NPCs constantly react to information they could not possess, which is the
most immersion-breaking failure mode in AI role-play. With it, you get dramatic irony,
secrets, and lies almost for free.

### Threads instead of plot

Do not store a plot. Store **threads**: an unresolved tension, its stakes, the parties
involved, a tension value, and a few *possible* resolutions (never one). A plot breaks
when the player deviates. A thread just gets re-aimed.

---

## 3. Ingest: fandom wiki → knowledge graph

Fandom runs MediaWiki, so `/api.php` gives structured access. Do not scrape HTML.

**Scope first.** A large wiki is 50k–200k pages and you need maybe 300. Pick seed pages
(the arc, era, or region you want to play in) and crawl **N hops outward** along links,
ranked by link-count and category relevance. Scope control is the whole game here.

Then a two-pass extraction, cheap before expensive:

**Pass A — structural, no LLM, near-free**
- Infoboxes → typed attributes. Character infoboxes are basically pre-made sheets:
  species, affiliation, status, relatives, first appearance.
- Categories → a free type system and taxonomy.
- Wikilinks → a raw untyped graph, already useful for relevance ranking.
- Section headers → natural chunk boundaries.

**Pass B — LLM, only on pages that survived scoping**
- Typed relations with evidence spans, so every edge is traceable to a sentence.
- Timeline events → `Event` nodes with in-world dates where stated.
- Voice cards mined from quoted dialogue on the page.
- Tone/register samples kept as raw text for the Narrator to imitate.

**Then reconcile.** Wikis contradict themselves, mix continuities, and mark things
"non-canon". Keep contradictions as *competing* edges with sources rather than picking a
winner, and let the fidelity dial decide at play time.

Practical notes: Fandom text is CC-BY-SA (fine personally, attribute if you share),
crawl politely with caching, and store the page revision id so you can re-ingest
incrementally.

### 3.1 Depth modes

Three modes, but with an amendment that matters more than the modes themselves: **depth
should be a property of each subgraph, not one global setting.** You play in a small
corner of a universe. Paying deep-extraction cost on the whole wiki is waste, and paying
skim cost on the region you actually inhabit is the thing that will make the GM feel thin.

| | **High / skim** | **Mid / working** | **Deep / scholar** |
|---|---|---|---|
| Hops from seed | 1 | 2 | 3+ or category closure |
| Pages | 50–150 | 200–600 | 1k–3k |
| Pass A (structural) | yes | yes | yes |
| Pass B (LLM relations) | no | core entities only | everything in scope |
| Voice cards | no | main cast | all speaking characters |
| Timeline events | dated only | dated + inferred order | full reconstruction |
| Contradiction handling | ignore | flag | reconcile + continuity tags |
| Embeddings | titles + leads | section-level, in scope | section-level, everything |
| Cost / time | minutes, ~free | tens of minutes | hours, real money |
| Good for | "give me the vibe and the names" | actually playing | a fandom you'll live in |

**Progressive and resumable, not three pipelines.** Deep is a superset of mid, which is a
superset of high. Store `depth_level` per node, so upgrading is a diff: find nodes below
target depth, process only those. Never re-extract what you already have. This also means
you can start playing on a skim ingest twenty minutes after choosing a fandom, which is
the difference between a project you use and one you keep meaning to finish setting up.

**Just-in-time deepening.** At play time, if the story approaches a node still at skim
level, deepen it before the scene. This is the same machinery as emergent worldbuilding
(§5.1) pointed at real source data instead of invention. It's also what makes *high* a
viable permanent baseline with deep pockets only where you've actually been. The Director
can hint ahead: if a thread points north, pre-deepen the northern nodes during idle time.

**Discovery pass before committing.** Separate scope *proposal* from ingest. Run the cheap
crawl, then show what you'd get: candidate page count, the top entities by centrality, the
factions and locations found, estimated cost and time. Then let me prune before spending
anything. A wiki crawl that silently pulls 3,000 pages of a continuity I don't care about
is the most likely way this step goes wrong, and a preview is a cheap fix.

**Seeding is the real lever.** Ranked link-distance is a mediocre relevance signal on its
own. Better: seed from a named arc, era, region, or category, and weight by co-occurrence
with the seeds rather than raw link count. A character who appears on every page in the
wiki is usually less relevant to your story than one who appears on six pages all inside
your chosen arc.

---

## 4. The turn loop

```
player input
  │
  ├─ 1. CLASSIFY      in-fiction action | dialogue | OOC directive | meta query
  │
  ├─ 2. ASSEMBLE      build the Scene Frame (below)
  │
  ├─ 3. INTEGRITY     coherence distance vs. the acting character's contract (§5.3)
  │                   → in-character | stretch | off-key | breach | incoherent
  │                   breach/incoherent → INTERRUPT, ask, await choice. Loop stops here.
  │
  ├─ 4. REFEREE       is this possible? does it contradict world state?
  │                   → allow | allow-with-cost | reinterpret | block-with-friction
  │
  ├─ 5. DIRECT        which thread advances? which GM move fires? beat type?
  │                   also: any consequence matured and arriving this scene? (§6)
  │
  ├─ 6. NARRATE       prose only, from the agreed facts
  │                   rough player input → rendered book prose (§7.1)
  │
  ├─ 6b. PROSE GATE   deterministic lint; targeted rewrite only if it trips (§8.2)
  │
  ├─ 7. EXTRACT       structured delta (strict JSON schema, not freeform)
  │
  ├─ 8. VALIDATE      contradiction check against graph; retry extraction on failure
  │
  ├─ 9. COMMIT        write chronicle, update sheets, decay salience
  │
  └─ 10. SEED         derive pending consequences from the delta; enqueue (§6.1)
         ── between scenes: TICK the consequence queue + world tick
```

Integrity runs *before* Referee deliberately: no point adjudicating whether an act is
physically possible if the character would never attempt it. It's also the cheapest call in
the loop, so failing fast there is free.

Steps 4–6 can collapse into one call when latency matters; 7–8 must stay separate,
because a model grading its own output in the same breath does not work.

### The Scene Frame

Retrieval is not "vector search the wiki". It is a deterministic assembly of slots,
mostly graph traversal:

1. **Location card** — where we are, 1 hop of detail.
2. **Present cast** — full sheets for anyone on stage, condition included.
3. **1–2 hop neighborhood** of every on-stage entity. This is the workhorse; graph
   locality is a far better relevance signal than embedding similarity.
4. **Open threads** ranked by tension.
5. **Recent scene** verbatim, plus rolled-up summaries above it.
6. **Epistemic mask** — what the present characters know and don't.
7. **Vector hits** for flavor and tone only, never for facts.
8. **Style contract** — POV, tense, prose density, content bounds.

Vector search is the *garnish*. Graph traversal plus fixed slots is the meal.

---

## 5. Handling the unexpected

This is the part you specifically flagged, and it needs actual machinery.

**Two different violations, two different gates.** I conflated these in the first pass and
they need separating, because the correct default for one is the opposite of the other:

| Violation | Example | Gate | Default stance |
|---|---|---|---|
| **World-fact** | "there's a tavern here" | Referee | **permissive** — canonize it |
| **Character** | monk stabs someone for laughs | Integrity gate | **strict** — push back |

Being loose about world facts costs nothing and buys improvisation. Being loose about
character integrity destroys the thing you came for. The ladder below is for world facts;
§5.3 is the strict one.

### 5.1 A move library, not improvisation

Borrow from Powered-by-the-Apocalypse: give the
Director a fixed menu of GM moves and let it pick, rather than free-associating.

- reveal an unwelcome truth
- offer an opportunity, with a cost
- put someone in a spot
- use up their resources
- turn their own move against them
- announce off-screen badness
- have an NPC act on their own agenda
- make the world push back physically

Constrained choice produces far better and more *legible* behavior than open generation,
and it gives you something to show in the "why did you do that?" panel.

**Just-in-time worldbuilding.** Player references a tavern that does not exist. Do not
refuse and do not hallucinate loosely. Spawn an entity with
`provenance: emergent`, generate it *consistent with canon neighbors*, commit it, and it
is real forever after. The graph is append-friendly by design.

### 5.2 The "yes, and" ladder — for world facts only

When the player asserts a fact:

1. Accept and canonize (harmless, interesting).
2. Accept but reinterpret (nearly right; bend it to fit).
3. Accept with a cost (works, but the world charges for it).
4. In-fiction friction (it fails *for a reason the world supplies*).
5. OOC flag (only for hard contradictions or breaking your own locked parameters).

Never a bare refusal. Escalate down the ladder only as far as needed.

### 5.3 The character integrity gate

The monk-at-the-airport case. You want to be *told* you can't do that, and you're right to
want it — this is the one place where a hard stop is the feature, not a failure.

The mechanism: every character sheet carries an explicit **character contract**.

```
contract:
  vows:        ["nonviolence", "poverty"]       # hard lines, ranked
  drives:      ["protect the vulnerable", ...]
  breaking_pt: what would actually make them break a vow
  cost_of_break: what it does to them if they do
```

Vows are the load-bearing part. They are not flavor text — they are *checked*.

On each in-fiction action, score the **coherence distance** between the action and the
acting character's contract, sheet, and recent behavior:

| Distance | Meaning | Response |
|---|---|---|
| **in-character** | consistent | narrate, no comment |
| **a stretch** | unusual but reachable | narrate, but make the character *feel* it |
| **off-key** | needs justification | in-fiction resistance: hesitation, the body refusing |
| **contract breach** | violates a ranked vow | **stop and ask, out of character** |
| **incoherent** | no continuity at all | stop, offer readings |

The last two produce a real interrupt. Wording matters — it should read as a collaborator
protecting your character, not a filter refusing you:

> **[GM]** Brother Anselm has held a vow of nonviolence for thirty years, and nothing in
> this scene threatens him. Drawing a knife here isn't a choice he has access to.
>
> Did you mean: **(a)** intervene without violence — you could still put yourself between
> them; **(b)** something has broken in him — if so let's establish *what*, and it becomes
> the story; **(c)** you want a different character; **(d)** override, this is a deliberate
> heel turn and I'll play the fallout straight.

That's the shape: name the contract, explain *why* it's blocking, and offer routes. Option
(d) always exists — you're the author, and an author must be able to break their own
character on purpose. But it's *deliberate*, logged in the divergence ledger, and the
world charges for it afterward.

**Why in-fiction resistance beats an OOC block at the "off-key" tier.** A character whose
hands shake and won't close on the knife is better writing *and* a better signal than a
system message. Reserve the OOC interrupt for genuine breaches so it keeps its weight.

**The vow-break arc.** A breach isn't just blocked — if you take route (b) or (d), it
should be the most consequential thing in the story. Set `broke_vow` on the sheet, spawn a
high-tension thread, and let every NPC who learns of it (epistemics, §2) react. A monk who
breaks nonviolence is a *far* better story than one who never could. The gate exists to
make it cost something, not to prevent it.

**Strictness is a dial**, per §11: `permissive` (narrate anything) → `coaching` (in-fiction
nudges only) → `strict` (interrupt on breach, the default) → `iron` (interrupt on off-key
too). Some sessions you want to be told no; some you want to flail. Also worth an
**intent-check for scene-level tone breaks** — pure chaos-goblin input in an otherwise
serious story is usually you testing the system, and a quick "playing this straight, or
blowing it up?" resolves it faster than either of us guessing.

### 5.4 Offscreen world tick

Between scenes, run a cheap pass where NPCs and factions
advance their own agendas one step. The world changing without the player is what makes
it feel like a place rather than a backdrop. It also generates unplanned complications
for free, which is much of what a good GM does.

---

## 6. Consequence propagation — chains you don't see

Your second point, and it's the one that most changes the architecture. What you're
describing: act on a character on-screen, and it should ripple outward through people and
places you *aren't* watching, evolve without you, and arrive back later — possibly having
caused things you never witness.

This is the difference between a world and a stage set. It's also where the epistemic
layer (§2) stops being a nice-to-have and becomes structural, because "things happen that
the player doesn't see" is *precisely* a statement about knowledge asymmetry.

### 6.1 Model it as a propagation queue, not a simulation

Don't simulate the world. Simulate the *consequences of what you touched*. Every committed
delta seeds pending consequences, which mature on their own schedule:

```
Consequence
  cause:        event id (what the player did)
  trigger:      predicate — "when X learns" | "after N scenes" | "if player enters Y"
  actor:        who acts
  action:       intended move (from a constrained library, as with GM moves)
  visibility:   onscreen | offscreen-discoverable | offscreen-hidden
  maturity:     pending | ripening | fired | expired | superseded
  depth:        how many hops from the original player act
```

Each tick, mature what's ready, fire it, and let firing seed *further* consequences at
`depth + 1`. That gives genuine chains rather than one-step reactions. The whole thing is
a cellular automaton over the social graph, which is cheap because you only ever process
the neighborhood you disturbed.

### 6.2 Propagation follows the existing edges

You said you like the relations — this is what they're *for*, beyond flavor. Consequences
travel along typed edges, which means the graph you built for consistency doubles as the
causality substrate:

- **Social**: harm a character → their `LOYAL_TO` / `KIN_OF` / `OWES` neighbors react.
  Reaction strength scales with edge weight and inversely with hops.
- **Factional**: harm a member → the faction responds per its *agenda*, not per sentiment.
- **Economic / structural**: burn a warehouse → prices move, a rival gains, someone's
  livelihood is gone.
- **Reputational**: this is the interesting one, because it's gated by *transmission*.

### 6.3 Information has to travel

The mechanism that makes offscreen chains feel real rather than magical: consequences
can't fire until the actor **knows**. So model transmission explicitly.

- A witness sees your act (or doesn't — check line of sight, darkness, who was present).
- News propagates along social edges with **latency** and **distortion**. By hop three the
  story is wrong, and the *distorted* version is what people act on. This is free drama.
- Some nodes are hubs: innkeepers, couriers, spy networks. They accelerate everything.
- Suppression is playable — kill the witness, buy silence, and you've *cut an edge* in the
  transmission graph. That's a real, legible tactic with real risk.

Consequence chains gated on rumor arrival produce exactly the effect you asked for: you
did something in scene 3, and in scene 19 a stranger in a different city treats you
strangely, because a garbled version of it got there ahead of you.

### 6.4 Three visibility classes

The design question hiding in your last sentence — chains that do things you never see.
Committing to all three is what makes the world feel independent of you:

- **`offscreen-discoverable`** — happened, and there's a findable trace. Most consequences
  should be this. A world of pure hidden machinery is indistinguishable from no machinery.
- **`offscreen-hidden`** — happened, no trace yet. Real, in the graph, may surface much
  later or never. This is what makes the world feel like it doesn't revolve around you.
- **`onscreen`** — arrives in narration.

Hidden consequences are still *committed to the chronicle*. They are not "maybe" — they're
true, you just don't know. That's the whole point, and it's why the graph has to be the
source of truth rather than the transcript.

### 6.5 Surfacing without breaking POV

The craft problem: a chain matures offscreen, and you need it to eventually *land*. The
tools, roughly in order of how much I'd lean on them:

1. **Consequence arrival** — it walks into the scene. Strongest, use most.
2. **Trace** — you notice something changed; a shop shuttered, a name gone quiet.
3. **Testimony** — someone tells you, filtered through their bias and their distortion.
4. **Interlude** — an explicit scene break to another POV. Powerful, spend it rarely.
5. **Retrospective reveal** — much later, you learn what your scene-3 act really caused.

Keep an **ignorance budget**: if too much has matured unseen, the Director starts steering
traces toward you. Otherwise the machinery runs beautifully and you never feel it, which is
the actual failure mode here — not incoherence, but *invisible* coherence.

### 6.6 A GM-only view

For the inspect UI (§11): a **causality map** showing your act → the chain it seeded → what
fired → what's still ripening, with a spoiler curtain. Being able to see, after the fact,
that scene 3's kindness is why scene 19 went the way it did is most of the payoff of
building any of this.

And a **dramatic-irony indicator**: a quiet marker when the scene contains a gap between
what you know and what the world knows. It's the signal that the machinery is doing work.

### 6.7 Keeping it affordable

- **Cap depth** (3–4 hops) and **prune by significance**; most consequences should die.
- Fire the queue in a **batch between scenes**, not per turn. One cheap call, or often no
  model call at all — much of this is deterministic graph work.
- **Lazy evaluation**: an offscreen-hidden consequence only needs full detail if the player
  ever gets near it. Store the intent, resolve prose on demand.
- Use a **small fast model**; this is bookkeeping, not writing.

---

## 7. Authoring controls: rough input, polished book

You want to type roughly and have the book read well. That's not a cosmetic feature — it
falls directly out of §1 (prose is a view of state), and once you take it seriously it
gives you something better than convenience.

### 7.1 Four registers per turn

Keep them all. They serve different purposes and conflating them loses something:

```
Turn
  raw_input    what you actually typed, verbatim, kept forever
  intent       parsed: actor, action, target, manner, dialogue-gist
  beat         canonical record of what happened (the delta, §1)
  book_prose   the rendered narrative paragraph(s)
```

So you type `i try to talk him down, mention his sister, dont draw` and the book gets a
worked paragraph with actual dialogue. The raw input survives because it's the record of
your *intent*, and you'll want it when the render misses.

**The render can put words in your character's mouth you didn't intend.** That's the risk
here and it needs a real answer, not just an undo:

- **Register detection.** If you write polished prose, keep it. If you write shorthand,
  render it. Someone who types a fully-formed sentence in their character's voice wants
  that sentence in the book, not a paraphrase of it.
- **`[verbatim]` marker** to force preservation on anything.
- **Dialogue is the danger zone.** Invented *gist* is fine; invented *commitments* are not.
  If your rough input implies a promise, a threat, or a revealed secret that you didn't
  actually specify, that's a delta the Referee should surface rather than quietly commit.
- **Reroll the prose without rerolling the beat.** Different sentences, same events. This
  is only possible because the beat is stored separately, which is the payoff of the split.

### 7.2 The book is a projection, so it can be re-rendered

The strongest consequence of storing beats separately: **the book is regenerable.** Change
the tone from noir to pulp and re-render chapter 4. Switch POV from third to first. Change
prose density. None of it touches what happened.

Two things this needs to be safe:

- **Pinning.** Passages you love are pinned and never re-rendered. Without this, a global
  tone change destroys the specific sentences that made you want to keep going.
- **Re-render is not retcon.** Re-rendering changes *how* it's told. Retcon changes *what
  happened* and has to propagate through §6. Keep them separate operations, and never let
  a tone change silently alter facts.

### 7.3 The direction panel

Out-of-fiction authorial steering, distinct from playing your character:

```
Directive
  text:      "turn this toward the captain betraying us"
  scope:     scene | chapter | campaign
  strength:  hint | push | mandate
  lifetime:  expires after N scenes, or on satisfaction
  status:    active | satisfied | retired
```

`hint` biases thread ranking. `push` makes the Director actively seek openings. `mandate`
means it happens; find the most plausible route.

**What recalculates.** You mentioned dependency recalculation, and it's mostly the
consequence queue (§6):

1. Re-rank threads — matching threads gain tension, competing ones lose it.
2. Re-scan pending consequences. Any that now contradict the directive get marked
   `superseded`. Others get re-timed to arrive where they'd land better.
3. Possibly spawn new threads or consequences.
4. Committed chronicle is untouched. Directives change the future only.

**Show the diff.** After a directive, report what moved: "3 pending consequences
superseded, 2 threads raised, 1 new thread." Silent recalculation in a system with
offscreen machinery is how you lose trust in it. This is the same instinct as the "why?"
panel — the whole design leans on being able to see the machine work.

**Prefer pressure over fiat.** A directive should ideally be satisfied by NPCs pursuing
their own agendas toward the outcome you asked for, not by an event dropping from the sky.
`mandate` is the escape hatch, and using it often is a signal the threads are stale.

---

## 8. Tone and the prose gate

### 8.1 The style contract

Tone needs to be a structured, inspectable object, because "write it noir" degrades within
five scenes:

```
StyleContract
  pov:            first | third-limited | third-omniscient | second
  tense:          past | present
  register:       plain | clipped | lyrical | ornate | archaic
  density:        sparse | balanced | rich        # description per beat
  dialogue_ratio: 0..1
  genre_lens:     noir | pulp | literary | grimdark | cozy | fairy-tale | epic | comic
  humor:          none | dry | absurd
  pacing:         languid | steady | breakneck
  scene_target:   words
  comparables:    ["works or authors to echo"]
  forbidden:      ["explicit banned patterns"]
  content_bounds: [...]
```

Two notes from experience with this kind of thing. **Comparables outperform adjectives** —
naming a work the model has read carries more signal than any stack of descriptors. And
**tone must be scoped**: campaign default, overridable per chapter or scene, because a
single comic interlude in a grimdark story is a feature, not drift.

### 8.2 The prose gate

Style and humanization are the same pipeline with two rule sets, so build them once:

```
narrator output
  → LINT (deterministic, no model call, ~free)
      style metrics + AI-tell patterns → score per rule
  → if score under threshold: ship it
  → else: REWRITE (model call, targeted at the specific violations)
  → optional: SELF-CRITIQUE pass on flagged output
```

**Most of the detection is deterministic**, which is what makes this affordable. Em dash
density, curly quotes, emoji, boldface density, sentence-length variance, adverb rate,
"not just X, it's Y" constructions, rule-of-three triples, participial-phrase tails,
copula avoidance (`serves as`, `stands as`), filler phrases, and a vocabulary blocklist
(`tapestry`, `testament`, `underscore`, `delve`, `vibrant`, `intricate`, `pivotal`,
`landscape` as abstraction) are all regex or simple statistics. Only the rewrite needs a
model, and only when lint actually trips.

**The self-critique trick is worth building in**: ask the model what makes the passage
read as AI-generated, let it answer, then have it revise against its own answer. It
reliably outperforms a single "make this better" instruction.

### 8.3 Fiction needs a different rule set than prose-doc humanizing

Important, and the reason not to just bolt on a generic humanizer. The standard AI-tell
lists are calibrated on encyclopedic and marketing text. Several of their rules are
actively wrong for fiction:

- **Em dashes are legitimate** in dialogue for interruption and self-correction.
- **Curly quotes are correct typography** for a book. Straight quotes are the tell that
  you're reading a text file, not a novel.
- **Rule of three is a real rhetorical device** in narrative prose.
- **Passive voice** is sometimes exactly right for narrative distance or withheld agency.
- **Sentence fragments** are a legitimate stylistic choice in close third.

Meanwhile the tells that actually give away AI fiction are mostly absent from those lists:

- **Somatic cliché inventory** — jaws clenching, breath hitching, stomachs dropping,
  shivers down spines, and the immortal "let out a breath he didn't know he was holding."
- **Named emotions instead of shown ones** — "she felt a profound sadness."
- **Sensory triads** — the smell of woodsmoke, leather, and something faintly metallic.
- **Portentous scene-final one-liners.** Every scene landing on a fortune-cookie beat.
- **Uniform dialogue.** Everyone speaks in complete, grammatical, equally-weighted
  sentences. Nobody interrupts, misunderstands, rambles, or is boring.
- **"Something unspoken passed between them"** and its whole family of non-events.
- **Symmetrical paragraph architecture** — every paragraph the same three-sentence shape.
- **No dead air.** Real scenes have slack in them; AI scenes are relentlessly significant.
- **Weather and eyes doing emotional labor** on the author's behalf.

So: two lint profiles, `prose-doc` and `fiction`, sharing an engine. The fiction profile is
the one that matters here, and it's mostly a cliché-frequency detector plus dialogue-variety
statistics. Worth tracking tells *across* scenes too, not just within one — a phrase used
once is fine, the same gesture in nine consecutive scenes is the actual failure.

**Keep a personal blocklist that grows.** When a phrase annoys you, add it. This becomes
the most valuable file in the project within a month, and it's specific to your taste in a
way no general list can be.

Related: the **style anchor** (§10) does more work than the gate. Re-injecting passages you
liked prevents drift better than any amount of post-hoc correction.

---

## 9. Provider harness and the 64k constraint

Treating this as a storytelling harness with swappable providers and a floor of 64k
context is a significant constraint, and it retroactively justifies the architecture.

### 9.1 Small context makes the state-first design more valuable

With a 200k window you can paper over a weak world model by dumping history into the
prompt. At 64k you cannot, so the graph has to do the remembering. Everything in §2 stops
being elegant and becomes load-bearing.

**The role split pays off here in a way I didn't originally frame it.** I proposed
Referee / Director / Narrator in §1 for quality reasons. The real structural benefit is
that no single call needs the whole picture:

| Role | Needs | Doesn't need | Budget |
|---|---|---|---|
| Classify | player input, cast list | everything else | ~2k |
| Integrity | acting character's contract + recent behavior | world graph, style | ~4k |
| Referee | facts, constraints, epistemics | prose style, verbatim scene | ~12k |
| Director | threads, agendas, pending consequences | prose style, deep lore | ~10k |
| Narrator | agreed beat, present cast, style, recent prose | full graph, mechanics | ~28k |

A monolithic prompt would need all of it at once and would not fit. Split, every call is
comfortable at 64k, and each role gets a *cleaner* prompt as a side effect.

### 9.2 Budgeted frame assembly

The Scene Frame (§4) needs hard per-slot token budgets and an eviction ladder, not
best-effort assembly:

- **Measure, don't estimate.** Real tokenizer per provider; conservative margin when the
  tokenizer is unknown.
- **Two densities per entity.** Full sheet for on-stage characters, thumbnail (name, one
  line, current condition) for everyone else. Most of the cast only ever needs thumbnails,
  and this single distinction saves more than any other optimization.
- **Fixed eviction order** when over budget: vector flavor hits go first, then older
  summaries, then neighborhood hops, then thumbnails. Style contract, present cast, and
  the agreed beat are never evicted.
- **Compression before eviction.** Summarize a slot to fit rather than dropping it.
- **Log the frame** with slot sizes. When a scene comes out wrong, the frame is the first
  thing to inspect, and this is what makes the "why?" panel real.

At 64k, also: cap the verbatim window aggressively and lean on rolled summaries (§10),
and prefer one well-chosen sheet over three mediocre ones.

### 9.3 Capability matrix, not a lowest common denominator

Providers differ in ways that break things silently. Describe each target explicitly:

```
ProviderCapabilities
  context_window
  structured_output:  native-schema | json-mode | none
  system_role:        yes | no
  streaming, cost_tier, tokenizer
  prose_quality:      subjective, your own rating
  steerability:       how well it holds a style contract
```

Then degrade deliberately:

- **Structured output is the one that matters.** The delta extraction (§4 step 7) is where
  a weak provider does permanent damage, because a bad delta corrupts the graph and every
  later turn inherits it. With native schema support, constrain decoding. With JSON mode,
  validate and repair-retry. With neither, use a fenced tagged format that's easy to parse,
  a stricter validator, and a lower auto-commit threshold.
- **No system role** → prepend to the first user message.
- **Unknown tokenizer** → assume a worse ratio and keep a bigger margin.

**Route roles to different models.** This is where the harness framing earns its keep:
a strong model narrates, a cheap fast one classifies, extracts, and lints. Most calls per
turn are small ones, so this dominates cost. Ship profiles — `local` (everything small),
`balanced` (strong narrator, cheap mechanics), `premium` — rather than making me wire it up.

**Two honest cautions.** Prose quality varies between providers far more than benchmarks
suggest, and it's the hardest thing here to evaluate automatically, so expect the style
anchor and prose gate to carry more weight when you swap. And **pin the extractor model**
independently of the narrator: changing the model that writes your graph mid-campaign is
how you get a subtly inconsistent world with no obvious cause.

---

## 10. Long play without drift

Hierarchical compaction: `turn → beat → scene → chapter`. Only the current scene is
verbatim; everything above is a summary that keeps *entity references intact* so the
graph stays walkable from summaries.

Two guards against the classic failures:

- **Salience decay.** Entities cool unless touched. Prevents the frame filling with
  people who left thirty scenes ago.
- **Style anchor.** Keep a small set of your best-liked passages and re-inject them
  periodically, or prose slowly homogenizes toward generic-model-voice.

Plus a **story bible**: a deliberately small, human-editable summary of the playthrough
that is always in context. When the automatic machinery drifts, this is your handle.

And a **divergence ledger**: an explicit list of every place the story has departed from
canon, so the Referee never quietly reverts to the source material.

---

## 11. Inspect and nudge

The player-facing tooling is essentially a debugger for the world model.

- **Graph explorer** — filter by layer, so you can see canon vs. what you made.
- **Sheets** — editable, with lock toggles per field. Vows editable too; raising a vow's
  rank makes the gate stricter about it.
- **Timeline** — chronicle with the divergence points marked.
- **Threads board** — tension dials you can drag.
- **Causality map** — player act → seeded chain → fired → ripening, spoiler-curtained
  (§6.6). The most novel view here, and the one that pays off the whole §6 build.
- **Direction panel** — write a directive, see the recalculation diff (§7.3).
- **Style panel** — the live style contract, plus re-render-with-pinning (§7.2).
- **Ingest panel** — per-region depth levels, what's skim vs. deep, upgrade in place (§3.1).
- **Frame budget view** — slot sizes for the last turn, what got evicted (§9.2). Sounds
  like developer plumbing; it's actually the fastest way to diagnose a scene that felt thin.
- **Knobs** — canon fidelity (strict / flexible / AU), **character strictness**
  (permissive / coaching / strict / iron), pacing, danger, NPC agency, propagation depth,
  ignorance budget, prose density, POV, content bounds.
- **"Why?" panel** — the retrieved frame, the integrity verdict, the move that fired, the
  delta committed. Transparency is what makes you trust it enough to stop double-checking.
- **Branch from scene N** — cheap and enormously useful. Full retcon with downstream
  recomputation is the ambitious version; branching gets you 80% at 5% of the cost.

---

## 12. Stack, opinionated

Bias: embedded and file-based, so one playthrough is one portable artifact and there is
no infrastructure to babysit.

- **Graph:** plain SQLite node/edge tables to start — genuinely enough, and it removes a
  dependency. Kùzu (embedded, Cypher, no server) is the natural upgrade once multi-hop
  temporal queries get gnarly, but **check its maintenance status before adopting it**; I
  have an unverified recollection that the company behind it wound down in 2025, and I
  could not confirm either way in this session. Neo4j is the boring, safe fallback if you
  decide you want real Cypher.
- **Vectors:** sqlite-vec or LanceDB. Same file-based logic.
- **Structured output:** strict JSON schema with validation and repair-retry on the
  delta step. Non-negotiable; this is the load-bearing part.
- **Orchestration:** a plain typed state machine. Resist agent frameworks here — the
  loop is fixed and known, so framework indirection only costs you debuggability.
- **Provider layer:** one thin adapter interface plus the capability matrix (§9.3). Resist
  a heavyweight abstraction library; you need maybe five methods, and you want to control
  the structured-output degradation path yourself because that's where the damage happens.
- **Models:** mixed, routed per role (§9.3). Cost lives in the small calls.
- **Prose lint:** plain regex and statistics, no model. Two profiles, `fiction` and
  `prose-doc`, sharing an engine (§8.3), plus a growing personal blocklist file.
- **UI:** local web app. The graph and sheet views are most of the work.

Prior art worth reading rather than reinventing: SillyTavern lorebooks (keyword-triggered
context injection, a crude version of the Scene Frame), Graphiti/Zep (bi-temporal
knowledge graphs), and PbtA / Ironsworn tabletop design for the move library and
thread model.

---

## 13. Build order

The wiki ingest feels like the hard part and is actually the boring part. The risky part
is whether the delta-extract-validate loop holds up. Prove that first.

Two things belong in Slice 0 that I'd originally have deferred: the **provider adapter**
and the **frame budget allocator**. Both are cheap to build early and expensive to retrofit,
because a 64k budget changes how every later slice is shaped. Build the loop against your
smallest target window from day one and it will never need rearchitecting upward.

- **Slice 0 — fake canon.** Hand-write 20 entities in the graph. No ingest at all. Build
  the turn loop, delta extraction, and validator, behind the provider adapter and a real
  token-budgeted frame. Play 20 turns. If this is not fun and consistent, nothing
  downstream saves it.
- **Slice 0.5 — the integrity gate.** Add contracts to those 20 characters and the
  coherence-distance check (§5.3). Deliberately try to play them wrong. This is small,
  self-contained, and testable *without* any of the rest — and it's the piece most likely
  to feel wrong in ways only play reveals (too preachy, too permissive, bad interrupt
  wording). Get it in early so you have many sessions to tune it.
- **Slice 0.75 — registers and the prose gate.** Rough-input rendering (§7.1), the style
  contract, and the deterministic fiction lint (§8.2). Both are nearly free, both change how
  every session *feels*, and the lint needs a long tail of your own annoyances to become
  good. Start collecting them now.
- **Slice 1 — real ingest, skim mode only.** One wiki, discovery pass, ~150 pages, Pass A
  (infoboxes, categories, links). Confirm the frame assembly beats a naive long prompt.
- **Slice 2 — depth modes.** Mid ingest, Pass B extraction, voice cards, per-node depth
  levels, just-in-time deepening (§3.1). This is where fandom *feel* arrives.
- **Slice 3 — Director.** Threads, move library, world tick, directives (§7.3).
- **Slice 4 — consequence propagation.** §6, in stages: one-hop reactions first, then the
  queue with maturity, then rumor transmission, then hidden chains. Do *not* build this
  before Slice 3 — it needs threads to hang consequences on, and it's the most expensive
  thing here to debug because the bugs show up twenty scenes later.
- **Slice 5 — Inspect UI**, locks, knobs, causality map, re-render, branching.

Evaluation matters more than usual here, since "good" is subjective. Keep a small suite
of adversarial probes: contradict yourself deliberately, reference dead characters,
invent locations, ask an NPC about something they cannot know, **play a character
flagrantly against their vows**, and **check that a scene-3 act still has traceable
descendants at scene 20**. Regression-test the Referee and the integrity gate against those.

Add a **provider conformance suite** once §9 exists: the same twenty-turn scripted session
replayed against each configured provider, checking that deltas still validate and the
graph ends in the same state. Prose will differ; the state must not.

---

## 14. Honest risks

- **Extraction quality caps everything.** A graph full of wrong edges is worse than no
  graph, because it makes the Referee confidently wrong. Confidence scores and evidence
  spans are the mitigation, and neither is free.
- **Latency budget.** Multi-call turns add up fast. Decide early whether a turn may take
  20 seconds or must feel like chat, because it changes the whole architecture.
- **Over-refereeing kills fun.** A GM that says "no" precisely and often is worse
  company than one that improvises loosely. The world-fact ladder in §5.2 exists for this
  reason and should lean permissive. Note this now cuts *against* §5.3 — see the tension
  below.
- **The integrity gate is the highest-variance feature here.** Done well it's the thing
  that makes the GM feel like a real collaborator who knows your character. Done badly it's
  a nag that lectures you about your own creation. Two specific failure modes: (a) it fires
  on *ambiguity* rather than genuine breach — a character being complicated reads as
  off-key; (b) the interrupt copy sounds like a content filter, which poisons the whole
  experience. Mitigation is a permissive default, a well-tuned `stretch` tier that uses
  in-fiction resistance instead of interrupts, and treating the interrupt wording as
  *writing*, not UX strings.
- **The two strictness dials pull in opposite directions,** and that's intentional, but it
  means the *acting character* determines which applies. Getting that routing wrong — e.g.
  applying character strictness to world assertions — produces a GM that feels arbitrary.
- **Invisible coherence.** The §6 machinery can run flawlessly and be entirely unfelt. If
  most consequences are hidden, you've spent your whole budget on something
  indistinguishable from randomness. The ignorance budget and a bias toward
  `offscreen-discoverable` are the mitigation. Ship §6 with the causality map, so at
  minimum *you* can see it working.
- **Consequence spam.** Naive propagation makes every act cause five things, and the story
  drowns in reaction. Prune hard; most consequences should die at depth 1. "Nothing
  happened" is a valid and common outcome.
- **Structure fighting prose.** Heavy state machinery can produce technically consistent
  writing that is dead on the page. The Narrator needs real freedom inside the
  constraints, and the style anchor is not optional.
- **The prose gate can flatten voice.** Anti-AI lint pushes toward the *absence* of tells,
  which is not the same as presence of style. Over-tuned, it produces careful, tell-free,
  characterless prose. Weight the style anchor above the lint, and keep the fiction profile
  narrow: cliché frequency and dialogue uniformity, not a grammar policeman.
- **Rough-input rendering can drift from intent.** The GM writing your character's dialogue
  from a gist is the feature, and also the place you'll most often feel misrepresented.
  Register detection, `[verbatim]`, and cheap prose-only rerolls are the mitigations (§7.1).
- **Ingest depth is a money and patience risk.** Deep mode on a large wiki is real cost for
  data you may never touch. The discovery preview and per-subgraph depth exist so the
  default path is cheap and you spend only where you play.
- **Directives can turn into a plot after all.** Heavy use of `mandate` recreates the
  railroad that §2's thread model exists to avoid. If you're mandating often, the threads
  have gone stale — fix those instead.
- **64k is a real ceiling, not a formality.** Long campaigns with big casts will hit it, and
  the failure is quiet: silently evicted context, then a scene that feels oddly amnesiac.
  The frame budget view exists so that failure is visible rather than mysterious.
- **Wikis lie.** Multiple continuities, fan speculation, and non-canon material sit
  side by side, unmarked.
