# Plan: schema and retrieval fixes

Written after a read-only review of `src/db/schema.sql` and every store, with the
capability claims measured on this machine rather than assumed. Companion to
`DESIGN.md` (the why) and `GAPS.md` (the reachability plan it is modelled on).

Two supporting briefings: `docs/research/sqlite-search-vector-graph-briefing.md`
(measured — FTS5 availability, vector options, WAL) and
`docs/legal-briefing-fandom-ingest.md` (primary sources — Fandom licensing, ToU,
`RDR Books`).

Sizes as in `GAPS.md`: **S** under an hour, **M** a few hours, **L** a day or more.

---

## The organising insight

Same shape as `GAPS.md`, one layer down. The engine is not missing a datastore.
**Ingest already collects far more than the narrator is ever shown**, and the one
genuinely new capability worth adding (full-text search) is already compiled into
the binary.

So the ordering is: surface what is already paid for, fix what is quietly wrong,
and only then add tables.

Explicitly **not** in this plan: a vector database. `GAPS.md` §4.3 said "I would
not build this until something concrete is failing without it" and nothing is.
Measured here: 1–2 hop temporal traversal over 200k edges is 0.01–0.03 ms, so
graph locality is not the bottleneck and never was. Details and the numbers that
justify deferring it are in the research briefing.

---

## Sequencing against the multi-world migration

Multi-fandom / multi-book work is in flight. It redefines the **scoping axis** —
today `canon` is file-global and `chronicle` is story-scoped; that becomes
world-scoped and story-scoped, whether by a `world_id` column or by
file-per-world plus a registry.

That axis is exactly what several of these fixes are about, so they must not be
written twice. Three groups:

| Group | Collides? | When |
|---|---|---|
| **A — rendering and correctness** | No. Touches no scoping. | Anytime, including now |
| **B — scope corrections** | Directly. Same axis. | After, and partly free |
| **C — new tables** | Needs the axis decided. | After |

Group A is safe because none of it adds or moves a scope column. Group B is
*about* scoping. Group C has to know what to scope new rows to.

### Ask the in-flight work for three things

Cheap to include now, expensive to retrofit. Worth raising before that work
lands, not after:

1. **A schema version in `meta`** (or a `migrations` table). Today `meta` holds
   exactly one key, `worldTitle`. `db.ts`'s `migrate()` is an append-only list of
   `ALTER TABLE` calls with no version marker, which works for additive columns
   and will not survive loading a *foreign* world file. Every later item here,
   and any form of world sharing, needs it.
2. **A decision on whether `meta` is per-file or per-world**, written down. It is
   world-level-unscoped-by-design today (`chronicle.ts:305`). If one file holds
   several fandoms, `worldTitle` as a bare global key is wrong.
3. **A per-world source manifest** — wiki base URL, revision set, licence string.
   `ingest_pages` already records `wiki`/`title`/`revision` per page, so the data
   exists but is not summarised anywhere. Needed for re-ingest, for attribution,
   and for the "recipe not payload" distribution posture.

---

## Group A — safe now, no collision — **done**

### A1 Surface `props` to the frame — **highest value in the plan** · S · done

Pass A writes every infobox field onto the entity (`passA.ts:100`). The only
readers anywhere in `src/` are `visualDescription` (composer) and `status`
(validate). Nothing in `src/frame/` touches `props` at all — verified by grep.

So species, affiliation, titles, rank, first appearance, allegiance are
extracted, stored, and never shown to the model. The narrator is working from
`name`, `type` and a one-line `summary` while the answer sits in the same row.

- Render a whitelisted subset in `renderSheet()`, and one or two fields in
  `thumbnail()`.
- Whitelist, not a dump: infobox keys are wiki-specific and noisy, and
  `GAPS.md` §4.1 already records markup leaking into summaries on the live
  Witcher run.
- Order and cap deterministically so token cost stays predictable.

**Why first:** best quality-per-hour ratio in the codebase, no new dependency,
no schema change, and it makes every later ingest improvement visible. Today a
better ingest produces no better prose, because the extra data has no path to a
frame.

**Verify:** frame-builder tests asserting whitelisted keys appear and unlisted
ones do not; one played turn compared before/after.

Done: `renderProps()` in `frame/builders.ts`, a 28-key whitelist rendered in a
fixed order, per-value clip at 120 chars, `maxKeys` cap. Wired into
`renderSheet` (full set), `thumbnail` (two keys, so an offstage name is legible)
and `locationCard` (full set — the place the scene is actually in). Eight tests.

Found while verifying, and fixed: Pass A already mirrors `affiliation` →
`identity.allegiances`, `occupation` → `competencies` and the summary → `arc`
(`passA.ts:184-186`), so rendering props beside a sheet printed three facts
twice. `renderSheet` now skips those keys (`SHEET_DUPLICATED_PROPS`); a
thumbnail, which has no sheet beside it, still shows `affiliation`. This
duplication predated the change — it was invisible because nothing rendered
`props` at all.

