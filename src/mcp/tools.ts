/**
 * MCP tool implementations. See `.design/MCP-CONNECTOR.md`.
 *
 * Pure functions over `World`/`Engine` — no MCP SDK types here, no HTTP. This
 * mirrors the existing separation `src/server/api.ts` already draws between
 * routes and the store/engine they call: the transport (`src/mcp/server.ts`)
 * wraps these, it does not contain them, so the same logic is trivially
 * testable without spinning up a protocol server (see `test/mcp-tools.test.ts`).
 *
 * Deliberately thin. `list_worlds`/`get_state`/`get_cast`/etc. are each a
 * couple of lines over a store method that already exists; the interesting
 * behaviour is `proposeTurn`/`resolveInterrupt`/`commitNarration`, which
 * drive the engine's `narrateExternally` split (`src/loop/engine.ts`) rather
 * than reimplementing any part of the turn loop here.
 */
import type { Engine } from '../loop/engine.ts';
import { forkStory, branchSave, rollback, type ForkOptions, type BranchOptions } from '../loop/branch.ts';
import { applyDirectiveRecalc, tickConsequences, worldTick } from '../consequence/propagate.ts';
import type { IllustrationService } from '../illustration/service.ts';
import { NoImageProviderError } from '../illustration/service.ts';
import { assignPlayerCharacter, proposeOpening, type ApplyCustomResult } from '../setup/apply.ts';
import { limitsFromWire, type SetupService, type IngestJobResult, type PreviewResult } from '../setup/service.ts';
import type { CharacterSketch, IngestPlan } from '../setup/planner.ts';
import type { WikiCandidate } from '../setup/directory.ts';
import type { DepthMode } from '../ingest/depth.ts';
import { slugId } from '../ingest/parse.ts';
import type { Job } from '../setup/jobs.ts';
import type { CurrentStory, CurrentWorld, World } from '../store/index.ts';
import { createStory, getStory, listStories, listStoriesForUser } from '../store/world.ts';
import type { SessionUser } from '../auth/config.ts';
import { listWorlds } from '../store/worlds.ts';
import type { Directive, StyleContract, Knobs, VisualStyle, EntityId, EntityType } from '../domain/types.ts';

export interface McpToolContext {
  /** Resolves fresh per call, exactly like every route in `api.ts` does — a story/world switch must take effect on the next call, not after a restart. */
  world: () => World;
  /**
   * Who this connection authenticated as, mapped from the verified bearer
   * token's subject (`src/mcp/auth.ts`). Non-null whenever `/mcp` is mounted
   * at all, because the route refuses unauthenticated requests before any tool
   * runs — but typed nullable so a test or an embedded caller can build a
   * context with no identity and get the legacy shared-story behaviour.
   *
   * This is what makes an MCP-created book *belong* to somebody: `world()`
   * above resolves through `CurrentStory.worldFor(user)`, the same per-user
   * resolution every REST route already used, and the story-writing tools
   * stamp `owner_user_id` with this id. Before it existed the token's verified
   * `sub` was computed in `handleMcpRequest` and then discarded, so every
   * story an MCP client created was unowned and invisible to the web UI's
   * own per-user list.
   */
  user?: SessionUser | null;
  /**
   * Sets which of this user's stories subsequent `world()` calls resolve to,
   * for the lifetime of this tool context. Provided by the `/mcp` route, which
   * builds one context per request and threads the selection through the
   * connection rather than through the process-wide `CurrentStory` pointer.
   * Absent in the login-off/legacy shape, where `switch_story` falls back to
   * that pointer.
   */
  selectStory?: (storyId: string) => void;
  engine: Engine;
  currentStory?: CurrentStory;
  currentWorld?: CurrentWorld;
  /** Undefined on a server built with `setup` disabled — see `requireSetup`'s REST-side equivalent in `src/server/api.ts`. */
  setup?: SetupService;
  /** Undefined on a server built with no image provider configured — see `requireIllustrations`'s REST-side equivalent in `src/server/api.ts`. */
  illustrations?: IllustrationService;
  dataRoot: string;
}

const VISUAL_STYLES: VisualStyle[] = ['realistic', 'drawing', 'sketch', 'draft', 'animation'];
function parseVisualStyle(v: unknown): VisualStyle | undefined {
  return typeof v === 'string' && (VISUAL_STYLES as string[]).includes(v) ? (v as VisualStyle) : undefined;
}

// -------------------------------------------------------------- read tools

export function listWorldsTool(ctx: McpToolContext) {
  const worlds = listWorlds(ctx.dataRoot);
  const current = ctx.currentWorld?.slug();
  return {
    worlds: worlds.map((w) => ({ ...w, current: w.slug === current })),
  };
}

/**
 * `switch_world`. The MCP-side counterpart of `POST /api/worlds/:slug/switch`
 * (`src/server/api.ts`) — same underlying `CurrentWorld.switchTo`, same
 * "takes effect immediately, no restart" semantics, because `world()`/`engine`
 * everywhere else in this file are live getters over it, not a `World`
 * captured once. Without this tool a calling model can *see* every world via
 * `list_worlds` but has no way to act on that list — every other tool only
 * ever reads whichever world happens to be open, which is the gap this closes.
 *
 * `currentWorld` is optional on `McpToolContext` (undefined whenever this
 * server was built with a single fixed `World` rather than a `CurrentWorld` —
 * see `createApiServer`'s own `world` option), so this throws a clear,
 * actionable message rather than a null-deref when that is the case.
 */
export function switchWorldTool(ctx: McpToolContext, args: { slug: string }) {
  if (!ctx.currentWorld) {
    throw new Error(
      'switch_world: this server has no switchable world (a single fixed world was configured at startup)',
    );
  }
  ctx.currentWorld.switchTo(args.slug);
  return { current: ctx.currentWorld.slug() };
}

/**
 * `list_stories`. Mirrors `GET /api/stories` exactly, ownership included: an
 * identified caller sees only the books they own, never the whole file's list,
 * because that list is other users' story titles and existence.
 */
export function listStoriesTool(ctx: McpToolContext) {
  const world = ctx.world();
  const stories = ctx.user ? listStoriesForUser(world.db, ctx.user.id) : listStories(world.db);
  return {
    stories: stories.map((s) => ({ ...s, current: s.id === world.storyId })),
  };
}

/**
 * The one ownership rule, shared by every MCP tool that names a story
 * explicitly, and identical to `ownsStoryOrRespond` on the REST side: a story
 * is yours if you own it, or if it is unowned (`owner_user_id IS NULL` — a
 * legacy save, or one created while login was off). Never "owned by everyone".
 */
function assertOwned(world: World, storyId: string, user: SessionUser | null | undefined, tool: string): void {
  const story = getStory(world.db, storyId);
  if (!story) throw new Error(`${tool}: no story ${storyId} in this world`);
  if (user && story.ownerUserId !== null && story.ownerUserId !== user.id) {
    throw new Error(`${tool}: story ${storyId} belongs to another user`);
  }
}

