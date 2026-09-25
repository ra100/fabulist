# Agent world upkeep over MCP, and per-user BYOK providers

Date: 2026-09-26 · Status: draft for review · Backends: A = Postgres + SQLite, B = Postgres only

## Problem

1. **MCP agents write prose only.** The MCP `INSTRUCTIONS` say "the server owns the world model"
   (`src/mcp/server-pg.ts:115`). With no provider configured, extraction silently falls back to
   `MockProvider.extract` (`src/providers/mock.ts:223`), which records no entities, facts, edges or
   threads, and `commit_narration` never says so (`src/mcp/tools-pg.ts:657`). Consequences are only
   seeded by the server-side `play` flow (`src/application/play-pg.ts:30`). Result: cast, threads,
   facts and causality stay empty while the story lives only in the agent's context.
2. **Providers are global.** One `SwappableRegistry` per process (`src/cli/serve-pg.ts:270`), admin-only
   config, API keys only via server env vars. A non-admin user cannot bring their own key, and token
   usage is tracked only for turn-loop roles, per story.

## Goals

- An MCP agent learns at story start how to play, the writing rules, and whether it must maintain the
  world itself; if so it can, atomically with each turn.
- A signed-in user can configure their own provider key, stored encrypted under a trust mode they
  choose, and see the tokens the backend spent on their behalf.
- Mode 2 (local, admin-configured provider) keeps working unchanged.

## Non-goals

Dollar costing; per-field change audit logs; BYOK for image providers; BYOK on SQLite; custom base
URLs for non-admins.

---

## A. Agent world upkeep over MCP

### A1. Upkeep signal

`upkeep: 'server' | 'agent'`, computed per request from the registry resolved for that request (see B3):
`server` iff `registry.get('extract').id !== 'mock'` (same test as `src/config/config.ts:220`).
Returned in `create_story`, `switch_story`, `start_story`, `get_state`, `propose_turn`, `commit_narration`,
`replace_turn_prose`. Because it is per request, it follows key/lock/profile changes mid-session.

### A2. `get_guide` tool

Returns, for the current story:
- the propose → write → commit loop (existing `INSTRUCTIONS` content);
- the writing contract: style, knobs, anchors, lint blocklist, and the no-invention rules from
  `narratorSystem` (`src/loop/roles-pg.ts:363`);
- validation behaviour (what gets repaired/dropped vs. what blocks a commit);
- when `upkeep=agent`, a per-turn upkeep checklist: new/changed cast (`entityUpserts`, `update_sheet`),
  relationships (`edgeAsserts`/`edgeRetires`, `relationshipUpdates`), facts and who knows/suspects them,
  threads opened/moved/resolved, conditions, vow breaks, and when to add a consequence by hand.

Static `INSTRUCTIONS` shrink to: pick/create a story, then call `get_guide`. Fixes while here: drop the
`switch_world` reference in the PG build (not registered); the `play` prompt's "relationships record
themselves" (`server-pg.ts:1158`) becomes conditional on upkeep.

### A3. World delta on `commit_narration`

New optional `world` argument with the `Delta` fields (`src/domain/types.ts:293`): `entityUpserts`,
`edgeAsserts`, `edgeRetires`, `conditionUpdates`, `relationshipUpdates`, `factsLearned`,
`threadUpdates` (title without known id opens a thread, as `applyDelta` does today), `vowBreaks`,
`events`, `sceneAdvance`.

- `upkeep=agent`: `world` becomes the turn's delta and runs through the existing path —
  `coerceDelta` (`src/loop/validate.ts:169`) → `validateDelta` (`src/loop/validate-pg.ts:67`) →
  `commitTurn` (`src/loop/commit-pg.ts:211`). Missing `events` defaults to one event from the prose
  (participants = present cast). No new commit path.
- `upkeep=server`: backend extraction runs as today; `world` is ignored and the response says so.
- Response adds `upkeep`, `applied` (count per field), `dropped` (repaired validation issues such as
  unresolved ids) so the agent can fix them; plus a `warning` when `upkeep=agent` and `world` was omitted.
- Blocked validation returns the existing `blocked` shape.

### A4. Consequences on the MCP path

After a successful `commit_narration`, run the deterministic `seedConsequences`
(`src/consequence/propagate-pg.ts:163`, no LLM) exactly as the `play` flow does, regardless of upkeep.

### A5. Granular tools

For corrections between turns, each wrapped in `recordAuthoringCheckpoint`
(`src/loop/history-pg.ts:96`) like existing authoring writes:
- `record_fact { text, knownBy[], suspectedBy[] }`
- `open_thread { title, stakes?, parties[], tension?, resolutions? }`
- `add_consequence { causeEventId, actorId, action, trigger, visibility, significance? }`

Existing `upsert_entity`, `upsert_edge`, `remove_edge`, `update_thread`, `update_sheet` remain.

### A6. History, rollback and fork

Already covered by full-state checkpoints: turn deltas land in the turn's checkpoint
(`commit-pg.ts:246`); tool writes get their own checkpoint; `restoreTurn` (`src/store/history-pg.ts:173`)
and fork restore/copy every story table including facts, threads, events, consequences.
Two additions:
- **Checkpoint origin.** New column `history_checkpoints.origin` (text, nullable for legacy rows):
  `turn:agent`, `turn:server`, or `tool:<name>`. Surfaced in the history/rollback UI and `get_state`
  recent history so "when did what change" is answerable.