Measured on the wiki fixture: `status: dead`, `born: 412 AV`, `enemies: The
Cinder Compact`, `relatives: … (brother)`, and for a location `region`,
`terrain`, `population` all now reach the Referee frame, at 1,569 of 12,000
tokens with nothing evicted.

### A2 Fix `participants LIKE '%id%'` — **bug** · S · done

`chronicle.ts:144`. `witnessedEvents` matches a JSON array with `LIKE`, so an id
that is a prefix of another matches both. Reproduced directly: searching
`char:tem` matched a row containing only `char:tem-the-elder`.

Consequence: the POV-safe recall path silently attributes events to the wrong
character — an epistemics bug, which is the subsystem the design leans on hardest.

- Rewrite via `json_each(participants)` (available — verified).
- `threads.parties` is the same shape; audit it while there even though nothing
  queries it that way yet.

**Verify:** a regression test with two ids where one is a prefix of the other.

Done: rewritten as `EXISTS (SELECT 1 FROM json_each(events.participants) WHERE
value = ?)`. Two tests, and the collision test was confirmed to *fail* against
the old `LIKE` before the fix was restored — a regression test that passes either
way is worthless. `threads.parties` audited: only ever filtered in JS after
`jsonGet`, so it never had the SQL form of this bug.

### A3 Bound the WAL · S · done

`journal_size_limit` is -1, so the WAL is reused in place and never shrinks. The
observed 4.6 MB WAL over a 320 KB database is *not* a leak — it is exactly
`wal_autocheckpoint`'s 1000-page default (1000 × 4096 = 4.1 MB), confirmed by
pragma. Bounded, but larger than the database it fronts, and it will be a
surprise to anyone copying a world file by hand.

- Set `journal_size_limit` in `openDb()`.
- Checkpoint at scene close, where a natural pause already exists.
- Use `VACUUM INTO` (not `copyFileSync`) wherever a single clean file is handed
  out. `branch.ts:337` already checkpoints before its file copy for this exact
  reason — the comment there is correct and worth generalising.

**Verify:** assert WAL size stays bounded across many small commits.

Done: `configure()` sets `journal_size_limit = 4 MB` in `openDb`, and an exported
`checkpoint(db)` runs `wal_checkpoint(TRUNCATE)` — called at scene close
(`compact.ts`) and reused by `branchSave`, which had open-coded the same pragma.
Measured on a real file: 4,000 commits → 4,023 KB WAL, checkpoint → 0 KB, data
intact. Two tests, including that it is a no-op rather than a throw on
`:memory:`. `VACUUM INTO` left for C1/bundling, where a single-file handoff
actually happens; `branch.ts` already checkpoints before its copy.

### A4 Cap stored verbatim text · S–M · done

Two fields store verbatim source prose by design: `edges.evidence` (a quoted
sentence) and `sheets.voice.samples` (quoted dialogue).

This is simultaneously a token cost, a quality question, and the single highest
-value legal change. `RDR Books` (S.D.N.Y. 2008) turned on **volume of verbatim
quotation** in a structured reference work derived from a fan wiki — the closest
decided analogue to what an ingest produces. See the legal briefing.

- Cap evidence at roughly a sentence (~25 words) at the ingest boundary in
  `passB.ts`'s validate step, where the trim is cheap and central.
- Prefer abstracted voice descriptors over stored dialogue lines. Note
  `renderSheet()` already leads with `voice.diction`, which is abstracted and is
  the part carrying most of the fidelity; `samples` is the exposure.
- Do not delete `samples` — cap the count and length. It is load-bearing for
  voice fidelity, per DESIGN §2.

**Do now, not later:** every day of ingest before the cap creates more rows to
migrate afterwards. Offsets-into-local-copy is the stronger version and belongs
in C1, but the cap does not need to wait for it.

**Verify:** ingest tests asserting the cap; check the Witcher fixture still
produces usable voice cards.

Done: `clipQuote(text, maxWords)` trims on a word boundary and marks the cut,
with `maxQuoteWords` defaulting to 25 and a `clippedQuotes` counter alongside the
existing drop counters. Four tests.

Worse than the plan assumed: evidence was bounded by `slice(0, 300)`, but voice
samples had **no length cap at all** — only a `length > 6` minimum — making them
the largest verbatim surface in the schema, exactly the `RDR` exposure. Both are
now capped. Ordering matters and is asserted: page-verification runs against the
model's *full* quote, and only the trimmed span is stored, so clipping can never
turn a real quote into an apparent hallucination. Event text gets a looser 2×
bound since it is the model's paraphrase rather than a quote.

### A5 Send an honest User-Agent · S · done