/**
 * `create_story`. The MCP-side counterpart of `POST /api/stories` — a fresh,
 * non-overlapping story sharing only this world's canon. Does not switch to
 * it, matching the REST route's own documented behaviour: the caller decides
 * whether to open it immediately (`switch_story`) or leave the current story
 * as it is.
 *
 * Ownership (`owner_user_id`) is deliberately left unset here — see
 * `.design/MCP-CONNECTOR.md` and this tool's own test for why: the REST
 * route attributes a created story to the verified session user, but no
 * such identity reaches an individual MCP tool call today (the OAuth
 * verification in `handleMcpRequest` authenticates the *connection*, not
 * each call), and this server currently only runs with login off in
 * practice. Wiring per-user ownership through here is future work, not a
 * silent gap this tool should paper over with a wrong owner.
 */
export function createStoryTool(ctx: McpToolContext, args: { title?: string }) {
  const world = ctx.world();
  const story = createStory(world.db, {
    title: args.title?.trim() ?? '',
    ...(ctx.user ? { ownerUserId: ctx.user.id } : {}),
  });
  // Scene 1 comes with the story now — see `createStory`, which opens it for
  // every creation path rather than leaving each one to remember.
  return { story };
}

/**
 * `fork_story`. The MCP-side counterpart of `POST /api/stories/fork`: omit
 * `atScene` for a fresh copy sharing canon only, pass it to copy that
 * story's own chronicle up to that scene boundary first (a "branch from
 * here" / "continue from an earlier point"). `fromStoryId` defaults to
 * whichever story is current in the open world.
 */
export function forkStoryTool(ctx: McpToolContext, args: { fromStoryId?: string; title?: string; atScene?: number }) {
  const world = ctx.world();
  const sourceId = args.fromStoryId || world.storyId;
  // The *source* must be readable by this caller: forking someone else's book
  // would hand over every scene of it under a story the forker now owns, the
  // same leak `assertOwned` prevents on the REST side. The fork itself is
  // always attributed to the caller, never to the source's owner.
  assertOwned(world, sourceId, ctx.user, 'fork_story');
  const opts: ForkOptions = { fromStoryId: sourceId };
  if (args.title !== undefined) opts.title = args.title;
  if (args.atScene !== undefined) opts.atScene = args.atScene;
  if (ctx.user) opts.ownerUserId = ctx.user.id;
  return forkStory(world, opts);
}

/**
 * `rollback`. The MCP-side counterpart of `POST /api/rollback` — the
 * connector needs this more than the browser does, since a model that has
 * just written a bad turn otherwise has no way to take it back at all.
 * Always acts on whichever story `ctx.world()` currently resolves to.
 *
 * `mode` defaults to `'fork'`, same as the REST route, for the same reason
 * (GAPS.md 3.6: the discarded tail survives as a sibling book rather than
 * being deleted). When it produces a new story: an identified caller with a
 * per-connection `selectStory` gets that connection alone moved onto it
 * (mirroring `switchStoryTool`'s own reasoning — the shared, server-wide
 * `CurrentStory` pointer must never be dragged by one caller's rollback);
 * the login-off/legacy path switches that shared pointer instead, since
 * there is only one reader by definition.
 */
export function rollbackTool(
  ctx: McpToolContext,
  args: { scene?: number; chapter?: number; mode?: 'fork' | 'destructive' },
) {
  const world = ctx.world();
  assertOwned(world, world.storyId, ctx.user, 'rollback');
  const result = rollback(world, {
    scene: args.scene,
    chapter: args.chapter,
    mode: args.mode,
    ownerUserId: ctx.user?.id,
  });
  if (result.mode === 'fork' && result.forkedStory) {
    if (ctx.user && ctx.selectStory) ctx.selectStory(result.forkedStory.id);
    else if (ctx.currentStory) ctx.currentStory.switchTo(result.forkedStory.id);
  }
  return result;
}

/**
 * `switch_story`. The MCP-side counterpart of `POST /api/stories/:id/switch`
 * — same underlying `CurrentStory.switchTo`, same "takes effect immediately"
 * semantics `switch_world` documents above, one level down: which *story*
 * within the currently open world every subsequent tool call operates on.

 *
 * `currentStory` is optional on `McpToolContext` for the same reason
 * `currentWorld` is (a server built over a single fixed `World` has no story
 * management at all — see `requireCurrentStory`'s REST-side equivalent).
 */
export function switchStoryTool(ctx: McpToolContext, args: { id: string }) {
  if (!ctx.currentStory) {
    throw new Error(
      'switch_story: this server has no story management enabled (a single fixed world was configured at startup)',
    );
  }
  const world = ctx.world();
  assertOwned(world, args.id, ctx.user, 'switch_story');
  // An identified caller gets a *per-connection* switch, not a server-wide one:
  // `selectStory` is what later `world()` calls in this session resolve
  // through, and mutating the shared `CurrentStory` pointer would drag every
  // other user — and the browser — onto this story too. `switchTo` stays the
  // login-off path, where there is only one reader by definition.
  if (ctx.user && ctx.selectStory) {
    ctx.selectStory(args.id);
    return { current: args.id, scope: 'this connection' as const };
  }
  ctx.currentStory.switchTo(args.id);
  return { current: args.id, scope: 'server-wide' as const };
}

export function getStateTool(ctx: McpToolContext) {
  const world = ctx.world();
  const session = world.session.get();
  const hasPlayer = !!world.cast.player();
  return {
    session,
    // The distinction a caller cannot otherwise draw: a world can be full of
    // canon and still have no protagonist, which is what a freshly created or
    // freshly ingested book looks like. Without this the only symptom is that
    // turns read oddly, with nothing saying why.
    hasPlayer,
    ...(hasPlayer ? {} : { nextStep: 'This book has no protagonist yet. Call list_characters, then start_story.' }),
    counts: world.graph.counts(),
    pendingConsequences: world.consequences.pending().length,
    hiddenFired: world.consequences.hiddenFiredCount(),
    usage: world.chronicle.usageTotals(),
  };
}

export function getCastTool(ctx: McpToolContext, args: { name?: string }) {
  const world = ctx.world();
  if (args.name) {
    const entity = world.graph.resolveName(args.name);
    if (!entity) return { sheet: null, entity: null };
    return { entity, sheet: world.cast.get(entity.id) ?? null };
  }
  return {
    cast: world.cast.list().map((sheet) => ({ sheet, entity: world.graph.get(sheet.entityId) ?? null })),
  };
}

export function getEntityTool(ctx: McpToolContext, args: { id?: string; name?: string }) {
  const world = ctx.world();
  const entity = args.id ? world.graph.get(args.id) : args.name ? world.graph.resolveName(args.name) : undefined;
  if (!entity) return { entity: null };
  return {
    entity,
    sheet: world.cast.get(entity.id) ?? null,
    neighbours: world.graph.neighbours(entity.id).map((n) => ({
      edge: n.edge,
      other: world.graph.get(n.otherId) ?? null,
    })),
  };
}

export function searchEntitiesTool(ctx: McpToolContext, args: { query: string; limit?: number }) {
  const world = ctx.world();
  return { entities: world.graph.search(args.query, args.limit ?? 20) };
}

// ---------------------------------------------------------- manual state edits

const ENTITY_TYPES: Record<string, EntityType> = {
  character: 'Character',
  location: 'Location',
  faction: 'Faction',
  item: 'Item',
  concept: 'Concept',
  event: 'Event',
};

function manualEntityType(type: string): EntityType {
  const parsed = ENTITY_TYPES[type.toLowerCase()];
  if (!parsed) throw new Error(`upsert_entity: unsupported type ${type}`);
  return parsed;
}