- **Prose replacement.** `replace_turn_prose` accepts the same optional `world`. With `upkeep=agent`
  and `world` given, the turn's delta is re-applied from the previous checkpoint (same semantics as
  server re-extraction); without it, the old delta stands and the response warns it may be stale.

### A7. Scope

Both MCP builds: `server-pg.ts`/`tools-pg.ts` and `server.ts`/`tools.ts` (SQLite has the same gap).

---

## B. Per-user BYOK providers (Postgres)

### B1. Storage and trust modes

Table `user_provider_keys`:
`id, user_id, label, endpoint_id, models jsonb (role → model id), trust ('unlock'|'sealed'),
ciphertext, nonce, key_hint (last 4), created_at, last_used_at`. RLS: owner only
(`src/db/schema-pg-roles.sql`). Plaintext is never stored or returned.

- **unlock** (default): the browser wraps the key under the user's master key with the same AES-GCM
  wrap as story DEKs (`web/src/crypto/keys.ts:163`), AAD `fabulist:user:{uid}:provider:{keyId}:v1`.
  Requires existing encryption enrollment. On unlock, the browser hands it over with the story keys
  (`storyKeyHandoff`, `keys.ts:266`); the server keeps it in an in-memory grant alongside
  `EphemeralStoryKeyStore` (4 h, zeroed on lock/expiry/delete). At rest the operator cannot decrypt.
- **sealed**: the server encrypts with AES-256-GCM under env `FABULIST_SECRETS_KEY` (32 bytes,
  base64), AAD bound to user and key id. Always usable (MCP, background jobs). An operator holding the
  env secret and DB can decrypt. If the env var is unset, the mode is disabled in UI and API.

The UI states this trade-off in plain words when choosing a mode.

### B2. Allowed endpoints

Curated allowlist `BYOK_ENDPOINTS` (separate from model `PRESETS`): `{ id, label, kind, baseUrl }`
with fixed https base URLs, verified against each provider's official docs at implementation time.

- Direct: OpenAI, Anthropic (`anthropic` kind), Google Gemini, Mistral, DeepSeek, xAI, Groq,
  Cerebras, Together, Fireworks.
- Routers: OpenRouter, Kilo Code.
- All except Anthropic use the existing `openai-compat` adapter.
- Model choice: list from the endpoint's `/models` with the user's key where supported, otherwise
  free-text model id. Per role: narrate, mechanics, extract (defaults: one model for all).

Not allowed for non-admins: `aws-profile`, gcloud ADC, Copilot OAuth, local servers, custom base URLs
— they run on the operator's credentials/network (SSRF).

### B3. Per-request registry resolution

`ProviderResolver.forRequest(user)` returns a `Registry`, in order:
1. the user's key, if usable (sealed, or unlock-gated with a live grant);
2. the server registry, if config `shareServerProvider` (default `true`, preserves today) or user is admin;
3. mock-only → `upkeep=agent`.

Cached per `(user, key id, key version)`, invalidated on save/delete/lock. Injection:
- new `TakeTurnOptions.providers`, read in `Engine.deps()` (`src/loop/engine-pg.ts:274`);
- `Compactor` built per call instead of once (`engine-pg.ts:237`);
- `SetupService` and ingest Pass B take the registry per call (`src/setup/service-pg.ts:387,693`);
- HTTP resolves from the route context user (`api-pg.ts:241`), MCP from `McpToolContext.user`.
Images stay on the server image registry.

### B4. Usage tracking

Table `usage_events`: `id, user_id, story_id?, role, provider_id, model, key_source ('own'|'server'),
tokens_in, tokens_out, at`. Written by one metering `Provider` wrapper applied by the resolver around
every provider it returns, so gate, compaction, Pass B, setup and probe calls are counted without
editing each call site. Existing `TurnMeta.providerCalls` stays.
- Users: own totals by day / model / source in `UsagePanel` and MCP `get_state`.
- Admins: per-user breakdown.

### B5. UI

- Settings → "My provider" (every signed-in user): endpoint, models, key, trust mode, Test (live call,
  not persisted), Save, Delete; status line: using your key / locked — unlock to use / using server
  provider / none — agent keeps the world.
- Admin config: `shareServerProvider` toggle.

### B6. Security

- Keys never logged; provider error bodies scrubbed of key-shaped strings before surfacing.
- Delete removes row and any grant; lock zeroes grants.
- Test and save rate-limited per user.
- Dedicated security review of crypto and key-handling code before merge.

---

## Testing

A:
- mock registry + `commit_narration` with `world` → entities, edges, facts, threads, consequences persisted;
- dropped ids reported; omitted `world` warns;
- stub non-mock extractor → `upkeep=server`, `world` ignored;
- `get_guide` content follows upkeep;
- rollback/fork across an agent-upkeep turn and a `record_fact` tool write restores exactly; origin recorded;
- `replace_turn_prose` with `world` re-applies delta.

B:
- sealed round trip; sealed disabled without env;
- unlock-gated key usable only during grant, falls back after lock;
- resolution order across all three branches, and with `shareServerProvider=false`;
- metering records gate and compaction calls with correct `key_source`;
- user cannot read or use another user's key (RLS);
- non-allowlisted endpoint or base URL rejected.

## Build order

A (A1–A7) first — independently shippable, fixes MCP today. Then B (B1 → B3 → B4 → B2/B5 → B6).
