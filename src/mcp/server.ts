/**
 * MCP transport. See `.design/MCP-CONNECTOR.md`.
 *
 * Wires `src/mcp/tools.ts`'s plain functions to the official
 * `@modelcontextprotocol/sdk`'s wire protocol, and `src/mcp/auth.ts`'s
 * bearer-token check to every request before the SDK ever sees it.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) deliberately: this
 * server's actual state lives in the world/story SQLite files and in
 * `Engine`'s own `pending` map (see `commitExternalNarration`), not in an
 * MCP session — a fresh `McpServer`/transport pair per HTTP request costs
 * nothing that matters here and sidesteps every session-affinity question a
 * stateful transport would raise behind a load balancer later.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import type { McpAuth, VerifiedUser } from './auth.ts';
import { addDefaultOutputSchema } from './output-schema.ts';
import {
  addAnchorTool,
  addDirectiveTool,
  branchStoryToFileTool,
  cancelSetupJobTool,
  closeSceneTool,
  commitIngestTool,
  commitNarrationTool,
  compactTool,
  composeIllustrationPromptTool,
  createCustomWorldTool,
  createStoryTool,
  deleteDirectiveTool,
  deleteIllustrationTool,
  discoverWorldTool,
  fetchTool,
  forkStoryTool,
  generatePortraitTool,
  generateSceneIllustrationTool,
  getBookTool,
  getCastTool,
  getEntityTool,
  getFactsTool,
  getSetupJobTool,
  getStateTool,
  getThreadsTool,
  lockSheetFieldTool,
  listCharactersTool,
  listStoriesTool,
  listWorldsTool,
  pinTurnTool,
  planWorldTool,
  playTool,
  previewIngestTool,
  proposeTurnTool,
  regenerateTurnTool,
  removeEdgeTool,
  replaceTurnProseTool,
  resetWorldTool,
  resolveInterruptTool,
  resolveWikiTool,
  rollbackTool,
  searchEntitiesTool,
  setCurrentLocationTool,
  searchTool,
  startStoryTool,
  switchStoryTool,
  switchWorldTool,
  tickTool,
  updateKnobsTool,
  upsertEdgeTool,
  upsertEntityTool,
  updateSheetTool,
  updateStyleTool,
  updateThreadTool,
  useSampleWorldTool,
  listWorldPacksTool,
  useWorldPackTool,
  type McpToolContext,
} from './tools.ts';

/** Every tool's result, JSON-stringified into the one `content` block every MCP client already knows how to render, plus the same value as `structuredContent` for a client that reads that instead — the dual-encoding OpenAI's own MCP compatibility guide documents (see `.design/MCP-CONNECTOR.md` §4). */
function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * Builds one `McpServer` with every tool registered against a given
 * `McpToolContext`. Called fresh per request (see the header comment on
 * statelessness) — cheap, since this only registers closures, it does not
 * open anything.
 */
/**
 * What the client is told about this server on `initialize`, before it has
 * called anything.
 *
 * Not decoration. Fifty-odd tools with good individual descriptions still do
 * not tell a model the *order*, and two of the orderings here are not
 * guessable: that `propose_turn` writes nothing until `commit_narration`
 * follows it, and that a world with canon can still have no protagonist. A
 * client that guesses wrong produces exactly the failure this server was
 * observed in — a book that reads beautifully in the chat transcript and is
 * empty on disk, because the prose was never committed.
 *
 * Kept as prose rather than a tool list: clients surface this verbatim to the
 * model, so it competes with the tool descriptions for attention and should
 * say only what those cannot.
 */
const INSTRUCTIONS = `Fabulist is a state-first fiction engine: the world is a graph in a database, and
prose is a view over it. Your job is to write the prose; the server owns the world model.

Getting oriented
1. \`list_worlds\`, then \`switch_world\` to pick one. Worlds hold canon (a wiki ingest or an authored
   setting) and are shared; books are the playthroughs inside them.
2. \`list_stories\` shows the books you own here. \`create_story\` makes a new one, \`switch_story\`
   opens it. A new book is empty by design — it shares the world's canon and nothing else.
3. \`get_state\` tells you where you are. If it reports no player character, the book is not
   playable yet: \`list_characters\` to see who is available, then \`start_story\` to become one of
   them (or to place an original). \`start_story\` returns a proposed opening line to play from.

Playing a turn — the part worth reading twice
The normal loop is two calls, and skipping the second one loses the turn:
  a. \`propose_turn\` with what the player does, in their words. The server runs its gates
     (does this fit the character, does it fit the world, what happens next) and stops before any
     prose exists. It returns \`narratorSystemPrompt\` + \`sceneFrame\`.
  b. You write the prose from that frame, then call \`commit_narration\` with it and the
     \`resumeToken\`. NOTHING IS SAVED UNTIL THIS CALL. Prose you only put in the chat is not in
     the book; the world model never sees it, and the next turn will not know it happened.
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
  next; \`add_anchor\` pins a passage as a style reference.

Ingesting a world
\`resolve_wiki\` → \`plan_world\` → \`preview_ingest\` (or \`discover_world\` for progress) →
\`commit_ingest\`. Previews cost nothing and report page counts and money; commit is the step that
writes canon. \`maxPages\`/\`passBMaxPages\` are separate budgets — reading pages is cheap, relation
extraction is one model call per page.`;