function entityReference(world: World, value: string, tool: string): EntityId {
  const exact = world.graph.get(value);
  if (exact) return exact.id;
  const matches = world.graph
    .search(value, 100)
    .filter((entity) => entity.name.toLowerCase() === value.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`${tool}: ${JSON.stringify(value)} is ambiguous; use an entity id`);
  throw new Error(`${tool}: no entity ${JSON.stringify(value)}`);
}

/** Create or copy-on-write update an entity in the active story with manual provenance. */
export function upsertEntityTool(
  ctx: McpToolContext,
  args: { id?: string; type: string; name: string; attributes?: Record<string, unknown>; summary?: string },
) {
  const world = ctx.world();
  const type = manualEntityType(args.type);
  const name = args.name.trim();
  if (!name) throw new Error('upsert_entity: name is required');
  const id = args.id?.trim() || slugId(type, name);
  const previous = world.graph.get(id);
  world.graph.upsert(
    {
      id,
      type,
      name,
      summary: args.summary?.trim() ?? previous?.summary ?? '',
      props: { ...(previous?.props ?? {}), ...(args.attributes ?? {}) },
      provenance: 'manual',
      confidence: 1,
      salience: previous?.salience ?? 0.5,
      depthLevel: previous?.depthLevel ?? 0,
      createdScene: previous?.createdScene ?? world.session.get().scene,
    },
    'chronicle',
  );
  return { id, created: !previous, entity: world.graph.get(id)! };
}

/** Assert a live story-scoped edge; IDs or unambiguous exact names are accepted. */
export function upsertEdgeTool(
  ctx: McpToolContext,
  args: { from: string; relation: string; to: string; attributes?: Record<string, unknown> },
) {
  const world = ctx.world();
  const relation = args.relation.trim();
  if (!relation) throw new Error('upsert_edge: relation is required');
  const subject = entityReference(world, args.from, 'upsert_edge.from');
  const object = entityReference(world, args.to, 'upsert_edge.to');
  const before = world.graph.edgesFrom(subject).find((edge) => edge.predicate === relation && edge.object === object);
  const weight = typeof args.attributes?.weight === 'number' ? args.attributes.weight : undefined;
  const evidence = typeof args.attributes?.note === 'string' ? args.attributes.note : undefined;
  world.graph.assertEdge(
    { subject, predicate: relation, object, weight, evidence },
    world.session.get().scene,
    'chronicle',
    'manual',
  );
  const edge = world.graph
    .edgesFrom(subject)
    .find((candidate) => candidate.predicate === relation && candidate.object === object);
  return { from: subject, relation, to: object, created: !before, edge };
}

/** Retire an edge rather than deleting it, preserving its history. */
export function removeEdgeTool(ctx: McpToolContext, args: { from: string; relation: string; to: string }) {
  const world = ctx.world();
  const subject = entityReference(world, args.from, 'remove_edge.from');
  const object = entityReference(world, args.to, 'remove_edge.to');
  return { removed: world.graph.retireEdge(subject, args.relation.trim(), object, world.session.get().scene) };
}

/** Set the current scene location to an existing Location entity. */
export function setCurrentLocationTool(ctx: McpToolContext, args: { entityId?: string; name?: string }) {
  const world = ctx.world();
  const ref = args.entityId ?? args.name;
  if (!ref) throw new Error('set_current_location: entityId or name is required');
  const id = entityReference(world, ref, 'set_current_location');
  const entity = world.graph.get(id)!;
  if (entity.type !== 'Location') throw new Error(`set_current_location: ${id} is a ${entity.type}, not a Location`);
  const session = world.session.set({ currentLocationId: id });
  world.chronicle.upsertScene(session.scene, { locationId: id });
  return { currentLocationId: id, scene: session.scene };
}

export function getThreadsTool(ctx: McpToolContext) {
  const world = ctx.world();
  return { threads: world.threads.all() };
}

export function getFactsTool(ctx: McpToolContext, args: { limit?: number }) {
  const world = ctx.world();
  return { facts: world.chronicle.facts(args.limit ?? 200) };
}

export function getBookTool(ctx: McpToolContext, args: { limit?: number }) {
  const world = ctx.world();
  return { turns: world.chronicle.turns({ limit: args.limit ?? 50 }) };
}

// ---------------------------------------------- starting a story after ingest

/**
 * `list_characters`. The MCP-side counterpart of `GET /api/setup/characters`
 * — candidate protagonists for `start_story`, ranked by connectedness (the
 * same "who matters most in this corner of the world" signal the REST route
 * uses), each flagged with whether it already has vows a player would
 * inherit. A world just ingested (like this one, right after a wiki crawl)
 * has entities but no protagonist yet — this is how a calling model finds
 * out who is available to *become* one, before calling `start_story`.
 */
export function listCharactersTool(ctx: McpToolContext) {
  const world = ctx.world();
  const characters = world.graph
    .list({ type: 'Character', limit: 60 })
    .map((e) => {
      const sheet = world.cast.get(e.id);
      return {
        id: e.id,
        name: e.name,
        summary: e.summary,
        salience: e.salience,
        hasVows: (sheet?.contract.vows.length ?? 0) > 0,
        connections: world.graph.neighbours(e.id).length,
      };
    })
    .sort((a, b) => b.connections - a.connections);
  return { characters };
}

/**
 * `start_story`. The MCP-side counterpart of `POST /api/setup/player` —
 * sets (or replaces) the protagonist of the current story and proposes an
 * opening line to play from. This is the tool that actually gets a freshly
 * ingested world (entities and edges, no player, no opening) into a playable
 * state; without it, `list_characters` can only look, never act.
 *
 * `existing` names one of `list_characters`' results to adopt as-is; leave
 * it unset (with `name`/`role`) to place an original character instead — see
 * `assignPlayerCharacter`'s own doc comment for exactly how each is built.
 * `setup` is optional on `McpToolContext` for the same reason `currentWorld`/
 * `currentStory` are (see `requireSetup`'s REST-side equivalent).
 */
export function startStoryTool(
  ctx: McpToolContext,
  args: {
    existing?: string;
    name?: string;
    role?: string;
    goals?: string[];
    vows?: Array<{ text: string; rank: number }>;
  },
) {
  if (!ctx.setup) {
    throw new Error(
      'start_story: this server has no setup service enabled (a single fixed world was configured at startup)',
    );
  }
  const world = ctx.world();
  const assigned = assignPlayerCharacter(world, {
    existing: args.existing ?? null,
    name: args.name ?? '',
    role: args.role ?? '',
    goals: args.goals ?? [],
    vows: args.vows ?? [],
  });
  return {
    ...assigned,
    opening: proposeOpening(world),
    nextStep: assigned.playerCharacterId
      ? 'The book is playable now. Offer the opening to the player, then take their first turn with propose_turn.'
      : 'No protagonist could be placed — the world may have no characters yet. Ingest canon first, or pass name/role to place an original.',
  };
}

// ---------------------------------------------------------- the turn tools

