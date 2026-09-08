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
import type { McpAuth } from './auth.ts';
import {
  commitNarrationTool,
  fetchTool,
  getBookTool,
  getCastTool,
  getEntityTool,
  getFactsTool,
  getStateTool,
  getThreadsTool,
  listStoriesTool,
  listWorldsTool,
  proposeTurnTool,
  resolveInterruptTool,
  searchEntitiesTool,
  searchTool,
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
function buildServer(ctx: McpToolContext): McpServer {
  const server = new McpServer({ name: 'fabulist', version: '0.1.0' });

  server.registerTool(
    'list_worlds',
    { description: 'List every world (shared canon + graph) this deployment knows about, marking which one is currently open.' },
    async () => toolResult(listWorldsTool(ctx)),
  );

  server.registerTool(
    'list_stories',
    { description: 'List every story (an independent playthrough) in the currently open world, marking which one is current.' },
    async () => toolResult(listStoriesTool(ctx)),
  );

  server.registerTool(
    'get_state',
    { description: 'Session position (scene/turn), entity/edge counts, pending consequences, and token usage for the current story.' },
    async () => toolResult(getStateTool(ctx)),
  );

  server.registerTool(
    'get_cast',
    {
      description: 'The cast of characters, or one character sheet by name (identity, contract/vows, voice, condition, appearance).',
      inputSchema: { name: z.string().optional().describe('A character name to resolve one sheet; omit to list the whole cast.') },
    },
    async ({ name }) => toolResult(getCastTool(ctx, { name })),
  );

  server.registerTool(
    'get_entity',
    {
      description: 'One entity (any type — character, place, faction, item) by id or name, with its live edges to neighbouring entities.',
      inputSchema: {
        id: z.string().optional().describe("Entity id, e.g. 'char:brother-anselm'."),
        name: z.string().optional().describe('Entity name, resolved if id is omitted.'),
      },
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
    },
    async ({ query, limit }) => toolResult(searchEntitiesTool(ctx, { query, limit })),
  );

  server.registerTool(
    'get_threads',
    { description: 'Every open and resolved narrative thread (tension dial, stakes, parties, possible resolutions) in the current story.' },
    async () => toolResult(getThreadsTool(ctx)),
  );

  server.registerTool(
    'get_facts',
    {
      description: 'Facts established as true in the current story\u2019s world (not who knows them \u2014 see the epistemics fields on get_cast for that).',
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => toolResult(getFactsTool(ctx, { limit })),
  );

  server.registerTool(
    'get_book',
    {
      description: 'The story so far: recorded turns in order (raw player input plus committed prose for each).',
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
    },
    async ({ limit }) => toolResult(getBookTool(ctx, { limit })),
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
        prose: z.string().describe('The finished prose for this turn, written from the narratorSystemPrompt and sceneFrame you were given.'),
      },
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
    },
    async ({ originalText, effect, actorId }) => toolResult(await resolveInterruptTool(ctx, { originalText, effect, actorId })),
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
    },
    async ({ query }) => toolResult(searchTool(ctx, { query })),
  );

  server.registerTool(
    'fetch',
    {
      description:
        'Retrieve the full text and metadata of one item returned by `search`, by its id. Also accepts a bare entity id or turn id.',
      inputSchema: { id: z.string().describe('An id from a `search` result, e.g. "entity:char:brother-anselm" or "thread:...".') },
    },
    async ({ id }) => toolResult(fetchTool(ctx, { id })),
  );

  return server;
}

export interface McpRouteOptions {
  toolContext: McpToolContext;
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

  const server = buildServer(opts.toolContext);
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