/**
 * What a connector-picker UI (Claude Desktop's "Add connector" list, ChatGPT's connector
 * card, ...) shows *before* anyone has connected — as opposed to `INSTRUCTIONS`, which the
 * model sees only after a session is already live. The MCP spec carries this as optional
 * fields on `initialize`'s `serverInfo` (`Implementation extends BaseMetadata, Icons`); most
 * clients ignore them, but the first-party ones (Claude, ChatGPT) render `title`/`description`
 * and the first usable `icons` entry, the same way Box/Airtable/Google Drive's own connectors
 * do. Mirrors `web/public/manifest.webmanifest`'s copy and icon set exactly, so the connector
 * card and the installed-PWA icon are the one asset a designer already approved, not a second
 * one invented here — the icons resolve against `resourceUrl`'s origin because that is the
 * only base URL this stateless, per-request handler is ever given (see `McpRouteOptions`
 * below); `web/public/*` is served unauthenticated (`PUBLIC_FILES`, `src/server/api.ts`), so a
 * client that has not connected yet can still fetch them.
 */
function serverInfo(resourceUrl: string) {
  const icon = (path: string, mimeType: string, sizes: string[]) => ({
    src: new URL(path, resourceUrl).toString(),
    mimeType,
    sizes,
  });
  return {
    name: 'fabulist',
    title: 'Fabulist',
    version: '0.1.0',
    description: 'A state-first fiction engine: the prose is a view, the world is the graph underneath.',
    icons: [
      icon('/favicon.svg', 'image/svg+xml', ['any']),
      icon('/icon-192.png', 'image/png', ['192x192']),
      icon('/icon-512.png', 'image/png', ['512x512']),
    ],
  };
}