/**
 * `propose_turn`. Runs classify/integrity/referee/direct exactly as a normal
 * turn would (`Engine.takeTurn`), then always stops before this engine's own
 * Narrator role — `narrateExternally: true` is not optional here, it is the
 * entire point of this tool: the calling model (Claude, ChatGPT, whatever
 * else is on the other end of the MCP connection) writes the prose from the
 * returned frame, and this server's own configured provider is never billed
 * for it. See `.design/MCP-CONNECTOR.md` §3, "mode (b)".
 *
 * Three possible shapes come back, matching three `TurnOutcome` kinds:
 * `awaiting-narration` (write the prose, then call `commit_narration`),
 * `interrupted` (the integrity gate stopped it; call `resolve_interrupt`),
 * `answered` (a meta-query; nothing to narrate, nothing pending).
 * `blocked` cannot happen here — that only comes from extract/validate,
 * which never run before Narrate — so it is not part of this return type.
 */
export async function proposeTurnTool(ctx: McpToolContext, args: { text: string; actorId?: string }) {
  // `world` is passed explicitly rather than left to `Engine`'s own getter:
  // that getter is the process-wide shared pointer, so without this an
  // identified caller's turn would be gated and committed against whichever
  // story happened to be current server-wide instead of their own.
  const outcome = await ctx.engine.takeTurn(args.text, {
    narrateExternally: true,
    world: ctx.world(),
    ...(args.actorId ? { actorId: args.actorId } : {}),
  });

  if (outcome.kind === 'awaiting-narration') {
    return {
      status: 'awaiting-narration' as const,
      // Stated in the payload, not only in the tool description and the server
      // instructions: a client that ignored both still gets told, at the exact
      // moment it matters, that stopping here throws the turn away.
      nextStep:
        'Write the prose from narratorSystemPrompt + sceneFrame, then call commit_narration with it and this resumeToken. Nothing is saved until you do.',
      resumeToken: outcome.resumeToken,
      narratorSystemPrompt: outcome.system,
      sceneFrame: outcome.user,
      maxTokens: outcome.maxTokens,
    };
  }
  if (outcome.kind === 'interrupted') {
    return {
      status: 'interrupted' as const,
      nextStep:
        'Show the player these options and call resolve_interrupt with the one they pick and this originalText. Do not call commit_narration — no turn is pending.',
      message: outcome.interrupt.message,
      distance: outcome.distance,
      reasoning: outcome.reasoning,
      options: outcome.interrupt.options,
      // The client needs the original text back to resolve this — see
      // `resolveInterruptTool` — and an MCP tool call carries no session of
      // its own to remember it for them (unlike the web UI's own React state).
      originalText: args.text,
    };
  }
  if (outcome.kind === 'answered') {
    return {
      status: 'answered' as const,
      nextStep:
        'This was a question about the world, not an action. Relay the answer; there is nothing to narrate or commit.',
      text: outcome.text,
    };
  }
  // 'blocked' — unreachable from takeTurn before Narrate, kept for
  // exhaustiveness so a future TurnOutcome addition fails here loudly
  // instead of falling through silently.
  throw new Error(`propose_turn: unexpected outcome kind ${(outcome as { kind: string }).kind}`);
}

/**
 * `commit_narration`. Resumes a `propose_turn` that returned
 * `awaiting-narration`, given the prose the calling model wrote from the
 * returned frame. See `Engine.commitExternalNarration` for what actually
 * runs (prose gate, extract, validate, commit — the same steps a normal
 * turn runs after its own Narrator role, shared code either way).
 */
export async function commitNarrationTool(ctx: McpToolContext, args: { resumeToken: string; prose: string }) {
  // Same reason as `proposeTurnTool`: the pending turn belongs to this user's
  // story, and `commitExternalNarration` refuses a story mismatch — which,
  // resolved through the shared pointer, is what any other reader's switch
  // would have looked like.
  const outcome = await ctx.engine.commitExternalNarration(args.resumeToken, args.prose, ctx.world());
  if (outcome.kind === 'narrated') {
    return {
      status: 'narrated' as const,
      nextStep:
        'Committed. Show the prose to the player and take the next turn with propose_turn, or close_scene at a scene break.',
      turnId: outcome.turn.id,
      prose: outcome.prose,
      eventsRecorded: outcome.commit.events.length,
      brokenVows: outcome.commit.brokenVows,
      newThreads: outcome.commit.newThreadIds,
    };
  }
  if (outcome.kind === 'blocked') {
    // extract/validate rejected the delta the prose implied.
    return {
      status: 'blocked' as const,
      nextStep:
        'Nothing was committed. Rewrite the prose so it does not imply the rejected change, then call propose_turn again for a fresh token.',
      reason: outcome.reason,
      issues: outcome.validation.issues.filter((i) => !i.repaired),
    };
  }
  // 'interrupted'/'answered'/'awaiting-narration' are all unreachable here:
  // this resumes a pipeline that already passed every gate before Narrate
  // (that is what recorded the pending state in the first place), and
  // `finishTurn` — what actually runs from here — only ever returns
  // 'narrated' or 'blocked'. Kept explicit rather than cast away, so a
  // future change to `TurnOutcome` fails this file's typecheck instead of
  // silently mismatching at runtime.
  throw new Error(
    `commit_narration: unexpected outcome kind ${outcome.kind} — this should be unreachable post-narrate`,
  );
}

/**
 * `resolve_interrupt`. The web UI resolves an interrupt by re-submitting the
 * same raw input with `overrideIntegrity: true` (see `web/src/App.tsx`) —
 * there is no server-side "pending interrupt" row to look up, the browser's
 * own React state already holds the original text. An MCP tool call has no
 * equivalent session, so the client (the calling model) has to hand the
 * original text back explicitly; `propose_turn`'s `interrupted` response
 * includes it in `originalText` for exactly this reason.
 *
 * `revise` and `switch-character` never reach the engine at all — same as
 * the web UI, both mean "nothing was written, try different input," which
 * this tool reports directly rather than resubmitting anything.
 */
export async function resolveInterruptTool(
  ctx: McpToolContext,
  args: {
    originalText: string;
    effect: 'override' | 'establish-break' | 'revise' | 'switch-character';
    actorId?: string;
  },
) {
  if (args.effect === 'revise' || args.effect === 'switch-character') {
    return { status: 'nothing-written' as const, hint: 'try a different action, or a different character' };
  }
  // Both 'override' and 'establish-break' proceed identically at the engine
  // level (see engine.ts's own comment on `overrideIntegrity`) — the
  // distinction is authorial intent the divergence ledger records, not a
  // different code path.
  const outcome = await ctx.engine.takeTurn(args.originalText, {
    narrateExternally: true,
    overrideIntegrity: true,
    world: ctx.world(),
    ...(args.actorId ? { actorId: args.actorId } : {}),
  });
  if (outcome.kind === 'awaiting-narration') {
    return {
      status: 'awaiting-narration' as const,
      resumeToken: outcome.resumeToken,
      narratorSystemPrompt: outcome.system,
      sceneFrame: outcome.user,
      maxTokens: outcome.maxTokens,
    };
  }
  if (outcome.kind === 'answered') return { status: 'answered' as const, text: outcome.text };
  // An override cannot interrupt again — the gate that would have is exactly
  // what overrideIntegrity bypasses — so 'interrupted' here would mean the
  // engine's own invariant broke, not a normal outcome to report gracefully.
  throw new Error(`resolve_interrupt: unexpected outcome kind ${(outcome as { kind: string }).kind} after override`);
}

// -------------------------------------------- other turn/session write tools

