# Agent World Upkeep over MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP agent learns at story start whether it must maintain the world model itself, and when it must, it can: atomically with each committed turn, with granular correction tools between turns, with consequences seeded on the MCP path, and with every checkpoint labelled by origin.

**Architecture:** One shared, backend-neutral module (`src/mcp/upkeep.ts`) holds `upkeepFor(registry)`, the guide text, the `world` zod schema and the applied-count helper. Both MCP builds (Postgres `*-pg.ts`, SQLite) call it. The agent's `world` argument becomes the turn's delta inside `Engine.finishTurn` in place of `extract()`, through the existing `coerceDelta` → `validateDelta` → `commitTurn` path. No new commit path. Post-commit consequence seeding reuses the `play` workflow adapter. Checkpoint origin is one nullable text column written by `HistoryStore.capture`.

**Tech Stack:** TypeScript on Node >= 26 (type stripping, `node --test`), `@modelcontextprotocol/sdk` + zod 3, Postgres (`pg`) and `node:sqlite`, React web UI, biome.

**Spec:** `docs/superpowers/specs/2026-09-26-agent-upkeep-and-byok-design.md` (section A, A1–A7, and the "A:" testing list). Section B (BYOK) is a separate plan. This plan works with today's single process-wide registry. B later passes a per-user registry to the same `upkeepFor`.

## Global Constraints

- Backends: A = Postgres + SQLite. Every behaviour lands in `server-pg.ts`/`tools-pg.ts` **and** `server.ts`/`tools.ts` (A7).
- Upkeep rule, verbatim: `server` iff `registry.get('extract').id !== 'mock'` (same test as `src/config/config.ts:220`). Computed per request, never cached.
- `upkeep` is returned by `create_story`, `switch_story`, `start_story`, `get_state`, `propose_turn`, `commit_narration`, `replace_turn_prose`.
- The agent `world` delta runs `coerceDelta` → `validateDelta` → `commitTurn`. No new commit path.
- Missing `events` defaults to one event from the prose (participants = present cast).
- `seedConsequences` runs after a successful `commit_narration` regardless of upkeep (no LLM).
- `history_checkpoints.origin`: text, nullable for legacy rows; values `turn:agent`, `turn:server`, `tool:<name>`.
- Granular tools are wrapped in `recordAuthoringCheckpoint`: `record_fact { text, knownBy[], suspectedBy[] }`, `open_thread { title, stakes?, parties[], tension?, resolutions? }`, `add_consequence { causeEventId, actorId, action, trigger, visibility, significance? }`.
- Code comments: at most one line, and only for a non-obvious *why*. Match the surrounding style. `pnpm lint` (biome) and `pnpm typecheck` stay clean.
- Commits: Conventional Commits, one logical change each, and stage only the files the task touched. Work on the current branch `feature/agent-upkeep-byok`.

### Commands

- One SQLite/unit test file: `node --disable-warning=ExperimentalWarning --test test/<file>.test.ts`
- Postgres tests need a server. Start it once with `pnpm pg:start` (`deploy/pg-dev.sh`, port 5433), then run: `env FABULIST_TEST_PG='postgres://postgres@localhost:5433/fabulist_test?host=/tmp' FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/<file>.test.ts`. `FABULIST_REQUIRE_TEST_PG=1` makes a missing server fail the run instead of quietly skipping the tests.
- Full suite: `pnpm test` (with the same env vars so Postgres tests run). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`.

## Review Focus

1. The agent passes `world.events`, but every entry has blank text. The turn should still commit exactly one event built from the prose, not zero events. Test: Task 4.
2. The agent's `world` references ids that neither exist nor are upserted, e.g. an edge to `char:nobody`. Those items should be dropped and listed in `dropped`, and the rest of the turn should commit. Test: Task 5.
3. The provider profile is swapped mid-session (mock → real extractor, or back). The very next `get_state`, `propose_turn` or `get_guide` should report the new `upkeep` without a reconnect. Test: Task 2.
4. `replace_turn_prose` is called with `world` after a later authoring edit or turn exists. It should be refused, with prose, world and history unchanged. Test: Task 10.
5. A database created before `origin` existed (an old SQLite save, or a Postgres schema before migration 009). The column should be added, and legacy rows should read back as `origin: null` rather than crashing. Test: Task 7.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/mcp/upkeep.ts` | Create | `Upkeep`, `upkeepFor`, `buildGuide` + guide text, `appliedCounts`, `worldDeltaInput`, `triggerInput` (zod). Shared by both MCP builds. |
| `src/loop/engine-pg.ts`, `src/loop/engine.ts` | Modify | `get registry()`; `commitExternalNarration(…, agentWorld?)`; `finishTurn` uses `agentDelta` when given; commit origin. |
| `src/loop/validate.ts` | Modify | `coerceAgentDelta` (prose-event fallback, then `coerceDelta`). |
| `src/loop/roles-pg.ts`, `src/loop/roles.ts` | Modify | `agentDelta(world, raw, prose)`: coerce and validate like `extract()`. |
| `src/frame/builders-pg.ts`, `src/frame/builders.ts` | Modify | Export the present-cast helper. |
| `src/application/play-pg.ts`, `src/application/play.ts` | Modify | Shared post-commit adapter; `commitNarration(…)` for MCP. |
| `src/loop/commit-pg.ts`, `src/loop/commit.ts` | Modify | `CommitTurnInput.origin`; PG `commitTurnOn`; `recommitTurn`. |
| `src/store/history-pg.ts`, `src/store/history.ts` | Modify | `capture(turnId?, origin?)`; `recent()`; `rewindBefore()`; origin in eligible turns. |
| `src/loop/history-pg.ts`, `src/loop/history.ts` | Modify | `recordAuthoringCheckpoint(…, origin?)`; origin on layout turns. |
| `src/loop/branch-pg.ts`, `src/loop/branch.ts` | Modify | Fork copies `origin`. |
| `src/domain/types.ts` | Modify | `HistoryCheckpoint.origin`, `CheckpointSummary`, `EligibleTurn.origin`, `StoryLayoutTurn.origin`. |
| `src/db/schema-pg.sql`, `src/db/migrations-pg/009-checkpoint-origin.sql`, `src/db/schema.sql`, `src/db/db.ts` | Modify/Create | `history_checkpoints.origin`. |
| `src/mcp/tools-pg.ts`, `src/mcp/tools.ts` | Modify | `upkeep` fields, `getGuideTool`, `commit_narration`/`replace_turn_prose` `world`, `recordFactTool`, `openThreadTool`, `addConsequenceTool`, `recentHistory`. |
| `src/mcp/server-pg.ts`, `src/mcp/server.ts` | Modify | Register tools and schemas, shrink `INSTRUCTIONS`, conditional `play` prompt. |
| `src/server/api-pg.ts`, `src/server/api.ts` | Modify | `lintBlocklist` on the MCP context; `origin` on book turns. |
| `web/src/api.ts`, `web/src/App.tsx` | Modify | `BookTurn.origin`; show it in the rollback turn picker. |
| `test/mcp-upkeep.test.ts` | Create | Unit + SQLite MCP tests for this feature. |
| `test/mcp-upkeep-pg.test.ts` | Create | Postgres MCP tests for this feature. |
| `test/mcp-e2e.test.ts`, `test/pg-api.test.ts`, `test/db-migrations.test.ts`, `test/api.test.ts` | Modify | Server wiring, migrations, book origin. |

---

### Task 1: `upkeepFor` and the guide builder

**Files:**
- Create: `src/mcp/upkeep.ts`
- Test: `test/mcp-upkeep.test.ts` (create)

**Interfaces:**
- Consumes: `Registry` (`src/providers/provider.ts:169-172`), `StyleContract`, `Knobs` (`src/domain/types.ts`).
- Produces:
  - `export type Upkeep = 'server' | 'agent'`
  - `export function upkeepFor(registry: Registry): Upkeep`
  - `export interface GuideInput { upkeep: Upkeep; writingRules: string; style: StyleContract; knobs: Knobs; anchors: Array<{ text: string; note: string }>; blocklist: string[] }`
  - `export interface Guide { upkeep: Upkeep; loop: string; writing: { rules: string; style: StyleContract; knobs: Knobs; anchors: Array<{ text: string; note: string }>; blocklist: string[] }; validation: string; upkeepChecklist?: string[] }`
  - `export function buildGuide(input: GuideInput): Guide`

- [ ] **Step 1: Write the failing test**

Create `test/mcp-upkeep.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { defaultKnobs, defaultStyleContract } from '../src/domain/types.ts';
import { buildGuide, upkeepFor } from '../src/mcp/upkeep.ts';

test('upkeepFor is "agent" exactly when the extract role resolves to the mock', () => {
  assert.equal(upkeepFor(new ProviderRegistry(new MockProvider())), 'agent');
  assert.equal(upkeepFor(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' }))), 'server');
  assert.equal(
    upkeepFor(new ProviderRegistry(new MockProvider({ id: 'narrator' }), { extract: new MockProvider() })),
    'agent',
    'a real narrator does not help if extraction is still the mock',
  );
  assert.equal(
    upkeepFor(new ProviderRegistry(new MockProvider(), { extract: new MockProvider({ id: 'bedrock' }) })),
    'server',
  );
});

test('buildGuide carries the loop, the writing contract and validation, and the checklist only for agent upkeep', () => {
  const input = {
    writingRules: 'You do not invent world facts.',
    style: defaultStyleContract(),
    knobs: defaultKnobs(),
    anchors: [{ text: 'The ink was cold.', note: 'plain' }],
    blocklist: ['breath she did not know'],
  };
  const agent = buildGuide({ ...input, upkeep: 'agent' });
  assert.equal(agent.upkeep, 'agent');
  assert.match(agent.loop, /propose_turn/);
  assert.match(agent.loop, /commit_narration/);
  assert.match(agent.loop, /NOTHING IS SAVED UNTIL THIS CALL/);
  assert.equal(agent.writing.rules, 'You do not invent world facts.');
  assert.deepEqual(agent.writing.blocklist, ['breath she did not know']);
  assert.deepEqual(agent.writing.anchors, [{ text: 'The ink was cold.', note: 'plain' }]);
  assert.match(agent.validation, /dropped/);
  assert.match(agent.validation, /blocked/);
  const checklist = agent.upkeepChecklist?.join('\n') ?? '';
  for (const field of ['entityUpserts', 'update_sheet', 'edgeAsserts', 'edgeRetires', 'relationshipUpdates', 'factsLearned', 'suspectedBy', 'threadUpdates', 'conditionUpdates', 'vowBreaks', 'add_consequence']) {
    assert.match(checklist, new RegExp(field), `checklist mentions ${field}`);
  }

  const server = buildGuide({ ...input, upkeep: 'server' });
  assert.equal(server.upkeep, 'server');
  assert.equal(server.upkeepChecklist, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-upkeep.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/mcp/upkeep.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/upkeep.ts`:

```ts
import type { Knobs, StyleContract } from '../domain/types.ts';
import type { Registry } from '../providers/provider.ts';

export type Upkeep = 'server' | 'agent';

/** The mock extractor records no cast, facts, edges or threads, so with it the agent must keep the world. */
export function upkeepFor(registry: Registry): Upkeep {
  return registry.get('extract').id === 'mock' ? 'agent' : 'server';
}

export interface GuideInput {
  upkeep: Upkeep;
  writingRules: string;
  style: StyleContract;
  knobs: Knobs;
  anchors: Array<{ text: string; note: string }>;
  blocklist: string[];
}

export interface Guide {
  upkeep: Upkeep;
  loop: string;
  writing: {
    rules: string;
    style: StyleContract;
    knobs: Knobs;
    anchors: Array<{ text: string; note: string }>;
    blocklist: string[];
  };
  validation: string;
  upkeepChecklist?: string[];
}

const LOOP = `Playing a turn
The normal loop is two calls, and skipping the second one loses the turn:
  a. \`propose_turn\` with what the player does, in their words. The server runs its gates
     (does this fit the character, does it fit the world, what happens next) and stops before any
     prose exists. It returns \`narratorSystemPrompt\` + \`sceneFrame\`.
  b. You write the prose from that frame, then call \`commit_narration\` with it and the
     \`resumeToken\`. NOTHING IS SAVED UNTIL THIS CALL. Prose you only put in the chat is not in
     the book; the world model never sees it, and the next turn will not know it happened.
  c. With \`upkeep: "agent"\`, also pass \`world\` to \`commit_narration\`: what this turn changed (see
     upkeepChecklist). With \`upkeep: "server"\`, omit it; the server extracts the change from your prose.
Two other outcomes from (a): \`interrupted\` means the action breaks something the character has
established about themselves — show the player the options and call \`resolve_interrupt\`, not
\`commit_narration\`. \`answered\` means the input was a question about the world, not an action;
there is nothing to narrate.
Prefer \`play\` instead of (a)+(b) only if you want this server's own model to write the prose.

Keeping the book shaped
• \`close_scene\` at a real scene break. Otherwise the whole book stays scene 1 forever, and the
  summarisation that keeps long stories coherent never runs.
• \`get_book\` is the committed text. Read it back if you are unsure whether a turn landed.
• \`update_style\`/\`update_knobs\` change how it is written; \`add_directive\` steers what happens
  next; \`add_anchor\` pins a passage as a style reference.`;

const VALIDATION = `Every turn's world change, extracted or yours, runs through one validator.
Repaired, reported in \`dropped\`, and the turn still commits: an unknown entity id is resolved by name
when it matches one entity, or dropped; an edge with a missing end is dropped; retiring an edge that is
not live is dropped; a vow break naming a vow the character does not hold is dropped; an upsert without
id or name is dropped.
Blocking (\`status: "blocked"\`, nothing commits): a turn with no event at all, or a character recorded
dead taking part in an event. With \`upkeep: "agent"\` an omitted or empty \`events\` becomes one event
from your prose with the present cast, so a missing event list never blocks.`;

const UPKEEP_CHECKLIST = [
  'Cast: add anyone or anything new in entityUpserts (id "type:kebab-name"), after search_entities shows it does not already exist. Sheet changes (wounds, allegiance, appearance) go through update_sheet between turns.',
  'Relationships: edgeAsserts for a typed relation the prose establishes; edgeRetires only for a live edge that ended; relationshipUpdates for trust/affection/respect shifts between two characters.',
  'Facts: factsLearned for information a character now holds, listing exactly who is in knownBy and who is only in suspectedBy. Use record_fact for a fact you missed.',
  'Threads: threadUpdates with a title and no id opens a thread; with an id, move tensionDelta or set status "resolved"/"abandoned". Use open_thread between turns.',
  'Conditions: conditionUpdates for mood, injuries, location or presentWith of anyone the prose changes.',
  'Vows: vowBreaks when a character breaks a vow they hold.',
  'Events: events with participants and significance 0..1; omit to record one event from the prose with the present cast. sceneAdvance: true only when place or time changes.',
  'Consequences are seeded automatically from significant events after each commit. Use add_consequence only for a reaction the prose sets up that the graph cannot infer.',
];

