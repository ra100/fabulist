# Implementation plan (completed)

The original implementation plan is complete: the foundation, integrity gate,
ingest, director, consequences, and inspector all shipped. Its durable choices now
live in [`docs/DECISIONS.md`](docs/DECISIONS.md); active, evidence-gated work lives
in [`docs/ROADMAP.md`](docs/ROADMAP.md). This file remains as the compact rationale
for the architectural baseline below, rather than an outdated sequence of slices.

---

## Stack decisions

| Choice | Decision | Why |
|---|---|---|
| Language | TypeScript, Node 26, ESM | One language for engine and UI; native SQLite in 26 |
| Database | `node:sqlite` (built-in) | Zero native deps, no build step, ships with Node 26 |
| Graph | SQLite node/edge tables | Per DESIGN §12; Cypher not needed at this scale |
| Tests | `node:test` + `node:assert` | Built in, no framework |
| Server | `node:http`, no framework | The API is ~15 routes |
| UI | Vite + React + TypeScript | Graph/sheet views are real work; RC is well-trodden |
| Package manager | pnpm | Already present |
| LLM access | Own adapter layer | Per DESIGN §12: control the degradation path |

**No native modules, no ORM, no agent framework.** The turn loop is a known state
machine; indirection would only cost debuggability.

### Why one package, not a monorepo

The engine, ingest, lint, and server share domain types and always ship together.
A monorepo would add build orchestration for no isolation benefit. The web UI is
the one genuinely separate artifact, so it gets its own Vite root under `web/`
and talks to the server over HTTP.

---

## Layout

```
src/
  domain/       types + zod-free schema validation (hand-written guards)
  db/           schema.sql, migration runner, connection
  store/        repositories over the DB, one per aggregate
  providers/    adapter interface, capability matrix, mock + real providers
  frame/        tokenizer, budget allocator, slot assembly
  roles/        classify, integrity, referee, director, narrator, extract, validate
  loop/         turn state machine wiring the roles together
  consequence/  queue, maturity tick, propagation along edges
  lint/         rule engine + fiction and prose-doc profiles
  ingest/       mediawiki client, scope discovery, pass A, pass B, depth
  server/       http api
  cli/          entry points
web/            Vite + React inspector UI
test/           node:test suites
seed/           hand-authored canon for Slice 0
```

---

## Decisions the design left open

**Tokenizer.** Real BPE per provider is a dependency and a maintenance burden. Use a
calibrated heuristic (chars/token by content class) with a configurable safety margin,
and keep the interface pluggable so a real tokenizer can drop in. Budget enforcement
needs to be *conservative*, not exact.

**Delta validation.** Three tiers: schema (shape), referential (do the entities exist),
semantic (does it contradict the graph). Schema failure triggers repair-retry; semantic
failure surfaces rather than auto-committing, because silently discarding a delta is how
the graph and the prose drift apart.

**Time.** Two clocks per DESIGN §2. `scene_no` is the ordering key for edge validity;
in-world dates are free-text and advisory, because wikis express them inconsistently.

**Mock provider.** Deterministic, seeded, pattern-matching. It must exercise every
role and return schema-valid deltas so the whole loop is testable offline. This is
also the harness for the provider conformance suite (DESIGN §13).

**Epistemics storage.** Facts are first-class rows with a `fact_knowledge` join table
(`fact_id`, `entity_id`, `level`: knows | suspects | wrong). Cheap to query per scene.

**IDs.** Deterministic slugs for canon (`char:brother-anselm`) so re-ingest is
idempotent; UUIDs for chronicle events and consequences.

---

The former definition of done is now the maintenance baseline: tests run without
network or API keys, the mock remains playable, the inspector works end to end, and
providers remain interchangeable behind the adapter interface.