/**
 * `play`. The MCP-side counterpart of `POST /api/play` — the *server*-
 * narrated alternative to `propose_turn`/`commit_narration`: this server's
 * own configured Narrator provider writes the prose (billed to whatever
 * profile is configured here, not the calling model), and the finished turn
 * comes back in one call. Exists alongside the split flow for a caller that
 * would rather not implement two round trips, or whose own model should not
 * be the one writing this world's prose style.
 */
export async function playTool(ctx: McpToolContext, args: { input: string; overrideIntegrity?: boolean }) {
  const world = ctx.world();
  const outcome = await ctx.engine.takeTurn(args.input, { overrideIntegrity: args.overrideIntegrity === true, world });
  let seeded = 0;
  let tick: ReturnType<typeof tickConsequences> | null = null;
  if (outcome.kind === 'narrated') {
    const { seedConsequences } = await import('../consequence/propagate.ts');
    seeded = seedConsequences(world, outcome.delta, outcome.commit.events).length;
    tick = tickConsequences(world);
    worldTick(world);
  }
  return { outcome, seeded, tick };
}

/** `pin_turn`. The MCP-side counterpart of `POST /api/turn/:id/pin` \u2014 a pinned turn's prose survives `regenerate_turn`/compaction untouched. */
export function pinTurnTool(ctx: McpToolContext, args: { id: string; pinned?: boolean }) {
  const world = ctx.world();
  world.chronicle.setPinned(args.id, args.pinned !== false);
  return world.chronicle.getTurn(args.id);
}

/**
 * `regenerate_turn`. The MCP-side counterpart of `POST /api/turn/:id/regenerate`
 * \u2014 re-renders one turn's prose in place; nothing about what happened changes,
 * only how it reads (DESIGN \u00a77.2's "prose is a view of state"). Throws on a
 * pinned turn rather than silently no-opping.
 */
export async function regenerateTurnTool(ctx: McpToolContext, args: { id: string; note?: string }) {
  const world = ctx.world();
  return ctx.engine.regenerateProse(args.id, { ...(args.note?.trim() ? { note: args.note.trim() } : {}), world });
}

/** Author-controlled exact prose replacement; it never re-extracts state. */
export function replaceTurnProseTool(ctx: McpToolContext, args: { id: string; prose: string; stateMode?: 'preserve' }) {
  const world = ctx.world();
  if (!args.prose.trim()) throw new Error('replace_turn_prose: prose is required');
  if (args.stateMode && args.stateMode !== 'preserve')
    throw new Error('replace_turn_prose: only stateMode "preserve" is supported');
  if (!world.chronicle.replaceProse(args.id, args.prose)) throw new Error(`replace_turn_prose: no turn ${args.id}`);
  return { stateMode: 'preserve' as const, turn: world.chronicle.getTurn(args.id)! };
}

/**
 * `update_sheet`. The MCP-side counterpart of `PUT /api/sheet/:id` \u2014 edits a
 * character's identity/contract/voice/condition/locks. `appearance` never
 * touches `referenceImagePath`/`seed` through this general editor (those two
 * fields are written exactly once, by `generate_portrait` on success) \u2014 same
 * strip the REST route applies, so an edit to the description text cannot
 * accidentally invalidate a reference that took a real provider call to produce.
 */
export function updateSheetTool(
  ctx: McpToolContext,
  args: {
    id: string;
    identity?: Record<string, unknown>;
    contract?: Record<string, unknown>;
    voice?: Record<string, unknown>;
    condition?: Record<string, unknown>;
    appearance?: Record<string, unknown>;
    locks?: string[];
  },
) {
  const world = ctx.world();
  const entity = world.graph.get(args.id);
  if (!entity) throw new Error(`update_sheet: no entity ${args.id}`);
  if (entity.type !== 'Character') throw new Error(`update_sheet: ${args.id} is not a character`);
  const existing = world.cast.getOrBlank(args.id);
  world.cast.put({
    ...existing,
    identity: (args.identity as unknown as typeof existing.identity) ?? existing.identity,
    contract: (args.contract as unknown as typeof existing.contract) ?? existing.contract,
    voice: (args.voice as unknown as typeof existing.voice) ?? existing.voice,
    condition: (args.condition as unknown as typeof existing.condition) ?? existing.condition,
    appearance: args.appearance
      ? {
          ...existing.appearance,
          ...args.appearance,
          referenceImagePath: existing.appearance.referenceImagePath,
          seed: existing.appearance.seed,
        }
      : existing.appearance,
    locks: args.locks ?? existing.locks,
  });
  return world.cast.get(args.id);
}

/** `lock_sheet_field`. The MCP-side counterpart of `POST /api/sheet/:id/lock` \u2014 marks (or unmarks) one field path as author-locked, exempt from future auto-drift. */
export function lockSheetFieldTool(ctx: McpToolContext, args: { id: string; path: string; locked?: boolean }) {
  const world = ctx.world();
  if (args.locked === false) world.cast.unlock(args.id, args.path);
  else world.cast.lock(args.id, args.path);
  return world.cast.get(args.id);
}

/** `update_thread`. The MCP-side counterpart of `PUT /api/thread/:id` \u2014 edits a narrative thread's tension, status, title, or stakes. */
export function updateThreadTool(
  ctx: McpToolContext,
  args: { id: string; tension?: number; status?: string; title?: string; stakes?: string },
) {
  const world = ctx.world();
  const { id, ...patch } = args;
  world.threads.update(id, patch as never);
  return world.threads.get(id);
}

/**
 * `add_directive`. The MCP-side counterpart of `POST /api/directive` \u2014
 * steers the future (a scene/chapter/campaign-scoped nudge) and reports the
 * recalculation it triggers, because silent recalculation in a system with
 * offscreen machinery is how you stop trusting it (see `applyDirectiveRecalc`).
 */
export function addDirectiveTool(
  ctx: McpToolContext,
  args: { text: string; scope?: Directive['scope']; strength?: Directive['strength']; lifetimeScenes?: number },
) {
  const world = ctx.world();
  const created = world.directives.create({
    text: args.text,
    scope: args.scope ?? 'chapter',
    strength: args.strength ?? 'push',
    lifetimeScenes: args.lifetimeScenes ?? 5,
    status: 'active',
    createdScene: world.session.get().scene,
  });
  const diff = applyDirectiveRecalc(world, created.id, created.text);
  return {
    directive: created,
    diff: {
      ...diff,
      raisedThreadTitles: diff.raisedThreads.map((tid) => world.threads.get(tid)?.title ?? tid),
      loweredThreadTitles: diff.loweredThreads.map((tid) => world.threads.get(tid)?.title ?? tid),
    },
  };
}

/** `delete_directive`. The MCP-side counterpart of `DELETE /api/directive/:id` \u2014 retires (never hard-deletes) a directive. */
export function deleteDirectiveTool(ctx: McpToolContext, args: { id: string }) {
  const world = ctx.world();
  world.directives.setStatus(args.id, 'retired');
  return { ok: true };
}

/** `update_style`. The MCP-side counterpart of `PUT /api/style` \u2014 merges a partial patch over the current story's style contract (POV, tense, register, ...). */
export function updateStyleTool(ctx: McpToolContext, args: Partial<StyleContract>) {
  const world = ctx.world();
  const cur = world.session.get();
  const next = { ...cur.style, ...args };
  world.session.set({ style: next });
  return next;
}