export function buildGuide(input: GuideInput): Guide {
  return {
    upkeep: input.upkeep,
    loop: LOOP,
    writing: {
      rules: input.writingRules,
      style: input.style,
      knobs: input.knobs,
      anchors: input.anchors,
      blocklist: input.blocklist,
    },
    validation: VALIDATION,
    ...(input.upkeep === 'agent' ? { upkeepChecklist: UPKEEP_CHECKLIST } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-upkeep.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/upkeep.ts test/mcp-upkeep.test.ts
git commit -m "feat(mcp): add upkeep signal and agent guide builder"
```

---

### Task 2: `get_guide` tool and `upkeep` on story tools (both builds)

**Files:**
- Modify: `src/loop/engine-pg.ts:242-245` (after `compaction()`), `src/loop/engine.ts:212-215` (after `compaction()`)
- Modify: `src/mcp/tools-pg.ts:47-95` (`McpToolContext`), `:210` (`createStoryTool`), `:310` (`switchStoryTool`), `:313-330` (`getStateTool`), `:562` (`startStoryTool`), `:602,616,631` (`proposeTurnTool`); add `getGuideTool` after `getStateTool`
- Modify: `src/mcp/tools.ts:37-73` (`McpToolContext`), `:165`, `:266,269`, `:272-289`, `:507`, `:546,560,575`; add `getGuideTool` after `getStateTool`
- Modify: `src/server/api-pg.ts:2552`, `src/server/api.ts:1937` (context `lintBlocklist`)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts` (create)

**Interfaces:**
- Consumes: `upkeepFor`, `buildGuide`, `Guide` (Task 1); `narratorSystem(style: StyleContract, verbatim: boolean): string` (`src/loop/roles-pg.ts:363`, `src/loop/roles.ts:331`); `world.chronicle.anchors(limit = 5)` (`chronicle-pg.ts:1190`, `chronicle.ts:519`).
- Produces:
  - `Engine.registry: Registry` (getter, both engines)
  - `McpToolContext.lintBlocklist?: () => string[]` (both builds)
  - `getGuideTool(ctx): Promise<Guide>` (PG) / `getGuideTool(ctx): Guide` (SQLite)
  - `upkeep: Upkeep` on the results of `createStoryTool`, `switchStoryTool`, `startStoryTool`, `getStateTool`, `proposeTurnTool`

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp-upkeep.test.ts`. Merge the new imports into the header:

```ts
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { Engine } from '../src/loop/engine.ts';
import {
  createStoryTool,
  getGuideTool,
  getStateTool,
  proposeTurnTool,
  type McpToolContext,
} from '../src/mcp/tools.ts';

test('SQLite MCP story tools report upkeep and follow a mid-session provider swap', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()));
  const engine = new Engine({ world, providers: registry });
  const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data', lintBlocklist: () => ['stock phrase'] };

  assert.equal(getStateTool(ctx).upkeep, 'agent');
  assert.equal(createStoryTool(ctx, { title: 'Second' }).upkeep, 'agent');
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  assert.equal(proposal.upkeep, 'agent');
  const guide = getGuideTool(ctx);
  assert.ok(guide.upkeepChecklist?.length);
  assert.match(guide.writing.rules, /You do not invent world facts/);
  assert.deepEqual(guide.writing.blocklist, ['stock phrase']);

  registry.swap(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' })), 'stub');
  assert.equal(getStateTool(ctx).upkeep, 'server', 'no reconnect needed');
  assert.equal(getGuideTool(ctx).upkeepChecklist, undefined);
  world.close();
});
```

Create `test/mcp-upkeep-pg.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, withPg } from './pg-harness.ts';
import type { Db } from '../src/db/pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { World } from '../src/store/index-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import {
  createStoryTool,
  getGuideTool,
  getStateTool,
  proposeTurnTool,
  switchStoryTool,
  type McpToolContext,
} from '../src/mcp/tools-pg.ts';

async function seededStory(db: Db): Promise<World> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  await seedWorld(world);
  return world;
}

test('PostgreSQL MCP story tools report upkeep and follow a mid-session provider swap', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seededStory(db);
    const registry = new SwappableRegistry(new ProviderRegistry(new MockProvider()));
    const engine = new Engine({ world: () => world, db, providers: registry });
    const ctx: McpToolContext = {
      db,
      world: async () => world,
      engine,
      dataRoot: 'data',
      selectStory: () => {},
      lintBlocklist: () => ['stock phrase'],
    };

    assert.equal((await getStateTool(ctx)).upkeep, 'agent');
    assert.equal((await createStoryTool(ctx, { title: 'Second' })).upkeep, 'agent');
    assert.equal((await switchStoryTool(ctx, { id: world.storyId })).upkeep, 'agent');
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    assert.equal(proposal.upkeep, 'agent');
    const guide = await getGuideTool(ctx);
    assert.ok(guide.upkeepChecklist?.length);
    assert.match(guide.writing.rules, /You do not invent world facts/);
    assert.deepEqual(guide.writing.blocklist, ['stock phrase']);

    registry.swap(new ProviderRegistry(new MockProvider({ id: 'stub-extractor' })), 'stub');
    assert.equal((await getStateTool(ctx)).upkeep, 'server', 'no reconnect needed');
    assert.equal((await getGuideTool(ctx)).upkeepChecklist, undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-upkeep.test.ts`
Expected: FAIL with `SyntaxError: The requested module '../src/mcp/tools.ts' does not provide an export named 'getGuideTool'`.

Run: `env FABULIST_TEST_PG='postgres://postgres@localhost:5433/fabulist_test?host=/tmp' FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/mcp-upkeep-pg.test.ts`
Expected: FAIL with the same missing-export error for `tools-pg.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/loop/engine-pg.ts`: after the `compaction()` method (ends line 245), add:

```ts
  /** The registry roles resolve from; MCP reads it per request to report who keeps the world. */
  get registry(): Registry {
    return this.providers;
  }
```

`src/loop/engine.ts`: the same getter, after `compaction()` (ends line 215). `Registry` is already imported in both files.

`src/mcp/tools-pg.ts`:
- imports: add `import { narratorSystem } from '../loop/roles-pg.ts';` and `import { buildGuide, upkeepFor } from './upkeep.ts';`
- `McpToolContext` (before the closing `}` at line 95):

```ts
  /** The prose-lint blocklist the gate enforces, for `get_guide`; absent means none. */
  lintBlocklist?: () => string[];
```

- after the interface, add:

```ts
const upkeepOf = (ctx: McpToolContext) => upkeepFor(ctx.engine.registry);
```

- line 210: `return { story };` → `return { story, upkeep: upkeepOf(ctx) };`
- line 310: `return { current: args.id, scope: 'this connection' as const };` → `return { current: args.id, scope: 'this connection' as const, upkeep: upkeepOf(ctx) };`
- `getStateTool`: after `usage: await world.chronicle.usageTotals(),` (line 328) add `upkeep: upkeepOf(ctx),`
- `startStoryTool`: after `...assigned,` (line 562) add `upkeep: upkeepOf(ctx),`
- `proposeTurnTool`: after each of `status: 'awaiting-narration' as const,` (602), `status: 'interrupted' as const,` (616) and `status: 'answered' as const,` (631) add `upkeep: upkeepOf(ctx),`
- after `getStateTool`, add:

```ts
/** `get_guide`. The turn loop, writing contract, validation behaviour and, for agent upkeep, the world checklist. */
export async function getGuideTool(ctx: McpToolContext) {
  const world = await ctx.world();
  const session = await world.session.get();
  return buildGuide({
    upkeep: upkeepOf(ctx),
    writingRules: narratorSystem(session.style, false),
    style: session.style,
    knobs: session.knobs,
    anchors: (await world.chronicle.anchors()).map(({ text, note }) => ({ text, note })),
    blocklist: ctx.lintBlocklist?.() ?? [],
  });
}
```

`src/mcp/tools.ts`:
- imports: add `import { narratorSystem } from '../loop/roles.ts';` and `import { buildGuide, upkeepFor } from './upkeep.ts';`
- `McpToolContext` (before `}` at line 73): the same `lintBlocklist?: () => string[];` member with the same one-line doc.
- after the interface: `const upkeepOf = (ctx: McpToolContext) => upkeepFor(ctx.engine.registry);`
- line 165: `return { story };` → `return { story, upkeep: upkeepOf(ctx) };`
- line 266: `return { current: args.id, scope: 'this connection' as const };` → `return { current: args.id, scope: 'this connection' as const, upkeep: upkeepOf(ctx) };`
- line 269: `return { current: args.id, scope: 'server-wide' as const };` → `return { current: args.id, scope: 'server-wide' as const, upkeep: upkeepOf(ctx) };`
- `getStateTool`: after `usage: world.chronicle.usageTotals(),` (line 287) add `upkeep: upkeepOf(ctx),`
- `startStoryTool`: after `...assigned,` (line 507) add `upkeep: upkeepOf(ctx),`
- `proposeTurnTool`: after lines 546, 560 and 575 (`status: '…' as const,`) add `upkeep: upkeepOf(ctx),`
- after `getStateTool`, add:

```ts
/** `get_guide`. The turn loop, writing contract, validation behaviour and, for agent upkeep, the world checklist. */
export function getGuideTool(ctx: McpToolContext) {
  const world = ctx.world();
  const session = world.session.get();
  return buildGuide({
    upkeep: upkeepOf(ctx),
    writingRules: narratorSystem(session.style, false),
    style: session.style,
    knobs: session.knobs,
    anchors: world.chronicle.anchors().map(({ text, note }) => ({ text, note })),
    blocklist: ctx.lintBlocklist?.() ?? [],
  });
}
```

`src/server/api-pg.ts`: in `mcpToolContextFor`'s returned object, after `dataRoot,` (line 2552) add:

```ts
      lintBlocklist: () => config?.lintOptions().blocklist ?? [],
```

`src/server/api.ts`: the same line after `dataRoot,` (line 1937). `config` is destructured from `opts` in both `createApiServer` functions (`api-pg.ts:2483`, `api.ts:1892`).

- [ ] **Step 4: Run tests to verify they pass**

Run both commands from Step 2. Expected: PASS. Then `pnpm typecheck`. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/loop/engine-pg.ts src/loop/engine.ts src/mcp/tools-pg.ts src/mcp/tools.ts src/server/api-pg.ts src/server/api.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(mcp): report upkeep on story tools and add get_guide"
```

---

### Task 3: Server wiring: register `get_guide`, shrink `INSTRUCTIONS`, conditional `play` prompt

**Files:**
- Modify: `src/mcp/server-pg.ts:22-84` (tool import list), `:115-154` (`INSTRUCTIONS`), `:307-316` (after `get_state` registration), `:1133-1138` and `:1162-1165` (play prompt)
- Modify: `src/mcp/server.ts` imports, `:114-151` (`INSTRUCTIONS`), `:300-309` (after `get_state`), `:1110-1115` and `:1139-1142` (play prompt)
- Test: `test/mcp-e2e.test.ts:282-311`, `test/pg-api.test.ts` (new test)

**Interfaces:**
- Consumes: `getGuideTool` (Task 2), `upkeepFor` (Task 1), `ctx.engine.registry` (Task 2).
- Produces: MCP tool `get_guide` (no input), a shrunk `INSTRUCTIONS`, and a `play` prompt whose relationship bullet depends on upkeep.

- [ ] **Step 1: Write the failing tests**

`test/mcp-e2e.test.ts`, in `'the server tells a client how to use it before any tool is called'` (line 282): after `assert.match(instructions!, /close_scene/);` add:

```ts
      assert.match(instructions!, /get_guide/, 'points at the guide for the loop and the writing rules');
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === 'get_guide'), 'get_guide is registered');
```

and after `assert.match(text, /commit_narration/);` add:

```ts
      assert.match(text, /get_guide/);
      assert.match(text, /You keep the world/, 'the mock-only e2e server tells the agent it keeps the world');
      assert.doesNotMatch(text, /Relationships record themselves/);
```

`test/pg-api.test.ts`: add after the `update_knobs` test (ends line 499):

```ts
test('Postgres MCP instructions name get_guide and never the unregistered switch_world', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(
      db,
      async (base) => {
        const { client, transport } = connectMcp(base);
        await client.connect(transport);
        try {
          const instructions = client.getInstructions() ?? '';
          assert.match(instructions, /get_guide/);
          assert.match(instructions, /NOTHING IS SAVED UNTIL THIS CALL/);
          assert.doesNotMatch(instructions, /switch_world/);
          const { tools } = await client.listTools();
          assert.ok(tools.some((tool) => tool.name === 'get_guide'));
          const guide = mcpPayload(await client.callTool({ name: 'get_guide', arguments: {} }));
          assert.equal(guide.upkeep, 'agent');
          const prompt = await client.getPrompt({ name: 'play', arguments: { world: 'verrow' } });
          const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
          assert.doesNotMatch(text, /switch_world/);
          assert.match(text, /set_story_sources/);
          assert.match(text, /You keep the world/);
        } finally {
          await client.close();
        }
      },
      { mcp: true },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-e2e.test.ts`
Expected: FAIL at `/get_guide/` on the instructions.

Run: `env FABULIST_TEST_PG='postgres://postgres@localhost:5433/fabulist_test?host=/tmp' FABULIST_REQUIRE_TEST_PG=1 node --disable-warning=ExperimentalWarning --test test/pg-api.test.ts --test-name-pattern "get_guide"`
Expected: FAIL at `/get_guide/`.

- [ ] **Step 3: Write minimal implementation**

`src/mcp/server-pg.ts`:
- add `getGuideTool,` to the `from './tools-pg.ts'` import list, and `import { upkeepFor } from './upkeep.ts';`
- replace lines 115-154 (`const INSTRUCTIONS = …;`) with:

```ts
const INSTRUCTIONS = `Fabulist is a state-first fiction engine: the world is a graph in a database, and
prose is a view over it. You write the prose. Whether the server or you keep the world model depends
on this server's configuration; every story tool reports it as \`upkeep\`.

