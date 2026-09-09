/**
 * HTTP API for the inspector UI. See DESIGN.md §11.
 *
 * Plain node:http — the surface is about twenty routes and a framework would
 * only add indirection. The UI is essentially a debugger for the world model,
 * so most routes are reads.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Engine } from '../loop/engine.ts';
import type { CurrentStory, CurrentWorld, World } from '../store/index.ts';
import { forkStory, rollback } from '../loop/branch.ts';
import { exportMarkdown, exportPlainText } from '../loop/export.ts';
import { createStory, deleteStory, getStory, listStories, listStoriesForUser } from '../store/world.ts';
import { createWorldFile, deleteWorldFile, listWorlds, renameWorldFile, replaceWorldFile } from '../store/worlds.ts';
import {
  applyDirectiveRecalc,
  seedConsequences,
  tickConsequences,
  worldTick,
} from '../consequence/propagate.ts';
import type { Condition, Directive, Entity, Knobs, StyleContract, VisualStyle } from '../domain/types.ts';
import { branchSave } from '../loop/branch.ts';
import { limitsFromWire, type SetupService } from '../setup/service.ts';
import type { DepthMode, IngestLimits } from '../ingest/depth.ts';
import type { SwappableRegistry } from '../providers/provider.ts';
import type { SwappableImageRegistry } from '../providers/image.ts';
import { switchImageProfile, switchProfile } from '../config/config.ts';
import { probeImageProviders } from '../providers/imageConfig.ts';
import { ROUTABLE_ROLES, validateImageSpec, validateSpec, type ConfigService } from '../config/service.ts';
import { seedConsequences as seedCons, tickConsequences as tickCons, worldTick as wTick } from '../consequence/propagate.ts';
import { type IllustrationService, NoImageProviderError } from '../illustration/service.ts';
import { composePortraitPrompt, composeScenePrompt } from '../illustration/composer.ts';
import { mcpSessionUser, type McpAuth } from '../mcp/auth.ts';
import { handleMcpRequest, protectedResourceMetadata } from '../mcp/server.ts';
import type { McpToolContext } from '../mcp/tools.ts';
import type { AuthConfig, SessionUser } from '../auth/config.ts';
import { verifySession } from '../auth/config.ts';
import { handleCallback, handleLogin, handleLogout } from '../auth/routes.ts';

export interface ServerOptions {
  /**
   * A getter, not a resolved `World`: every request resolves this fresh
   * (see the dispatch loop in `createApiServer`), so a story switch
   * (`POST /api/stories/:id/switch`) takes effect on the very next request
   * with no restart — the same reasoning as `Engine`/`SetupService`/
   * `IllustrationService` already accepting this shape, applied to the
   * routes that read/write `world` directly rather than through one of those.
   */
  world: World | (() => World);
  engine: Engine;
  port?: number;
  /** Directory of built UI assets; when absent the API runs alone. */
  webRoot?: string;
  /** Enables the setup wizard routes. */
  setup?: SetupService;
  /** Enables live provider profile switching. */
  registry?: SwappableRegistry;
  /** Enables the configuration routes. */
  config?: ConfigService;
  /** Enables the illustration routes. */
  illustrations?: IllustrationService;
  /** Enables live image-provider profile switching. */
  imageRegistry?: SwappableImageRegistry;
  /** Enables the story-management routes (list/create/switch/rename/delete/fork). */
  currentStory?: CurrentStory;
  /** Enables the world-management routes (list/create/switch/rename/delete). */
  currentWorld?: CurrentWorld;
  /** Where world directories live; defaults to `data`. */
  dataRoot?: string;
  /**
   * Enables `/mcp` and its `/.well-known/oauth-protected-resource` metadata
   * route — a remote MCP server for Claude/ChatGPT-style connectors, see
   * `.design/MCP-CONNECTOR.md`. Absent means the route is not mounted at
   * all, never mounted-but-unauthenticated: `buildMcpAuth` (`src/mcp/auth.ts`)
   * returns `null` when neither `MCP_OAUTH_ISSUER` nor `MCP_DEV_TOKEN` is
   * configured, and `serve.ts` passes that straight through as "do not
   * enable this."
   */
  mcpAuth?: McpAuth;
  /** The externally-reachable URL of the `/mcp` route, required alongside `mcpAuth` \u2014 what the OAuth resource-indicator and metadata point back at. */
  mcpResourceUrl?: string;
  /**
   * Enables the web login flow (`/auth/login`, `/auth/callback`,
   * `/auth/logout`) and gates every other route behind a valid session
   * cookie. Absent means what it always meant before this existed: no
   * login screen, no gate, every route open — see `src/auth/config.ts`'s
   * `resolveAuthConfig` for how `serve.ts` decides whether to pass this at
   * all.
   */
  authConfig?: AuthConfig;
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void;