/** `update_knobs`. The MCP-side counterpart of `PUT /api/knobs` \u2014 merges a partial patch over the current story's dials (canon fidelity, danger, pacing, ...). */
export function updateKnobsTool(ctx: McpToolContext, args: Partial<Knobs>) {
  const world = ctx.world();
  const cur = world.session.get();
  const next = { ...cur.knobs, ...args };
  world.session.set({ knobs: next });
  return next;
}

/** `add_anchor`. The MCP-side counterpart of `POST /api/anchor` \u2014 records a style-anchor passage (prose the player liked, to steer future generation toward). */
export function addAnchorTool(ctx: McpToolContext, args: { text: string; note?: string }) {
  const world = ctx.world();
  world.chronicle.addAnchor(args.text, args.note ?? '', world.session.get().scene);
  return { ok: true };
}

/**
 * `generate_portrait`. The MCP-side counterpart of `POST /api/illustrate/portrait/:id`
 * \u2014 generates or regenerates a character's portrait; sets `appearance.referenceImagePath`
 * on success. `illustrations` is optional on `McpToolContext` for the same reason
 * `setup`/`currentWorld` are (see `requireIllustrations`'s REST-side equivalent).
 */
export async function generatePortraitTool(ctx: McpToolContext, args: { entityId: string; visualStyle?: string }) {
  if (!ctx.illustrations) {
    throw new Error('generate_portrait: this server has no image provider configured');
  }
  const style = parseVisualStyle(args.visualStyle);
  try {
    return await ctx.illustrations.illustratePortrait(args.entityId, style, ctx.world());
  } catch (err) {
    if (err instanceof NoImageProviderError) throw new Error('generate_portrait: no image provider configured');
    throw err;
  }
}

/**
 * `generate_scene_illustration`. The MCP-side counterpart of `POST /api/illustrate/scene/:turnId`
 * \u2014 illustrates an already-committed turn, from the cast/location its own delta recorded
 * (never a player-supplied list, so the image depicts what actually happened).
 */
export async function generateSceneIllustrationTool(
  ctx: McpToolContext,
  args: { turnId: string; visualStyle?: string },
) {
  if (!ctx.illustrations) {
    throw new Error('generate_scene_illustration: this server has no image provider configured');
  }
  const world = ctx.world();
  const turn = world.chronicle.getTurn(args.turnId);
  if (!turn) throw new Error(`generate_scene_illustration: no turn ${args.turnId}`);
  const style = parseVisualStyle(args.visualStyle);
  const firstEvent = turn.delta?.events[0];
  const locationId = (firstEvent?.locationId ?? world.session.get().currentLocationId ?? null) as EntityId | null;
  const presentIds = (firstEvent?.participants ?? []) as EntityId[];
  try {
    return await ctx.illustrations.illustrateScene(
      args.turnId,
      locationId,
      presentIds,
      turn.bookProse.slice(0, 400),
      style,
      world,
    );
  } catch (err) {
    if (err instanceof NoImageProviderError)
      throw new Error('generate_scene_illustration: no image provider configured');
    throw err;
  }
}

/**
 * `compose_illustration_prompt`. The MCP-side counterpart of
 * `GET /api/illustrate/{portrait,scene}/.../prompt` — the copy-pasteable
 * fallback `.design/ILLUSTRATIONS.md` §6 requires: composition and
 * generation are deliberately split in `IllustrationService`, and this tool
 * only ever calls `composePortrait`/`composeScene`, never `illustratePortrait`/
 * `illustrateScene` — so it returns a real prompt/negative-prompt pair
 * whether or not an image provider is configured, unlike `generate_portrait`/
 * `generate_scene_illustration` which need one. The one thing this *cannot*
 * fix is illustration being disabled outright (`ctx.illustrations` absent,
 * i.e. no `IllustrationService` wired into this server at all) — that still
 * throws, same as the other two illustration tools, because there is no
 * `composePortrait`/`composeScene` to call without a service instance.
 */
export async function composeIllustrationPromptTool(
  ctx: McpToolContext,
  args:
    | { subject: 'portrait'; entityId: string; visualStyle?: string }
    | { subject: 'scene'; turnId: string; visualStyle?: string },
) {
  if (!ctx.illustrations) {
    throw new Error('compose_illustration_prompt: illustration is not enabled on this server');
  }
  const style = parseVisualStyle(args.visualStyle);
  const note =
    'Copy-pasteable fallback — no provider was called and nothing was generated or stored. Paste prompt/negativePrompt into whatever image tool is available.';
  if (args.subject === 'portrait') {
    const composed = ctx.illustrations.composePortrait(args.entityId, style);
    return { ...composed, note };
  }
  const world = ctx.world();
  const turn = world.chronicle.getTurn(args.turnId);
  if (!turn) throw new Error(`compose_illustration_prompt: no turn ${args.turnId}`);
  const firstEvent = turn.delta?.events[0];
  const locationId = (firstEvent?.locationId ?? world.session.get().currentLocationId ?? null) as EntityId | null;
  const presentIds = (firstEvent?.participants ?? []) as EntityId[];
  const composed = ctx.illustrations.composeScene(
    args.turnId,
    locationId,
    presentIds,
    turn.bookProse.slice(0, 400),
    style,
  );
  return { ...composed, note };
}

/** `delete_illustration`. The MCP-side counterpart of `DELETE /api/illustration/:id`. */
export function deleteIllustrationTool(ctx: McpToolContext, args: { id: string }) {
  ctx.world().illustrations.delete(args.id);
  return { ok: true };
}

/** `tick`. The MCP-side counterpart of `POST /api/tick` \u2014 advances seeded consequences toward firing and runs whatever else the world clock does per tick. */
export function tickTool(ctx: McpToolContext) {
  const world = ctx.world();
  const tick = tickConsequences(world);
  const notes = worldTick(world);
  return { tick, notes };
}

/**
 * `compact`. The MCP-side counterpart of `POST /api/compact` \u2014 summarise one
 * closed scene on demand (pass `scene`), or catch up everything that closed
 * unsummarised (omit it).
 */
export async function compactTool(ctx: McpToolContext, args: { scene?: number; force?: boolean }) {
  const world = ctx.world();
  const compactor = ctx.engine.compaction();
  if (typeof args.scene === 'number') {
    const summary = await compactor.summariseScene(args.scene, args.force === true);
    return { scene: args.scene, summary };
  }
  return compactor.backfill(world.session.get().scene);
}

/**
 * `close_scene`. The MCP-side counterpart of `POST /api/scene/close` \u2014 closes
 * the current scene by hand (the CLI's `/scene`). Without this, scene stays 1
 * forever unless the extractor happens to set `sceneAdvance`, and hierarchical
 * compaction never runs.
 */
export async function closeSceneTool(ctx: McpToolContext) {
  const world = ctx.world();
  const before = world.session.get();
  const result = await ctx.engine.compaction().onSceneClosed(before.scene);
  world.session.set({ scene: before.scene + 1, turn: 0 });
  world.chronicle.upsertScene(before.scene + 1, { chapter: ctx.engine.compaction().chapterOf(before.scene + 1) });
  const summary = world.chronicle.scenes().find((s) => s.scene === before.scene)?.summary ?? null;
  return {
    closedScene: before.scene,
    nowScene: before.scene + 1,
    summary,
    scenesSummarised: result.scenesSummarised,
    chaptersSummarised: result.chaptersSummarised,
  };
}