Getting oriented
1. \`list_worlds\` shows the canon worlds (wiki ingests or authored settings); they are shared, and
   books are the playthroughs inside them. \`set_story_sources\` picks which worlds the open book reads.
2. \`list_stories\` shows the books you own here. \`create_story\` makes a new one, \`switch_story\`
   opens it. A new book is empty by design — it shares the world's canon and nothing else.
3. \`get_state\` tells you where you are. If it reports no player character, the book is not
   playable yet: \`list_characters\` to see who is available, then \`start_story\` to become one of
   them (or to place an original). \`start_story\` returns a proposed opening line to play from.
4. \`get_guide\` before the first turn, and again whenever \`upkeep\` changes. It holds the turn loop,
   the writing rules, what validation repairs or blocks, and the world checklist when \`upkeep\` is "agent".
If a tool returns \`status: "locked"\`, ask the user to open Fabulist in their browser and unlock
Private Storage, then retry. This is an expected privacy state, not a connector or transport failure.

The one rule worth repeating here: a turn is \`propose_turn\` then \`commit_narration\`. NOTHING IS SAVED
UNTIL THIS CALL; prose you only put in the chat is not in the book. \`close_scene\` at real scene breaks.

Ingesting a world
\`resolve_wiki\` → \`plan_world\` → \`preview_ingest\` (or \`discover_world\` for progress) →
\`commit_ingest\`. Previews cost nothing and report page counts and money; commit is the step that
writes canon. \`maxPages\`/\`passBMaxPages\` are separate budgets — reading pages is cheap, relation
extraction is one model call per page.`;
```

- after the `get_state` registration (ends line 316), add:

```ts
  server.registerTool(
    'get_guide',
    {
      description:
        'How to play this story: the propose/commit loop, the writing contract (style, knobs, anchors, lint blocklist), what validation repairs or blocks, ' +
        'and, when upkeep is "agent", the per-turn checklist for keeping the world yourself. Call it before the first turn.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(await getGuideTool(ctx)),
  );
```

- play prompt, lines 1134-1138: replace

```ts
              world
                ? `1. switch_world to "${world}".`
                : '1. list_worlds, and ask which one — or use the one already open.',
              '2. list_stories. Open an existing book with switch_story, or create_story for a new one.',
              '3. get_state. If there is no player character, list_characters and then start_story.',
```

with

```ts
              world
                ? `1. Once a book is open (step 2), call set_story_sources with ["${world}"].`
                : '1. list_worlds, and ask which one — or use the one already open.',
              '2. list_stories. Open an existing book with switch_story, or create_story for a new one.',
              '3. get_state, then get_guide. If there is no player character, list_characters and then start_story.',
```

- play prompt, lines 1162-1165 (the four `'- Relationships record themselves: …'` lines): replace with

```ts
              ...(upkeepFor(ctx.engine.registry) === 'server'
                ? [
                    '- Relationships record themselves: commit_narration’s extraction step reads what the prose',
                    '  actually depicts and creates the connections — there is no separate "create a connection"',
                    '  call. Write the relationship plainly enough in the prose for extraction to catch it, then',
                    '  spot-check with get_entity (its neighbours field) that the edge actually landed.',
                  ]
                : [
                    '- You keep the world: this server has no extraction model, so pass commit_narration a world',
                    '  delta every turn (get_guide lists what goes in it). Relationships, facts and threads you leave',
                    '  out are not recorded; spot-check with get_entity (its neighbours field) that an edge landed.',
                  ]),
```

`src/mcp/server.ts`:
- add `getGuideTool,` to the `from './tools.ts'` import list, and `import { upkeepFor } from './upkeep.ts';`
- replace lines 114-151 (`const INSTRUCTIONS = …;`) with the text below. It is the same as PG, except that step 1 keeps `switch_world`, which is registered in this build, and there is no `locked` paragraph, which this build never had:

```ts
const INSTRUCTIONS = `Fabulist is a state-first fiction engine: the world is a graph in a database, and
prose is a view over it. You write the prose. Whether the server or you keep the world model depends
on this server's configuration; every story tool reports it as \`upkeep\`.

Getting oriented
1. \`list_worlds\`, then \`switch_world\` to pick one. Worlds hold canon (a wiki ingest or an authored
   setting) and are shared; books are the playthroughs inside them.
2. \`list_stories\` shows the books you own here. \`create_story\` makes a new one, \`switch_story\`
   opens it. A new book is empty by design — it shares the world's canon and nothing else.
3. \`get_state\` tells you where you are. If it reports no player character, the book is not
   playable yet: \`list_characters\` to see who is available, then \`start_story\` to become one of
   them (or to place an original). \`start_story\` returns a proposed opening line to play from.
4. \`get_guide\` before the first turn, and again whenever \`upkeep\` changes. It holds the turn loop,
   the writing rules, what validation repairs or blocks, and the world checklist when \`upkeep\` is "agent".

The one rule worth repeating here: a turn is \`propose_turn\` then \`commit_narration\`. NOTHING IS SAVED
UNTIL THIS CALL; prose you only put in the chat is not in the book. \`close_scene\` at real scene breaks.

Ingesting a world
\`resolve_wiki\` → \`plan_world\` → \`preview_ingest\` (or \`discover_world\` for progress) →
\`commit_ingest\`. Previews cost nothing and report page counts and money; commit is the step that
writes canon. \`maxPages\`/\`passBMaxPages\` are separate budgets — reading pages is cheap, relation
extraction is one model call per page.`;
```

- after the `get_state` registration (ends line 309), add the same `get_guide` registration with `async () => toolResult(getGuideTool(ctx)),` as its handler.
- play prompt line 1115: `'3. get_state. If there is no player character, list_characters and then start_story.',` → `'3. get_state, then get_guide. If there is no player character, list_characters and then start_story.',` (keep line 1112's `switch_world`; it exists in this build).
- play prompt lines 1139-1142: the same `...(upkeepFor(ctx.engine.registry) === 'server' ? [...] : [...])` replacement as PG.

- [ ] **Step 4: Run tests to verify they pass**

Run both commands from Step 2. Expected: PASS. Then `pnpm typecheck && pnpm lint`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server-pg.ts src/mcp/server.ts test/mcp-e2e.test.ts test/pg-api.test.ts
git commit -m "feat(mcp): register get_guide and point instructions at it"
```

---

### Task 4: Agent delta coercion and validation

**Files:**
- Modify: `src/loop/validate.ts` (add after `coerceDelta`, which ends at line 293)
- Modify: `src/loop/validate-pg.ts:34-41` (re-export list)
- Modify: `src/frame/builders-pg.ts:287` (`export` the existing `resolvePresentIds`)
- Modify: `src/frame/builders.ts:227` (`export` `presentIds` and narrow its parameter type)
- Modify: `src/loop/roles-pg.ts:27-47` (imports), after `extract` (ends line 485)
- Modify: `src/loop/roles.ts:19-38` (imports), after `extract` (ends line 451)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `coerceDelta(raw: unknown): { delta: Delta; issues: ValidationIssue[] }` (`validate.ts:169`), `validateDelta` (`validate-pg.ts:67` async; `validate.ts:301` sync).
- Produces:
  - `export function coerceAgentDelta(raw: unknown, prose: string, participants: EntityId[], locationId: EntityId | null): { delta: Delta; issues: ValidationIssue[] }` (`validate.ts`, re-exported from `validate-pg.ts`)
  - `export async function resolvePresentIds(world: World, session: SessionState): Promise<EntityId[]>` (`builders-pg.ts`)
  - `export function presentIds(ctx: Pick<FrameContext, 'world' | 'session'>): EntityId[]` (`builders.ts`)
  - `export async function agentDelta(world: World, raw: unknown, prose: string): Promise<{ delta: Delta; validation: ValidationResult }>` (`roles-pg.ts`)
  - `export function agentDelta(world: World, raw: unknown, prose: string): { delta: Delta; validation: ValidationResult }` (`roles.ts`)

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp-upkeep.test.ts`. Add these imports:

```ts
import { coerceAgentDelta } from '../src/loop/validate.ts';
import { agentDelta } from '../src/loop/roles.ts';
```

```ts
test('coerceAgentDelta falls back to one prose event when every supplied event is blank', () => {
  const { delta, issues } = coerceAgentDelta(
    { events: [{ text: '   ' }, 'junk'], factsLearned: [{ text: 'The bell is cracked.', knownBy: ['char:a'] }] },
    'Rain  on the\nroof.',
    ['char:a', 'char:b'],
    'loc:roof',
  );
  assert.equal(delta.events.length, 1);
  assert.deepEqual(delta.events[0], {
    text: 'Rain on the roof.',
    participants: ['char:a', 'char:b'],
    locationId: 'loc:roof',
    significance: 0.5,
  });
  assert.equal(delta.factsLearned.length, 1, 'the other fields are kept');
  assert.equal(issues.filter((i) => !i.repaired).length, 0, 'a missing event list never blocks an agent turn');
});

test('coerceAgentDelta keeps agent events when at least one has text', () => {
  const { delta } = coerceAgentDelta(
    { events: [{ text: 'Anselm bars the door.', participants: ['char:a'], significance: 0.8 }] },
    'prose',
    ['char:z'],
    null,
  );
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0]!.text, 'Anselm bars the door.');
  assert.deepEqual(delta.events[0]!.participants, ['char:a']);
});