interface RouteContext {
  world: World;
  engine: Engine;
  setup: SetupService | undefined;
  registry: SwappableRegistry | undefined;
  config: ConfigService | undefined;
  illustrations: IllustrationService | undefined;
  imageRegistry: SwappableImageRegistry | undefined;
  currentStory: CurrentStory | undefined;
  currentWorld: CurrentWorld | undefined;
  dataRoot: string;
  url: URL;
  body: unknown;
  /** Raw request bytes, populated only for routes listed in `RAW_BODY_ROUTES` — `undefined` for every other route, which reads `body` instead. */
  rawBody: Buffer | undefined;
  params: Record<string, string>;
  /** The signed-in user, once the session gate already verified them for this request — `null` when login is off entirely (see `src/auth/config.ts`), never re-verified here since the gate above already paid that cost. */
  user: SessionUser | null;
  /** Present whenever login is configured at all — `undefined` in login-off mode. `requireAdmin` reads this alongside `user` to distinguish "login is off" from "login is on, but not an admin." */
  authConfig: AuthConfig | undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  // Icon assets in web/public. Without these the fallback is octet-stream, which a
  // browser will not accept for apple-touch-icon or for manifest icon entries.
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Reads a request body as raw bytes, no JSON parsing.
 *
 * A world upload is a SQLite file, not a JSON document — `readBody` above
 * would try `JSON.parse` on it, fail (a SQLite file starts with the literal
 * bytes `SQLite format 3\0`, never valid JSON), and silently hand the route
 * `undefined`. `rawBodyRoutes` below marks which routes need this instead, so
 * the dispatch loop can pick the right reader per route without every other
 * handler's `body` changing shape.
 */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------- routes

const routes: Array<{ method: string; path: string; pattern: RegExp; handler: Handler }> = [];

/**
 * Routes whose body must reach the handler as raw bytes (`ctx.rawBody`)
 * rather than JSON-parsed into `ctx.body` — currently just the world upload
 * route. A `Set` keyed by `"METHOD path"` rather than a flag on `route()`
 * itself: every other call site stays exactly as it was, and the dispatch
 * loop below has one place to ask "does this one need bytes instead."
 */
const RAW_BODY_ROUTES = new Set<string>();

/** Set once per process, so the client can tell a restart from a reload. */
const STARTED_AT = new Date().toISOString();

function route(method: string, path: string, handler: Handler): void {
  // `:name` becomes a named capture, so params come out typed as strings.
  const pattern = new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`,
  );
  // The literal path is kept beside the compiled pattern so `/api/meta` can
  // report the inventory this build actually serves. Recovering it from the
  // regex afterwards would mean un-escaping and un-capturing, and a
  // hand-maintained list drifts the first time a route is added without
  // remembering to update it.
  routes.push({ method, path, pattern, handler });
}

/**
 * What this build serves.
 *
 * Exists because of a concrete failure that cost real debugging time: the web
 * client is a static bundle, so rebuilding `dist/` while an older server keeps
 * running produces a UI whose newer features call routes the backend does not
 * have. It surfaced as `no route for POST /api/stories` from a Stories tab that
 * rendered perfectly — a 404 that looks like a broken feature rather than a
 * stale process.
 *
 * Route paths rather than a version number: a hand-bumped version is one more
 * thing to forget, and the inventory answers "can this page's features work
 * here" directly instead of by proxy.
 */
route('GET', '/api/meta', (_req, res) => {
  send(res, 200, {
    // Sorted so two servers can be diffed by eye.
    routes: routes.map((r) => `${r.method} ${r.path}`).sort(),
    startedAt: STARTED_AT,
  });
});

/**
 * The web UI's own login-state check, distinct from `verifySession` at the
 * dispatch layer: that gate already ran and either let this request through
 * (login off, or a valid session) or 401'd it. This route exists so the
 * frontend can render "signed in as X" / a login link without every other
 * route needing to say so, and so it degrades to `{ user: null }` rather
 * than a 404 when login is off entirely — a page that always calls this on
 * load should not need to know whether login is even configured.
 */
route('GET', '/api/auth/me', (_req, res, { user }) => {
  send(res, 200, { user });
});

route('GET', '/api/state', (_req, res, { world }) => {
  const session = world.session.get();
  send(res, 200, {
    session,
    worldTitle: world.chronicle.getMeta('worldTitle', 'Untitled world'),
    counts: world.graph.counts(),
    scenes: world.chronicle.scenes(),
    threads: world.threads.open(20),
    directives: world.directives.active(),
    pendingConsequences: world.consequences.pending().length,
    hiddenFired: world.consequences.hiddenFiredCount(),
    divergences: world.chronicle.divergences(),
    usage: world.chronicle.usageTotals(),
  });
});

/**
 * `minWeight` defaults to 0.5, which excludes `MENTIONS`.
 *
 * Measured on a real wiki ingest: 58,170 of 73,854 edges (79%) were untyped
 * `MENTIONS` at weight 0.15 — raw wikilinks, recorded honestly as weak
 * evidence — against ~6,100 typed relationships. Drawn together, the typed
 * structure is invisible inside the mention mesh, which is why a
 * well-connected graph read as "there are hardly any edges". So the explorer
 * now opens on the relationships someone asserted, and mentions are opt-in
 * (`?minWeight=0`) rather than the default view.
 *
 * A weight floor rather than a predicate blocklist: weight is already how this
 * codebase records confidence in an edge (`RELATION_FIELDS` assigns 0.6–0.85,
 * Pass B defaults to 0.6, mentions 0.15), so one number expresses "assertions,
 * not co-occurrence" without naming predicates that may change.
 */
route('GET', '/api/graph', (_req, res, { world, url }) => {
  const layer = url.searchParams.get('layer');
  const type = url.searchParams.get('type');
  const minWeightRaw = url.searchParams.get('minWeight');
  const minWeight = minWeightRaw === null ? 0.5 : Number(minWeightRaw);
  const entities = world.graph.list({
    limit: Number(url.searchParams.get('limit') ?? 400),
    ...(layer === 'canon' || layer === 'chronicle' ? { layer } : {}),
    ...(type ? { type: type as never } : {}),
  });
  const ids = new Set(entities.map((e) => e.id));
  const scene = world.session.get().scene;
  const all = world.graph.allEdges(3000).filter((e) => ids.has(e.subject) && ids.has(e.object));
  const live = all.filter((e) => e.validTo === null || e.validTo > scene);
  const edges = Number.isFinite(minWeight) && minWeight > 0 ? live.filter((e) => e.weight >= minWeight) : live;
  // Reported so the view can say "1,204 typed (8,900 mentions hidden)" rather
  // than leaving the reader to wonder where the rest went.
  send(res, 200, { entities, edges, scene, hiddenEdges: live.length - edges.length, minWeight });
});

route('GET', '/api/entity/:id', (_req, res, { world, params }) => {
  const id = decodeURIComponent(params.id ?? '');
  const entity = world.graph.get(id);
  if (!entity) return send(res, 404, { error: 'not found' });
  const scene = world.session.get().scene;
  send(res, 200, {
    entity,
    canon: world.graph.getCanon(id),
    sheet: world.cast.get(id),
    edgesOut: world.graph.edgesFrom(id, scene),
    edgesIn: world.graph.edgesTo(id, scene),
    relationships: world.cast.relationshipsOf(id),
    relationshipsToward: world.cast.relationshipsToward(id),
    knowledge: world.chronicle.knowledgeOf(id),
  });
});

route('GET', '/api/cast', (_req, res, { world }) => {
  const sheets = world.cast.list();
  send(
    res,
    200,
    sheets.map((s) => ({ sheet: s, entity: world.graph.get(s.entityId) })),
  );
});

route('PUT', '/api/sheet/:id', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const existing = world.cast.get(id);
  if (!existing) return send(res, 404, { error: 'no sheet' });
  const patch = (body ?? {}) as Record<string, unknown>;
  world.cast.put({
    ...existing,
    identity: (patch.identity as typeof existing.identity) ?? existing.identity,
    contract: (patch.contract as typeof existing.contract) ?? existing.contract,
    voice: (patch.voice as typeof existing.voice) ?? existing.voice,
    condition: (patch.condition as Condition) ?? existing.condition,
    // A patch's `appearance` never touches `referenceImagePath`/`seed` — those
    // two fields are written exactly once, by `IllustrationService` on a
    // successful portrait generation, not through this general-purpose sheet
    // editor. Explicitly stripped rather than merged-over, so an edit to the
    // description text cannot accidentally clear a reference that took a real
    // provider call to produce.
    appearance: patch.appearance
      ? { ...existing.appearance, ...(patch.appearance as Record<string, unknown>), referenceImagePath: existing.appearance.referenceImagePath, seed: existing.appearance.seed }
      : existing.appearance,
    locks: (patch.locks as string[]) ?? existing.locks,
  });
  send(res, 200, world.cast.get(id));
});

route('POST', '/api/sheet/:id/lock', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { path, locked } = (body ?? {}) as { path?: string; locked?: boolean };
  if (!path) return send(res, 400, { error: 'path required' });
  if (locked === false) world.cast.unlock(id, path);
  else world.cast.lock(id, path);
  send(res, 200, world.cast.get(id));
});

route('GET', '/api/book', (_req, res, { world }) => {
  const turns = world.chronicle.turns({ limit: 1000 });
  send(res, 200, {
    scenes: world.chronicle.scenes(),
    turns: turns.map((t) => ({
      id: t.id,
      scene: t.scene,
      turn: t.turn,
      rawInput: t.rawInput,
      bookProse: t.bookProse,
      pinned: t.pinned,
      move: t.meta.move,
      integrity: t.meta.integrity?.distance ?? null,
      lintScore: t.meta.lint?.score ?? null,
    })),
  });
});

/**
 * GET rather than POST: this reads, never writes, and a plain link/download
 * button in a browser is a GET by construction — no JS-built request needed
 * just to fetch a file. `format` defaults to markdown; `text` gets the
 * plain-text variant (`exportPlainText`). `content-disposition: attachment`
 * with a filename derived from the world/story title, so a browser's
 * download prompts something more useful than the route's own path.
 */
route('GET', '/api/export', (_req, res, { world, url }) => {
  const format = url.searchParams.get('format') === 'text' ? 'text' : 'markdown';
  const title = world.chronicle.getMeta('worldTitle', '') || 'book';
  const slugged = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'book';
  const body = format === 'text' ? exportPlainText(world) : exportMarkdown(world);
  const ext = format === 'text' ? 'txt' : 'md';
  res.writeHead(200, {
    'content-type': format === 'text' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${slugged}.${ext}"`,
    'cache-control': 'no-store',
  });
  res.end(body);
});

route('GET', '/api/turn/:id', (_req, res, { world, params }) => {
  const turn = world.chronicle.getTurn(decodeURIComponent(params.id ?? ''));
  if (!turn) return send(res, 404, { error: 'not found' });
  send(res, 200, turn);
});

route('POST', '/api/turn/:id/pin', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { pinned } = (body ?? {}) as { pinned?: boolean };
  world.chronicle.setPinned(id, pinned !== false);
  send(res, 200, world.chronicle.getTurn(id));
});

/**
 * Re-renders one turn's prose in place. The headline consequence of "prose is
 * a view of state" (DESIGN §7.2): nothing about what happened changes, only
 * how it reads. Refuses a pinned turn with a 409 rather than a silent no-op,
 * so the UI has something concrete to show instead of a passage that just
 * didn't move.
 */
route('POST', '/api/turn/:id/regenerate', async (_req, res, { engine, world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { note } = (body ?? {}) as { note?: string };
  try {
    // `world` explicit: the per-request (per-user, when login is on) world
    // — see `TakeTurnOptions.world`'s own doc comment for why.
    const turn = await engine.regenerateProse(id, { ...(note?.trim() ? { note: note.trim() } : {}), world });
    send(res, 200, turn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, message.includes('pinned') ? 409 : 404, { error: message });
  }
});

route('POST', '/api/play', async (_req, res, { engine, world, body }) => {
  const { input, overrideIntegrity } = (body ?? {}) as { input?: string; overrideIntegrity?: boolean };
  if (!input?.trim()) return send(res, 400, { error: 'input required' });

  // `world` explicit: the per-request (per-user, when login is on) world —
  // see `TakeTurnOptions.world`'s own doc comment for why this must not be
  // left to the engine's own captured getter once two users can each be
  // mid-turn on their own story at the same time.
  const outcome = await engine.takeTurn(input, { overrideIntegrity: overrideIntegrity === true, world });

  // Consequence seeding and the world tick run after the turn commits, so the
  // response can report what the act set in motion.
  let seeded = 0;
  let tick = null;
  if (outcome.kind === 'narrated') {
    seeded = seedConsequences(world, outcome.delta, outcome.commit.events).length;
    tick = tickConsequences(world);
    worldTick(world);
  }
  send(res, 200, { outcome, seeded, tick });
});

route('GET', '/api/threads', (_req, res, { world }) => {
  send(res, 200, world.threads.all());
});

/**
 * Hand-authored thread. §11's "you cannot create, retitle or close a thread
 * by hand" — retitling and closing already went through `PUT /api/thread/:id`
 * (it accepts `title`/`status` alongside `tension`), so creation was the one
 * real gap. `tension` defaults to 0.5 (the same default the schema uses) and
 * `parties`/`resolutions` default empty rather than requiring the caller to
 * know the shape up front — a thread can be given stakes and a resolution
 * later, the way one written by the extractor would be filled in over time.
 */
route('POST', '/api/threads', (_req, res, { world, body }) => {
  const b = (body ?? {}) as { title?: string; stakes?: string; tension?: number; parties?: string[]; resolutions?: string[] };
  if (!b.title?.trim()) return send(res, 400, { error: 'title required' });
  const created = world.threads.create({
    title: b.title.trim(),
    stakes: b.stakes ?? '',
    tension: b.tension ?? 0.5,
    parties: b.parties ?? [],
    resolutions: b.resolutions ?? [],
    status: 'open',
    createdScene: world.session.get().scene,
  });
  send(res, 200, created);
});

route('PUT', '/api/thread/:id', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (!world.threads.get(id)) return send(res, 404, { error: 'no thread' });
  const patch = (body ?? {}) as { tension?: number; status?: string; title?: string; stakes?: string };
  world.threads.update(id, patch as never);
  send(res, 200, world.threads.get(id));
});

route('GET', '/api/consequences', (_req, res, { world }) => {
  const all = world.consequences.all();
  send(
    res,
    200,
    all.map((c) => ({ ...c, actorName: world.graph.get(c.actorId)?.name ?? c.actorId })),
  );
});

/**
 * The causality map: player act to seeded chain to fired to ripening.
 * Being able to see that scene 3 is why scene 19 went the way it did is most of
 * the payoff of building the propagation engine at all.
 */