`client.ts` sets no custom UA, so requests go out as bare undici.

Fandom's `robots.txt` explicitly `Allow`s `/api.php?` for `User-agent: *` while
`Disallow`ing GPTBot, ClaudeBot and CCBot **by name**. That generic allowance is
a real asset — but only while identifying honestly, and the ToU separately bars
forging headers. A descriptive UA plus a contact URL plus the existing politeness
delay keeps the crawl inside the grant it is actually relying on.

- Descriptive product UA with a contact URL, configurable.
- Never a browser-spoofing UA.

**Verify:** assert the header is sent; note it in the README ingest section.

Done: `DEFAULT_USER_AGENT` plus a `userAgent` option, applied in the default
fetcher rather than widened into `FetchLike` (an injected fetcher is a test
fixture or a caller's own transport and should not be forced to thread a header
it does not use). Asserted **on the wire** against a real local HTTP server, not
read back off the constructor: the default is sent, it carries a contact URL, it
never matches `Mozilla|Chrome|Safari|Gecko`, and an override reaches the server.

README note still outstanding — the only piece of Group A not landed.

---

## Group B — after the migration, and partly free — **B3 done**

### B1 Move canon contradictions out of story scope · S–M

`depth.ts:194` and `setup/service.ts:219` route ingest-time contradictions
through `chronicle.addDivergence()`, which writes `story_id` into a table with
`ON DELETE CASCADE`.

Three problems: a property of *canon* is attributed to whichever story happened
to be bound during ingest; other stories cannot see it; and deleting that
unrelated story deletes the record of what the source material disagreed about.

DESIGN §3 wants contradictions kept as **competing edges with sources**, with the
fidelity dial choosing at play time. What exists is a text log in the wrong
scope. The scoping half may fall out of the migration for free; the
competing-edges half is a separate, larger question — consider whether the
existing `confidence` + `provenance` + `valid_from` columns already express it
before adding anything.

**Wait because:** this is a scope change on the axis being rewritten.

### B2 Aliases and redirects · M

`client.ts` resolves redirects at fetch time (`redirects: '1'`) and discards the
mapping. So "Geralt" / "Geralt of Rivia" / "White Wolf" / "Gwynbleidd" cannot
resolve to one node, and `resolveName()` falls back to a `LIKE` scan
(`graph.ts:197`).

This is the cheapest real quality win after A1: players type short names, and
extraction returns whatever the prose used.

- An alias table, world-scoped (aliases are a property of canon).
- Capture the redirect mapping already being thrown away.
- Feed `resolveName()`.

Pair with C2's trigram index — exact alias hit first, fuzzy only on a miss.

### B3 An integrity check for entity references · S · done

Every FK in the schema points at `stories(id)`. `edges.subject`/`object`,
`sheets.entity_id`, `fact_knowledge.entity_id`, `relationships.from_id`/`to_id`,
`events.location_id`, `scenes.location_id` are unconstrained text.

That is *correct* — an FK cannot express "canon or this story's chronicle" — but
it means dangling references are possible and nothing detects them. The
in-progress `branch.ts` edit is already hand-rolling id remapping for exactly
this reason.

Not a schema change: a diagnostic that reports orphans, runnable after ingest,
fork and truncate. Cheap, and it is how a fork bug gets caught before it
corrupts a save.

Done, and landed early: it adds no scoping column, so unlike the rest of Group B
it survives the multi-world migration unchanged.

`store/integrity.ts` + `cli/integrity.ts` (`pnpm integrity [path]`, exit 1 when
anything dangles). The full surface turned out to be **15 unconstrained entity
references plus 3 intra-story row references across 10 tables** — enumerated
from `pragma_foreign_key_list` rather than from reading the schema by eye.

Two things make it worth more than a naive existence check:

- It resolves through the **overlay**, not `entities` flatly. An id that exists
  only as story A's chronicle row is dangling from story B's perspective even
  though `SELECT 1 FROM entities WHERE id = ?` succeeds — and that is exactly
  what a fork bug produces. Tested.
- It is **whole-file, not per-story**, because the failures worth catching are
  cross-story leaks and a per-story check looks clean on both sides of one.

Read-only by design: it reports, never repairs. A dangling reference means
something upstream is wrong, and deleting the evidence would remove the signal.

**It found a real bug on its first run against `data/fabulist.db`:**
`SetupService.reset()`'s table list omitted `illustrations`, so a reset emptied
`entities` and left three portraits pointing at `char:brother-anselm`. The table
postdates `reset()` and nothing linked the two. Fixed, with a regression test
that asserts via `checkIntegrity` rather than counting one table — so the next
table added fails it too instead of repeating the bug. Confirmed the test fails
against the unfixed list.