test('SQLite agentDelta validates an agent world and records the present cast on the fallback event', () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const { delta, validation } = agentDelta(
    world,
    { edgeAsserts: [{ subject: 'char:brother-anselm', predicate: 'DISTRUSTS', object: 'char:nobody' }] },
    'Anselm waits by the door.',
  );
  assert.equal(validation.ok, true);
  assert.equal(delta.events.length, 1);
  assert.ok(delta.events[0]!.participants.includes('char:brother-anselm'));
  assert.equal(delta.events[0]!.locationId, 'loc:the-scriptorium');
  assert.equal(delta.edgeAsserts.length, 0, 'an edge to an unknown id is dropped');
  assert.ok(validation.issues.some((i) => i.repaired && /char:nobody/.test(i.message)));
  world.close();
});
```

Append to `test/mcp-upkeep-pg.test.ts` (import `agentDelta` from `'../src/loop/roles-pg.ts'`):

```ts
test('PostgreSQL agentDelta validates an agent world and records the present cast on the fallback event', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await seededStory(db);
    const { delta, validation } = await agentDelta(
      world,
      { edgeAsserts: [{ subject: 'char:brother-anselm', predicate: 'DISTRUSTS', object: 'char:nobody' }] },
      'Anselm waits by the door.',
    );
    assert.equal(validation.ok, true);
    assert.equal(delta.events.length, 1);
    assert.ok(delta.events[0]!.participants.includes('char:brother-anselm'));
    assert.equal(delta.events[0]!.locationId, 'loc:the-scriptorium');
    assert.equal(delta.edgeAsserts.length, 0);
    assert.ok(validation.issues.some((i) => i.repaired && /char:nobody/.test(i.message)));
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-upkeep.test.ts`
Expected: FAIL with `does not provide an export named 'coerceAgentDelta'`.

Run the PG file (command pattern above). Expected: FAIL with `does not provide an export named 'agentDelta'`.

- [ ] **Step 3: Write minimal implementation**

`src/loop/validate.ts`, after `coerceDelta` (line 293). `EntityId` is added to the existing `'../domain/types.ts'` type import if it is not already there:

```ts
/**
 * The agent's `world` argument as a delta. With no usable event, the turn gets
 * one from the prose, since an agent-kept turn must not block on bookkeeping.
 */
export function coerceAgentDelta(
  raw: unknown,
  prose: string,
  participants: EntityId[],
  locationId: EntityId | null,
): { delta: Delta; issues: ValidationIssue[] } {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const usable = asArray(o.events).some(
    (e) => typeof e === 'object' && e !== null && asString((e as Record<string, unknown>).text).trim() !== '',
  );
  const events = usable
    ? o.events
    : [{ text: prose.replace(/\s+/g, ' ').trim().slice(0, 160), participants, locationId, significance: 0.5 }];
  return coerceDelta({ ...o, events });
}
```

`src/loop/validate-pg.ts`: add `coerceAgentDelta,` to the `export { … } from './validate.ts';` list (lines 34-41).

`src/frame/builders-pg.ts:287`: `async function resolvePresentIds(` → `export async function resolvePresentIds(`.

`src/frame/builders.ts:227`: `function presentIds(ctx: FrameContext): EntityId[] {` → `export function presentIds(ctx: Pick<FrameContext, 'world' | 'session'>): EntityId[] {`.

`src/loop/roles-pg.ts`: add `resolvePresentIds,` to the `'../frame/builders-pg.ts'` import, add `coerceAgentDelta,` to the `'./validate-pg.ts'` import, and after `extract` (line 485) add:

```ts
/** The agent-kept counterpart of `extract`: same validation, no model call. */
export async function agentDelta(
  world: World,
  raw: unknown,
  prose: string,
): Promise<{ delta: Delta; validation: ValidationResult }> {
  const session = await world.session.get();
  const participants = await resolvePresentIds(world, session);
  const { delta, issues } = coerceAgentDelta(raw, prose, participants, session.currentLocationId);
  const validation = await validateDelta(world, delta);
  validation.issues = [...issues, ...validation.issues];
  validation.ok = validation.issues.filter((i) => !i.repaired).length === 0;
  return { delta, validation };
}
```

`src/loop/roles.ts`: add `presentIds,` to the `'../frame/builders.ts'` import, add `coerceAgentDelta,` to the `'./validate.ts'` import, and after `extract` (line 451) add:

```ts
/** The agent-kept counterpart of `extract`: same validation, no model call. */
export function agentDelta(
  world: World,
  raw: unknown,
  prose: string,
): { delta: Delta; validation: ValidationResult } {
  const session = world.session.get();
  const { delta, issues } = coerceAgentDelta(raw, prose, presentIds({ world, session }), session.currentLocationId);
  const validation = validateDelta(world, delta);
  validation.issues = [...issues, ...validation.issues];
  validation.ok = validation.issues.filter((i) => !i.repaired).length === 0;
  return { delta, validation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run both files. Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/loop/validate.ts src/loop/validate-pg.ts src/frame/builders-pg.ts src/frame/builders.ts src/loop/roles-pg.ts src/loop/roles.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(loop): validate an agent-supplied world delta like an extracted one"
```

---

### Task 5: `world` on `commit_narration`

**Files:**
- Modify: `src/loop/engine-pg.ts:519-609` (`finishTurn`), `:643-682` (`commitExternalNarration`)
- Modify: `src/loop/engine.ts:446-532` (`finishTurn`), `:566-599` (`commitExternalNarration`)
- Modify: `src/mcp/upkeep.ts` (add `appliedCounts`, `worldDeltaInput`)
- Modify: `src/mcp/tools-pg.ts:650-689`, `src/mcp/tools.ts:594-632` (`commitNarrationTool`)
- Modify: `src/mcp/server-pg.ts:514-532`, `src/mcp/server.ts:507-524` (`commit_narration` registration)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`, `test/mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `agentDelta` (Task 4), `upkeepOf` (Task 2).
- Produces:
  - `Engine.commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World, agentWorld?: unknown): Promise<TurnOutcome>` (both engines). When `agentWorld !== undefined`, it replaces `extract()`.
  - `export function appliedCounts(delta: Delta): Record<string, number>` (`upkeep.ts`)
  - `export const worldDeltaInput` (zod object, `upkeep.ts`)
  - `commitNarrationTool(ctx, { resumeToken, prose, world? })` → narrated shape gains `upkeep`, `applied`, `dropped: ValidationIssue[]`, `warning?`; blocked shape gains `upkeep`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp-upkeep.test.ts` (import `commitNarrationTool` from `'../src/mcp/tools.ts'`). The context helper and the world fixture are also used by later tasks:

```ts
function sqliteContext(extractId = 'mock') {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider({ id: extractId })) });
  const ctx: McpToolContext = { world: () => world, engine, dataRoot: 'data' };
  return { world, engine, ctx };
}

const AGENT_WORLD = {
  entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman', summary: 'Keeps the river crossing.' }],
  edgeAsserts: [
    { subject: 'char:ferryman-oll', predicate: 'OWES', object: 'char:brother-anselm' },
    { subject: 'char:nobody', predicate: 'KNOWS', object: 'char:brother-anselm' },
  ],
  factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'], suspectedBy: ['char:sister-oria'] }],
  threadUpdates: [{ title: 'The night ferry', stakes: 'who crosses unseen', parties: ['char:ferryman-oll'] }],
  events: [
    {
      text: 'Anselm strikes a bargain with Oll.',
      participants: ['char:brother-anselm', 'char:ferryman-oll'],
      significance: 0.9,
    },
  ],
};

test('SQLite commit_narration with agent upkeep commits the world delta and reports what was dropped', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, {
    resumeToken: proposal.resumeToken,
    prose: 'Anselm strikes a bargain with the ferryman.',
    world: AGENT_WORLD,
  });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  assert.equal(out.upkeep, 'agent');
  assert.equal(out.warning, undefined);
  assert.equal(out.applied.entityUpserts, 1);
  assert.equal(out.applied.edgeAsserts, 1, 'the edge to an unknown id is not applied');
  assert.equal(out.applied.factsLearned, 1);
  assert.ok(out.dropped.some((issue) => /char:nobody/.test(issue.message)));
  assert.equal(out.newThreads.length, 1, 'a title without an id opens a thread');
  assert.equal(world.graph.get('char:ferryman-oll')?.name, 'Oll the Ferryman');
  assert.ok(world.graph.neighbours('char:ferryman-oll').some((n) => n.edge.predicate === 'OWES'));
  assert.ok(world.chronicle.knowledgeOf('char:sister-oria').some((k) => k.level === 'suspects' && /ferry runs/.test(k.text)));
  assert.ok(world.threads.all().some((thread) => thread.title === 'The night ferry'));
  world.close();
});

test('SQLite commit_narration warns when agent upkeep omits world', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'Anselm warms the ink.' });
  if (out.status !== 'narrated') throw new Error('expected narrated');
  assert.match(out.warning ?? '', /no world was given/);
  world.close();
});

test('SQLite commit_narration with server upkeep ignores world and says so', async () => {
  const { world, ctx } = sqliteContext('stub-extractor');
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, {
    resumeToken: proposal.resumeToken,
    prose: 'Anselm warms the ink.',
    world: AGENT_WORLD,
  });
  if (out.status !== 'narrated') throw new Error('expected narrated');
  assert.equal(out.upkeep, 'server');
  assert.match(out.warning ?? '', /ignored world/);
  assert.equal(world.graph.get('char:ferryman-oll'), undefined);
  assert.deepEqual(out.dropped, []);
  world.close();
});
```

Append to `test/mcp-upkeep-pg.test.ts` (import `commitNarrationTool` from `'../src/mcp/tools-pg.ts'`). Define the same `AGENT_WORLD` constant at the top of the file, and this helper after `seededStory`:

```ts
async function pgContext(db: Db, extractId = 'mock') {
  const world = await seededStory(db);
  const engine = new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider({ id: extractId })) });
  const ctx: McpToolContext = { db, world: async () => world, engine, dataRoot: 'data', selectStory: () => {} };
  return { world, engine, ctx };
}
```

```ts
test('PostgreSQL commit_narration with agent upkeep commits the world delta and reports what was dropped', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, {
      resumeToken: proposal.resumeToken,
      prose: 'Anselm strikes a bargain with the ferryman.',
      world: AGENT_WORLD,
    });
    if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
    assert.equal(out.upkeep, 'agent');
    assert.equal(out.applied.entityUpserts, 1);
    assert.equal(out.applied.edgeAsserts, 1);
    assert.ok(out.dropped.some((issue) => /char:nobody/.test(issue.message)));
    assert.equal(out.newThreads.length, 1);
    assert.equal((await world.graph.get('char:ferryman-oll'))?.name, 'Oll the Ferryman');
    assert.ok((await world.graph.neighbours('char:ferryman-oll')).some((n) => n.edge.predicate === 'OWES'));
    assert.ok(
      (await world.chronicle.knowledgeOf('char:sister-oria')).some((k) => k.level === 'suspects' && /ferry runs/.test(k.text)),
    );
    assert.ok((await world.threads.all()).some((thread) => thread.title === 'The night ferry'));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL commit_narration with server upkeep ignores world and says so', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db, 'stub-extractor');
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, {
      resumeToken: proposal.resumeToken,
      prose: 'Anselm warms the ink.',
      world: AGENT_WORLD,
    });
    if (out.status !== 'narrated') throw new Error('expected narrated');
    assert.equal(out.upkeep, 'server');
    assert.match(out.warning ?? '', /ignored world/);
    assert.equal(await world.graph.get('char:ferryman-oll'), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

`test/mcp-e2e.test.ts`: add after the full-turn test (ends line 227):

```ts
test('commit_narration accepts a world delta over real MCP calls', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const proposal = payload(await client.callTool({ name: 'propose_turn', arguments: { text: 'i look around the cell' } }));
      const committed = payload(
        await client.callTool({
          name: 'commit_narration',
          arguments: {
            resumeToken: proposal.resumeToken,
            prose: 'A ferryman waits at the grate.',
            world: { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman' }] },
          },
        }),
      );
      assert.equal(committed.status, 'narrated');
      assert.equal(committed.upkeep, 'agent');
      const entity = payload(await client.callTool({ name: 'get_entity', arguments: { id: 'char:ferryman-oll' } }));
      assert.match(JSON.stringify(entity), /Oll the Ferryman/);
    } finally {
      await client.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/mcp-upkeep.test.ts`
Expected: FAIL. `out.applied` is undefined (`TypeError: Cannot read properties of undefined (reading 'entityUpserts')`).

Run the PG file. Expected: the same failure. Run `test/mcp-e2e.test.ts`. Expected: FAIL because the unknown `world` key is stripped, so `upkeep` is undefined.

- [ ] **Step 3: Write minimal implementation**

`src/mcp/upkeep.ts`: extend the imports and append:

```ts
import { z } from 'zod';
import type { Delta, Knobs, StyleContract } from '../domain/types.ts';
```

```ts
export function appliedCounts(delta: Delta): Record<string, number> {
  return {
    events: delta.events.length,
    entityUpserts: delta.entityUpserts.length,
    edgeAsserts: delta.edgeAsserts.length,
    edgeRetires: delta.edgeRetires.length,
    conditionUpdates: delta.conditionUpdates.length,
    relationshipUpdates: delta.relationshipUpdates.length,
    factsLearned: delta.factsLearned.length,
    threadUpdates: delta.threadUpdates.length,
    vowBreaks: delta.vowBreaks.length,
    sceneAdvance: delta.sceneAdvance ? 1 : 0,
  };
}

export const worldDeltaInput = z.object({
  events: z
    .array(
      z.object({
        text: z.string(),
        participants: z.array(z.string()).optional(),
        locationId: z.string().nullable().optional(),
        significance: z.number().min(0).max(1).optional(),
      }),
    )
    .optional()
    .describe('What happened. Omit to record one event from the prose with the present cast.'),
  entityUpserts: z
    .array(
      z.object({
        id: z.string().describe('type:kebab-name'),
        type: z.enum(['Character', 'Location', 'Faction', 'Item', 'Concept', 'Event']),
        name: z.string(),
        summary: z.string().optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  edgeAsserts: z
    .array(z.object({ subject: z.string(), predicate: z.string(), object: z.string(), weight: z.number().min(0).max(1).optional() }))
    .optional(),
  edgeRetires: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() })).optional(),
  conditionUpdates: z.array(z.object({ entityId: z.string(), patch: z.record(z.string(), z.unknown()) })).optional(),
  relationshipUpdates: z
    .array(
      z.object({
        fromId: z.string(),
        toId: z.string(),
        trustDelta: z.number().optional(),
        affectionDelta: z.number().optional(),
        respectDelta: z.number().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  factsLearned: z
    .array(z.object({ text: z.string(), knownBy: z.array(z.string()).optional(), suspectedBy: z.array(z.string()).optional() }))
    .optional(),
  threadUpdates: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        stakes: z.string().optional(),
        tensionDelta: z.number().optional(),
        parties: z.array(z.string()).optional(),
        resolutions: z.array(z.string()).optional(),
        status: z.enum(['open', 'resolved', 'abandoned']).optional(),
      }),
    )
    .optional(),
  vowBreaks: z.array(z.object({ entityId: z.string(), vowId: z.string() })).optional(),
  sceneAdvance: z.boolean().optional(),
});
```

`src/loop/engine-pg.ts`:
- import: add `agentDelta,` to the `'./roles-pg.ts'` import list (lines 38-48).
- `finishTurn` args type (lines 519-534): add `agentWorld?: unknown;` after `onStage?: (stage: string) => void;`.
- line 561: `const { delta, validation } = await extract(deps, prose, rawInput);` →

```ts
    const { delta, validation } =
      args.agentWorld === undefined
        ? await extract(deps, prose, rawInput)
        : await agentDelta(world, args.agentWorld, prose);
```

- line 643: `async commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World): Promise<TurnOutcome> {` → `async commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World, agentWorld?: unknown): Promise<TurnOutcome> {`
- in its `this.finishTurn({ … })` call, after `deps,` add `agentWorld,`.

`src/loop/engine.ts`: the same four edits. `agentDelta` is added to the `'./roles.ts'` import. Line 487 becomes:

```ts
    const { delta, validation } =
      args.agentWorld === undefined ? await extract(deps, prose, rawInput) : agentDelta(world, args.agentWorld, prose);
```

Also change line 566's signature, and add `agentWorld,` to the `finishTurn` call.

`src/mcp/tools-pg.ts`: import `appliedCounts` alongside `buildGuide, upkeepFor` from `'./upkeep.ts'`. Replace `commitNarrationTool` (lines 650-689) with:

```ts
export async function commitNarrationTool(
  ctx: McpToolContext,
  args: { resumeToken: string; prose: string; world?: unknown },
) {
  ctx.chargePaidCall?.();
  const upkeep = upkeepOf(ctx);
  const agentWorld = upkeep === 'agent' ? args.world : undefined;
  const warning =
    upkeep === 'agent' && args.world === undefined
      ? 'upkeep is "agent" but no world was given, so only the mock extractor’s placeholder event was recorded. Pass world on every commit (see get_guide).'
      : upkeep === 'server' && args.world !== undefined
        ? 'upkeep is "server": the server extracted this turn from your prose and ignored world.'
        : undefined;
  // Same reason as `proposeTurnTool`: the pending turn belongs to this user's story.
  const outcome = await ctx.engine.commitExternalNarration(args.resumeToken, args.prose, await ctx.world(), agentWorld);
  if (outcome.kind === 'narrated') {
    return {
      status: 'narrated' as const,
      nextStep:
        'Committed. Show the prose to the player and take the next turn with propose_turn, or close_scene at a scene break.',
      upkeep,
      turnId: outcome.turn.id,
      prose: outcome.prose,
      eventsRecorded: outcome.commit.events.length,
      brokenVows: outcome.commit.brokenVows,
      newThreads: outcome.commit.newThreadIds,
      applied: appliedCounts(outcome.delta),
      dropped: agentWorld === undefined ? [] : outcome.validation.issues.filter((i) => i.repaired),
      ...(warning ? { warning } : {}),
    };
  }
  if (outcome.kind === 'blocked') {
    return {
      status: 'blocked' as const,
      nextStep:
        'Nothing was committed. Fix what the issues name (the prose, or the world you passed), then call propose_turn again for a fresh token.',
      upkeep,
      reason: outcome.reason,
      issues: outcome.validation.issues.filter((i) => !i.repaired),
    };
  }
  throw new Error(
    `commit_narration: unexpected outcome kind ${outcome.kind} — this should be unreachable post-narrate`,
  );
}
```

(Keep the original multi-line comment above the final `throw` if you like. It predates this change.)

`src/mcp/tools.ts`: replace `commitNarrationTool` (lines 594-632) with the same body, minus `ctx.chargePaidCall?.();` (this build has none) and with `ctx.world()` in place of `await ctx.world()`. Import `appliedCounts` the same way.

`src/mcp/server-pg.ts` (`commit_narration`, lines 514-532): import `worldDeltaInput` from `'./upkeep.ts'`, add to `inputSchema` after `prose`:

```ts
        world: worldDeltaInput
          .optional()
          .describe('With upkeep "agent": what this turn changed (see get_guide). Ignored with upkeep "server".'),
```

change the handler to `async ({ resumeToken, prose, world }) => toolResult(await commitNarrationTool(ctx, { resumeToken, prose, world })),` and append to the description string: `' With upkeep "agent", pass world: the turn’s changes to cast, relationships, facts and threads.'`

`src/mcp/server.ts` (`commit_narration`, lines 507-524): the same three edits.

- [ ] **Step 4: Run tests to verify they pass**

Run `test/mcp-upkeep.test.ts`, the PG file, `test/mcp-e2e.test.ts`, and `test/mcp-tools.test.ts` (the existing `commitNarrationTool` tests must still pass). Expected: PASS. Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/loop/engine-pg.ts src/loop/engine.ts src/mcp/upkeep.ts src/mcp/tools-pg.ts src/mcp/tools.ts src/mcp/server-pg.ts src/mcp/server.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts test/mcp-e2e.test.ts
git commit -m "feat(mcp): accept an agent world delta on commit_narration"
```

---

### Task 6: Consequences on the MCP commit path

**Files:**
- Modify: `src/application/play-pg.ts:1-46`, `src/application/play.ts:1-37`
- Modify: `src/mcp/tools-pg.ts` (`commitNarrationTool` from Task 5), `src/mcp/tools.ts` (same)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `runPlayTurn`, `PlayWorkflowAdapter` (`src/application/play-workflow.ts:7-17,32-58`); `commitExternalNarration(…, agentWorld?)` (Task 5); `TickResult` (`propagate-pg.ts:143`, `propagate.ts:233`); `TurnOutcome` (both engines).
- Produces:
  - `export async function commitNarration(db: Db, engine: Engine, world: World, resumeToken: string, prose: string, agentWorld?: unknown): Promise<{ outcome: TurnOutcome; seeded: number; tick: TickResult | null }>` (`play-pg.ts`)
  - `export function commitNarration(engine: Engine, world: World, resumeToken: string, prose: string, agentWorld?: unknown): Promise<{ outcome: TurnOutcome; seeded: number; tick: TickResult | null }>` (`play.ts`)
  - `commit_narration` narrated result gains `consequencesSeeded: number`, `consequencesFired: number`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp-upkeep.test.ts`:

```ts
test('SQLite commit_narration seeds consequences in its own checkpoint, like play', async () => {
  const { world, ctx } = sqliteContext();
  const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'A bargain.', world: AGENT_WORLD });
  if (out.status !== 'narrated') throw new Error('expected narrated');
  assert.ok(out.consequencesSeeded > 0, 'a significant event touching a well-connected character ripples');
  assert.ok(world.consequences.all().length >= out.consequencesSeeded);
  const checkpoints = world.db
    .prepare('SELECT count(*) AS n FROM history_checkpoints WHERE story_id = ?')
    .get(world.storyId) as { n: number };
  assert.equal(Number(checkpoints.n), 2, 'the turn checkpoint, then the consequence checkpoint');
  world.close();
});
```

Append to `test/mcp-upkeep-pg.test.ts`:

```ts
test('PostgreSQL commit_narration seeds consequences in its own checkpoint, like play', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const proposal = await proposeTurnTool(ctx, { text: 'i warm the ink' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: 'A bargain.', world: AGENT_WORLD });
    if (out.status !== 'narrated') throw new Error('expected narrated');
    assert.ok(out.consequencesSeeded > 0);
    assert.ok((await world.consequences.all()).length >= out.consequencesSeeded);
    const count = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM history_checkpoints WHERE story_id = $1`,
      [world.storyId],
    );
    assert.equal(Number(count?.count), 2);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run both files. Expected: FAIL, because `out.consequencesSeeded` is `undefined` and `undefined > 0` is false.

- [ ] **Step 3: Write minimal implementation**

Replace `src/application/play-pg.ts` with:

```ts
import { seedConsequences, tickConsequences, worldTick, type TickResult } from '../consequence/propagate-pg.ts';
import type { Db } from '../db/pg.ts';
import type { Engine, TakeTurnOptions, TurnOutcome } from '../loop/engine-pg.ts';
import { recordAuthoringCheckpoint } from '../loop/history-pg.ts';
import type { World } from '../store/index-pg.ts';
import { runPlayTurn, type PlayWorkflowAdapter } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

type Adapter = PlayWorkflowAdapter<World, TurnOutcome, TickResult>;

function postCommit(db: Db, takeTurn: Adapter['takeTurn']): Adapter {
  return {
    takeTurn,
    seedConsequences: async (resolvedWorld, delta, events) =>
      (
        await seedConsequences(
          resolvedWorld,
          delta as Parameters<typeof seedConsequences>[1],
          events as Parameters<typeof seedConsequences>[2],
        )
      ).length,
    tickConsequences,
    worldTick,
    recordAuthoringCheckpoint: (resolvedWorld, mutate) => recordAuthoringCheckpoint(db, resolvedWorld, mutate),
  };
}

/**
 * The complete application workflow for one server-narrated turn.
 *
 * HTTP and MCP are transports over this operation; neither should be able to
 * forget consequence seeding or the world tick after a successful commit.
 */
export async function playTurn(db: Db, engine: Engine, world: World, input: string, opts: PlayTurnOptions = {}) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld, text, options) =>
      engine.takeTurn(text, {
        world: resolvedWorld,
        overrideIntegrity: options.overrideIntegrity,
        ...(options.onStage ? { onStage: options.onStage } : {}),
        ...(options.onToken ? { onToken: options.onToken } : {}),
      }),
    ),
    world,
    input,
    opts,
  );
}

/** The second half of the MCP split turn, followed by the same consequence workflow as `playTurn`. */
export async function commitNarration(
  db: Db,
  engine: Engine,
  world: World,
  resumeToken: string,
  prose: string,
  agentWorld?: unknown,
) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld) => engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld)),
    world,
    '',
  );
}
```

Replace `src/application/play.ts` with:

```ts
import { seedConsequences, tickConsequences, worldTick, type TickResult } from '../consequence/propagate.ts';
import type { Engine, TakeTurnOptions, TurnOutcome } from '../loop/engine.ts';
import { recordAuthoringCheckpointTx } from '../loop/history.ts';
import type { World } from '../store/index.ts';
import { runPlayTurn, type PlayWorkflowAdapter } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

type Adapter = PlayWorkflowAdapter<World, TurnOutcome, TickResult>;

function postCommit(takeTurn: Adapter['takeTurn']): Adapter {
  return {
    takeTurn,
    seedConsequences: (resolvedWorld, delta, events) =>
      seedConsequences(
        resolvedWorld,
        delta as Parameters<typeof seedConsequences>[1],
        events as Parameters<typeof seedConsequences>[2],
      ).length,
    tickConsequences,
    worldTick,
    recordAuthoringCheckpoint: recordAuthoringCheckpointTx,
  };
}