/**
 * `branch_story_to_file`. The MCP-side counterpart of `POST /api/branch` \u2014
 * forks the *save file* at a scene into a different path on disk, leaving
 * the source completely untouched. This is a different operation from
 * `fork_story` (which branches within the same world file): a genuinely
 * separate save the caller can hand off or archive independently.
 */
export function branchStoryToFileTool(
  ctx: McpToolContext,
  args: { atScene: number; toPath: string; overwrite?: boolean },
) {
  const world = ctx.world();
  const fromPath = world.db.prepare(`PRAGMA database_list`).get() as { file?: string } | undefined;
  if (!fromPath?.file) throw new Error('branch_story_to_file: cannot branch an in-memory save');
  const opts: BranchOptions = {
    fromPath: fromPath.file,
    toPath: args.toPath,
    atScene: args.atScene,
    overwrite: args.overwrite === true,
  };
  return branchSave(opts);
}

// ---------------------------------------------------- setup wizard write tools

/** `resolve_wiki`. The MCP-side counterpart of `POST /api/setup/resolve` \u2014 resolves free text to candidate wikis. */
export async function resolveWikiTool(ctx: McpToolContext, args: { query: string }) {
  if (!ctx.setup) throw new Error('resolve_wiki: this server has no setup service enabled');
  return { candidates: await ctx.setup.resolveWiki(args.query.trim()) };
}

/** `plan_world`. The MCP-side counterpart of `POST /api/setup/plan` \u2014 free text plus a resolved wiki (from resolve_wiki) becomes an editable ingest plan. */
export async function planWorldTool(ctx: McpToolContext, args: { wish: string; wiki: WikiCandidate }) {
  if (!ctx.setup) throw new Error('plan_world: this server has no setup service enabled');
  return ctx.setup.plan(args.wish.trim(), args.wiki);
}

/**
 * `preview_ingest`. The MCP-side counterpart of `POST /api/setup/preview` \u2014
 * crawls and reports what an ingest would cost, without writing anything.
 * The returned `previewKey` is what `commit_ingest` needs, so confirming a
 * preview never pays for the crawl twice.
 *
 * `maxPages`/`hops`/`passBMaxPages` override the mode's presets: there is no
 * 3,000-page ceiling any more, and the LLM pass is budgeted separately from
 * the crawl so "read widely, extract relations from the best N" is one call.
 * `"all"` is refused on this path (dump-only) — see `assertBudgetIsServable`.
 */
export async function previewIngestTool(
  ctx: McpToolContext,
  args: {
    baseUrl: string;
    seeds: string[];
    mode?: DepthMode;
    excludeCategories?: string[];
    title?: string;
    maxPages?: number | string;
    hops?: number | string;
    passBMaxPages?: number | string;
  },
) {
  if (!ctx.setup) throw new Error('preview_ingest: this server has no setup service enabled');
  return ctx.setup.preview(
    args.baseUrl,
    args.seeds,
    args.mode ?? 'mid',
    args.excludeCategories ?? [],
    args.title ?? '',
    undefined,
    limitsFromWire(args),
  );
}

/**
 * `discover_world`. The MCP-side counterpart of `POST /api/setup/discover` \u2014
 * same crawl as `preview_ingest`, run as a background job (poll with
 * `get_setup_job`) so a slow mid/deep crawl reports real progress instead of
 * a blind wait. Also refines the character sketch against what the crawl
 * actually found.
 */
export function discoverWorldTool(
  ctx: McpToolContext,
  args: {
    baseUrl: string;
    seeds: string[];
    mode?: DepthMode;
    character?: CharacterSketch;
    excludeCategories?: string[];
    title?: string;
    maxPages?: number | string;
    hops?: number | string;
    passBMaxPages?: number | string;
  },
): Job<PreviewResult & { previewKey: string; character: CharacterSketch }> {
  if (!ctx.setup) throw new Error('discover_world: this server has no setup service enabled');
  const sketch = args.character ?? { existing: null, name: '', role: '', goals: [], vows: [] };
  return ctx.setup.startDiscover(
    args.baseUrl,
    args.seeds,
    args.mode ?? 'mid',
    sketch,
    args.excludeCategories ?? [],
    args.title ?? '',
    limitsFromWire(args),
  );
}

/**
 * `commit_ingest`. The MCP-side counterpart of `POST /api/setup/ingest` \u2014
 * commits a previewed scope (from `preview_ingest`/`discover_world`'s
 * `previewKey`) as a background job (poll with `get_setup_job`). This is the
 * step that actually writes canon.
 */
export function commitIngestTool(
  ctx: McpToolContext,
  args: { previewKey: string; character?: CharacterSketch; style?: Partial<IngestPlan['style']>; opening?: string },
): Job<IngestJobResult> {
  if (!ctx.setup) throw new Error('commit_ingest: this server has no setup service enabled');
  return ctx.setup.startIngest(args.previewKey, {
    character: args.character ?? { existing: null, name: '', role: '', goals: [], vows: [] },
    style: args.style ?? {},
    opening: args.opening ?? '',
  });
}

/** `create_custom_world`. The MCP-side counterpart of `POST /api/setup/custom` \u2014 builds an authored world from a description, no wiki involved. Runs as a background job (poll with `get_setup_job`). */
export function createCustomWorldTool(
  ctx: McpToolContext,
  args: { description: string; style?: Partial<IngestPlan['style']> },
): Job<ApplyCustomResult> {
  if (!ctx.setup) throw new Error('create_custom_world: this server has no setup service enabled');
  return ctx.setup.startCustomWorld(args.description.trim(), args.style);
}

/** `use_sample_world`. The MCP-side counterpart of `POST /api/setup/sample` \u2014 the built-in example, for trying the engine with no setup at all. */
export function useSampleWorldTool(ctx: McpToolContext) {
  if (!ctx.setup) throw new Error('use_sample_world: this server has no setup service enabled');
  return ctx.setup.useSample();
}

/** `list_world_packs`. The MCP-side counterpart of `GET /api/setup/packs` \u2014 the shipped original worlds and the scenarios each one offers. */
export function listWorldPacksTool(ctx: McpToolContext) {
  if (!ctx.setup) throw new Error('list_world_packs: this server has no setup service enabled');
  return { packs: ctx.setup.packs() };
}

/**
 * `use_world_pack`. The MCP-side counterpart of `POST /api/setup/pack`.
 *
 * Rebinds `currentStory` for the same reason the HTTP route does: installing a
 * pack creates one story per scenario, so the story this server was bound to
 * beforehand is not the one that was just chosen. Without the rebind the caller
 * would install a world and then keep playing a different one.
 */
export function useWorldPackTool(ctx: McpToolContext, args: { packId: string; scenarioId?: string }) {
  if (!ctx.setup) throw new Error('use_world_pack: this server has no setup service enabled');
  const result = ctx.setup.usePack(args.packId, args.scenarioId);
  ctx.currentStory?.switchTo(result.storyId);
  return result;
}

/** `get_setup_job`. Polls a job started by discover_world/commit_ingest/create_custom_world. The MCP-side counterpart of `GET /api/setup/job/:id`. */
export function getSetupJobTool(ctx: McpToolContext, args: { id: string }) {
  if (!ctx.setup) throw new Error('get_setup_job: this server has no setup service enabled');
  const job = ctx.setup.jobs.get(args.id);
  if (!job) throw new Error(`get_setup_job: no such job ${args.id}`);
  return job;
}