route('GET', '/api/causality', (_req, res, { world }) => {
  const events = world.chronicle.events({ limit: 500 });
  const consequences = world.consequences.all(500);
  const nodes = events.map((e) => ({
    id: e.id,
    kind: 'event' as const,
    label: e.text.slice(0, 90),
    scene: e.scene,
    visibility: e.visibility,
    fromConsequenceId: e.fromConsequenceId,
  }));
  const links: Array<{ from: string; to: string; kind: string; maturity: string }> = [];
  for (const c of consequences) {
    nodes.push({
      id: c.id,
      kind: 'consequence' as never,
      label: `${world.graph.get(c.actorId)?.name ?? c.actorId} ${c.action}`,
      scene: c.createdScene,
      visibility: c.visibility,
      fromConsequenceId: null,
    });
    links.push({ from: c.causeEventId, to: c.id, kind: 'seeds', maturity: c.maturity });
    const derived = events.filter((e) => e.fromConsequenceId === c.id);
    for (const d of derived) links.push({ from: c.id, to: d.id, kind: 'fired', maturity: c.maturity });
  }
  send(res, 200, { nodes, links });
});

route('GET', '/api/facts', (_req, res, { world }) => {
  const facts = world.chronicle.facts(200);
  send(
    res,
    200,
    facts.map((f) => ({
      ...f,
      knowers: world.chronicle.knowersOf(f.id).map((k) => ({
        ...k,
        name: world.graph.get(k.entityId)?.name ?? k.entityId,
      })),
    })),
  );
});

/**
 * Grants (or updates) an entity's knowledge of a fact — §11's fix for the
 * natural authoring move when the extractor gets epistemics wrong: an NPC
 * reacting to something they should not know, or one who plainly should
 * know something and the extractor never wired it. `setKnowledge` already
 * does the write; this is the missing route. `since_scene` defaults to now
 * rather than the fact's own creation scene, since a hand-authored grant is
 * usually "they learn this right now", not a backdated correction — a
 * caller wanting the latter can still pass `sinceScene` explicitly.
 *
 * A bad `factId` fails on the `fact_knowledge.fact_id` foreign key rather
 * than being checked here twice, and is reported as 404 rather than a raw
 * 500 — the same "let the constraint do the work, translate the failure"
 * shape `checkIntegrity` uses elsewhere.
 */