export function playTurn(engine: Engine, world: World, input: string, options: PlayTurnOptions = {}) {
  return runPlayTurn(
    postCommit((resolvedWorld, text, opts) =>
      engine.takeTurn(text, {
        world: resolvedWorld,
        overrideIntegrity: opts.overrideIntegrity,
        ...(opts.onStage ? { onStage: opts.onStage } : {}),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
      }),
    ),
    world,
    input,
    options,
  );
}

/** The second half of the MCP split turn, followed by the same consequence workflow as `playTurn`. */
export function commitNarration(engine: Engine, world: World, resumeToken: string, prose: string, agentWorld?: unknown) {
  return runPlayTurn(
    postCommit((resolvedWorld) => engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld)),
    world,
    '',
  );
}
```

`src/mcp/tools-pg.ts`: change the import `import { playTurn } from '../application/play-pg.ts';` (line 45) to `import { commitNarration, playTurn } from '../application/play-pg.ts';`. In `commitNarrationTool`, replace

```ts
  const outcome = await ctx.engine.commitExternalNarration(args.resumeToken, args.prose, await ctx.world(), agentWorld);
```

with

```ts
  const { outcome, seeded, tick } = await commitNarration(
    ctx.db,
    ctx.engine,
    await ctx.world(),
    args.resumeToken,
    args.prose,
    agentWorld,
  );
```

and add to the narrated return, after `dropped: …,`:

```ts
      consequencesSeeded: seeded,
      consequencesFired: tick?.fired.length ?? 0,
```

`src/mcp/tools.ts`: add `import { commitNarration } from '../application/play.ts';` and make the same two edits, using `commitNarration(ctx.engine, ctx.world(), args.resumeToken, args.prose, agentWorld)`.

- [ ] **Step 4: Run tests to verify they pass**

Run both upkeep files, plus `test/application-workflows.test.ts`, `test/api.test.ts` and `test/mcp-tools.test.ts` (they exercise the refactored `playTurn`). Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/application/play-pg.ts src/application/play.ts src/mcp/tools-pg.ts src/mcp/tools.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(mcp): seed consequences after commit_narration like play"
```

---

### Task 7: Checkpoint origin column

**Files:**
- Create: `src/db/migrations-pg/009-checkpoint-origin.sql`
- Modify: `src/db/schema-pg.sql:617-626`, `src/db/schema.sql:271-281`, `src/db/db.ts:83-129` (`migrate`)
- Modify: `src/domain/types.ts:399-406` (`HistoryCheckpoint`)
- Modify: `src/store/history-pg.ts:29-36` (`CheckpointRow`), `:53-62` (`checkpointOf`), `:75-77` (`capture`), `:322-379` (`captureIn`)
- Modify: `src/store/history.ts:26-44` (`CheckpointRow`, `toCheckpoint`), `:60-134` (`capture`)
- Modify: `src/loop/history-pg.ts:96-114`, `src/loop/history.ts:77-98`
- Modify: `src/loop/commit-pg.ts:43-50,246`, `src/loop/commit.ts:22-29,201`
- Modify: `src/loop/engine-pg.ts:593-600`, `src/loop/engine.ts:516-523` (commit call)
- Modify: `src/application/play-pg.ts`, `src/application/play.ts` (`postCommit` from Task 6)
- Modify: `src/loop/branch-pg.ts:553-569`, `src/loop/branch.ts:552-563` (fork copy)
- Test: `test/db-migrations.test.ts`, `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces:
  - `HistoryCheckpoint.origin: string | null`
  - `HistoryStore.capture(turnId?: string, origin?: string)` (PG async, SQLite sync)
  - `recordAuthoringCheckpoint<T>(db: Db, world: World, mutate: (w: World) => Promise<T>, origin?: string): Promise<T>` (PG)
  - `recordAuthoringCheckpoint(world: World, origin?: string): void` and `recordAuthoringCheckpointTx<T>(world: World, mutate: (w: World) => Promise<T>, origin?: string): Promise<T>` (SQLite)
  - `CommitTurnInput.origin?: string` (default `'turn:server'`)
  - Origins written: `turn:agent`, `turn:server`, `tool:consequences` (post-commit seed/tick checkpoint on both play and MCP paths)

- [ ] **Step 1: Write the failing tests**

`test/db-migrations.test.ts`: add after the first test (ends line 30):

```ts
test('openDb adds history_checkpoints.origin to a save created before it existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabulist-legacy-origin-'));
  try {
    const path = join(dir, 'world.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE history_checkpoints (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL, turn_id TEXT, position INTEGER NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL)`);
    legacy.exec(`INSERT INTO history_checkpoints VALUES ('checkpoint:legacy', 'story:x', NULL, 1, '{}', '2026-01-01T00:00:00.000Z')`);
    legacy.close();

    const db = openDb(path);
    try {
      const columns = rows<{ name: string }>(db.prepare(`SELECT name FROM pragma_table_info('history_checkpoints')`).all());
      assert.ok(columns.some((column) => column.name === 'origin'));
      const legacyRow = db.prepare(`SELECT origin FROM history_checkpoints WHERE id = 'checkpoint:legacy'`).get() as {
        origin: string | null;
      };
      assert.equal(legacyRow.origin, null, 'legacy rows stay unlabelled rather than guessed');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

`test/mcp-upkeep-pg.test.ts`: add imports `import { applyMigrations } from '../src/db/pg.ts';`, `rollbackTool` from `'../src/mcp/tools-pg.ts'`, and a helper:

```ts
async function agentTurn(ctx: McpToolContext, text: string, world: Record<string, unknown>) {
  const proposal = await proposeTurnTool(ctx, { text });
  if (proposal.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${proposal.status}`);
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: `${text}, and it is written down.`, world });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  return out;
}