/** `cancel_setup_job`. The MCP-side counterpart of `POST /api/setup/job/:id/cancel` \u2014 cooperative cancellation; keeps whatever the job already wrote. */
export function cancelSetupJobTool(ctx: McpToolContext, args: { id: string }) {
  if (!ctx.setup) throw new Error('cancel_setup_job: this server has no setup service enabled');
  return { cancelled: ctx.setup.jobs.cancel(args.id) };
}

/**
 * `reset_world`. The MCP-side counterpart of `POST /api/setup/reset` \u2014 wipes
 * the whole world file (canon included, every story dropped, one blank story
 * created to replace them) so the wizard can be run again. Genuinely
 * destructive \u2014 there is no undo, and unlike `create_story`/`fork_story` this
 * discards every existing story in the file, not just the current one.
 */
export function resetWorldTool(ctx: McpToolContext) {
  if (!ctx.setup) throw new Error('reset_world: this server has no setup service enabled');
  const storyId = ctx.setup.reset();
  ctx.currentStory?.switchTo(storyId);
  return { ok: true, storyId };
}

// ------------------------------------------- ChatGPT search/fetch compatibility

/**
 * `search` and `fetch` — the two read-only tools OpenAI's own MCP guide says a
 * server "should implement" for ChatGPT's plugin/deep-research surfaces
 * (confirmed against platform.openai.com/docs/mcp, not inferred only from
 * `.design/MCP-CONNECTOR.md` §4, which predicted this gap and listed the pair
 * as not started).
 *
 * Why they exist alongside the richer tools above rather than replacing any of
 * them: ChatGPT looks these up *by name*. Our nearest equivalent is called
 * `search_entities`, and nothing was named `fetch` at all, so an authenticated
 * ChatGPT connector discovered zero tools it recognized — the exact symptom
 * that prompted this. Claude accepts any tool shape and was unaffected either
 * way; this is purely additive, so it stays unaffected.
 *
 * The `{id, title, url}` / `{id, title, text, url, metadata}` shapes are
 * OpenAI's, not ours.
 *
 * Ids are passed through *verbatim*, with no wrapper prefix of our own,
 * because every id this returns is already self-identifying: facts are
 * `fact:<uuid>` (`ChronicleStore.addFact`), threads `thread:<uuid>`
 * (`world.ts`), turns `turn:<uuid>` (`ChronicleStore.addTurn`), and entities
 * carry a type prefix (`char:`, `place:`, ...). An earlier draft here added its
 * own `entity:`/`fact:`/... prefix and stripped it again in `fetch`; that
 * double-prefixed the three that were already prefixed, and — caught by the
 * round-trip test below rather than by reading it — broke `fetch` on a *bare*
 * native turn id, since stripping `turn:` left an id `getTurn` cannot match.
 * Dispatching on the native prefix removes the whole class of bug and makes a
 * bare id from any other tool work for free.
 *
 * `url` is required by the shape but this app has no per-resource public URLs
 * (the inspector is a SPA with client-side routing, and a deployment may be
 * IP-allowlisted or not public at all — see `deploy/README.md`). A stable
 * `fabulist://` URI is honest about being an identifier rather than inventing
 * an `https://` link that would 404 for whoever clicked it.
 */
function searchUri(id: string): string {
  return `fabulist://${id}`;
}

export function searchTool(ctx: McpToolContext, args: { query: string }) {
  const world = ctx.world();
  const query = args.query.trim();
  const results: Array<{ id: string; title: string; url: string }> = [];

  if (!query) return { results };

  for (const entity of world.graph.search(query, 20)) {
    results.push({ id: entity.id, title: `${entity.name} — ${entity.type}`, url: searchUri(entity.id) });
  }

  // Facts and threads have no store-level text search (unlike `graph.search`),
  // so they are filtered here. Case-insensitive substring, deliberately the
  // same crude match the rest of this app uses for prose-ish text; anything
  // smarter belongs in the store, shared with the web UI, not bolted on here.
  const needle = query.toLowerCase();

  for (const fact of world.chronicle.facts(500)) {
    if (!fact.text.toLowerCase().includes(needle)) continue;
    results.push({
      id: fact.id,
      title: fact.text.length > 80 ? `${fact.text.slice(0, 77)}...` : fact.text,
      url: searchUri(fact.id),
    });
  }

  for (const thread of world.threads.all()) {
    if (!`${thread.title} ${thread.stakes}`.toLowerCase().includes(needle)) continue;
    results.push({
      id: thread.id,
      title: `${thread.title} (tension ${thread.tension})`,
      url: searchUri(thread.id),
    });
  }

  return { results };
}

/**
 * `fetch`. Resolves any id `search` returned — or any id a calling model saw
 * from one of the other tools — to full text plus metadata.
 */
export function fetchTool(ctx: McpToolContext, args: { id: string }) {
  const world = ctx.world();
  const id = args.id.trim();

  if (id.startsWith('fact:')) {
    const fact = world.chronicle.facts(1000).find((f) => f.id === id);
    if (!fact) throw new Error(`fetch: no fact ${id}`);
    return {
      id,
      title: 'Fact',
      text: fact.text,
      url: searchUri(id),
      metadata: { scene: fact.scene, layer: fact.layer },
    };
  }

  if (id.startsWith('thread:')) {
    const thread = world.threads.all().find((t) => t.id === id);
    if (!thread) throw new Error(`fetch: no thread ${id}`);
    const text = [
      thread.title,
      `Stakes: ${thread.stakes}`,
      `Possible resolutions:\n${thread.resolutions.map((r) => `- ${r}`).join('\n')}`,
    ].join('\n');
    return {
      id,
      title: thread.title,
      text,
      url: searchUri(id),
      metadata: {
        tension: thread.tension,
        status: thread.status,
        parties: thread.parties,
        createdScene: thread.createdScene,
      },
    };
  }

  if (id.startsWith('turn:')) {
    const turn = world.chronicle.getTurn(id);
    if (!turn) throw new Error(`fetch: no turn ${id}`);
    return {
      id,
      title: `Scene ${turn.scene}, turn ${turn.turn}`,
      text: turn.bookProse,
      url: searchUri(id),
      metadata: { scene: turn.scene, turn: turn.turn, rawInput: turn.rawInput, pinned: turn.pinned },
    };
  }

  // Anything else is an entity id (`char:`, `place:`, ...) or a plain name a
  // model passed through from get_cast.
  const entity = world.graph.get(id) ?? world.graph.resolveName(id);
  if (!entity) {
    throw new Error(`fetch: unrecognized id '${id}' (expected an id from search, or an entity name)`);
  }
  const sheet = world.cast.get(entity.id) ?? null;
  const neighbours = world.graph
    .neighbours(entity.id)
    .map((n) => `${n.edge.predicate} → ${world.graph.get(n.otherId)?.name ?? n.otherId}`);
  const text = [
    `${entity.name} (${entity.type})`,
    entity.summary,
    neighbours.length ? `\nRelations:\n${neighbours.map((l) => `- ${l}`).join('\n')}` : '',
    sheet ? `\nSheet:\n${JSON.stringify(sheet, null, 2)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: entity.id,
    title: entity.name,
    text,
    url: searchUri(entity.id),
    metadata: { type: entity.type, layer: entity.layer, provenance: entity.provenance, confidence: entity.confidence },
  };
}