route('POST', '/api/fact/:id/knowledge', (_req, res, { world, params, body }) => {
  const factId = decodeURIComponent(params.id ?? '');
  const b = (body ?? {}) as { entityId?: string; level?: string; distortion?: number; sinceScene?: number };
  if (!b.entityId) return send(res, 400, { error: 'entityId required' });
  if (b.level !== 'knows' && b.level !== 'suspects' && b.level !== 'wrong') {
    return send(res, 400, { error: "level must be 'knows', 'suspects', or 'wrong'" });
  }
  try {
    world.chronicle.setKnowledge(factId, b.entityId, b.level, b.sinceScene ?? world.session.get().scene, b.distortion ?? 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(res, message.includes('FOREIGN KEY') ? 404 : 500, { error: message.includes('FOREIGN KEY') ? 'no fact' : message });
  }
  send(res, 200, { factId, knowers: world.chronicle.knowersOf(factId) });
});

/** The undo: back to "never told", not to some fourth level meaning "explicitly does not know". */
route('DELETE', '/api/fact/:id/knowledge/:entityId', (_req, res, { world, params }) => {
  const factId = decodeURIComponent(params.id ?? '');
  const entityId = decodeURIComponent(params.entityId ?? '');
  world.chronicle.revokeKnowledge(factId, entityId);
  send(res, 200, { factId, knowers: world.chronicle.knowersOf(factId) });
});

route('GET', '/api/directives', (_req, res, { world }) => {
  send(res, 200, world.directives.active());
});

/**
 * A directive steers the future and reports the recalculation, because silent
 * recalculation in a system with offscreen machinery is how you stop trusting it.
 */
route('POST', '/api/directive', (_req, res, { world, body }) => {
  const b = (body ?? {}) as Partial<Directive>;
  if (!b.text) return send(res, 400, { error: 'text required' });
  const created = world.directives.create({
    text: b.text,
    scope: b.scope ?? 'chapter',
    strength: b.strength ?? 'push',
    lifetimeScenes: b.lifetimeScenes ?? 5,
    status: 'active',
    createdScene: world.session.get().scene,
  });
  const diff = applyDirectiveRecalc(world, created.id, created.text);
  send(res, 200, {
    directive: created,
    diff: {
      ...diff,
      raisedThreadTitles: diff.raisedThreads.map((id) => world.threads.get(id)?.title ?? id),
      loweredThreadTitles: diff.loweredThreads.map((id) => world.threads.get(id)?.title ?? id),
    },
  });
});

route('DELETE', '/api/directive/:id', (_req, res, { world, params }) => {
  world.directives.setStatus(decodeURIComponent(params.id ?? ''), 'retired');
  send(res, 200, { ok: true });
});

route('GET', '/api/style', (_req, res, { world }) => {
  send(res, 200, world.session.get().style);
});

route('PUT', '/api/style', (_req, res, { world, body }) => {
  const cur = world.session.get();
  const next = { ...cur.style, ...((body ?? {}) as Partial<StyleContract>) };
  world.session.set({ style: next });
  send(res, 200, next);
});

route('GET', '/api/knobs', (_req, res, { world }) => {
  send(res, 200, world.session.get().knobs);
});

route('PUT', '/api/knobs', (_req, res, { world, body }) => {
  const cur = world.session.get();
  const next = { ...cur.knobs, ...((body ?? {}) as Partial<Knobs>) };
  world.session.set({ knobs: next });
  send(res, 200, next);
});

route('GET', '/api/frames', (_req, res, { engine }) => {
  // Slot sizes for the last turn. Sounds like plumbing; it is the fastest way to
  // diagnose a scene that felt thin.
  const out: Record<string, unknown> = {};
  for (const [role, frame] of Object.entries(engine.lastFrames)) out[role] = frame.log;
  send(res, 200, out);
});

// -------------------------------------------------------------- illustration

function requireIllustrations(res: ServerResponse, illustrations: IllustrationService | undefined): IllustrationService | null {
  if (!illustrations) {
    send(res, 503, { error: 'illustration is not enabled on this server' });
    return null;
  }
  return illustrations;
}

const VISUAL_STYLES: VisualStyle[] = ['realistic', 'drawing', 'sketch', 'draft', 'animation'];
function parseVisualStyle(v: unknown): VisualStyle | undefined {
  return typeof v === 'string' && (VISUAL_STYLES as string[]).includes(v) ? (v as VisualStyle) : undefined;
}

/** Which image providers are usable here, mirroring `/api/providers` for text. Admin-only: this reports and lets a caller act on server-wide provider config, not anything scoped to a story. */
route('GET', '/api/images/providers', async (_req, res, { imageRegistry, config, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  // Configured overrides must be included, or a custom host saved through
  // `PUT /api/config/image-provider/:key` would never appear in the picker and
  // an edited preset would still be probed at its loopback default — the panel
  // would contradict the file. Mirrors how `/api/providers` reads
  // `cfg.providers` for text.
  const results = await probeImageProviders(config?.get().imageProviders ?? {}, {});
  send(res, 200, {
    profile: imageRegistry?.profile() ?? 'none',
    results,
    // The keys the UI may offer, so a custom provider is selectable rather than
    // merely visible.
    keys: config?.imageProviderKeys() ?? [],
  });
});

/** Same refuse-and-explain contract as `/api/providers/profile`. `profile: null` (or omitted) turns illustration off. Admin-only, same reasoning as `GET /api/images/providers` above. */
route('POST', '/api/images/profile', (_req, res, { imageRegistry, body, config, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  if (!imageRegistry) return send(res, 503, { error: 'no swappable image registry on this server' });
  const { profile } = (body ?? {}) as { profile?: string | null };
  // Same reason as `/api/providers/profile`: write to the config this server was
  // started with, not to `switchImageProfile`'s default path.
  const result = switchImageProfile(imageRegistry, profile ?? null, config?.path);
  // And reload, exactly as the text-profile route does. `switchImageProfile`
  // writes the file directly, while `ConfigService` holds an in-memory copy taken
  // at construction — so without this, the next `PUT /api/config/provider/:key`
  // saves that stale copy and silently reverts the image profile to whatever it
  // was, turning illustration off behind the user's back. Reproduced directly
  // (switch image provider, then edit an unrelated provider: `imageProfile`
  // vanished from the file) before adding this.
  if (result.ok) config?.reload();
  if (!result.ok) return send(res, 400, { error: `"${profile}" is not usable`, notes: result.notes });
  send(res, 200, result);
});

/**
 * The composed prompt alone, with no provider call — the explicit fallback
 * for "no vision model available here". Needs only `world`, not the
 * illustration service, so it works even on a server that never wired one up.
 */
route('GET', '/api/illustrate/portrait/:id/prompt', (_req, res, { world, params, url }) => {
  const entityId = decodeURIComponent(params.id ?? '');
  const entity = world.graph.get(entityId);
  if (!entity) return send(res, 404, { error: 'no such entity' });
  const style = parseVisualStyle(url.searchParams.get('visualStyle'));
  send(res, 200, composePortraitPrompt(entity, world.cast.getOrBlank(entityId), style ? { ...world.session.get().style, visualStyle: style } : world.session.get().style));
});

route('GET', '/api/illustrate/scene/:turnId/prompt', (_req, res, { world, params, url }) => {
  const turnId = decodeURIComponent(params.turnId ?? '');
  const turn = world.chronicle.getTurn(turnId);
  if (!turn) return send(res, 404, { error: 'no such turn' });
  const style = parseVisualStyle(url.searchParams.get('visualStyle'));
  const firstEvent = turn.delta?.events[0];
  const locationId = firstEvent?.locationId ?? world.session.get().currentLocationId ?? null;
  const location = locationId ? world.graph.get(locationId) : undefined;
  const present = (firstEvent?.participants ?? [])
    .map((id) => world.graph.get(id))
    .filter((e): e is Entity => !!e)
    .map((entity) => ({ entity, sheet: world.cast.get(entity.id) }));
  const styleContract = style ? { ...world.session.get().style, visualStyle: style } : world.session.get().style;
  send(res, 200, composeScenePrompt(location, present, styleContract, turn.bookProse.slice(0, 400)));
});

/** Generates or regenerates a character's portrait. Sets `appearance.referenceImagePath` on success (see `IllustrationService`). */
route('POST', '/api/illustrate/portrait/:id', async (_req, res, { world, illustrations, params, body }) => {
  const svc = requireIllustrations(res, illustrations);
  if (!svc) return;
  const entityId = decodeURIComponent(params.id ?? '');
  const style = parseVisualStyle((body as { visualStyle?: unknown } | undefined)?.visualStyle);
  try {
    // `world` explicitly, not the service's own captured getter: this is
    // the per-request world (per-user when login is on, via
    // `currentStory.worldFor(user, ...)` above) — see
    // `IllustrationService.illustratePortrait`'s own doc comment for why
    // that distinction matters once two users can be generating against
    // two different stories at once.
    send(res, 200, await svc.illustratePortrait(entityId, style, world));
  } catch (err) {
    send(res, err instanceof NoImageProviderError ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Generates a scene image for an already-committed turn. */
route('POST', '/api/illustrate/scene/:turnId', async (_req, res, { world, illustrations, params, body }) => {
  const svc = requireIllustrations(res, illustrations);
  if (!svc) return;
  const turnId = decodeURIComponent(params.turnId ?? '');
  const turn = world.chronicle.getTurn(turnId);
  if (!turn) return send(res, 404, { error: 'no such turn' });
  const style = parseVisualStyle((body as { visualStyle?: unknown } | undefined)?.visualStyle);

  // Present cast and location come from the delta the turn already committed,
  // not from a fresh player-supplied list — the illustration must depict what
  // actually happened, and the delta is the one place that is recorded.
  const firstEvent = turn.delta?.events[0];
  const locationId = firstEvent?.locationId ?? world.session.get().currentLocationId ?? null;
  const presentIds = firstEvent?.participants ?? [];

  try {
    // `world` explicitly here too, same reasoning as the portrait route above.
    send(res, 200, await svc.illustrateScene(turnId, locationId, presentIds, turn.bookProse.slice(0, 400), style, world));
  } catch (err) {
    send(res, err instanceof NoImageProviderError ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('GET', '/api/illustrations/turn/:turnId', (_req, res, { world, params }) => {
  send(res, 200, world.illustrations.forTurn(decodeURIComponent(params.turnId ?? '')));
});

route('GET', '/api/illustrations/entity/:id', (_req, res, { world, params }) => {
  send(res, 200, world.illustrations.forEntity(decodeURIComponent(params.id ?? '')));
});

route('DELETE', '/api/illustration/:id', (_req, res, { world, params }) => {
  world.illustrations.delete(decodeURIComponent(params.id ?? ''));
  send(res, 200, { ok: true });
});

/**
 * Serves generated image bytes. A separate path from `serveStatic`'s
 * `webRoot`, because the images directory lives beside the database
 * (`store/illustration.ts`), not inside the built UI bundle, and can be
 * anywhere the operator's `dbPath` puts it.
 */
route('GET', '/api/illustration/:id/image', (_req, res, { world, params }) => {
  const illus = world.illustrations.get(decodeURIComponent(params.id ?? ''));
  const abs = illus ? world.illustrations.absolutePath(illus) : null;
  if (!abs || !existsSync(abs)) return send(res, 404, { error: 'no image' });
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(readFileSync(abs));
});

route('GET', '/api/anchors', (_req, res, { world }) => {
  send(res, 200, world.chronicle.anchors(20));
});

route('POST', '/api/anchor', (_req, res, { world, body }) => {
  const { text, note } = (body ?? {}) as { text?: string; note?: string };
  if (!text) return send(res, 400, { error: 'text required' });
  world.chronicle.addAnchor(text, note ?? '', world.session.get().scene);
  send(res, 200, { ok: true });
});

route('POST', '/api/tick', (_req, res, { world }) => {
  const tick = tickConsequences(world);
  const notes = worldTick(world);
  send(res, 200, { tick, notes });
});

route('GET', '/api/chapters', (_req, res, { world }) => {
  send(res, 200, { chapters: world.chronicle.chapters(), scenes: world.chronicle.scenes() });
});

/**
 * The chronicle as a spine (DESIGN §11: "Timeline — chronicle with the
 * divergence points marked"). Scenes, chapters and the divergence ledger
 * all already existed in the database with nothing rendering them as one
 * connected view — this assembles exactly that, once, server-side, rather
 * than asking the client to reconcile three separate endpoints itself.
 * Turn counts come from `chronicle.turns()` grouped in memory rather than a
 * `GROUP BY` query: this route runs once per tab-open, not once per turn, so
 * the extra row-scan costs nothing a reader would notice, and it reuses the
 * exact same `Turn[]` shape every other consumer of `turns()` already gets
 * rather than adding a bespoke count query.
 */
route('GET', '/api/timeline', (_req, res, { world }) => {
  const scenes = world.chronicle.scenes();
  const chapters = world.chronicle.chapters();
  const divergences = world.chronicle.divergences();
  const turns = world.chronicle.turns({ limit: 5000 });

  const turnCounts = new Map<number, number>();
  for (const t of turns) turnCounts.set(t.scene, (turnCounts.get(t.scene) ?? 0) + 1);

  const divergencesByScene = new Map<number, typeof divergences>();
  for (const d of divergences) {
    const list = divergencesByScene.get(d.scene) ?? [];
    list.push(d);
    divergencesByScene.set(d.scene, list);
  }

  // Every scene that has a `scenes` row, at least one turn, a recorded
  // divergence, or is the current scene — a scene can have turns with no
  // row yet (the current, still-open scene, before it accumulates enough
  // turns to summarise), a row with no turns (closed too early to
  // summarise), or — the case this route cares about that `exportMarkdown`
  // does not — a divergence recorded at the current scene before any turn
  // in it has committed yet (a directive/override can fire before the turn
  // that reports it finishes). Unioned and ordered.
  const sceneNumbers = new Set<number>([
    ...scenes.map((s) => s.scene),
    ...turnCounts.keys(),
    ...divergencesByScene.keys(),
    world.session.get().scene,
  ]);
  const sceneMeta = new Map(scenes.map((s) => [s.scene, s]));

  const sceneEntries = [...sceneNumbers]
    .sort((a, b) => a - b)
    .map((scene) => {
      const meta = sceneMeta.get(scene);
      return {
        scene,
        title: meta?.title ?? '',
        summary: meta?.summary ?? '',
        chapter: meta?.chapter ?? 1,
        turnCount: turnCounts.get(scene) ?? 0,
        divergences: divergencesByScene.get(scene) ?? [],
      };
    });

  send(res, 200, {
    currentScene: world.session.get().scene,
    chapters,
    scenes: sceneEntries,
    divergenceCount: divergences.length,
  });
});

/** Summarise a closed scene on demand, or catch up everything that closed unsummarised. */
route('POST', '/api/compact', async (_req, res, { world, engine, body }) => {
  const { scene, force } = (body ?? {}) as { scene?: number; force?: boolean };
  const compactor = engine.compaction();
  if (typeof scene === 'number') {
    const summary = await compactor.summariseScene(scene, force === true);
    return send(res, 200, { scene, summary });
  }
  const result = await compactor.backfill(world.session.get().scene);
  send(res, 200, result);
});

/**
 * Closes the current scene by hand, the UI's equivalent of the CLI's `/scene`.
 * Without this, scene stays 1 forever unless the extractor happens to set
 * `sceneAdvance`, and hierarchical compaction never runs.
 */
route('POST', '/api/scene/close', async (_req, res, { world, engine }) => {
  const before = world.session.get();
  const result = await engine.compaction().onSceneClosed(before.scene);
  world.session.set({ scene: before.scene + 1, turn: 0 });
  world.chronicle.upsertScene(before.scene + 1, { chapter: engine.compaction().chapterOf(before.scene + 1) });
  const summary = world.chronicle.scenes().find((s) => s.scene === before.scene)?.summary ?? null;
  send(res, 200, {
    closedScene: before.scene,
    nowScene: before.scene + 1,
    summary,
    scenesSummarised: result.scenesSummarised,
    chaptersSummarised: result.chaptersSummarised,
  });
});

/**
 * Fork the save at a scene. Full retcon would mean recomputing every downstream
 * consequence; branching gets most of the value for almost none of the cost, and
 * leaves the original playthrough intact.
 */
route('POST', '/api/branch', (_req, res, { world, body }) => {
  const { atScene, toPath, overwrite } = (body ?? {}) as { atScene?: number; toPath?: string; overwrite?: boolean };
  if (typeof atScene !== 'number' || !toPath) return send(res, 400, { error: 'atScene and toPath are required' });

  const fromPath = world.db.prepare(`PRAGMA database_list`).get() as { file?: string } | undefined;
  if (!fromPath?.file) return send(res, 400, { error: 'cannot branch an in-memory save' });

  try {
    send(res, 200, branchSave({ fromPath: fromPath.file, toPath, atScene, overwrite: overwrite === true }));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------- stories
// A world file can hold more than one independent playthrough (Slice 1-3 of
// the multi-story migration). These routes are what actually makes that
// reachable — `currentStory` is optional so a server started without one
// (every test that only needs a single fixed story, and any caller not yet
// updated) keeps behaving exactly as before.

function requireCurrentStory(res: ServerResponse, currentStory: CurrentStory | undefined): CurrentStory | null {
  if (!currentStory) {
    send(res, 503, { error: 'story management is not enabled on this server' });
    return null;
  }
  return currentStory;
}

/**
 * True when `user` may act on `storyId` — either login is off (`user` is
 * `null`, the legacy no-ownership-concept mode, unchanged) or the story's
 * `owner_user_id` is either this user's own id or `null` (a story from
 * before ownership existed, or created during a login-off session; see
 * `db.ts`'s migration comment for why an unowned row is never silently
 * reassigned to whoever happens to ask first — it stays reachable, not
 * exclusively theirs, until a real claim mechanism exists). Sends the 403
 * itself and returns `false` so every call site is a one-line early return.
 */
function ownsStoryOrRespond(res: ServerResponse, world: World, storyId: string, user: SessionUser | null): boolean {
  if (!user) return true;
  const story = getStory(world.db, storyId);
  if (!story) {
    send(res, 404, { error: `no story ${storyId} in this world` });
    return false;
  }
  if (story.ownerUserId !== null && story.ownerUserId !== user.id) {
    send(res, 403, { error: 'this story belongs to another user' });
    return false;
  }
  return true;
}

/**
 * Every story in this world file, most recently played first — or, when
 * login is on, every story *this user* owns. Never the whole file's list
 * for a logged-in user: that would leak every other user's story titles
 * and existence, not just their content.
 *
 * `current` is included per row rather than left for the client to work out.
 * Without it every row rendered identically, each with an equally live "open"
 * button and nothing marking the one already being read — which made the
 * feature look missing rather than merely unlabelled.
 */
route('GET', '/api/stories', (_req, res, { world, user }) => {
  const stories = user ? listStoriesForUser(world.db, user.id) : listStories(world.db);
  send(res, 200, stories.map((s) => ({ ...s, current: s.id === world.storyId })));
});

/**
 * Starts a new, non-overlapping story sharing only canon — "start a new
 * story in this world" from the save browser. Does not switch to it: the
 * caller decides whether to open it immediately or leave the current story
 * as it is.
 */
route('POST', '/api/stories', (_req, res, { world, body, user }) => {
  const { title } = (body ?? {}) as { title?: string };
  const story = createStory(world.db, { title: title?.trim() ?? '', ownerUserId: user?.id });
  send(res, 201, story);
});

/**
 * Forks a story: omit `atScene` for a fresh copy sharing canon only, pass it
 * to copy that story's own chronicle up to the scene boundary first — the
 * "branch from here" / "continue from an earlier point" case. `fromStoryId`
 * defaults to whichever story is current, but the save browser needs to
 * branch a story it is not currently looking at without a visible
 * switch-then-fork-then-switch-back round trip, so an explicit id in the
 * body is honoured too — `forkStory` only ever reads that story's own rows,
 * never mutates it, so this is safe regardless of which story is current.
 *
 * Ownership: when login is on, the *source* story must belong to the
 * caller (or be unowned) — forking someone else's story would let a user
 * read every scene of it under a story they now own, which is exactly the
 * leak `ownsStoryOrRespond` exists to prevent. The new forked story is
 * always attributed to the caller, never to the source's owner — see
 * `ForkOptions.ownerUserId`'s own doc comment for why that is not a bug.
 */
route('POST', '/api/stories/fork', (_req, res, { world, body, user }) => {
  const { title, atScene, fromStoryId } = (body ?? {}) as { title?: string; atScene?: number; fromStoryId?: string };
  const sourceId = fromStoryId || world.storyId;
  if (!ownsStoryOrRespond(res, world, sourceId, user)) return;
  try {
    send(res, 201, forkStory(world, { fromStoryId: sourceId, title: title?.trim(), atScene, ownerUserId: user?.id }));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Rolls back the currently-open story to a scene or chapter boundary
 * (DESIGN §11 / GAPS.md 3.6) — the backward move branching never covered:
 * "the last chapter went somewhere I did not mean". Always acts on
 * `world.storyId`, never an explicit id, since rollback is deliberately
 * "shorten the book I am reading right now", not a general story-management
 * operation — a caller wanting to shorten a *different* story switches to
 * it first, the same way every other single-story write route in this file
 * already assumes the current story.
 *
 * `mode` defaults to `'fork'` (see `rollback`'s own doc comment for why).
 * When it produces a new story and login is off, this route switches the
 * shared `CurrentStory` pointer immediately — unlike `POST
 * /api/stories/fork`, which deliberately does not switch, because a
 * rollback's whole point is "go there now", not "make a copy I may or may
 * not open later". With login *on*, the pointer is deliberately left alone
 * — the same reasoning `switchStoryTool` documents for `selectStory`:
 * mutating the shared, server-wide pointer would drag every other signed-in
 * user onto this one caller's rollback. `forkStory`'s own `createStory`
 * already stamps the new story's `last_played_at` as now, so
 * `worldFor(user)`'s "most recently played of *this user's* stories"
 * resolution lands on it naturally on the very next request; the client
 * still records the id locally (`setSelectedStoryId`, mirroring the
 * Stories tab's own switch handler) so a concurrent second tab is not
 * pulled along too.
 */
route('POST', '/api/rollback', (_req, res, { world, currentStory, body, user }) => {
  const { scene, chapter, mode } = (body ?? {}) as { scene?: number; chapter?: number; mode?: 'fork' | 'destructive' };
  if (!ownsStoryOrRespond(res, world, world.storyId, user)) return;
  const effectiveMode = mode ?? 'fork';
  // The switch below only runs in login-off mode (see this route's own doc
  // comment for why login-on deliberately skips it), so that is the only
  // case where `currentStory` is actually required.
  if (effectiveMode === 'fork' && !user && !currentStory) {
    return send(res, 503, { error: 'rollback in fork mode needs story management enabled on this server' });
  }
  try {
    const result = rollback(world, { scene, chapter, mode: effectiveMode, ownerUserId: user?.id });
    if (result.mode === 'fork' && result.forkedStory && !user) currentStory!.switchTo(result.forkedStory.id);
    send(res, 200, result);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Switches which story every subsequent request operates on. Takes effect immediately, no restart. */
route('POST', '/api/stories/:id/switch', (_req, res, { world, currentStory, params, user }) => {
  const cs = requireCurrentStory(res, currentStory);
  if (!cs) return;
  const id = decodeURIComponent(params.id ?? '');
  if (!ownsStoryOrRespond(res, world, id, user)) return;
  try {
    cs.switchTo(id);
    send(res, 200, { current: id });
  } catch (err) {
    send(res, 404, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('PUT', '/api/stories/:id/title', (_req, res, { world, params, body, user }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { title } = (body ?? {}) as { title?: string };
  if (typeof title !== 'string') return send(res, 400, { error: 'title is required' });
  if (!ownsStoryOrRespond(res, world, id, user)) return;
  // Renaming works on any story in the file, not only the current one — the
  // save browser needs to rename an entry without switching to it first.
  world.withStory(id).session.rename(title.trim());
  send(res, 200, { id, title: title.trim() });
});

/**
 * Deletes one story and everything scoped to it. Refuses the currently open
 * story (switch away first, so the server is never left holding a
 * `CurrentStory` pointing at something that no longer exists) and the last
 * story in a file (that is `POST /api/setup/reset`'s job — a deliberately
 * more destructive, whole-file operation).
 */
route('DELETE', '/api/stories/:id', (_req, res, { world, params, user }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (id === world.storyId) return send(res, 409, { error: 'cannot delete the story that is currently open; switch to another one first' });
  if (!ownsStoryOrRespond(res, world, id, user)) return;
  try {
    deleteStory(world.db, id);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ------------------------------------------------------------------- worlds
//
// The layer above stories. `/api/stories/*` moves between playthroughs inside
// one file; these move between files. See `store/worlds.ts` for why the two are
// kept separate, and `CurrentWorld` for why a switch reuses the story getter
// every consumer already holds rather than introducing a second seam.

function requireCurrentWorld(res: ServerResponse, currentWorld: CurrentWorld | undefined): CurrentWorld | null {
  if (!currentWorld) {
    send(res, 503, { error: 'world management is not enabled on this server' });
    return null;
  }
  return currentWorld;
}

/** Every world on this machine, most recently played first, with the open one flagged. */
route('GET', '/api/worlds', (_req, res, { currentWorld, dataRoot }) => {
  const open = currentWorld?.slug() ?? null;
  send(res, 200, {
    current: open,
    worlds: listWorlds(dataRoot).map((w) => ({
      slug: w.slug,
      title: w.title,
      storyCount: w.storyCount,
      entityCount: w.entityCount,
      lastPlayedAt: w.lastPlayedAt,
      bytes: w.bytes,
      current: w.slug === open,
    })),
  });
});

/**
 * Creates an empty world and does *not* switch to it.
 *
 * Not switching is the deliberate half. Creating a world is the first step of a
 * flow that continues in the setup wizard, and the caller decides when to leave
 * the story it currently has open — the same reasoning `POST /api/stories`
 * already applies one level down. A create-and-switch would also mean an
 * accidental click silently navigates away from an in-progress scene.
 */
route('POST', '/api/worlds', (_req, res, { currentWorld, dataRoot, body }) => {
  const cw = requireCurrentWorld(res, currentWorld);
  if (!cw) return;
  const { title } = (body ?? {}) as { title?: string };
  try {
    send(res, 201, createWorldFile(title?.trim() ?? '', dataRoot));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Switches which world every subsequent request operates on. Closes the old
 * database and opens the new one; takes effect immediately, no restart.
 */
route('POST', '/api/worlds/:slug/switch', (_req, res, { currentWorld, params }) => {
  const cw = requireCurrentWorld(res, currentWorld);
  if (!cw) return;
  const slug = decodeURIComponent(params.slug ?? '');
  try {
    cw.switchTo(slug);
    send(res, 200, { current: cw.slug() });
  } catch (err) {
    send(res, 404, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Retitles a world, moving its directory too when it is not the open one. */
route('PUT', '/api/worlds/:slug/title', (_req, res, { currentWorld, dataRoot, params, body }) => {
  const cw = requireCurrentWorld(res, currentWorld);
  if (!cw) return;
  const slug = decodeURIComponent(params.slug ?? '');
  const { title } = (body ?? {}) as { title?: string };
  if (typeof title !== 'string' || !title.trim()) return send(res, 400, { error: 'title is required' });
  try {
    send(res, 200, renameWorldFile(slug, title, { dataRoot, openSlug: cw.slug() }));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Deletes a world outright — canon, every story in it, and its images.
 *
 * Refuses the open world (switch away first, so the server is never left
 * holding a closed handle) and refuses the last one, so there is always
 * somewhere to land. Emptying the only world you have is `POST
 * /api/setup/reset`, which keeps the file and clears its contents.
 */
route('DELETE', '/api/worlds/:slug', (_req, res, { currentWorld, dataRoot, params }) => {
  const cw = requireCurrentWorld(res, currentWorld);
  if (!cw) return;
  const slug = decodeURIComponent(params.slug ?? '');
  if (listWorlds(dataRoot).length <= 1) {
    return send(res, 409, { error: 'cannot delete the only world; use reset to empty it instead' });
  }
  try {
    deleteWorldFile(slug, { dataRoot, openSlug: cw.slug() });
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 409, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Replaces a world's database file with an uploaded one — a save recovered
 * elsewhere (`sqlite3 .recover` after corruption, most concretely) handed
 * back to a deployed instance over HTTP, for an operator with no SSH access
 * to the box it runs on. See `store/worlds.ts`'s `replaceWorldFile` for the
 * validate-before-touching-disk sequence and why the existing file is backed
 * up rather than overwritten outright.
 *
 * Admin-only, for the same reason `/api/config/*` is: this replaces a file
 * every story in that world shares, not something scoped to the caller's own
 * story. Refuses the currently-open world exactly like `DELETE
 * /api/worlds/:slug` above, for the identical live-handle hazard.
 *
 * 512 MB cap: generous for a SQLite world file at this app's scale (the
 * largest real one seen in development, a multi-wiki Star Trek ingest, is
 * ~64 MB) while still bounding how much an admin-only-but-still-a-network-
 * caller route will buffer into memory from one request — `readRawBody`
 * has no cap of its own, so this is the one place that matters.
 */
route('POST', '/api/worlds/:slug/upload', (_req, res, { currentWorld, dataRoot, params, rawBody, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const cw = requireCurrentWorld(res, currentWorld);
  if (!cw) return;
  const slug = decodeURIComponent(params.slug ?? '');
  if (!rawBody?.length) return send(res, 400, { error: 'request body is empty; upload the .db file as raw bytes' });
  const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
  if (rawBody.length > MAX_UPLOAD_BYTES) {
    return send(res, 413, { error: `upload too large (${rawBody.length} bytes; limit is ${MAX_UPLOAD_BYTES})` });
  }
  try {
    const summary = replaceWorldFile(slug, rawBody, { dataRoot, openSlug: cw.slug() });
    send(res, 200, summary);
  } catch (err) {
    send(res, 409, { error: err instanceof Error ? err.message : String(err) });
  }
});
RAW_BODY_ROUTES.add('POST /api/worlds/:slug/upload');

/**
 * What is usable on this machine. Read-only and slightly slow (it touches local
 * servers and credential helpers), so the UI fetches it on demand rather than
 * with the rest of the state. Admin-only: this probes and reports on the
 * server's own machine-level credentials, not anything scoped to a story.
 */
route('GET', '/api/providers', async (_req, res, ctx) => {
  if (!requireAdmin(res, ctx.authConfig, ctx.user)) return;
  const [{ probeAll, usableProfiles }, { PROFILES }, { loadConfig }] = await Promise.all([
    import('../providers/probe.ts'),
    import('../providers/http.ts'),
    import('../config/config.ts'),
  ]);
  const cfg = loadConfig();
  const results = await probeAll(cfg.providers, {});
  send(res, 200, {
    profile: ctx.registry?.profile() ?? cfg.profile,
    results,
    usableProfiles: usableProfiles(results, PROFILES),
    profiles: Object.keys(PROFILES),
  });
});

/**
 * Streaming turn. Narration arrives as it is written, which for a writing tool is
 * the difference between watching and waiting.
 *
 * Server-sent events rather than a websocket: the traffic is one-directional and
 * short-lived, and SSE reconnects itself.
 */
route('POST', '/api/play/stream', async (_req, res, { engine, world, body }) => {
  const { input, overrideIntegrity } = (body ?? {}) as { input?: string; overrideIntegrity?: boolean };
  if (!input?.trim()) return send(res, 400, { error: 'input required' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const outcome = await engine.takeTurn(input, {
      overrideIntegrity: overrideIntegrity === true,
      onStage: (stage) => emit('stage', { stage }),
      onToken: (chunk) => emit('token', { chunk }),
      world,
    });

    let seeded = 0;
    let tick = null;
    if (outcome.kind === 'narrated') {
      seeded = seedCons(world, outcome.delta, outcome.commit.events).length;
      tick = tickCons(world);
      wTick(world);
    }
    emit('done', { outcome, seeded, tick });
  } catch (err) {
    emit('error', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ------------------------------------------------------------------- config
// Everything here was a hand-edited file plus a restart. Each route validates
// per field, so a bad value comes back pointing at itself rather than breaking
// the engine several turns later.

/**
 * Gates a route to admins only, per `src/auth/config.ts`'s `AuthConfig
 * .adminEmails`. `user` is `null` in exactly two cases that must be told
 * apart: login is off entirely (every route already unrestricted, so this
 * lets the request through — a bare `pnpm serve` must not suddenly need an
 * admin allowlist it never asked for) versus login is on and this specific
 * request has no valid session (already 401'd by the dispatch loop before
 * any route body runs, so this branch is unreachable in practice — kept
 * anyway so this function's own logic does not depend on that upstream
 * ordering to be correct). A signed-in non-admin gets a 403, distinct from
 * the 401 an unauthenticated request gets, so the two failure reasons
 * ("you are nobody" vs. "you are somebody, but not this") stay
 * distinguishable to the client.
 */
function requireAdmin(res: ServerResponse, authConfig: AuthConfig | undefined, user: SessionUser | null): boolean {
  if (!authConfig) return true; // login is off — unrestricted, unchanged from before this existed
  if (!user?.isAdmin) {
    send(res, 403, { error: 'this setting is restricted to administrators' });
    return false;
  }
  return true;
}

function requireConfig(res: ServerResponse, config: ConfigService | undefined): ConfigService | null {
  if (!config) {
    send(res, 503, { error: 'configuration editing is not enabled on this server' });
    return null;
  }
  return config;
}

route('GET', '/api/config', (_req, res, { config, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, {
    config: svc.get(),
    providerKeys: svc.providerKeys(),
    profiles: svc.profileNames(),
    roles: ROUTABLE_ROLES,
    presets: Object.fromEntries(svc.providerKeys().map((k) => [k, svc.resolveSpec(k)])),
  });
});

route('PUT', '/api/config', (_req, res, { config, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, svc.patch((body ?? {}) as never));
});

route('PUT', '/api/config/provider/:key', (_req, res, { config, params, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  const key = decodeURIComponent(params.key ?? '');
  send(res, 200, svc.putProvider(key, (body ?? {}) as never));
});

route('DELETE', '/api/config/provider/:key', (_req, res, { config, params, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, svc.removeProvider(decodeURIComponent(params.key ?? '')));
});

/** Validates and probes one spec without saving it, so "test" precedes "keep". Admin-only, same reasoning as the rest of `/api/config/*`. */
route('POST', '/api/config/provider/test', async (_req, res, { body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const { key, spec } = (body ?? {}) as { key?: string; spec?: unknown };
  const name = (key ?? 'candidate').trim() || 'candidate';
  const checked = validateSpec(name, spec);
  if (!checked.spec) return send(res, 200, { status: 'unavailable', issues: checked.issues, detail: 'the spec is not valid yet' });

  const { probeProvider } = await import('../providers/probe.ts');
  const result = await probeProvider(name, checked.spec, {});
  send(res, 200, { ...result, issues: checked.issues });
});

/**
 * Image-provider CRUD, mirroring the text routes above. This is what lets a
 * ComfyUI or Unsloth Studio on another machine be configured at all: the specs
 * always carried a `baseUrl`, but nothing could write one, so both were pinned
 * to their loopback preset defaults.
 */
route('PUT', '/api/config/image-provider/:key', (_req, res, { config, params, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  const key = decodeURIComponent(params.key ?? '');
  send(res, 200, svc.putImageProvider(key, (body ?? {}) as never));
});

route('DELETE', '/api/config/image-provider/:key', (_req, res, { config, params, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, svc.removeImageProvider(decodeURIComponent(params.key ?? '')));
});

/**
 * Validates and probes one image spec without saving it — the same
 * "test precedes keep" contract as the text route, and more useful here: the
 * whole point of a custom `baseUrl` is that it may be wrong or unreachable, and
 * finding that out at illustration time costs a turn.
 */
route('POST', '/api/config/image-provider/test', async (_req, res, { body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const { key, spec } = (body ?? {}) as { key?: string; spec?: unknown };
  const name = (key ?? 'candidate').trim() || 'candidate';
  const checked = validateImageSpec(name, spec);
  if (!checked.spec) return send(res, 200, { status: 'unavailable', issues: checked.issues, detail: 'the spec is not valid yet' });

  const { probeImageProviders } = await import('../providers/imageConfig.ts');
  // Probe *only* the candidate, not the whole catalog: this must report on the
  // host being typed, and probing every preset would also make the request as
  // slow as its least reachable entry.
  const results = await probeImageProviders({ [name]: checked.spec }, {});
  const result = results.find((r) => r.key === name);
  send(res, 200, { ...(result ?? { status: 'unknown', detail: 'no probe result' }), issues: checked.issues });
});

route('POST', '/api/config/blocklist', (_req, res, { config, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireConfig(res, config);
  if (!svc) return;
  const { phrase, remove } = (body ?? {}) as { phrase?: string; remove?: boolean };
  if (!phrase) return send(res, 400, { error: 'phrase is required' });
  send(res, 200, remove === true ? svc.removeBlocked(phrase) : svc.addBlocked(phrase));
});

/** Switches provider profile without a restart. Admin-only: this changes which LLM every user of this server talks to next, not anything scoped to the caller's own story. */
route('POST', '/api/providers/profile', (_req, res, ctx) => {
  if (!requireAdmin(res, ctx.authConfig, ctx.user)) return;
  const { registry, body } = ctx;
  if (!registry) return send(res, 503, { error: 'profile switching is not enabled on this server' });
  const { profile } = (body ?? {}) as { profile?: string };
  if (!profile) return send(res, 400, { error: 'profile is required' });

  // The config service knows which file this server is actually using;
  // `switchProfile`'s own default points at `fabulist.config.json`, which on a
  // throwaway (`--memory`) server would edit the operator's real config.
  const result = switchProfile(registry, profile, ctx.config?.path);
  if (result.ok) ctx.config?.reload();
  if (!result.ok) {
    return send(res, 400, {
      error: `"${profile}" is not usable here, so nothing changed`,
      notes: result.notes,
      profile: result.profile,
    });
  }
  send(res, 200, result);
});

route('GET', '/api/search', (_req, res, { world, url }) => {
  const q = url.searchParams.get('q') ?? '';
  send(res, 200, q ? world.graph.search(q, 30) : []);
});

// -------------------------------------------------------------------- setup
// The wizard exists so a player never has to know what a seed page is. Each
// route is one question answered, and nothing commits until a preview has been
// seen.

function requireSetup(res: ServerResponse, setup: SetupService | undefined): SetupService | null {
  if (!setup) {
    send(res, 503, { error: 'setup is not enabled on this server' });
    return null;
  }
  return setup;
}

/**
 * The wizard gate. Deliberately does *not* return entity/edge counts: this
 * route is polled alongside `/api/state` on every UI refresh, and both used to
 * call `graph.counts()` — a full scan of `entities` and `edges`, since
 * `story_id = ? OR layer = 'canon'` is unindexable — so a refresh paid for it
 * three times over (twice here, once there) to render one number that
 * `/api/state` already carries. `fresh` is now an existence check.
 */
route('GET', '/api/setup/status', (_req, res, { setup, world }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const session = world.session.get();
  send(res, 200, {
    fresh: svc.isFresh(),
    playerCharacterId: session.playerCharacterId,
    hasPlayer: !!world.cast.player(),
  });
});

/** "the witcher" becomes a list of real, verified wikis. */
route('POST', '/api/setup/resolve', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { query } = (body ?? {}) as { query?: string };
  if (!query?.trim()) return send(res, 400, { error: 'query is required' });
  send(res, 200, { candidates: await svc.resolveWiki(query.trim()) });
});

/** Free text plus a chosen wiki becomes an editable plan. */
route('POST', '/api/setup/plan', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { wish, wiki } = (body ?? {}) as { wish?: string; wiki?: { name: string; baseUrl: string; articles: number; language: string; via: string; confidence: number } };
  if (!wish?.trim() || !wiki?.baseUrl) return send(res, 400, { error: 'wish and wiki are required' });
  send(res, 200, await svc.plan(wish.trim(), wiki as never));
});

/** What it would cost, before anything is spent. */
route('POST', '/api/setup/preview', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { baseUrl, seeds, mode, excludeCategories, title } = (body ?? {}) as {
    baseUrl?: string; seeds?: string[]; mode?: DepthMode; excludeCategories?: string[]; title?: string;
  };
  if (!baseUrl || !seeds?.length) return send(res, 400, { error: 'baseUrl and seeds are required' });
  // `maxPages`/`hops`/`passBMaxPages` accept a positive integer or "all", and a
  // bad one is a 400 rather than a silent fallback to the mode's preset — see
  // `limitsFromWire`/`parseBudget`. An unlimited budget is refused by the
  // service itself (dump-only), which surfaces here the same way.
  let limits: IngestLimits;
  try {
    limits = limitsFromWire((body ?? {}) as Record<string, unknown>);
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    send(res, 200, await svc.preview(baseUrl, seeds, mode ?? 'mid', excludeCategories ?? [], title ?? '', undefined, limits));
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Same crawl as `/preview`, run as a job so the UI can show real progress
 * instead of a bare "checking…" — a `mid`/`deep` crawl is the slowest step in
 * the wizard and was, until now, the one with no progress reporting at all.
 * Also returns a character sketch refined against what was actually found.
 */
route('POST', '/api/setup/discover', (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { baseUrl, seeds, mode, excludeCategories, title, character } = (body ?? {}) as {
    baseUrl?: string; seeds?: string[]; mode?: DepthMode; excludeCategories?: string[]; title?: string;
    character?: never;
  };
  if (!baseUrl || !seeds?.length) return send(res, 400, { error: 'baseUrl and seeds are required' });
  const sketch = character ?? { existing: null, name: '', role: '', goals: [], vows: [] };
  try {
    const limits = limitsFromWire((body ?? {}) as Record<string, unknown>);
    send(res, 200, svc.startDiscover(baseUrl, seeds, mode ?? 'mid', sketch, excludeCategories ?? [], title ?? '', limits));
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

/** Commits a previewed scope. Returns a job to poll. */
route('POST', '/api/setup/ingest', (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { previewKey, character, style, opening } = (body ?? {}) as {
    previewKey?: string; character?: never; style?: never; opening?: string;
  };
  if (!previewKey) return send(res, 400, { error: 'previewKey is required; preview before committing' });
  try {
    const job = svc.startIngest(previewKey, {
      character: character ?? { existing: null, name: '', role: '', goals: [], vows: [] },
      style: style ?? {},
      opening: opening ?? '',
    });
    send(res, 200, job);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('POST', '/api/setup/custom', (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { description, style } = (body ?? {}) as { description?: string; style?: never };
  if (!description?.trim()) return send(res, 400, { error: 'description is required' });
  send(res, 200, svc.startCustomWorld(description.trim(), style));
});

route('POST', '/api/setup/sample', (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, svc.useSample());
});

/**
 * The shipped original worlds. Summaries only — a pack is seventy-odd entities
 * with full character sheets, and the picker needs a title, a blurb and the list
 * of scenarios, not the canon.
 */
route('GET', '/api/setup/packs', (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, { packs: svc.packs() });
});

/**
 * Installs a shipped world and opens one of its scenarios.
 *
 * Rebinds `currentStory` for the same reason `POST /api/setup/reset` does: a pack
 * install creates one story per scenario, and the story this server was bound to
 * beforehand is not the one the player just chose.
 */
route('POST', '/api/setup/pack', (_req, res, { setup, currentStory, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { packId, scenarioId } = (body ?? {}) as { packId?: string; scenarioId?: string };
  if (!packId) return send(res, 400, { error: 'packId is required' });
  try {
    const result = svc.usePack(packId, scenarioId);
    currentStory?.switchTo(result.storyId);
    send(res, 200, result);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('GET', '/api/setup/job/:id', (_req, res, { setup, params }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const job = svc.jobs.get(decodeURIComponent(params.id ?? ''));
  if (!job) return send(res, 404, { error: 'no such job' });
  send(res, 200, job);
});

route('POST', '/api/setup/job/:id/cancel', (_req, res, { setup, params }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, { cancelled: svc.jobs.cancel(decodeURIComponent(params.id ?? '')) });
});

/** Candidate protagonists, so the player can pick from what was actually ingested. */
route('GET', '/api/setup/characters', (_req, res, { world }) => {
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
  send(res, 200, characters);
});

/** Sets or replaces the protagonist after an ingest. */
route('POST', '/api/setup/player', async (_req, res, { setup, world, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const sketch = (body ?? {}) as { existing?: string | null; name?: string; role?: string; goals?: string[]; vows?: Array<{ text: string; rank: number }> };
  const { assignPlayerCharacter, proposeOpening } = await import('../setup/apply.ts');
  const assigned = assignPlayerCharacter(world, {
    existing: sketch.existing ?? null,
    name: sketch.name ?? '',
    role: sketch.role ?? '',
    goals: sketch.goals ?? [],
    vows: sketch.vows ?? [],
  });
  send(res, 200, { ...assigned, opening: proposeOpening(world) });
});

/**
 * Whether this world came from a wiki, and how much of the last ingest's
 * scope Pass B has actually finished — what a Settings panel shows so
 * "continue reading" is an informed choice rather than a leap of faith.
 * Admin-only: this reports on and lets a caller act on canon shared by
 * every user of this world, not anything scoped to the caller's own story
 * — unlike the first-run setup wizard's own ingest (`POST /api/setup/ingest`,
 * above), which stays open to any signed-in user since starting a *fresh*
 * world is a per-user action, not a mutation of an existing shared one.
 */
route('GET', '/api/setup/ingest-health', (_req, res, { setup, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, svc.ingestHealth());
});

/**
 * Finishes an interrupted ingest, or extends one with a wider seed set or a
 * deeper mode. Needs no wiki/seeds/mode in the body at all for a plain
 * resume — `ingestHealth`'s persisted context already has them; the body's
 * fields exist only to widen the scope for "read more". Admin-only, same
 * reasoning as `GET /api/setup/ingest-health` above.
 */
route('POST', '/api/setup/continue', (_req, res, { setup, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { seeds, mode, excludeCategories } = (body ?? {}) as {
    seeds?: string[]; mode?: DepthMode; excludeCategories?: string[];
  };
  try {
    // Raising `maxPages` here is the "keep reading, further out" path: the
    // crawl re-runs at the wider budget and Pass B skips every page it already
    // finished, so widening a 600-page world to 20,000 pays only for the new
    // ones.
    const limits = limitsFromWire((body ?? {}) as Record<string, unknown>);
    const job = svc.continueIngest({ seeds, mode, excludeCategories, limits });
    send(res, 200, job);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('POST', '/api/setup/reset', (_req, res, { setup, currentStory }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  // `reset()` drops every story row and creates one blank replacement, so the
  // id this server was bound to no longer exists. Rebinding is not optional:
  // without it the very next request resolves `world()` against a deleted
  // story, reading a default session with no row to write back to.
  const storyId = svc.reset();
  currentStory?.switchTo(storyId);
  send(res, 200, { ok: true, storyId });
});

// ------------------------------------------------------------------- server

function serveStatic(res: ServerResponse, webRoot: string, pathname: string): boolean {
  // Normalise and confine to webRoot so `..` cannot escape it.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(webRoot, rel);
  if (!file.startsWith(normalize(webRoot))) return false;

  const target = existsSync(file) && statSync(file).isFile() ? file : join(webRoot, 'index.html');
  if (!existsSync(target)) return false;

  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
  res.end(readFileSync(target));
  return true;
}

/**
 * The same thing without the SPA fallback.
 *
 * `serveStatic` answers an unknown path with `index.html`, which is right for the app's
 * client-side routes and wrong for everything the unauthenticated branch below serves: a
 * request for `/landing.html` against a `dist/` built before the landing page existed
 * would otherwise hand an anonymous visitor the *app* shell, which then 401s every call it
 * makes and looks like a broken product rather than a missing build.
 */
function serveStaticExact(res: ServerResponse, webRoot: string, pathname: string): boolean {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(webRoot, rel);
  if (!file.startsWith(normalize(webRoot))) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

/**
 * Which page navigations an anonymous visitor may have, and which files those pages need.
 *
 * Deliberately a small allowlist rather than "everything except /api". The landing page is
 * the public face of the project; the app is not, and the difference has to be a list
 * somebody has to edit, not a rule somebody has to remember.
 *
 * The hashed bundle under `/assets/` is public because it is not a secret — the app's own
 * JavaScript was always readable by anyone who had signed in once, every route it calls is
 * still gated, and withholding it would only have stopped the landing page from booting.
 */
const PUBLIC_PAGES = new Set(['/', '/welcome']);
const PUBLIC_FILES = new Set([
  '/landing.html',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
]);
const isPublicAsset = (pathname: string): boolean =>
  PUBLIC_FILES.has(pathname) || (pathname.startsWith('/assets/') && !pathname.includes('..'));

export function createApiServer(opts: ServerOptions) {
  const {
    engine,
    webRoot,
    setup,
    registry,
    config,
    illustrations,
    imageRegistry,
    currentStory,
    currentWorld,
    mcpAuth,
    mcpResourceUrl,
    authConfig,
  } = opts;
  const dataRoot = opts.dataRoot ?? 'data';
  const getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
  /**
   * Built per request, from the identity the bearer token proved.
   *
   * The tools are stateless closures, but *which world they resolve* is not:
   * `worldFor(user)` gives each verified MCP caller their own story, exactly
   * as every REST route already did for a session cookie. A single shared
   * context (the previous shape) meant two MCP users read and wrote the same
   * book, and anything they created was owned by nobody.
   *
   * `selected` is this connection's story choice — `switch_story` writes it
   * rather than moving the process-wide `CurrentStory` pointer, so one client
   * switching books cannot drag every other reader along. It lives in the
   * closure, so it lasts for the request that set it and is re-resolved from
   * "most recently played" afterwards, which is the same durability the web
   * UI's own `?storyId=` selection has.
   */
  const mcpToolContextFor = (verified: { userId: string; raw: Record<string, unknown> }): McpToolContext => {
    const user = mcpSessionUser(verified, authConfig);
    let selected: string | undefined;
    const world = () => {
      if (!user || !currentStory) return getWorld();
      return currentStory.worldFor(user, selected);
    };
    return {
      world,
      user,
      selectStory: (storyId: string) => {
        selected = storyId;
      },
      engine,
      currentStory,
      currentWorld,
      setup,
      illustrations,
      dataRoot,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // RFC 9728: served whenever MCP is enabled at all, unauthenticated by
    // design — a client fetches this *because* it just got a 401, so gating
    // the metadata document itself behind auth would be circular.
    if (mcpAuth && mcpResourceUrl && url.pathname === '/.well-known/oauth-protected-resource') {
      return send(res, 200, protectedResourceMetadata(mcpAuth, mcpResourceUrl));
    }

    // /mcp carries its own bearer-token check (src/mcp/auth.ts) — a
    // fundamentally different credential than the web session cookie below,
    // since the caller is Claude/ChatGPT, not a browser with a cookie jar.
    // It is deliberately reached *before* the session gate, not gated by it.
    if (mcpAuth && mcpResourceUrl && url.pathname === '/mcp') {
      try {
        const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
        await handleMcpRequest(req, res, body, { toolContext: mcpToolContextFor, auth: mcpAuth, resourceUrl: mcpResourceUrl });
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Login itself must be reachable with no session — that is the entire
    // point of these three routes — so they sit ahead of the gate below,
    // not behind it. Unauthenticated by design, the same reasoning as the
    // MCP metadata route just above.
    //
    // `/login` is a deliberate convenience alias for `/auth/login`: it is the
    // path people type and bookmark, and pointing it at the same handler
    // costs one condition.
    //
    // It is *not* load-bearing, and the record is worth correcting because an
    // earlier version of this comment claimed otherwise. It was added while
    // chasing an infinite redirect loop, on the theory that AuthKit was
    // bouncing sign-in requests to a bare `/login` for reasons unknown "on
    // WorkOS's side". That theory was wrong, and the alias did not fix the
    // loop. The actual cause was a WorkOS setting: Connect → Configuration →
    // "External Sign-in URI" was set to `https://fabulist.rast.io/login`,
    // which is WorkOS's Standalone Connect feature — it makes AuthKit skip
    // its own sign-in page and delegate to your app, expecting the app to
    // authenticate the user itself and then call AuthKit's completion API.
    // `handleLogin` does the opposite (it redirects *to* AuthKit), so every
    // attempt looped. Clearing that setting fixed it; this alias is only
    // still here because it is independently useful.
    if (authConfig && (url.pathname === '/auth/login' || url.pathname === '/login')) {
      await handleLogin(authConfig, req, res);
      return;
    }
    if (authConfig && url.pathname === '/auth/callback') {
      await handleCallback(authConfig, req, res, url);
      return;
    }
    if (authConfig && url.pathname === '/auth/logout' && req.method === 'POST') {
      handleLogout(res);
      return;
    }

    // The session gate. Everything below this line — every /api/ route and
    // every static asset — requires a verified session when login is
    // required at all, with one carve-out above it: the public landing page.
    //
    // A browser with no valid session lands on the pitch rather than on
    // somebody else's login form, because a visitor has to be able to read
    // what this is, and how to run it themselves, before being asked for an
    // identity. An API call still gets a plain 401 (redirecting a fetch() is
    // rarely what the caller wants — it would "succeed" with the login page's
    // HTML as the body, which is a worse failure than an honest 401 the client
    // can actually detect). `/api/auth/me` is one of those 401s, and it is how
    // the landing page decides between "Sign in" and "Open the chronicle".
    let user: SessionUser | null = null;
    if (authConfig) {
      user = await verifySession(authConfig, req, res);
      if (!user) {
        const wantsHtml = (req.headers.accept ?? '').includes('text/html') && !url.pathname.startsWith('/api/') && url.pathname !== '/mcp';
        if (webRoot) {
          if (wantsHtml && PUBLIC_PAGES.has(url.pathname) && serveStaticExact(res, webRoot, '/landing.html')) return;
          if (isPublicAsset(url.pathname) && serveStaticExact(res, webRoot, url.pathname)) return;
        }
        if (wantsHtml) {
          res.writeHead(302, { location: '/auth/login' });
          return res.end();
        }
        return send(res, 401, { error: 'sign-in required' });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      const params = url.pathname.match(match.pattern)?.groups ?? {};
      const isRawBody = RAW_BODY_ROUTES.has(`${match.method} ${match.path}`);
      try {
        const body =
          isRawBody || req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
        const rawBody = isRawBody ? await readRawBody(req) : undefined;
        // Resolved fresh per request, not once at server construction: a
        // story switch must take effect on the very next request, not after
        // a restart. Every route body still just reads `world` as a plain
        // value — the getter is dereferenced exactly once, here.
        //
        // When login is on, this is where per-user story isolation actually
        // happens: `currentStory.worldFor(user, ...)` resolves to *this
        // user's own* story on every request rather than the shared
        // process-wide pointer `getWorld()` reads — see `worldFor`'s own
        // doc comment in `store/index.ts` for why that distinction matters.
        // `?storyId=` lets a user with more than one story pick a specific
        // one for this request rather than always getting "my most
        // recent" — `worldFor` verifies it actually belongs to them before
        // honouring it.
        const world =
          currentStory && user ? currentStory.worldFor(user, url.searchParams.get('storyId') ?? undefined) : getWorld();
        await match.handler(req, res, {
          world,
          engine,
          setup,
          registry,
          config,
          illustrations,
          imageRegistry,
          currentStory,
          currentWorld,
          dataRoot,
          url,
          body,
          rawBody,
          params,
          user,
          authConfig,
        });
      } catch (err) {
        // Surface the message: this is a local single-user tool, and a silent
        // 500 during a session is worse than a leaked stack trace.
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // `/welcome` is the landing page at a stable address, reachable whether or
    // not login is configured and whether or not you are already signed in.
    // Without it the pitch would be visible only to people who do not have an
    // account, which is exactly backwards for the person developing it and for
    // anyone who wants to send someone else the link.
    if (webRoot && url.pathname === '/welcome' && serveStaticExact(res, webRoot, '/landing.html')) return;

    if (webRoot && serveStatic(res, webRoot, url.pathname)) return;
    send(res, 404, { error: 'not found' });
  });

  return server;
}

export function listRoutes(): string[] {
  return routes.map((r) => `${r.method} ${r.pattern.source}`);
}