async function origins(db: Db, storyId: string): Promise<Array<string | null>> {
  const { rows } = await db.query<{ origin: string | null }>(
    `SELECT origin FROM history_checkpoints WHERE story_id = $1 ORDER BY position`,
    [storyId],
  );
  return rows.map((row) => row.origin);
}
```

```ts
test('PostgreSQL migration 009 adds history_checkpoints.origin to an existing schema', async (t) => {
  const ran = await withPg(async (db, schema) => {
    await db.query('ALTER TABLE history_checkpoints DROP COLUMN origin');
    await db.query('DELETE FROM migrations WHERE version = 9');
    await applyMigrations(db);
    const row = await db.one<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'history_checkpoints' AND column_name = 'origin'`,
      [schema],
    );
    assert.equal(Number(row?.count), 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL checkpoints record their origin, and a fork keeps it', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const first = await agentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
    assert.deepEqual(await origins(db, world.storyId), ['turn:agent', 'tool:consequences']);

    const server = await pgContext(db, 'stub-extractor');
    const proposal = await proposeTurnTool(server.ctx, { text: 'i check the door' });
    if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
    await commitNarrationTool(server.ctx, { resumeToken: proposal.resumeToken, prose: 'The door holds.' });
    assert.deepEqual(await origins(db, server.world.storyId), ['turn:server', 'tool:consequences']);

    const fork = await rollbackTool(ctx, { turnId: first.turnId });
    assert.deepEqual(await origins(db, fork.story!.id), ['turn:agent'], 'the fork copies the retained checkpoint with its origin');
  });
  if (!ran) t.skip('no Postgres configured');
});
```

`test/mcp-upkeep.test.ts`: add `rollbackTool` to the tools import and:

```ts
function sqliteOrigins(world: World): Array<string | null> {
  return (
    world.db.prepare('SELECT origin FROM history_checkpoints WHERE story_id = ? ORDER BY position').all(world.storyId) as Array<{
      origin: string | null;
    }>
  ).map((row) => row.origin);
}

async function sqliteAgentTurn(ctx: McpToolContext, text: string, world: Record<string, unknown>) {
  const proposal = await proposeTurnTool(ctx, { text });
  if (proposal.status !== 'awaiting-narration') throw new Error(`expected awaiting-narration, got ${proposal.status}`);
  const out = await commitNarrationTool(ctx, { resumeToken: proposal.resumeToken, prose: `${text}, and it is written down.`, world });
  if (out.status !== 'narrated') throw new Error(`expected narrated, got ${out.status}`);
  return out;
}

test('SQLite checkpoints record their origin, and a fork keeps it', async () => {
  const { world, ctx } = sqliteContext();
  const first = await sqliteAgentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
  assert.deepEqual(sqliteOrigins(world), ['turn:agent', 'tool:consequences']);
  const fork = rollbackTool(ctx, { turnId: first.turnId });
  assert.deepEqual(sqliteOrigins(world.withStory(fork.forkedStory!.id)), ['turn:agent']);
  world.close();

  const server = sqliteContext('stub-extractor');
  const proposal = await proposeTurnTool(server.ctx, { text: 'i check the door' });
  if (proposal.status !== 'awaiting-narration') throw new Error('expected awaiting-narration');
  await commitNarrationTool(server.ctx, { resumeToken: proposal.resumeToken, prose: 'The door holds.' });
  assert.deepEqual(sqliteOrigins(server.world), ['turn:server', 'tool:consequences']);
  server.world.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/db-migrations.test.ts test/mcp-upkeep.test.ts`
Expected: FAIL. `origin` column is missing, and `no such column: origin` appears in `sqliteOrigins`.

Run the PG file. Expected: FAIL with `column "origin" … does not exist`.

- [ ] **Step 3: Write minimal implementation**

Create `src/db/migrations-pg/009-checkpoint-origin.sql`:

```sql
-- turn:agent, turn:server or tool:<name>; NULL for checkpoints written before origins existed.
ALTER TABLE history_checkpoints ADD COLUMN IF NOT EXISTS origin TEXT;
```

`src/db/schema-pg.sql`: after `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),` (line 623) insert `  origin     TEXT,`.

`src/db/schema.sql`: after `  created_at TEXT NOT NULL,` (line 277) insert `  origin     TEXT,`.

`src/db/db.ts` `migrate`: after the closing `` `); `` of the `db.exec` block (line 128), add:

```ts
  addColumnIfMissing(db, 'history_checkpoints', 'origin', 'TEXT');
```

`src/domain/types.ts` `HistoryCheckpoint` (lines 399-406): after `createdAt: string;` add:

```ts
  /** `turn:agent`, `turn:server` or `tool:<name>`; null for checkpoints recorded before origins existed. */
  origin: string | null;
```

`src/store/history-pg.ts`:
- `CheckpointRow`: add `origin: string | null;`
- `checkpointOf`: add `origin: value.origin ?? null,` after `createdAt: isoOf(value.created_at),`
- `capture` (lines 75-77):

```ts
  async capture(turnId?: string, origin?: string): Promise<HistoryCheckpoint> {
    return this.transaction((queryable) => this.captureIn(queryable, turnId, origin));
  }
```

- `captureIn` signature (line 322): `private async captureIn(queryable: Queryable, turnId?: string, origin?: string): Promise<HistoryCheckpoint> {`. In the `checkpoint` literal add `origin: origin ?? null,` after `createdAt: …,`. Replace the INSERT with:

```ts
    await queryable.query(
      `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at, origin)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        checkpoint.id,
        this.storyId,
        checkpoint.turnId,
        checkpoint.position,
        key ? '{}' : JSON.stringify(checkpoint.state),
        checkpoint.createdAt,
        checkpoint.origin,
      ],
    );
```

`src/store/history.ts`:
- `CheckpointRow`: add `origin: string | null;`. In `toCheckpoint` add `origin: rowValue.origin ?? null,`.
- `capture(turnId?: string): HistoryCheckpoint {` → `capture(turnId?: string, origin?: string): HistoryCheckpoint {`. In the `checkpoint` literal add `origin: origin ?? null,`. Replace the INSERT with:

```ts
      this.db
        .prepare(
          `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at, origin) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          checkpoint.id,
          checkpoint.storyId,
          checkpoint.turnId,
          checkpoint.position,
          JSON.stringify(checkpoint.state),
          checkpoint.createdAt,
          checkpoint.origin,
        );
```

`src/loop/history-pg.ts` `recordAuthoringCheckpoint` (lines 96-114): add a fourth parameter `origin?: string,` and change `await transactionWorld.history.capture();` to `await transactionWorld.history.capture(undefined, origin);`.

`src/loop/history.ts`:

```ts
/** Records an immutable post-authoring snapshot without replacing a turn checkpoint. */
export function recordAuthoringCheckpoint(world: World, origin?: string): void {
  world.history.capture(undefined, origin);
}
```

and in `recordAuthoringCheckpointTx` add a third parameter `origin?: string,` and change `world.history.capture();` to `world.history.capture(undefined, origin);`.

`src/loop/commit-pg.ts`: `CommitTurnInput` (lines 43-50) add `origin?: string;`. Line 246 becomes `await w.history.capture(turn.id, input.origin ?? 'turn:server');`.

`src/loop/commit.ts`: `CommitTurnInput` (lines 22-29) add `origin?: string;`. Line 201 becomes `world.history.capture(turn.id, input.origin ?? 'turn:server');`.

`src/loop/engine-pg.ts` (commit call, lines 593-600) and `src/loop/engine.ts` (lines 516-523): after `threadId: plan.threadId,` add:

```ts
      origin: args.agentWorld === undefined ? 'turn:server' : 'turn:agent',
```

`src/application/play-pg.ts` `postCommit`: `recordAuthoringCheckpoint: (resolvedWorld, mutate) => recordAuthoringCheckpoint(db, resolvedWorld, mutate, 'tool:consequences'),`

`src/application/play.ts` `postCommit`: `recordAuthoringCheckpoint: (resolvedWorld, mutate) => recordAuthoringCheckpointTx(resolvedWorld, mutate, 'tool:consequences'),`

`src/loop/branch-pg.ts` `copyRetainedCheckpoints` (lines 564-568):

```ts
    await tx.query(
      `INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at, origin)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [`checkpoint:${randomUUID()}`, storyId, turnId, checkpoint.position, JSON.stringify(state), checkpoint.createdAt, checkpoint.origin],
    );
```

`src/loop/branch.ts` `copyRetainedCheckpoints` (lines 560-562):

```ts
    db
      .prepare(`INSERT INTO history_checkpoints (id, story_id, turn_id, position, state, created_at, origin) VALUES (?,?,?,?,?,?,?)`)
      .run(`checkpoint:${randomUUID()}`, storyId, turnId, checkpoint.position, JSON.stringify(state), checkpoint.createdAt, checkpoint.origin);
```

- [ ] **Step 4: Run tests to verify they pass**

Run `test/db-migrations.test.ts`, `test/mcp-upkeep.test.ts`, the PG upkeep file, `test/history.test.ts`, `test/branch.test.ts`, and (PG) `test/pg-history.test.ts`. Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations-pg/009-checkpoint-origin.sql src/db/schema-pg.sql src/db/schema.sql src/db/db.ts src/domain/types.ts src/store/history-pg.ts src/store/history.ts src/loop/history-pg.ts src/loop/history.ts src/loop/commit-pg.ts src/loop/commit.ts src/loop/engine-pg.ts src/loop/engine.ts src/application/play-pg.ts src/application/play.ts src/loop/branch-pg.ts src/loop/branch.ts test/db-migrations.test.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(history): record checkpoint origin"
```

---

### Task 8: Recent history in `get_state`

**Files:**
- Modify: `src/domain/types.ts` (after `HistoryCheckpoint`)
- Modify: `src/store/history-pg.ts` (after `checkpointsThrough`, lines 88-95), `src/store/history.ts` (after `checkpointsThrough`, lines 143-149)
- Modify: `src/mcp/tools-pg.ts` `getStateTool`, `src/mcp/tools.ts` `getStateTool`
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `history_checkpoints.origin` (Task 7).
- Produces:
  - `export interface CheckpointSummary { position: number; turnId: string | null; origin: string | null; createdAt: string }`
  - `HistoryStore.recent(limit = 10): Promise<CheckpointSummary[]>` (PG) / `CheckpointSummary[]` (SQLite), newest first, with no state read.
  - `getStateTool(...).recentHistory: CheckpointSummary[]`

- [ ] **Step 1: Write the failing tests**

`test/mcp-upkeep.test.ts`:

```ts
test('SQLite get_state lists recent checkpoints newest first with their origin', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const state = getStateTool(ctx);
  assert.deepEqual(
    state.recentHistory.map(({ origin, turnId }) => [origin, turnId]),
    [['tool:consequences', null], ['turn:agent', turn.turnId]],
  );
  world.close();
});
```

`test/mcp-upkeep-pg.test.ts`:

```ts
test('PostgreSQL get_state lists recent checkpoints newest first with their origin', async (t) => {
  const ran = await withPg(async (db) => {
    const { ctx } = await pgContext(db);
    const turn = await agentTurn(ctx, 'i warm the ink', {});
    const state = await getStateTool(ctx);
    assert.deepEqual(
      state.recentHistory.map(({ origin, turnId }) => [origin, turnId]),
      [['tool:consequences', null], ['turn:agent', turn.turnId]],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run both files. Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'map')`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/types.ts`, after `HistoryCheckpoint`:

```ts
/** Checkpoint metadata without its state, for "when did what change". */
export interface CheckpointSummary {
  position: number;
  turnId: string | null;
  origin: string | null;
  createdAt: string;
}
```

`src/store/history-pg.ts` (add `type CheckpointSummary` to the `'../domain/types.ts'` import), after `checkpointsThrough`:

```ts
  async recent(limit = 10): Promise<CheckpointSummary[]> {
    const { rows } = await this.db.query<Pick<CheckpointRow, 'position' | 'turn_id' | 'origin' | 'created_at'>>(
      `SELECT position, turn_id, origin, created_at FROM history_checkpoints
        WHERE story_id = $1 ORDER BY position DESC LIMIT $2`,
      [this.storyId, limit],
    );
    return rows.map((row) => ({
      position: Number(row.position),
      turnId: row.turn_id,
      origin: row.origin,
      createdAt: isoOf(row.created_at),
    }));
  }
```

`src/store/history.ts` (add `type CheckpointSummary` to its types import), after `checkpointsThrough`:

```ts
  recent(limit = 10): CheckpointSummary[] {
    return rows<Pick<CheckpointRow, 'position' | 'turn_id' | 'origin' | 'created_at'>>(
      this.db
        .prepare(
          `SELECT position, turn_id, origin, created_at FROM history_checkpoints
            WHERE story_id = ? ORDER BY position DESC LIMIT ?`,
        )
        .all(this.storyId, limit),
    ).map((row) => ({ position: Number(row.position), turnId: row.turn_id, origin: row.origin, createdAt: row.created_at }));
  }
```

`src/mcp/tools-pg.ts` `getStateTool`: after `upkeep: upkeepOf(ctx),` add `recentHistory: await world.history.recent(),`.
`src/mcp/tools.ts` `getStateTool`: after `upkeep: upkeepOf(ctx),` add `recentHistory: world.history.recent(),`.

Update the `get_state` description in both servers (`server-pg.ts:311-312`, `server.ts:304-305`) to `'Session position (scene/turn), entity/edge counts, pending consequences, token usage, upkeep, and recent history checkpoints with their origin for the current story.'`.

- [ ] **Step 4: Run tests to verify they pass**

Run both files, plus `test/mcp-tools.test.ts` (its `getStateTool` shape test). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/store/history-pg.ts src/store/history.ts src/mcp/tools-pg.ts src/mcp/tools.ts src/mcp/server-pg.ts src/mcp/server.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(mcp): show recent checkpoint origins in get_state"
```

---

### Task 9: Granular tools `record_fact`, `open_thread`, `add_consequence`

**Files:**
- Modify: `src/mcp/upkeep.ts` (add `triggerInput`)
- Modify: `src/mcp/tools-pg.ts` (after `updateThreadTool`, lines 848-858), `src/mcp/tools.ts` (after `updateThreadTool`, lines 794-803)
- Modify: `src/mcp/server-pg.ts` (after the `update_thread` registration, ends line 647), `src/mcp/server.ts` (after `update_thread`, ends line 637)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `recordAuthoringCheckpoint(…, origin)` (Task 7), `entityReference(world, value, tool)` (`tools-pg.ts:388`, `tools.ts:339`), `world.chronicle.addFact/setKnowledge`, `world.threads.create`, `world.consequences.enqueue`.
- Produces:
  - `recordFactTool(ctx, { text: string; knownBy?: string[]; suspectedBy?: string[] })` → `{ fact: Fact; knownBy: EntityId[]; suspectedBy: EntityId[] }`
  - `openThreadTool(ctx, { title: string; stakes?: string; parties: string[]; tension?: number; resolutions?: string[] })` → `Thread`
  - `addConsequenceTool(ctx, { causeEventId: string; actorId: string; action: string; trigger: Trigger; visibility: Visibility; significance?: number })` → `Consequence`
  - Checkpoint origins `tool:record_fact`, `tool:open_thread`, `tool:add_consequence`
  - `export const triggerInput` (zod, `upkeep.ts`)

- [ ] **Step 1: Write the failing tests**

`test/mcp-upkeep.test.ts` (import `recordFactTool`, `openThreadTool`, `addConsequenceTool` from `'../src/mcp/tools.ts'`):

```ts
test('SQLite granular tools write one checkpoint each, labelled by tool', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const recorded = recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['Brother Anselm'], suspectedBy: ['char:sister-oria'] });
  assert.deepEqual(recorded.knownBy, ['char:brother-anselm'], 'names resolve like the other authoring tools');
  assert.ok(world.chronicle.knowledgeOf('char:sister-oria').some((k) => k.level === 'suspects' && /takes coin/.test(k.text)));
  const thread = openThreadTool(ctx, { title: 'The garrison purse', parties: ['char:captain-sered'], tension: 2 });
  assert.equal(thread.tension, 1, 'tension is clamped to 0..1');
  assert.deepEqual(thread.resolutions, ['unresolved', 'escalates', 'fades']);
  const event = world.chronicle.events({ limit: 1 })[0]!;
  const consequence = addConsequenceTool(ctx, {
    causeEventId: event.id,
    actorId: 'char:captain-sered',
    action: 'Sered audits the ferry tolls.',
    trigger: { kind: 'after-scenes', scenes: 1 },
    visibility: 'offscreen-discoverable',
  });
  assert.equal(consequence.maturity, 'pending');
  assert.throws(
    () => addConsequenceTool(ctx, { causeEventId: 'ev:missing', actorId: 'char:captain-sered', action: 'x', trigger: { kind: 'immediate' }, visibility: 'onscreen' }),
    /no event "ev:missing"/,
  );
  assert.throws(() => recordFactTool(ctx, { text: 'x', knownBy: ['char:nobody'] }), /no entity/);
  assert.deepEqual(sqliteOrigins(world), ['turn:agent', 'tool:consequences', 'tool:record_fact', 'tool:open_thread', 'tool:add_consequence']);
  assert.ok(turn.turnId);
  world.close();
});

test('SQLite rollback and fork across an agent turn and a record_fact write restore exactly', async () => {
  const { world, ctx } = sqliteContext();
  const first = await sqliteAgentTurn(ctx, 'i warm the ink', {
    entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman' }],
    factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'] }],
  });
  recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['char:brother-anselm'] });
  await sqliteAgentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'loc:far-bank', type: 'Location', name: 'The Far Bank' }] });

  const fork = rollbackTool(ctx, { turnId: first.turnId });
  const forked = world.withStory(fork.forkedStory!.id);
  assert.ok(forked.graph.get('char:ferryman-oll'));
  assert.ok(forked.chronicle.facts().some((f) => f.text === 'The ferry runs at night.'));
  assert.ok(!forked.chronicle.facts().some((f) => f.text.startsWith('Oll takes coin')), 'the later tool write is not in the fork');
  assert.equal(forked.graph.get('loc:far-bank'), undefined);

  rollbackTool(ctx, { turnId: first.turnId, mode: 'destructive' });
  assert.ok(world.graph.get('char:ferryman-oll'));
  assert.ok(!world.chronicle.facts().some((f) => f.text.startsWith('Oll takes coin')));
  assert.equal(world.graph.get('loc:far-bank'), undefined);
  assert.deepEqual(sqliteOrigins(world), ['turn:agent']);
  world.close();
});
```

`test/mcp-upkeep-pg.test.ts` (import the three tools from `'../src/mcp/tools-pg.ts'`):

```ts
test('PostgreSQL granular tools write one checkpoint each, labelled by tool', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', {});
    const recorded = await recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['Brother Anselm'], suspectedBy: ['char:sister-oria'] });
    assert.deepEqual(recorded.knownBy, ['char:brother-anselm']);
    const thread = await openThreadTool(ctx, { title: 'The garrison purse', parties: ['char:captain-sered'], tension: 2 });
    assert.equal(thread.tension, 1);
    const event = (await world.chronicle.events({ limit: 1 }))[0]!;
    const consequence = await addConsequenceTool(ctx, {
      causeEventId: event.id,
      actorId: 'char:captain-sered',
      action: 'Sered audits the ferry tolls.',
      trigger: { kind: 'after-scenes', scenes: 1 },
      visibility: 'offscreen-discoverable',
    });
    assert.equal(consequence.maturity, 'pending');
    await assert.rejects(
      () => addConsequenceTool(ctx, { causeEventId: 'ev:missing', actorId: 'char:captain-sered', action: 'x', trigger: { kind: 'immediate' }, visibility: 'onscreen' }),
      /no event "ev:missing"/,
    );
    assert.deepEqual(await origins(db, world.storyId), ['turn:agent', 'tool:consequences', 'tool:record_fact', 'tool:open_thread', 'tool:add_consequence']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL rollback and fork across an agent turn and a record_fact write restore exactly', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const first = await agentTurn(ctx, 'i warm the ink', {
      entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll the Ferryman' }],
      factsLearned: [{ text: 'The ferry runs at night.', knownBy: ['char:brother-anselm'] }],
    });
    await recordFactTool(ctx, { text: 'Oll takes coin from the garrison.', knownBy: ['char:brother-anselm'] });
    await agentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'loc:far-bank', type: 'Location', name: 'The Far Bank' }] });

    const fork = await rollbackTool(ctx, { turnId: first.turnId });
    const forked = await World.forStory(db, fork.story!.id);
    assert.ok(await forked.graph.get('char:ferryman-oll'));
    assert.ok((await forked.chronicle.facts()).some((f) => f.text === 'The ferry runs at night.'));
    assert.ok(!(await forked.chronicle.facts()).some((f) => f.text.startsWith('Oll takes coin')));
    assert.equal(await forked.graph.get('loc:far-bank'), undefined);

    await rollbackTool(ctx, { turnId: first.turnId, mode: 'destructive' });
    assert.ok(await world.graph.get('char:ferryman-oll'));
    assert.ok(!(await world.chronicle.facts()).some((f) => f.text.startsWith('Oll takes coin')));
    assert.equal(await world.graph.get('loc:far-bank'), undefined);
    assert.deepEqual(await origins(db, world.storyId), ['turn:agent']);
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run both files. Expected: FAIL with `does not provide an export named 'recordFactTool'`.

- [ ] **Step 3: Write minimal implementation**

`src/mcp/upkeep.ts`, append:

```ts
export const triggerInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }),
  z.object({ kind: z.literal('after-scenes'), scenes: z.number().int().min(1) }),
  z.object({ kind: z.literal('on-enter'), locationId: z.string() }),
  z.object({ kind: z.literal('on-learn'), entityId: z.string(), factId: z.string() }),
]);
```

`src/mcp/tools-pg.ts`: extend the domain types import with `Trigger, Visibility`, and add after `updateThreadTool`:

```ts
/** `record_fact`. A fact and exactly who knows or suspects it, for corrections between turns. */
export async function recordFactTool(
  ctx: McpToolContext,
  args: { text: string; knownBy?: string[]; suspectedBy?: string[] },
) {
  const text = args.text.trim();
  if (!text) throw new Error('record_fact: text is required');
  const world = await ctx.world();
  return recordAuthoringCheckpoint(
    ctx.db,
    world,
    async (transactionWorld) => {
      const knownBy: EntityId[] = [];
      for (const value of args.knownBy ?? []) knownBy.push(await entityReference(transactionWorld, value, 'record_fact'));
      const suspectedBy: EntityId[] = [];
      for (const value of args.suspectedBy ?? []) suspectedBy.push(await entityReference(transactionWorld, value, 'record_fact'));
      const { scene } = await transactionWorld.session.get();
      const fact = await transactionWorld.chronicle.addFact(text, scene);
      for (const id of knownBy) await transactionWorld.chronicle.setKnowledge(fact.id, id, 'knows', scene);
      for (const id of suspectedBy) await transactionWorld.chronicle.setKnowledge(fact.id, id, 'suspects', scene);
      return { fact, knownBy, suspectedBy };
    },
    'tool:record_fact',
  );
}

/** `open_thread`. Opens a narrative thread the prose set up but no turn recorded. */
export async function openThreadTool(
  ctx: McpToolContext,
  args: { title: string; stakes?: string; parties: string[]; tension?: number; resolutions?: string[] },
) {
  const title = args.title.trim();
  if (!title) throw new Error('open_thread: title is required');
  const world = await ctx.world();
  return recordAuthoringCheckpoint(
    ctx.db,
    world,
    async (transactionWorld) => {
      const parties: EntityId[] = [];
      for (const value of args.parties) parties.push(await entityReference(transactionWorld, value, 'open_thread'));
      return transactionWorld.threads.create({
        title,
        stakes: args.stakes ?? '',
        tension: Math.max(0, Math.min(1, args.tension ?? 0.4)),
        parties,
        resolutions: args.resolutions?.length ? args.resolutions : ['unresolved', 'escalates', 'fades'],
        status: 'open',
        createdScene: (await transactionWorld.session.get()).scene,
      });
    },
    'tool:open_thread',
  );
}

/** `add_consequence`. A reaction the prose sets up that propagation over the graph cannot infer. */
export async function addConsequenceTool(
  ctx: McpToolContext,
  args: { causeEventId: string; actorId: string; action: string; trigger: Trigger; visibility: Visibility; significance?: number },
) {
  const action = args.action.trim();
  if (!action) throw new Error('add_consequence: action is required');
  const world = await ctx.world();
  return recordAuthoringCheckpoint(
    ctx.db,
    world,
    async (transactionWorld) => {
      const { rowCount } = await transactionWorld.db.query(`SELECT 1 FROM events WHERE story_id = $1 AND id = $2`, [
        transactionWorld.storyId,
        args.causeEventId,
      ]);
      if (!rowCount) throw new Error(`add_consequence: no event ${JSON.stringify(args.causeEventId)} in this story`);
      const actorId = await entityReference(transactionWorld, args.actorId, 'add_consequence');
      return transactionWorld.consequences.enqueue({
        causeEventId: args.causeEventId,
        trigger: args.trigger,
        actorId,
        action,
        visibility: args.visibility,
        maturity: args.trigger.kind === 'immediate' ? 'ripening' : 'pending',
        depth: 1,
        significance: Math.max(0, Math.min(1, args.significance ?? 0.5)),
        createdScene: (await transactionWorld.session.get()).scene,
      });
    },
    'tool:add_consequence',
  );
}
```

`src/mcp/tools.ts`: extend the domain types import with `Trigger, Visibility`, add `import { tx } from '../db/db.ts';`, and add after `updateThreadTool`. The SQLite build writes first and then captures, following this file's pattern (`recordAuthoringCheckpoint(world, origin)`); `tx` makes the write and the checkpoint atomic:

```ts
/** `record_fact`. A fact and exactly who knows or suspects it, for corrections between turns. */
export function recordFactTool(ctx: McpToolContext, args: { text: string; knownBy?: string[]; suspectedBy?: string[] }) {
  const text = args.text.trim();
  if (!text) throw new Error('record_fact: text is required');
  const world = ctx.world();
  return tx(world.db, () => {
    const knownBy = (args.knownBy ?? []).map((value) => entityReference(world, value, 'record_fact'));
    const suspectedBy = (args.suspectedBy ?? []).map((value) => entityReference(world, value, 'record_fact'));
    const { scene } = world.session.get();
    const fact = world.chronicle.addFact(text, scene);
    for (const id of knownBy) world.chronicle.setKnowledge(fact.id, id, 'knows', scene);
    for (const id of suspectedBy) world.chronicle.setKnowledge(fact.id, id, 'suspects', scene);
    recordAuthoringCheckpoint(world, 'tool:record_fact');
    return { fact, knownBy, suspectedBy };
  });
}

/** `open_thread`. Opens a narrative thread the prose set up but no turn recorded. */
export function openThreadTool(
  ctx: McpToolContext,
  args: { title: string; stakes?: string; parties: string[]; tension?: number; resolutions?: string[] },
) {
  const title = args.title.trim();
  if (!title) throw new Error('open_thread: title is required');
  const world = ctx.world();
  return tx(world.db, () => {
    const parties = args.parties.map((value) => entityReference(world, value, 'open_thread'));
    const thread = world.threads.create({
      title,
      stakes: args.stakes ?? '',
      tension: Math.max(0, Math.min(1, args.tension ?? 0.4)),
      parties,
      resolutions: args.resolutions?.length ? args.resolutions : ['unresolved', 'escalates', 'fades'],
      status: 'open',
      createdScene: world.session.get().scene,
    });
    recordAuthoringCheckpoint(world, 'tool:open_thread');
    return thread;
  });
}

/** `add_consequence`. A reaction the prose sets up that propagation over the graph cannot infer. */
export function addConsequenceTool(
  ctx: McpToolContext,
  args: { causeEventId: string; actorId: string; action: string; trigger: Trigger; visibility: Visibility; significance?: number },
) {
  const action = args.action.trim();
  if (!action) throw new Error('add_consequence: action is required');
  const world = ctx.world();
  return tx(world.db, () => {
    const cause = world.db.prepare(`SELECT 1 FROM events WHERE story_id = ? AND id = ?`).get(world.storyId, args.causeEventId);
    if (!cause) throw new Error(`add_consequence: no event ${JSON.stringify(args.causeEventId)} in this story`);
    const consequence = world.consequences.enqueue({
      causeEventId: args.causeEventId,
      trigger: args.trigger,
      actorId: entityReference(world, args.actorId, 'add_consequence'),
      action,
      visibility: args.visibility,
      maturity: args.trigger.kind === 'immediate' ? 'ripening' : 'pending',
      depth: 1,
      significance: Math.max(0, Math.min(1, args.significance ?? 0.5)),
      createdScene: world.session.get().scene,
    });
    recordAuthoringCheckpoint(world, 'tool:add_consequence');
    return consequence;
  });
}
```

`src/mcp/server-pg.ts`: import `triggerInput` from `'./upkeep.ts'` and `addConsequenceTool, openThreadTool, recordFactTool` from `'./tools-pg.ts'`. After the `update_thread` registration add:

```ts
  server.registerTool(
    'record_fact',
    {
      description:
        'Record a fact between turns and exactly who knows it and who only suspects it. For correcting what a turn missed; a turn’s own facts go in commit_narration’s world.',
      inputSchema: {
        text: z.string().min(1).max(MAX_FREE_TEXT_CHARS),
        knownBy: z.array(z.string()).optional().describe('Entity ids or exact names of who knows it.'),
        suspectedBy: z.array(z.string()).optional().describe('Entity ids or exact names of who only suspects it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, knownBy, suspectedBy }) => toolResult(await recordFactTool(ctx, { text, knownBy, suspectedBy })),
  );

  server.registerTool(
    'open_thread',
    {
      description: 'Open a narrative thread between turns: a question the story has raised and not yet answered.',
      inputSchema: {
        title: z.string().min(1).max(MAX_FREE_TEXT_CHARS),
        stakes: z.string().max(MAX_FREE_TEXT_CHARS).optional(),
        parties: z.array(z.string()).describe('Entity ids or exact names of who it involves.'),
        tension: z.number().min(0).max(1).optional(),
        resolutions: z.array(z.string()).optional().describe('Possible outcomes; defaults to unresolved/escalates/fades.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, stakes, parties, tension, resolutions }) =>
      toolResult(await openThreadTool(ctx, { title, stakes, parties, tension, resolutions })),
  );

  server.registerTool(
    'add_consequence',
    {
      description:
        'Queue a reaction to a recorded event that graph propagation would not infer. Most consequences are seeded automatically after each commit.',
      inputSchema: {
        causeEventId: z.string().describe('An event id from this story (get_book / fetch).'),
        actorId: z.string().describe('Entity id or exact name of who reacts.'),
        action: z.string().min(1).max(MAX_FREE_TEXT_CHARS),
        trigger: triggerInput,
        visibility: z.enum(['onscreen', 'offscreen-discoverable', 'offscreen-hidden']),
        significance: z.number().min(0).max(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ causeEventId, actorId, action, trigger, visibility, significance }) =>
      toolResult(await addConsequenceTool(ctx, { causeEventId, actorId, action, trigger, visibility, significance })),
  );
```

`src/mcp/server.ts`: the same three registrations with the same imports (from `'./tools.ts'`), using `toolResult(recordFactTool(ctx, …))`, `toolResult(openThreadTool(ctx, …))` and `toolResult(addConsequenceTool(ctx, …))` (no `await`). Check that `MAX_FREE_TEXT_CHARS` is imported from `'../server/contracts.ts'` in `server.ts`; add it if it is not.

- [ ] **Step 4: Run tests to verify they pass**

Run both files and `test/mcp-e2e.test.ts` (the annotations/output-schema test covers the new tools). Expected: PASS. Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/upkeep.ts src/mcp/tools-pg.ts src/mcp/tools.ts src/mcp/server-pg.ts src/mcp/server.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(mcp): add record_fact, open_thread and add_consequence tools"
```

---

### Task 10: `replace_turn_prose` with `world`

**Files:**
- Modify: `src/store/history-pg.ts` (after `restoreTurn`, ends line 217), `src/store/history.ts` (after `restoreTurn`, ends line 249)
- Modify: `src/loop/commit-pg.ts:211-250` (split `commitTurn`; add `recommitTurn`), `src/loop/commit.ts` (add `recommitTurn` after `commitTurn`)
- Modify: `src/mcp/tools-pg.ts:782-794`, `src/mcp/tools.ts:729-737` (`replaceTurnProseTool`)
- Modify: `src/mcp/server-pg.ts:583-592`, `src/mcp/server.ts:573-582` (`replace_turn_prose` registration)
- Test: `test/mcp-upkeep.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `agentDelta` (Task 4), `CommitTurnInput.origin` (Task 7), `worldDeltaInput`, `appliedCounts` (Task 5).
- Produces:
  - `HistoryStore.rewindBefore(turnId: string): Promise<void>` (PG) / `void` (SQLite). This restores the checkpoint before the turn and removes the turn and its later checkpoints. It throws when any later checkpoint has an origin other than `tool:consequences`, or when there is no earlier checkpoint.
  - `export type RecommitResult = { kind: 'committed'; commit: CommitResult; turn: Turn; delta: Delta; validation: ValidationResult } | { kind: 'blocked'; validation: ValidationResult }` (both commit files)
  - `recommitTurn(db: Db, world: World, turnId: string, bookProse: string, agentWorld: unknown): Promise<RecommitResult>` (PG) / `recommitTurn(world, turnId, bookProse, agentWorld): RecommitResult` (SQLite)
  - `replaceTurnProseTool(ctx, { id, prose, stateMode?: 'preserve', world?: unknown })` → with agent upkeep and `world`: `{ status: 'replaced', stateMode: 'reapplied', upkeep, replacedTurnId, turn, applied, dropped, newThreads }` or `{ status: 'blocked', upkeep, nextStep, issues }`. Otherwise it keeps today's `{ stateMode: 'preserve', turn }` plus `upkeep` and an optional `warning`.

- [ ] **Step 1: Write the failing tests**

`test/mcp-upkeep.test.ts` (import `replaceTurnProseTool`):

```ts
test('SQLite replace_turn_prose with world re-applies the latest turn from the checkpoint before it', async () => {
  const { world, ctx } = sqliteContext();
  await sqliteAgentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
  const second = await sqliteAgentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'item:brass-key', type: 'Item', name: 'A Brass Key' }] });
  const out = replaceTurnProseTool(ctx, {
    id: second.turnId,
    prose: 'Anselm checks the door and finds a lantern.',
    world: { entityUpserts: [{ id: 'item:lantern', type: 'Item', name: 'A Hooded Lantern' }] },
  });
  if (out.status !== 'replaced') throw new Error(`expected replaced, got ${out.status}`);
  assert.equal(out.stateMode, 'reapplied');
  assert.equal(out.replacedTurnId, second.turnId);
  assert.equal(world.graph.get('item:brass-key'), undefined, 'the old delta is gone');
  assert.ok(world.graph.get('item:lantern'));
  assert.ok(world.graph.get('char:ferryman-oll'), 'the earlier turn stands');
  const turns = world.chronicle.turns();
  assert.equal(turns.length, 2);
  assert.equal(turns.at(-1)!.bookProse, 'Anselm checks the door and finds a lantern.');
  assert.deepEqual(sqliteOrigins(world), ['turn:agent', 'tool:consequences', 'turn:agent']);
  world.close();
});

test('SQLite replace_turn_prose with world refuses when a later edit exists, and changes nothing', async () => {
  const { world, ctx } = sqliteContext();
  await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const second = await sqliteAgentTurn(ctx, 'i check the door', {});
  recordFactTool(ctx, { text: 'The latch sticks.' });
  const before = sqliteOrigins(world);
  assert.throws(
    () => replaceTurnProseTool(ctx, { id: second.turnId, prose: 'Other prose.', world: {} }),
    /later turns or edits/,
  );
  assert.deepEqual(sqliteOrigins(world), before);
  assert.notEqual(world.chronicle.getTurn(second.turnId)?.bookProse, 'Other prose.');
  world.close();
});

test('SQLite replace_turn_prose without world keeps the delta and warns under agent upkeep', async () => {
  const { world, ctx } = sqliteContext();
  const turn = await sqliteAgentTurn(ctx, 'i warm the ink', {});
  const out = replaceTurnProseTool(ctx, { id: turn.turnId, prose: 'New prose.' });
  assert.equal(out.stateMode, 'preserve');
  assert.equal(out.upkeep, 'agent');
  assert.match(out.warning ?? '', /may no longer match/);
  world.close();
});
```

`test/mcp-upkeep-pg.test.ts` (import `replaceTurnProseTool`):

```ts
test('PostgreSQL replace_turn_prose with world re-applies the latest turn from the checkpoint before it', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', { entityUpserts: [{ id: 'char:ferryman-oll', type: 'Character', name: 'Oll' }] });
    const second = await agentTurn(ctx, 'i check the door', { entityUpserts: [{ id: 'item:brass-key', type: 'Item', name: 'A Brass Key' }] });
    const out = await replaceTurnProseTool(ctx, {
      id: second.turnId,
      prose: 'Anselm checks the door and finds a lantern.',
      world: { entityUpserts: [{ id: 'item:lantern', type: 'Item', name: 'A Hooded Lantern' }] },
    });
    if (out.status !== 'replaced') throw new Error(`expected replaced, got ${out.status}`);
    assert.equal(await world.graph.get('item:brass-key'), undefined);
    assert.ok(await world.graph.get('item:lantern'));
    assert.ok(await world.graph.get('char:ferryman-oll'));
    const turns = await world.chronicle.turns();
    assert.equal(turns.length, 2);
    assert.equal(turns.at(-1)!.bookProse, 'Anselm checks the door and finds a lantern.');
    assert.deepEqual(await origins(db, world.storyId), ['turn:agent', 'tool:consequences', 'turn:agent']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PostgreSQL replace_turn_prose with world refuses when a later edit exists, and changes nothing', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    await agentTurn(ctx, 'i warm the ink', {});
    const second = await agentTurn(ctx, 'i check the door', {});
    await recordFactTool(ctx, { text: 'The latch sticks.' });
    const before = await origins(db, world.storyId);
    await assert.rejects(
      () => replaceTurnProseTool(ctx, { id: second.turnId, prose: 'Other prose.', world: {} }),
      /later turns or edits/,
    );
    assert.deepEqual(await origins(db, world.storyId), before);
    assert.notEqual((await world.chronicle.getTurn(second.turnId))?.bookProse, 'Other prose.');
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run both files. Expected: FAIL. `out.status` is undefined (the current tool returns `{ stateMode, turn }`), so `expected replaced, got undefined`. The refusal test fails with `Missing expected exception`.

- [ ] **Step 3: Write minimal implementation**

`src/store/history-pg.ts`, after `restoreTurn`:

```ts
  /**
   * Restores the checkpoint just before `turnId` and removes that turn and its
   * later history so it can be committed again. Only the latest turn qualifies,
   * since a later turn or authoring edit would otherwise be silently discarded.
   */
  async rewindBefore(turnId: string): Promise<void> {
    await this.transaction(async (queryable) => {
      await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.storyId]);
      const { rows: turns } = await queryable.query<{ history_position: number | null }>(
        `SELECT history_position FROM turns WHERE id = $1 AND story_id = $2`,
        [turnId, this.storyId],
      );
      const position = turns[0]?.history_position;
      if (position == null) throw new Error(`rewind: turn ${turnId} has no exact history`);
      const { rows: later } = await queryable.query<{ origin: string | null }>(
        `SELECT origin FROM history_checkpoints WHERE story_id = $1 AND position > $2`,
        [this.storyId, position],
      );
      if (later.some((checkpoint) => checkpoint.origin !== 'tool:consequences'))
        throw new Error(`rewind: turn ${turnId} has later turns or edits; roll back to it first`);
      const { rows: bases } = await queryable.query<CheckpointRow>(
        `SELECT * FROM history_checkpoints WHERE story_id = $1 AND position < $2 ORDER BY position DESC LIMIT 1`,
        [this.storyId, position],
      );
      if (!bases[0]) throw new Error(`rewind: turn ${turnId} has no earlier checkpoint to rewind to`);

      const key = await this.privateKey(queryable);
      await this.restoreLayout(queryable, await this.readState(queryable, bases[0], key));
      await queryable.query(`DELETE FROM turns WHERE story_id = $1 AND history_position >= $2`, [this.storyId, position]);
      await queryable.query(`DELETE FROM scene_segments WHERE story_id = $1 AND start_position > $2`, [
        this.storyId,
        position,
      ]);
      await queryable.query(
        `DELETE FROM encrypted_story_values
          WHERE story_id = $1 AND table_name = 'history_checkpoints'
            AND record_id IN (SELECT id FROM history_checkpoints WHERE story_id = $1 AND position >= $2)`,
        [this.storyId, position],
      );
      await queryable.query(`DELETE FROM history_checkpoints WHERE story_id = $1 AND position >= $2`, [
        this.storyId,
        position,
      ]);
      await this.reconcileContinuation(queryable, position);
      await this.invalidateStaleSummaries(queryable, key);
    });
  }
```

`src/store/history.ts`, after `restoreTurn`:

```ts
  /**
   * Restores the checkpoint just before `turnId` and removes that turn and its
   * later history so it can be committed again. Only the latest turn qualifies,
   * since a later turn or authoring edit would otherwise be silently discarded.
   */
  rewindBefore(turnId: string): void {
    tx(this.db, () => {
      const turn = row<{ history_position: number | null }>(
        this.db.prepare(`SELECT history_position FROM turns WHERE id = ? AND story_id = ?`).get(turnId, this.storyId),
      );
      const position = turn?.history_position;
      if (position == null) throw new Error(`rewind: turn ${turnId} has no exact history`);
      const later = rows<{ origin: string | null }>(
        this.db.prepare(`SELECT origin FROM history_checkpoints WHERE story_id = ? AND position > ?`).all(this.storyId, position),
      );
      if (later.some((checkpoint) => checkpoint.origin !== 'tool:consequences'))
        throw new Error(`rewind: turn ${turnId} has later turns or edits; roll back to it first`);
      const base = row<CheckpointRow>(
        this.db
          .prepare(`SELECT * FROM history_checkpoints WHERE story_id = ? AND position < ? ORDER BY position DESC LIMIT 1`)
          .get(this.storyId, position),
      );
      if (!base) throw new Error(`rewind: turn ${turnId} has no earlier checkpoint to rewind to`);

      this.restoreLayout(toCheckpoint(base).state);
      this.db.prepare(`DELETE FROM turns WHERE story_id = ? AND history_position >= ?`).run(this.storyId, position);
      this.db.prepare(`DELETE FROM scene_segments WHERE story_id = ? AND start_position > ?`).run(this.storyId, position);
      this.db.prepare(`DELETE FROM history_checkpoints WHERE story_id = ? AND position >= ?`).run(this.storyId, position);
      this.reconcileContinuation(position);
      this.invalidateStaleSummaries();
    });
  }