function buildServer(ctx: McpToolContext, resourceUrl: string): McpServer {
  const server = new McpServer(serverInfo(resourceUrl), { instructions: INSTRUCTIONS });
  addDefaultOutputSchema(server);

  server.registerTool(
    'list_worlds',
    {
      description:
        'List every world (shared canon + graph) this deployment knows about, marking which one is currently open.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(listWorldsTool(ctx)),
  );

  server.registerTool(
    'switch_world',
    {
      description:
        'Switch which world every subsequent tool call operates on (list_stories, get_cast, get_facts, propose_turn, ...). ' +
        'Takes effect immediately, no restart \u2014 use the slug from list_worlds.',
      inputSchema: { slug: z.string().describe("A world's slug, from list_worlds.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ slug }) => toolResult(switchWorldTool(ctx, { slug })),
  );

  server.registerTool(
    'list_stories',
    {
      description:
        'List every story (an independent playthrough) in the currently open world, marking which one is current.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(listStoriesTool(ctx)),
  );

  server.registerTool(
    'create_story',
    {
      description:
        'Start a fresh, non-overlapping story in the currently open world, sharing only its canon (no chronicle copied). ' +
        'Does not switch to it \u2014 call switch_story with the returned id to open it.',
      inputSchema: { title: z.string().optional().describe('A title for the new story; omit for untitled.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) => toolResult(createStoryTool(ctx, { title })),
  );

  server.registerTool(
    'fork_story',
    {
      description:
        'Branch a story: omit atScene for a fresh copy sharing canon only (a parallel "what if"), or pass it to copy that ' +
        "story's chronicle up to that scene boundary first (a continuation from an earlier point). Does not switch to the fork.",
      inputSchema: {
        fromStoryId: z.string().optional().describe('The story to fork from; defaults to whichever story is current.'),
        title: z.string().optional(),
        atScene: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Copy the source story\u2019s chronicle up to (not including) this scene.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ fromStoryId, title, atScene }) => toolResult(forkStoryTool(ctx, { fromStoryId, title, atScene })),
  );

  server.registerTool(
    'rollback',
    {
      description:
        'Undo the last chapter or scene of the currently open story \u2014 the backward move fork_story never covered. ' +
        "Pass exactly one of scene or chapter. Defaults to mode 'fork': branches at the target boundary into a new " +
        'sibling story and switches to it, leaving the discarded tail intact as a story you can still open. Pass ' +
        "mode 'destructive' to truncate the current story in place instead, with no sibling and no way back.",
      inputSchema: {
        scene: z.number().int().positive().optional().describe('Roll back to the start of this scene.'),
        chapter: z.number().int().positive().optional().describe('Roll back to the start of this chapter.'),
        mode: z
          .enum(['fork', 'destructive'])
          .optional()
          .describe("Defaults to 'fork' (safe, keeps the tail as a sibling story)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ scene, chapter, mode }) => toolResult(rollbackTool(ctx, { scene, chapter, mode })),
  );

  server.registerTool(
    'switch_story',
    {
      description:
        'Switch which story, within the currently open world, every subsequent tool call operates on (get_state, get_cast, propose_turn, ...). ' +
        'Takes effect immediately \u2014 use an id from list_stories, create_story, or fork_story.',
      inputSchema: { id: z.string().describe("A story's id, from list_stories, create_story, or fork_story.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(switchStoryTool(ctx, { id })),
  );

  server.registerTool(
    'get_state',
    {
      description:
        'Session position (scene/turn), entity/edge counts, pending consequences, and token usage for the current story.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(getStateTool(ctx)),
  );

  server.registerTool(
    'get_cast',
    {
      description:
        'The cast of characters, or one character sheet by name (identity, contract/vows, voice, condition, appearance).',
      inputSchema: {
        name: z.string().optional().describe('A character name to resolve one sheet; omit to list the whole cast.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => toolResult(getCastTool(ctx, { name })),
  );

  server.registerTool(
    'get_entity',
    {
      description:
        'One entity (any type — character, place, faction, item) by id or name, with its live edges to neighbouring entities.',
      inputSchema: {
        id: z.string().optional().describe("Entity id, e.g. 'char:brother-anselm'."),
        name: z.string().optional().describe('Entity name, resolved if id is omitted.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, name }) => toolResult(getEntityTool(ctx, { id, name })),
  );

  server.registerTool(
    'search_entities',
    {
      description: 'Free-text search over every entity in the world graph (characters, places, factions, items).',
      inputSchema: {
        query: z.string().describe('Search text.'),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => toolResult(searchEntitiesTool(ctx, { query, limit })),
  );

  server.registerTool(
    'upsert_entity',
    {
      description: 'Create or update an entity in this story’s graph. Manual edits shadow canon only in this story.',
      inputSchema: {
        id: z.string().optional().describe('Canonical entity id; omit to derive one from type and name.'),
        type: z.enum(['character', 'location', 'faction', 'item', 'concept', 'event']),
        name: z.string(),
        summary: z.string().optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, type, name, summary, attributes }) =>
      toolResult(upsertEntityTool(ctx, { id, type, name, summary, attributes })),
  );

  server.registerTool(
    'upsert_edge',
    {
      description:
        'Create or update a live relationship edge. Use ids when possible; exact unambiguous names also resolve.',
      inputSchema: {
        from: z.string(),
        relation: z.string(),
        to: z.string(),
        attributes: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional weight (number) and note (string).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, relation, to, attributes }) => toolResult(upsertEdgeTool(ctx, { from, relation, to, attributes })),
  );

  server.registerTool(
    'remove_edge',
    {
      description: 'Retire a live relationship edge while retaining its history.',
      inputSchema: { from: z.string(), relation: z.string(), to: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, relation, to }) => toolResult(removeEdgeTool(ctx, { from, relation, to })),
  );

  server.registerTool(
    'set_current_location',
    {
      description: 'Set the active story and current scene location to an existing Location entity.',
      inputSchema: { entityId: z.string().optional(), name: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, name }) => toolResult(setCurrentLocationTool(ctx, { entityId, name })),
  );

  server.registerTool(
    'get_threads',
    {
      description:
        'Every open and resolved narrative thread (tension dial, stakes, parties, possible resolutions) in the current story.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(getThreadsTool(ctx)),
  );

  server.registerTool(
    'get_facts',
    {
      description:
        'Facts established as true in the current story\u2019s world (not who knows them \u2014 see the epistemics fields on get_cast for that).',
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => toolResult(getFactsTool(ctx, { limit })),
  );

  server.registerTool(
    'get_book',
    {
      description: 'The story so far: recorded turns in order (raw player input plus committed prose for each).',
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => toolResult(getBookTool(ctx, { limit })),
  );

  server.registerTool(
    'list_characters',
    {
      description:
        'Candidate protagonists in the current story\u2019s world, ranked by connectedness, each flagged with whether it already ' +
        'has vows. Use this to find who is available before calling start_story \u2014 most useful right after an ingest, when ' +
        'the world has entities but no protagonist yet.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(listCharactersTool(ctx)),
  );

  server.registerTool(
    'start_story',
    {
      description:
        'Set (or replace) the current story\u2019s protagonist and get an opening line to play from. Pass existing (a name from ' +
        'list_characters) to adopt a wiki character as-is, or name/role/goals/vows with existing omitted to place an original ' +
        'character instead. This is the tool that turns a freshly ingested world into a playable one.',
      inputSchema: {
        existing: z.string().optional().describe('A character name from list_characters to adopt as the protagonist.'),
        name: z.string().optional().describe('Name for an original character; ignored if existing is set.'),
        role: z.string().optional().describe('A one-line role/summary for an original character.'),
        goals: z.array(z.string()).optional(),
        vows: z.array(z.object({ text: z.string(), rank: z.number() })).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ existing, name, role, goals, vows }) =>
      toolResult(startStoryTool(ctx, { existing, name, role, goals, vows })),
  );

  server.registerTool(
    'play',
    {
      description:
        'Play one turn with this server writing the prose itself (billed to this server\u2019s own configured Narrator provider, not you). ' +
        'The finished turn comes back in one call \u2014 the alternative to propose_turn/commit_narration for a caller that would rather ' +
        'not implement the two-step split, or whose own model should not be the one writing this world\u2019s prose style.',
      inputSchema: {
        input: z.string().describe("The player's turn, in their own words."),
        overrideIntegrity: z
          .boolean()
          .optional()
          .describe('Bypass the character-integrity gate, same as resolve_interrupt\u2019s "override".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ input, overrideIntegrity }) => toolResult(await playTool(ctx, { input, overrideIntegrity })),
  );

  server.registerTool(
    'propose_turn',
    {
      description:
        'Play one turn. Runs the world-model gates (character integrity, world plausibility, what happens next) server-side and stops before writing prose: ' +
        'you (the calling model) write the prose yourself from the returned narratorSystemPrompt + sceneFrame, then call commit_narration with it. ' +
        "If the action would breach the character's own established contract (a vow, a settled trait), this returns status 'interrupted' with the " +
        'options a human author would see; call resolve_interrupt with one of them rather than commit_narration. ' +
        "If the input was an out-of-fiction question about the world rather than an action, this returns status 'answered' with the answer directly \u2014 nothing to narrate.",
      inputSchema: {
        text: z.string().describe("The player's turn, in their own words \u2014 shorthand is fine."),
        actorId: z.string().optional().describe('Override which character acts; defaults to the player character.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, actorId }) => toolResult(await proposeTurnTool(ctx, { text, actorId })),
  );

  server.registerTool(
    'commit_narration',
    {
      description:
        'Finish a turn started by propose_turn (status "awaiting-narration") or resolve_interrupt, given the prose you wrote from its returned frame. ' +
        'Runs the prose gate, extracts the state delta, and commits it \u2014 the same steps a turn always runs after its prose exists, regardless of who wrote it.',
      inputSchema: {
        resumeToken: z.string().describe('The resumeToken from the awaiting-narration response this completes.'),
        prose: z
          .string()
          .describe(
            'The finished prose for this turn, written from the narratorSystemPrompt and sceneFrame you were given.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ resumeToken, prose }) => toolResult(await commitNarrationTool(ctx, { resumeToken, prose })),
  );

  server.registerTool(
    'resolve_interrupt',
    {
      description:
        'Answer an interrupt returned by propose_turn (a character-integrity gate stop). Pass the same originalText the interrupted response gave you, ' +
        "and the option's effect the user picked. 'override' and 'establish-break' proceed to awaiting-narration, same as propose_turn; " +
        "'revise' and 'switch-character' write nothing \u2014 ask the user for different input instead.",
      inputSchema: {
        originalText: z.string().describe('The originalText field from the interrupted propose_turn response.'),
        effect: z.enum(['override', 'establish-break', 'revise', 'switch-character']),
        actorId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ originalText, effect, actorId }) =>
      toolResult(await resolveInterruptTool(ctx, { originalText, effect, actorId })),
  );

  // ------------------------------------------ other turn/session write tools

  server.registerTool(
    'pin_turn',
    {
      description: 'Pin (or unpin) a turn\u2019s prose so it survives regenerate_turn/compaction untouched.',
      inputSchema: {
        id: z.string().describe('A turn id.'),
        pinned: z.boolean().optional().describe('Defaults to true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, pinned }) => toolResult(pinTurnTool(ctx, { id, pinned })),
  );

  server.registerTool(
    'regenerate_turn',
    {
      description:
        'Re-render one turn\u2019s prose in place \u2014 nothing about what happened changes, only how it reads. Refuses a pinned turn.',
      inputSchema: {
        id: z.string().describe('A turn id.'),
        note: z.string().optional().describe('Guidance for the re-render, e.g. "shorter" or "more tension".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, note }) => toolResult(await regenerateTurnTool(ctx, { id, note })),
  );

  server.registerTool(
    'replace_turn_prose',
    {
      description:
        'Commit exact author-supplied prose for a turn while preserving its existing state delta. This is not regenerate_turn.',
      inputSchema: { id: z.string(), prose: z.string(), stateMode: z.literal('preserve').optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, prose, stateMode }) => toolResult(replaceTurnProseTool(ctx, { id, prose, stateMode })),
  );

  server.registerTool(
    'update_sheet',
    {
      description:
        'Edit a character\u2019s sheet: identity, contract (vows/drives), voice, condition, appearance, or field locks. ' +
        'Each field replaces the sheet\u2019s current value for that section when provided; omit a field to leave it untouched. ' +
        'appearance never touches referenceImagePath/seed through this tool \u2014 those are set only by generate_portrait.',
      inputSchema: {
        id: z.string().describe('A character entity id, e.g. "char:brother-anselm".'),
        identity: z.record(z.string(), z.unknown()).optional(),
        contract: z.record(z.string(), z.unknown()).optional(),
        voice: z.record(z.string(), z.unknown()).optional(),
        condition: z.record(z.string(), z.unknown()).optional(),
        appearance: z.record(z.string(), z.unknown()).optional(),
        locks: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, identity, contract, voice, condition, appearance, locks }) =>
      toolResult(updateSheetTool(ctx, { id, identity, contract, voice, condition, appearance, locks })),
  );

  server.registerTool(
    'lock_sheet_field',
    {
      description:
        'Mark (or unmark) one field path on a character sheet as author-locked, exempt from future auto-drift.',
      inputSchema: {
        id: z.string().describe('A character entity id.'),
        path: z.string().describe('A field path on the sheet, e.g. "identity.arc".'),
        locked: z.boolean().optional().describe('Defaults to true; pass false to unlock.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, path, locked }) => toolResult(lockSheetFieldTool(ctx, { id, path, locked })),
  );

  server.registerTool(
    'update_thread',
    {
      description: 'Edit a narrative thread\u2019s tension, status, title, or stakes.',
      inputSchema: {
        id: z.string().describe('A thread id.'),
        tension: z.number().optional(),
        status: z.string().optional(),
        title: z.string().optional(),
        stakes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, tension, status, title, stakes }) =>
      toolResult(updateThreadTool(ctx, { id, tension, status, title, stakes })),
  );

  server.registerTool(
    'add_directive',
    {
      description:
        'Steer the future: a scene/chapter/campaign-scoped nudge the world model bends toward. Reports the recalculation it ' +
        'triggers (which threads rose or fell), because silent recalculation is how you stop trusting the machinery.',
      inputSchema: {
        text: z.string().describe('The directive itself, in plain language.'),
        scope: z.enum(['scene', 'chapter', 'campaign']).optional().describe('Defaults to "chapter".'),
        strength: z.enum(['hint', 'push', 'mandate']).optional().describe('Defaults to "push".'),
        lifetimeScenes: z.number().int().positive().optional().describe('Defaults to 5.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, scope, strength, lifetimeScenes }) =>
      toolResult(addDirectiveTool(ctx, { text, scope, strength, lifetimeScenes })),
  );

  server.registerTool(
    'delete_directive',
    {
      description: 'Retire a directive (never hard-deleted).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(deleteDirectiveTool(ctx, { id })),
  );

  server.registerTool(
    'update_style',
    {
      description:
        'Merge a partial patch over the current story\u2019s style contract \u2014 POV, tense, register, density, pacing, comparables, ' +
        'visual style, and so on. Only the fields provided change; the rest are left as they are.',
      inputSchema: {
        pov: z.enum(['first', 'third-limited', 'third-omniscient', 'second']).optional(),
        tense: z.enum(['past', 'present']).optional(),
        register: z.enum(['plain', 'clipped', 'lyrical', 'ornate', 'archaic']).optional(),
        density: z.enum(['sparse', 'balanced', 'rich']).optional(),
        dialogueRatio: z.number().optional(),
        genreLens: z.string().optional(),
        humor: z.enum(['none', 'dry', 'absurd']).optional(),
        pacing: z.enum(['languid', 'steady', 'breakneck']).optional(),
        sceneTarget: z.number().int().positive().optional(),
        comparables: z.array(z.string()).optional(),
        forbidden: z.array(z.string()).optional(),
        contentBounds: z.array(z.string()).optional(),
        visualStyle: z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']).optional(),
        visualAnchor: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (patch) => toolResult(updateStyleTool(ctx, patch)),
  );

  server.registerTool(
    'update_knobs',
    {
      description:
        'Merge a partial patch over the current story\u2019s dials \u2014 canon fidelity, character strictness, pacing, danger, ' +
        'NPC agency, propagation depth, ignorance budget, prose density. Only the fields provided change.',
      inputSchema: {
        canonFidelity: z.enum(['strict', 'flexible', 'au']).optional(),
        characterStrictness: z.enum(['permissive', 'coaching', 'strict', 'iron']).optional(),
        pacing: z.number().optional(),
        danger: z.number().optional(),
        npcAgency: z.number().optional(),
        propagationDepth: z.number().optional(),
        ignoranceBudget: z.number().optional(),
        proseDensity: z.number().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (patch) => toolResult(updateKnobsTool(ctx, patch)),
  );

  server.registerTool(
    'add_anchor',
    {
      description: 'Record a style-anchor passage \u2014 prose the player liked, to steer future generation toward.',
      inputSchema: { text: z.string(), note: z.string().optional() },
      outputSchema: { ok: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, note }) => toolResult(addAnchorTool(ctx, { text, note })),
  );

  server.registerTool(
    'generate_portrait',
    {
      description: 'Generate or regenerate a character\u2019s portrait. Sets appearance.referenceImagePath on success.',
      inputSchema: {
        entityId: z.string().describe('A character entity id.'),
        visualStyle: z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ entityId, visualStyle }) => toolResult(await generatePortraitTool(ctx, { entityId, visualStyle })),
  );

  server.registerTool(
    'generate_scene_illustration',
    {
      description: 'Illustrate an already-committed turn, from the cast and location its own delta recorded.',
      inputSchema: {
        turnId: z.string().describe('A turn id.'),
        visualStyle: z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ turnId, visualStyle }) => toolResult(await generateSceneIllustrationTool(ctx, { turnId, visualStyle })),
  );

  server.registerTool(
    'compose_illustration_prompt',
    {
      description:
        'The copy-pasteable prompt/negativePrompt for a portrait or scene, with no provider call \u2014 works even with no image provider ' +
        'configured. Use this when generate_portrait/generate_scene_illustration fail with "no image provider configured", so an ' +
        'illustration request never dead-ends into prose-only without offering the prompt first.',
      inputSchema: {
        subject: z.enum(['portrait', 'scene']),
        entityId: z.string().optional().describe('A character entity id. Required when subject is "portrait".'),
        turnId: z.string().optional().describe('A turn id. Required when subject is "scene".'),
        visualStyle: z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subject, entityId, turnId, visualStyle }) => {
      if (subject === 'portrait') {
        if (!entityId) throw new Error('compose_illustration_prompt: entityId is required when subject is "portrait"');
        return toolResult(await composeIllustrationPromptTool(ctx, { subject, entityId, visualStyle }));
      }
      if (!turnId) throw new Error('compose_illustration_prompt: turnId is required when subject is "scene"');
      return toolResult(await composeIllustrationPromptTool(ctx, { subject, turnId, visualStyle }));
    },
  );

  server.registerTool(
    'delete_illustration',
    {
      description: 'Delete a generated illustration.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(deleteIllustrationTool(ctx, { id })),
  );

  server.registerTool(
    'tick',
    {
      description: 'Advance seeded consequences toward firing and run whatever else the world clock does per tick.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => toolResult(tickTool(ctx)),
  );

  server.registerTool(
    'compact',
    {
      description:
        'Summarise one closed scene on demand (pass scene), or catch up everything that closed unsummarised (omit it).',
      inputSchema: { scene: z.number().int().positive().optional(), force: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ scene, force }) => toolResult(await compactTool(ctx, { scene, force })),
  );

  server.registerTool(
    'close_scene',
    {
      description:
        'Close the current scene by hand. Without this, scene stays 1 forever unless the extractor happens to advance it, ' +
        'and hierarchical compaction never runs.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => toolResult(await closeSceneTool(ctx)),
  );

  server.registerTool(
    'branch_story_to_file',
    {
      description:
        'Fork the save *file* at a scene into a different path on disk, leaving the source completely untouched \u2014 a ' +
        'genuinely separate save to hand off or archive independently. Different from fork_story, which branches within ' +
        'the same world file.',
      inputSchema: {
        atScene: z.number().int().positive().describe('The branch resumes at the start of this scene.'),
        toPath: z.string().describe('Filesystem path for the new save.'),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ atScene, toPath, overwrite }) => toolResult(branchStoryToFileTool(ctx, { atScene, toPath, overwrite })),
  );

  // -------------------------------------------------------- setup wizard tools

  server.registerTool(
    'resolve_wiki',
    {
      description: 'Resolve free text (a franchise/setting name) to candidate wikis, for plan_world/preview_ingest.',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ query }) => toolResult(await resolveWikiTool(ctx, { query })),
  );

  server.registerTool(
    'plan_world',
    {
      description: 'Turn free text plus a resolved wiki (from resolve_wiki) into an editable ingest plan.',
      inputSchema: {
        wish: z.string().describe('What kind of story the player wants.'),
        wiki: z.object({
          name: z.string(),
          baseUrl: z.string(),
          articles: z.number(),
          language: z.string(),
          via: z.enum(['directory', 'slug', 'search', 'explicit']),
          confidence: z.number(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ wish, wiki }) => toolResult(await planWorldTool(ctx, { wish, wiki })),
  );

  // Shared by preview_ingest/discover_world: the budget knobs are identical on
  // both, and a model that learns them on one should not find a different
  // spelling on the other.
  const budgetSchema = {
    maxPages: z
      .union([z.number().int().positive(), z.literal('all')])
      .optional()
      .describe(
        'Pages to keep in scope, overriding the mode preset (skim 150, mid 600, deep 3000). Any size is allowed — there is no ' +
          '3000-page ceiling. "all" means the whole wiki and is only supported for offline dump ingest, not this server-side crawl.',
      ),
    hops: z
      .union([z.number().int().positive(), z.literal('all')])
      .optional()
      .describe('Crawl radius from the seeds, overriding the mode preset (skim 1, mid 2, deep 3).'),
    passBMaxPages: z
      .union([z.number().int().positive(), z.literal('all')])
      .optional()
      .describe(
        'Cap on how many pages the LLM relation-extraction pass runs on, budgeted separately from maxPages because it is one ' +
          'model call per page and dominates both cost and wall-clock. Pages are chosen by crawl score, best first. ' +
          'Use a large maxPages with a small passBMaxPages to build the whole structural graph cheaply.',
      ),
  };

  server.registerTool(
    'preview_ingest',
    {
      description:
        'Crawl and report what an ingest would cost (page count, estimated time), without writing anything. The returned ' +
        'previewKey is what commit_ingest needs \u2014 confirming a preview never re-pays for the crawl. The response\u2019s ' +
        '`budgets` field reports the page/hop/pass-B limits the crawl actually ran with.',
      inputSchema: {
        baseUrl: z.string().describe('Wiki base URL, e.g. "https://memory-alpha.fandom.com".'),
        seeds: z.array(z.string()).describe('Seed page titles to crawl from.'),
        mode: z
          .enum(['skim', 'mid', 'deep', 'all'])
          .optional()
          .describe('Defaults to "mid". "all" is the whole wiki, and needs an offline dump ingest.'),
        excludeCategories: z.array(z.string()).optional(),
        title: z.string().optional(),
        ...budgetSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ baseUrl, seeds, mode, excludeCategories, title, maxPages, hops, passBMaxPages }) =>
      toolResult(
        await previewIngestTool(ctx, { baseUrl, seeds, mode, excludeCategories, title, maxPages, hops, passBMaxPages }),
      ),
  );

  server.registerTool(
    'discover_world',
    {
      description:
        'Same crawl as preview_ingest, run as a background job (poll with get_setup_job) so a slow mid/deep crawl reports ' +
        'real progress. Also refines a character sketch against what the crawl actually found.',
      inputSchema: {
        baseUrl: z.string(),
        seeds: z.array(z.string()),
        mode: z.enum(['skim', 'mid', 'deep', 'all']).optional(),
        character: z
          .object({
            existing: z.string().nullable(),
            name: z.string(),
            role: z.string(),
            goals: z.array(z.string()),
            vows: z.array(z.object({ text: z.string(), rank: z.number() })),
          })
          .optional(),
        excludeCategories: z.array(z.string()).optional(),
        title: z.string().optional(),
        ...budgetSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ baseUrl, seeds, mode, character, excludeCategories, title, maxPages, hops, passBMaxPages }) =>
      toolResult(
        discoverWorldTool(ctx, {
          baseUrl,
          seeds,
          mode,
          character,
          excludeCategories,
          title,
          maxPages,
          hops,
          passBMaxPages,
        }),
      ),
  );

  server.registerTool(
    'commit_ingest',
    {
      description:
        'Commit a previewed scope (previewKey from preview_ingest/discover_world) as a background job (poll with ' +
        'get_setup_job). This is the step that actually writes canon.',
      inputSchema: {
        previewKey: z.string(),
        character: z
          .object({
            existing: z.string().nullable(),
            name: z.string(),
            role: z.string(),
            goals: z.array(z.string()),
            vows: z.array(z.object({ text: z.string(), rank: z.number() })),
          })
          .optional(),
        style: z.record(z.string(), z.unknown()).optional(),
        opening: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewKey, character, style, opening }) =>
      toolResult(commitIngestTool(ctx, { previewKey, character, style, opening })),
  );

  server.registerTool(
    'create_custom_world',
    {
      description:
        'Build an authored world from a plain-language description, no wiki involved. Runs as a background job (poll with get_setup_job).',
      inputSchema: { description: z.string(), style: z.record(z.string(), z.unknown()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ description, style }) => toolResult(createCustomWorldTool(ctx, { description, style })),
  );

  server.registerTool(
    'use_sample_world',
    {
      description: 'Load the built-in example world, for trying the engine with no setup at all.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => toolResult(useSampleWorldTool(ctx)),
  );

  server.registerTool(
    'list_world_packs',
    {
      description:
        'List the shipped original worlds (science fiction, fantasy, historical, contemporary) and the scenarios each one offers.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(listWorldPacksTool(ctx)),
  );

  server.registerTool(
    'use_world_pack',
    {
      description:
        'Install one of the shipped original worlds and open one of its scenarios. Omit scenarioId to take the first. Call list_world_packs first to see the choices.',
      inputSchema: { packId: z.string(), scenarioId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ packId, scenarioId }) => toolResult(useWorldPackTool(ctx, { packId, scenarioId })),
  );

  server.registerTool(
    'get_setup_job',
    {
      description: 'Poll a job started by discover_world, commit_ingest, or create_custom_world.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(getSetupJobTool(ctx, { id })),
  );

  server.registerTool(
    'cancel_setup_job',
    {
      description: 'Cooperatively cancel a running setup job; keeps whatever it already wrote.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(cancelSetupJobTool(ctx, { id })),
  );

  server.registerTool(
    'reset_world',
    {
      description:
        'Wipe the whole world file (canon included, every story dropped, one blank story created to replace them) so the ' +
        'wizard can be run again. Genuinely destructive \u2014 there is no undo.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async () => toolResult(resetWorldTool(ctx)),
  );

  // `search` and `fetch`: the two read-only tools OpenAI's MCP guide says a
  // server should implement for ChatGPT's plugin/deep-research surfaces, which
  // look them up by these exact names. Registered last because they are a
  // compatibility adapter over the tools above, not new capability — see
  // `searchTool`/`fetchTool` in tools.ts for why they exist and what the
  // required result shapes are.
  server.registerTool(
    'search',
    {
      description:
        'Search this world for entities (characters, places, factions, items), established facts, and open narrative threads matching a text query. Returns ids to pass to `fetch` for full detail.',
      inputSchema: { query: z.string().describe('Free-text search query.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query }) => toolResult(searchTool(ctx, { query })),
  );

  server.registerTool(
    'fetch',
    {
      description:
        'Retrieve the full text and metadata of one item returned by `search`, by its id. Also accepts a bare entity id or turn id.',
      inputSchema: {
        id: z.string().describe('An id from a `search` result, e.g. "entity:char:brother-anselm" or "thread:...".'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(fetchTool(ctx, { id })),
  );

  // A prompt, not another tool: this is the "where do I start" entry point a
  // client shows the user as a slash command, and it is the one place that can
  // hand the model the whole loop at once rather than relying on it to have
  // read the server instructions. Registered last so the tool list above reads
  // in dependency order.
  server.registerPrompt(
    'play',
    {
      title: 'Play this world',
      description: 'Open a book in this world and play it, following the propose/commit turn loop correctly.',
      argsSchema: {
        world: z.string().optional().describe('World slug to open. Omit to use whichever is already open.'),
        wish: z.string().optional().describe('What kind of story the player wants, in their own words.'),
      },
    },
    ({ world, wish }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              wish ? `The player wants: ${wish}` : 'Ask the player what kind of story they want.',
              '',
              'Then, in this order:',
              world
                ? `1. switch_world to "${world}".`
                : '1. list_worlds, and ask which one — or use the one already open.',
              '2. list_stories. Open an existing book with switch_story, or create_story for a new one.',
              '3. get_state. If there is no player character, list_characters and then start_story.',
              '4. Play turns: propose_turn, write the prose from the frame it returns, then commit_narration',
              '   with that prose and the resumeToken. The turn is not saved until commit_narration returns —',
              '   prose that only appears in this conversation is not in the book.',
              '5. On an "interrupted" result, show the player the options and use resolve_interrupt.',
              '6. Call close_scene at scene breaks.',
              '',
              'Write in the style the frame asks for, not your own. Keep the player in the fiction:',
              'do not narrate the tool calls.',
              '',
              'Keep the world honest — run this pass at the start of the session and again after any turn',
              'that introduces a new name, place, relationship, or revelation:',
              '',
              '- Read before writing: get_state (position, counts, pending consequences) and get_book',
              '  (recent committed prose), so you know what is already true before adding anything.',
              '- Search before inventing: search_entities for any name/place you are about to introduce —',
              '  do not create a second entity for something that already exists under a slightly',
              '  different name.',
              '- Verify before asserting: cross-check with get_entity/get_facts before treating something as',
              '  established. Do not narrate a new fact that contradicts one already on record.',
              '- Keep dossiers current: when a turn changes what is true about a character — a new wound,',
              '  a revealed allegiance, a broken vow — call update_sheet (identity/contract/voice/condition/',
              '  appearance) rather than letting the prose drift ahead of the sheet. appearance.referenceImagePath',
              '  and .seed are read-only through update_sheet; only generate_portrait writes those.',
              '- Relationships record themselves: commit_narration\u2019s extraction step reads what the prose',
              '  actually depicts and creates the connections — there is no separate "create a connection"',
              '  call. Write the relationship plainly enough in the prose for extraction to catch it, then',
              '  spot-check with get_entity (its neighbours field) that the edge actually landed.',
              '- Respect pace and stakes: before improvising tone or intensity, check get_state\u2019s knobs',
              '  (danger, pacing, characterStrictness, canonFidelity, propagationDepth, ignoranceBudget,',
              '  proseDensity) and get_threads\u2019 stakes/tension for every open thread. Follow those dials —',
              '  do not silently drift them. update_knobs/update_thread exist for when the player explicitly',
              '  asks to change one.',
              '- If generate_portrait or generate_scene_illustration fail with "no image provider configured",',
              '  call compose_illustration_prompt instead — it returns the same prompt/negativePrompt with no',
              '  provider needed, ready to paste into any image tool, before falling back to prose-only.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

export interface McpRouteOptions {
  /**
   * Builds the tool context for one request, given the identity the bearer
   * token proved.
   *
   * A factory rather than a value because the context is now per-*caller*:
   * `world()` inside it resolves through `CurrentStory.worldFor(user)`, so two
   * MCP clients authenticated as two people must not share one context. The
   * previous shape handed every request the same server-wide context, which is
   * why an MCP-created story ended up owned by nobody while the verified `sub`
   * sat unused in `AuthInfo`.
   */
  toolContext: (user: VerifiedUser) => McpToolContext | Promise<McpToolContext>;
  auth: McpAuth;
  /** The canonical URL of this MCP endpoint, e.g. `https://fabulist.example.com/mcp` \u2014 what `WWW-Authenticate` and the protected-resource metadata point back at (MCP spec's own resource-indicator requirement, RFC 8707; see `.design/MCP-CONNECTOR.md` \u00a71). */
  resourceUrl: string;
}

/** `WWW-Authenticate` on every 401 this route returns \u2014 not optional: it is how a compliant MCP client discovers where to authenticate at all (see `auth.ts`'s header comment and the MCP spec's own sequence diagram). */
function wwwAuthenticateHeader(resourceUrl: string): string {
  return [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${new URL('/.well-known/oauth-protected-resource', resourceUrl).toString()}"`,
  ].join(', ');
}

/**
 * Handles one request to the `/mcp` route. Verifies the bearer token first —
 * before the SDK's transport is even constructed — so an invalid or missing
 * token never reaches tool-calling code at all, matching AuthKit's own
 * documented middleware shape (`.design/MCP-CONNECTOR.md` \u00a71) rather than
 * inventing a different check-late pattern.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  opts: McpRouteOptions,
): Promise<void> {
  let verified: { userId: string; raw: Record<string, unknown> };
  try {
    verified = await opts.auth.verify(req.headers.authorization);
  } catch {
    // Every failure mode (missing header, malformed token, expired,
    // wrong audience) reports the same 401 + WWW-Authenticate: MCP clients
    // branch on the *header*, not on distinguishing failure reasons, and
    // handing an unauthenticated caller a more specific reason ("wrong
    // audience" vs "expired") is free information for an attacker and no
    // help to a legitimate client, which just needs to know "go log in."
    res.setHeader('WWW-Authenticate', wwwAuthenticateHeader(opts.resourceUrl));
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const authInfo: AuthInfo = {
    token: '',
    clientId: verified.userId,
    scopes: [],
    extra: { userId: verified.userId, claims: verified.raw },
  };
  const reqWithAuth = Object.assign(req, { auth: authInfo });

  const server = buildServer(await opts.toolContext(verified), opts.resourceUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(reqWithAuth, res, body);
  } finally {
    res.on('close', () => {
      transport.close();
      server.close();
    });
  }
}

/** The `/.well-known/oauth-protected-resource` document every MCP client fetches on first 401, per RFC 9728. */
export function protectedResourceMetadata(auth: McpAuth, resourceUrl: string) {
  return auth.protectedResourceMetadata(resourceUrl);
}
