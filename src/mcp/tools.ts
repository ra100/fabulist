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
import type { CurrentStory, CurrentWorld, World } from '../store/index.ts';
import { listStories } from '../store/world.ts';
import { listWorlds } from '../store/worlds.ts';

export interface McpToolContext {
  /** Resolves fresh per call, exactly like every route in `api.ts` does — a story/world switch must take effect on the next call, not after a restart. */
  world: () => World;
  engine: Engine;
  currentStory?: CurrentStory;
  currentWorld?: CurrentWorld;
  dataRoot: string;
}

// -------------------------------------------------------------- read tools

export function listWorldsTool(ctx: McpToolContext) {
  const worlds = listWorlds(ctx.dataRoot);
  const current = ctx.currentWorld?.slug();
  return {
    worlds: worlds.map((w) => ({ ...w, current: w.slug === current })),
  };
}

export function listStoriesTool(ctx: McpToolContext) {
  const world = ctx.world();
  const stories = listStories(world.db);
  return {
    stories: stories.map((s) => ({ ...s, current: s.id === world.storyId })),
  };
}

export function getStateTool(ctx: McpToolContext) {
  const world = ctx.world();
  const session = world.session.get();
  return {
    session,
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
  const outcome = await ctx.engine.takeTurn(args.text, {
    narrateExternally: true,
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
  if (outcome.kind === 'interrupted') {
    return {
      status: 'interrupted' as const,
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
    return { status: 'answered' as const, text: outcome.text };
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
  const outcome = await ctx.engine.commitExternalNarration(args.resumeToken, args.prose);
  if (outcome.kind === 'narrated') {
    return {
      status: 'narrated' as const,
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
  throw new Error(`commit_narration: unexpected outcome kind ${outcome.kind} — this should be unreachable post-narrate`);
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
  args: { originalText: string; effect: 'override' | 'establish-break' | 'revise' | 'switch-character'; actorId?: string },
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