```

`src/loop/commit-pg.ts`: add imports `import type { ValidationResult } from './validate-pg.ts';` and `import { agentDelta } from './roles-pg.ts';`. Replace `commitTurn` (lines 211-250) with:

```ts
export async function commitTurn(db: Db, world: World, input: CommitTurnInput): Promise<CommitTurnResult> {
  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
    const w = new World({
      db: client,
      storyId: world.storyId,
      sources: world.sources,
      imagesDir: world.illustrations.imagesDir,
      crypto: world.crypto,
    });
    return commitTurnOn(w, input);
  });
}

/** `commitTurn`'s body, for a caller already holding the story lock on a transaction world. */
async function commitTurnOn(w: World, input: CommitTurnInput): Promise<CommitTurnResult> {
  const session = await w.session.get();
  const layout = await storyLayout(w);
  const previous = layout.turns.at(-1)?.source;
  const activeScene = layout.turns.at(-1)?.scene ?? layout.currentScene;
  const advancingFromEmptyScene = previous && session.scene > activeScene;
  const scene = advancingFromEmptyScene ? previous.scene + 1 : (previous?.scene ?? session.scene);
  const turnNo = advancingFromEmptyScene ? 1 : (previous?.turn ?? session.turn) + 1;
  const commit = await applyDelta(w, input.delta, scene, turnNo, 'onscreen');
  const turn = await w.chronicle.addTurn({
    scene,
    turn: turnNo,
    rawInput: input.rawInput,
    intent: input.intent,
    delta: input.delta,
    bookProse: input.bookProse,
    pinned: false,
    meta: input.meta,
  });
  if (input.threadId) await w.threads.adjustTension(input.threadId, 0.05);
  if (input.delta.sceneAdvance) {
    await w.session.set({ scene: activeScene + 1, turn: 0 });
    await w.chronicle.upsertScene(activeScene + 1, {}, `raw:${scene + 1}`);
  } else {
    await w.session.set({ turn: turnNo });
  }
  await w.history.capture(turn.id, input.origin ?? 'turn:server');
  return { commit, turn };
}

export type RecommitResult =
  | { kind: 'committed'; commit: CommitResult; turn: Turn; delta: Delta; validation: ValidationResult }
  | { kind: 'blocked'; validation: ValidationResult };

/**
 * Re-commits the latest turn with new prose and an agent world delta, from the
 * checkpoint before it: the same result as rolling back one turn and committing again.
 */
export async function recommitTurn(
  db: Db,
  world: World,
  turnId: string,
  bookProse: string,
  agentWorld: unknown,
): Promise<RecommitResult> {
  const rejected: { validation?: ValidationResult } = {};
  try {
    return await db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
      const w = new World({
        db: client,
        storyId: world.storyId,
        sources: world.sources,
        imagesDir: world.illustrations.imagesDir,
        crypto: world.crypto,
      });
      const old = await w.chronicle.getTurn(turnId);
      if (!old) throw new Error(`replace_turn_prose: no turn ${turnId}`);
      await w.history.rewindBefore(turnId);
      // Validated after the rewind so ids only the replaced delta introduced do not count as known.
      const { delta, validation } = await agentDelta(w, agentWorld, bookProse);
      if (!validation.ok) {
        rejected.validation = validation;
        throw new Error('delta failed validation');
      }
      const { commit, turn } = await commitTurnOn(w, {
        rawInput: old.rawInput,
        intent: old.intent,
        delta,
        bookProse,
        meta: old.meta,
        origin: 'turn:agent',
      });
      if (old.pinned) await w.chronicle.setPinned(turn.id, true);
      return { kind: 'committed' as const, commit, turn, delta, validation };
    });
  } catch (error) {
    if (rejected.validation) return { kind: 'blocked', validation: rejected.validation };
    throw error;
  }
}
```

`src/loop/commit.ts`: add imports `import type { ValidationResult } from './validate.ts';` and `import { agentDelta } from './roles.ts';`, and after `commitTurn` add:

```ts
export type RecommitResult =
  | { kind: 'committed'; commit: CommitResult; turn: Turn; delta: Delta; validation: ValidationResult }
  | { kind: 'blocked'; validation: ValidationResult };

/**
 * Re-commits the latest turn with new prose and an agent world delta, from the
 * checkpoint before it: the same result as rolling back one turn and committing again.
 */
export function recommitTurn(world: World, turnId: string, bookProse: string, agentWorld: unknown): RecommitResult {
  const rejected: { validation?: ValidationResult } = {};
  try {
    return tx(world.db, () => {
      const old = world.chronicle.getTurn(turnId);
      if (!old) throw new Error(`replace_turn_prose: no turn ${turnId}`);
      world.history.rewindBefore(turnId);
      // Validated after the rewind so ids only the replaced delta introduced do not count as known.
      const { delta, validation } = agentDelta(world, agentWorld, bookProse);
      if (!validation.ok) {
        rejected.validation = validation;
        throw new Error('delta failed validation');
      }
      const { commit, turn } = commitTurn(world, {
        rawInput: old.rawInput,
        intent: old.intent,
        delta,
        bookProse,
        meta: old.meta,
        origin: 'turn:agent',
      });
      if (old.pinned) world.chronicle.setPinned(turn.id, true);
      return { kind: 'committed' as const, commit, turn, delta, validation };
    });
  } catch (error) {
    if (rejected.validation) return { kind: 'blocked', validation: rejected.validation };
    throw error;
  }
}
```

`src/mcp/tools-pg.ts`: add `import { recommitTurn } from '../loop/commit-pg.ts';`. Replace `replaceTurnProseTool` (lines 782-794) with:

```ts
/** Author-controlled exact prose replacement; with agent upkeep and `world`, re-applies the turn's delta too. */
export async function replaceTurnProseTool(
  ctx: McpToolContext,
  args: { id: string; prose: string; stateMode?: 'preserve'; world?: unknown },
) {
  const world = await ctx.world();
  if (!args.prose.trim()) throw new Error('replace_turn_prose: prose is required');
  if (args.stateMode && args.stateMode !== 'preserve')
    throw new Error('replace_turn_prose: only stateMode "preserve" is supported');
  const upkeep = upkeepOf(ctx);
  if (upkeep === 'agent' && args.world !== undefined) {
    const result = await recommitTurn(ctx.db, world, args.id, args.prose, args.world);
    if (result.kind === 'blocked') {
      return {
        status: 'blocked' as const,
        upkeep,
        nextStep: 'Nothing was changed. Fix what the issues name, then call replace_turn_prose again.',
        issues: result.validation.issues.filter((i) => !i.repaired),
      };
    }
    return {
      status: 'replaced' as const,
      stateMode: 'reapplied' as const,
      upkeep,
      replacedTurnId: args.id,
      turn: result.turn,
      applied: appliedCounts(result.delta),
      dropped: result.validation.issues.filter((i) => i.repaired),
      newThreads: result.commit.newThreadIds,
    };
  }
  if (!(await world.chronicle.replaceProse(args.id, args.prose)))
    throw new Error(`replace_turn_prose: no turn ${args.id}`);
  const warning =
    upkeep === 'agent'
      ? 'The turn’s recorded world delta was kept and may no longer match this prose; pass world to re-apply it.'
      : args.world !== undefined
        ? 'upkeep is "server": world was ignored and the recorded delta was kept.'
        : undefined;
  return {
    status: 'replaced' as const,
    stateMode: 'preserve' as const,
    upkeep,
    turn: (await world.chronicle.getTurn(args.id))!,
    ...(warning ? { warning } : {}),
  };
}
```

`src/mcp/tools.ts`: add `import { recommitTurn } from '../loop/commit.ts';` and replace `replaceTurnProseTool` (lines 729-737) with the same body, using `const world = ctx.world();`, `recommitTurn(world, args.id, args.prose, args.world)`, `world.chronicle.replaceProse(...)` and `world.chronicle.getTurn(args.id)!`, all without `await`, and without the `async` keyword.

Existing tests read `.stateMode` and `.turn` from this tool, and both are still present on the preserve path.

`src/mcp/server-pg.ts` (`replace_turn_prose`, lines 583-592):

```ts
  server.registerTool(
    'replace_turn_prose',
    {
      description:
        'Commit exact author-supplied prose for a turn. By default the turn’s state delta is preserved. With upkeep "agent" and world, ' +
        'the latest turn is re-committed from the checkpoint before it with that delta (its id changes; later edits must be rolled back first). This is not regenerate_turn.',
      inputSchema: {
        id: z.string(),
        prose: z.string(),
        stateMode: z.literal('preserve').optional(),
        world: worldDeltaInput.optional().describe('With upkeep "agent": the corrected world delta for this turn.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, prose, stateMode, world }) => toolResult(await replaceTurnProseTool(ctx, { id, prose, stateMode, world })),
  );
```

`src/mcp/server.ts` (lines 573-582): the same registration with the handler `async ({ id, prose, stateMode, world }) => toolResult(replaceTurnProseTool(ctx, { id, prose, stateMode, world })),`.

- [ ] **Step 4: Run tests to verify they pass**

Run both upkeep files, `test/mcp-tools.test.ts`, `test/mcp-tools-pg.test.ts`, `test/history.test.ts` and `test/pg-commit.test.ts`. Expected: PASS. Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/store/history-pg.ts src/store/history.ts src/loop/commit-pg.ts src/loop/commit.ts src/mcp/tools-pg.ts src/mcp/tools.ts src/mcp/server-pg.ts src/mcp/server.ts test/mcp-upkeep.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(mcp): re-apply an agent world delta on replace_turn_prose"
```

---

### Task 11: Checkpoint origin in the web rollback picker

**Files:**
- Modify: `src/domain/types.ts:379-390` (`StoryLayoutTurn`), `:409-414` (`EligibleTurn`)
- Modify: `src/store/history-pg.ts:97-116` and `:550-558` (eligible-turn queries), `src/store/history.ts:151-174`
- Modify: `src/loop/history-pg.ts:32-36`, `src/loop/history.ts:30-34` (layout push)
- Modify: `src/server/api-pg.ts:637-641`, `src/server/api.ts:397-401` (book turns)
- Modify: `web/src/api.ts:168-172` (`BookTurn`), `web/src/App.tsx:1625-1629` (turn `<option>`)
- Test: `test/api.test.ts`, `test/mcp-upkeep-pg.test.ts`

**Interfaces:**
- Consumes: `history_checkpoints.origin` (Task 7).
- Produces: `EligibleTurn.origin: string | null`, `StoryLayoutTurn.origin: string | null`, a book-route turn field `origin`, and `BookTurn.origin: string | null`.

- [ ] **Step 1: Write the failing tests**

`test/api.test.ts`, in `'the book endpoint returns both registers per turn'` (line 379), after `assert.ok(turns[0]!.bookProse.length > 0, …);`:

```ts
    assert.equal((turns[0] as { origin?: string | null }).origin, 'turn:server', 'the rollback picker can show who wrote it');
```

`test/mcp-upkeep-pg.test.ts`:

```ts
test('PostgreSQL eligible turns carry their checkpoint origin', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, ctx } = await pgContext(db);
    const turn = await agentTurn(ctx, 'i warm the ink', {});
    assert.deepEqual(
      (await world.history.eligibleTurns()).map(({ turnId, origin }) => [turnId, origin]),
      [[turn.turnId, 'turn:agent']],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test test/api.test.ts`
Expected: FAIL with `undefined !== 'turn:server'`.
Run the PG file. Expected: FAIL with `[[id, undefined]]` vs `[[id, 'turn:agent']]`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/types.ts`: in `EligibleTurn` add `origin: string | null;` after `position: number;`. In `StoryLayoutTurn` add `origin: string | null;` after `position: number | null;`.

`src/store/history-pg.ts`: in the three eligible-turn SELECTs (`eligibleTurn` line 99, `eligibleTurns` line 109, `eligibleTurnFrom` line 552), change `SELECT t.id AS "turnId", t.scene, t.turn, t.history_position AS position` to `SELECT t.id AS "turnId", t.scene, t.turn, t.history_position AS position, h.origin`.

`src/store/history.ts`: in `eligibleTurn` (line 155) and `eligibleTurns` (line 167), change `SELECT t.id AS turnId, t.scene, t.turn, t.history_position AS position` to `SELECT t.id AS turnId, t.scene, t.turn, t.history_position AS position, h.origin`.

`src/loop/history-pg.ts:35` and `src/loop/history.ts:33`: `startsScene, eligible: Boolean(history), position: history?.position ?? null, source,` → `startsScene, eligible: Boolean(history), position: history?.position ?? null, origin: history?.origin ?? null, source,`.

`src/server/api-pg.ts:637-638` and `src/server/api.ts:397-398`:

```ts
    turns: layout.turns.slice(offset, offset + limit).map(({ source: t, scene, chapter, eligible, position, origin, startsScene }) => ({
      id: t.id, scene, chapter, turn: t.turn, historyPosition: position, origin, eligible, startsScene,
```

`web/src/api.ts:171`: `eligible: boolean; historyPosition: number | null; startsScene: boolean;` → `eligible: boolean; historyPosition: number | null; origin: string | null; startsScene: boolean;`.

`web/src/App.tsx:1627`: `{chapterTurnLabel(turn)} · scene {turn.scene}` → `{chapterTurnLabel(turn)} · scene {turn.scene}{turn.origin ? ` · ${turn.origin}` : ''}`.

- [ ] **Step 4: Run tests to verify they pass**

Run `test/api.test.ts`, the PG upkeep file, `test/history.test.ts` and `test/pg-history.test.ts`. Expected: PASS. Then `pnpm typecheck && pnpm lint && pnpm build:web`.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/store/history-pg.ts src/store/history.ts src/loop/history-pg.ts src/loop/history.ts src/server/api-pg.ts src/server/api.ts web/src/api.ts web/src/App.tsx test/api.test.ts test/mcp-upkeep-pg.test.ts
git commit -m "feat(web): show checkpoint origin in the rollback turn picker"
```

---

## Final verification

- [ ] `env FABULIST_TEST_PG='postgres://postgres@localhost:5433/fabulist_test?host=/tmp' FABULIST_REQUIRE_TEST_PG=1 pnpm test`. Every test passes and none are skipped for missing Postgres.
- [ ] `pnpm typecheck && pnpm lint && pnpm build:web`, all clean.
- [ ] `graft build` to refresh the context graph after the changes.

## Self-review notes

- **Spec coverage:** A1 → Tasks 1, 2, 5, 10. A2 → Tasks 1–3. A3 → Tasks 4, 5. A4 → Task 6. A5 → Task 9. A6 origin → Tasks 7, 8, 11. A6 prose replacement → Task 10. A7 → every task covers both builds.
- **Spec "A:" tests:** mock + world persisted → Tasks 5, 6. Dropped ids and missing-world warning → Task 5. Stub extractor ignores world → Task 5. Guide follows upkeep → Tasks 1, 2. Rollback/fork across an agent turn and `record_fact` → Task 9. Origin recorded → Task 7. `replace_turn_prose` re-applies → Task 10.
- **Type names used across tasks:** `upkeepFor`, `upkeepOf`, `Upkeep`, `buildGuide`, `appliedCounts`, `worldDeltaInput`, `triggerInput`, `coerceAgentDelta`, `agentDelta`, `commitNarration`, `recommitTurn`, `RecommitResult`, `rewindBefore`, `recent`, `CheckpointSummary`, `origin`, `lintBlocklist`.