Incidental confirmation of A3's argument, worth recording: probing that save by
`cp data/fabulist.db /tmp/probe.db` reported *clean*, because the 3 bad rows were
in a 4.1 MB WAL the copy did not include. Copying a WAL-mode database by hand
silently loses committed data — which is why `checkpoint()` exists and why
bundling (C1) must use `VACUUM INTO` rather than a file copy.

---

## Group C — new tables, after the axis is decided

### C1 Persist section text · M

`parse.ts:212` splits sections and its comment says "natural chunk boundaries for
later embedding" — but nothing stores them. This one table unblocks three
separate things:

- **FTS5** has something to index (C2).
- **Evidence as offset+length pointers** instead of stored strings — the strong
  version of A4, and what makes the legal posture structural rather than
  cosmetic.
- **Re-ingest and depth upgrades** stop needing a refetch to re-examine text.

World-scoped, keyed to `ingest_pages` with its revision so staleness is
detectable. Size it deliberately: this is the only item here that materially
grows the file.

### C2 FTS5 over sections, trigram over names · M

**Verified on this machine** (Node 24.10.0, SQLite 3.50.4): `CREATE VIRTUAL
TABLE … USING fts5` succeeds, as does `rtree`; `loadExtension` and
`enableLoadExtension` both exist. Measured: BM25 top-10 over 50k sections in
0.69 ms.

Two indexes, two jobs:
- **Standard FTS5** over section text with `bm25()` + `snippet()` — lore lookup.
  BM25 beats embeddings on rare proper nouns, which is most of a fandom.
- **`tokenize='trigram'`** over names and aliases — fuzzy resolution and dedupe.
  Measurement says trigram plus deterministic string distance beats embeddings
  here, and it is far more debuggable.

Version trap to pin: FTS5 landed in **Node 24.0.0**, was backported to
**22.16.0**, and is in **no 23.x release**. `engines` already says `>=24`, so the
floor is fine — but probe at startup rather than trusting it, since the failure
is a confusing SQL error rather than a clear one.

Feed results into a discretionary slot at `Priority.vectorFlavour` (10), which is
already the first thing evicted. A bad search hit must never displace a
structurally required entity.

### C3 In-world time · M–L

Scene integers are story position, not world chronology. `inWorldDate` is
stringly stuffed into `props` (`depth.ts:170`) and never read. So "what happened
before the siege" is unanswerable — a real hole for something calling itself a
world database, and the gap most likely to matter once several fandoms with
strong canonical timelines sit side by side.

Non-trivial: fictional calendars are inconsistent and often relative ("three
winters later"). Suggested shape — a sortable numeric key plus the original
string, sparse and nullable, with an explicit "unknown" that is not zero. Do not
try to normalise every date.

Note this is the one item whose *value* rises with multi-fandom, so it may be
worth more after the migration than it looks now.

### C4 A canon layer for situation — **only if worlds get shared** · L

`threads`, `facts` and `relationships` are story-scoped outright, with no canon
layer, by explicit design comment (`schema.sql:145`, `:159`).

Correct for single-world play. But it means a world can be packaged with a
*place* and no *situation*: `proposeOpening()` already notices, falling back to
the graph because "a fresh wiki ingest usually has no threads yet"
(`apply.ts:285`).

Only worth doing if worlds actually get exported or shared. If multi-world stays
local — one file, many fandoms, one user — skip it. Revisit only against a real
requirement to hand someone a startable world.

---

## Sequence

**Now, alongside the migration:** A1, A2, A3, A4, A5. Independent files, no
scope columns touched, each shippable alone. A1 is the one to do first.

**Immediately after it lands:** B1, B2. (**B3 done ahead of them** — it adds no
scoping column, so it survives the migration unchanged, and it immediately found
a real `reset()` bug.)

**Then, on evidence:** C1 → C2 together, since C2 without C1 has nothing to
index. C3 when timeline questions actually surface. C4 only if worlds get shared.

**Not now:** vector search. Revisit if paraphrase lookup or tone matching is
concretely failing after C2 — those are the two cases embeddings genuinely win.
Then it is a small brute-force embedding table fused by RRF, and `sqlite-vec`
only past ~20k vectors, where it is a 162 KB drop-in rather than a migration.

Gates per item, as elsewhere in this repo: `pnpm test` green (512 tests today),
`pnpm typecheck` clean, and for anything touching a frame, one played turn
compared before and after.

---

## Open questions

- **Does the migration scope `meta` per world?** B1 and C1 both need the answer.
- **Will worlds be exported, or only switched between locally?** Decides C4 and
  how strict A4/C1 need to be. Local-only lowers the legal exposure
  substantially — see the briefing's risk table.
- **Is `props` noisy enough per wiki that A1's whitelist must be
  wiki-specific?** Start global; revisit if the Witcher run shows junk.
- **Do `confidence` + `provenance` + `valid_from` already express competing
  claims** well enough for B1 without new columns? Probably — worth checking
  before designing anything.
