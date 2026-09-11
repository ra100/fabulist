/**
 * HTTP API for the inspector UI. See DESIGN.md §11.
 *
 * Plain node:http — the surface is about twenty routes and a framework would
 * only add indirection. The UI is essentially a debugger for the world model,
 * so most routes are reads.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createDirective } from '../application/directives.ts';
import { postgresDirectiveRepository } from '../application/directives-pg.ts';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/pg.ts';
import type { Engine } from '../loop/engine-pg.ts';
import { World, worldFor } from '../store/index-pg.ts';
import { forkStory, rollback } from '../loop/branch-pg.ts';
import { exportMarkdown, exportPlainText } from '../loop/export-pg.ts';
import {
  claimUnownedStories,
  createStory,
  deleteStory,
  getStory,
  listStories,
  listStoriesForUser,
  listUnownedStories,
} from '../store/world-pg.ts';
import {
  createWorld,
  deleteWorld,
  getWorldBySlug,
  listWorlds,
  renameWorld,
  setStorySources,
} from '../store/index-pg.ts';
import {
  assertWorldAccess,
  blockPhrase,
  blocklistFor,
  grantWorldAccess,
  revokeWorldAccess,
  setWorldVisibility,
  unblockPhrase,
  worldGrants,
  worldsVisibleTo,
} from '../store/access-pg.ts';
import { tickConsequences, worldTick } from '../consequence/propagate-pg.ts';
import type { Entity, VisualStyle } from '../domain/types.ts';
import { limitsFromWire, type SetupService } from '../setup/service-pg.ts';
import type { IngestLimits } from '../ingest/depth-pg.ts';
import type { SwappableRegistry } from '../providers/provider.ts';
import type { SwappableImageRegistry } from '../providers/image.ts';
import { switchImageProfile, switchProfile } from '../config/config.ts';
import { probeImageProviders } from '../providers/imageConfig.ts';
import { ROUTABLE_ROLES, validateImageSpec, validateSpec, type ConfigService } from '../config/service.ts';
import { type IllustrationService, NoImageProviderError } from '../illustration/service-pg.ts';
import { composePortraitPrompt, composeScenePrompt } from '../illustration/composer.ts';
import { mcpSessionUser, type McpAuth } from '../mcp/auth.ts';
import { handleMcpRequest, protectedResourceMetadata } from '../mcp/server-pg.ts';
import type { McpToolContext } from '../mcp/tools-pg.ts';
import type { AuthConfig, SessionUser } from '../auth/config.ts';
import { verifySession } from '../auth/config.ts';
import { encryptionKeysForUser, enrollEncryptionKeys } from '../auth/encryption-keys-pg.ts';
import { EphemeralStoryKeyStore } from '../auth/ephemeral-story-keys.ts';
import { withEncryptionRollout } from '../auth/encryption-rollout-pg.ts';
import { handleCallback, handleLogin, handleLogout } from '../auth/routes.ts';
import { parseBody, readJsonBody, readRawBody, sendJson as send, statusForError } from './http.ts';
import {
  createThreadBodySchema,
  createStoryBodySchema,
  encryptionEnrollmentBodySchema,
  encryptionLockBodySchema,
  encryptionUnlockBodySchema,
  directiveBodySchema,
  forkStoryBodySchema,
  illustrationBodySchema,
  imageProfileBodySchema,
  knowledgeBodySchema,
  knobsBodySchema,
  personalBlocklistBodySchema,
  pgBranchBodySchema,
  profileBodySchema,
  playBodySchema,
  regenerateBodySchema,
  renameBodySchema,
  rollbackBodySchema,
  setupContinueBodySchema,
  setupCustomBodySchema,
  setupDiscoverBodySchema,
  setupIngestBodySchema,
  setupPackBodySchema,
  setupPlanBodySchema,
  setupPlayerBodySchema,
  setupPreviewBodySchema,
  setupResolveBodySchema,
  sheetBodySchema,
  sheetLockBodySchema,
  styleBodySchema,
  storySourcesBodySchema,
  turnPinBodySchema,
  updateThreadBodySchema,
  visibilityBodySchema,
  worldAccessBodySchema,
} from './contracts.ts';
import { playTurn } from '../application/play-pg.ts';

export interface ServerOptions {
  /**
   * A getter, not a resolved `World`: every request resolves this fresh
   * (see the dispatch loop in `createApiServer`), so a story switch
   * (`POST /api/stories/:id/switch`) takes effect on the very next request
   * with no restart — the same reasoning as `Engine`/`SetupService`/
   * `IllustrationService` already accepting this shape, applied to the
   * routes that read/write `world` directly rather than through one of those.
   */
  world: World | (() => World | Promise<World>);
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
  /** Where illustration bytes live; defaults to `<dataRoot>/images`. */
  imagesDir?: string;
  /**
   * The pool, required.
   *
   * Replaces `currentStory`/`currentWorld`, which were process-level mutable
   * singletons holding "the story/world currently open" — so one request's switch
   * changed what every other request saw. Story and world are resolved per request
   * now, from the session user, which makes that class of bug unrepresentable.
   */
  db: Db;
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
  /** Browser-unlocked story keys held in process memory only. */
  ephemeralStoryKeys?: EphemeralStoryKeyStore;
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void;

interface RouteContext {
  world: World;
  /**
   * The pool.
   *
   * Routes need it for two things a `World` cannot do: start a transaction (a
   * fork, a delta commit, a canon rebuild) and query across stories or worlds (the
   * world registry, the story list). `world.db` is a `Queryable` that may be a
   * transaction client, so it is deliberately not the same thing.
   */
  db: Db;
  engine: Engine;
  setup: SetupService | undefined;
  registry: SwappableRegistry | undefined;
  config: ConfigService | undefined;
  illustrations: IllustrationService | undefined;
  imageRegistry: SwappableImageRegistry | undefined;
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
  ephemeralStoryKeys: EphemeralStoryKeyStore;
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

/**
 * `package.json`'s own `version`, read once at import time rather than
 * hand-duplicated here — a second copy of the version string is one more
 * place a release could forget to bump. Resolved from this file's own
 * location, not `process.cwd()`: `pnpm serve` already runs from the repo
 * root, but the Docker image's `WORKDIR` and a systemd unit's
 * `WorkingDirectory` are exactly the kind of thing that drifts, and
 * `import.meta.url` is the one thing about this file's location that cannot.
 * Falls back to `'unknown'` rather than throwing — a missing or unreadable
 * `package.json` should degrade the version badge, not the whole server.
 */
const APP_VERSION: string = (() => {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

function route(method: string, path: string, handler: Handler): void {
  // `:name` becomes a named capture, so params come out typed as strings.
  const pattern = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
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
 * Route paths, not a version number, remain the staleness *check*
 * (`checkServerFreshness` in `web/src/api.ts`): a hand-bumped version is one
 * more thing to forget, and the inventory answers "can this page's features
 * work here" directly instead of by proxy. `version` in the route body below
 * is purely informational — what a human reads in the settings tab to
 * confirm which release is actually running — and costs nothing to keep
 * honest since `APP_VERSION` is read straight from `package.json`, the same
 * field a release already bumps for its git tag, not a second copy
 * hand-maintained here.
 */
/**
 * Liveness *and* database reachability, for container healthchecks.
 *
 * `/api/meta` was doing this job and could not: it renders the route table from
 * memory and never touches Postgres, so a container reporting `healthy` said
 * nothing about whether the database was reachable — and the deploy's own wait loop
 * used the same endpoint. Both were reporting "the process is up", which was never
 * the question worth asking after a database migration.
 *
 * Answered by the dispatcher *before* the session gate, so an unauthenticated
 * healthcheck gets a real answer rather than a 401 it would have to interpret as
 * success. Registered here too, so it appears in `/api/meta`'s route list and stays
 * discoverable; the dispatcher's copy is what actually runs. Returns 503 with the
 * reason when the database is unreachable, which is what makes a healthcheck, a
 * restart policy and a load balancer all behave correctly.
 */
route('GET', '/api/health', async (_req, res, { db }) => {
  const started = Date.now();
  try {
    await db.query('SELECT 1');
    send(res, 200, { ok: true, database: 'reachable', ms: Date.now() - started });
  } catch (err) {
    send(res, 503, {
      ok: false,
      database: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

route('GET', '/api/meta', (_req, res) => {
  send(res, 200, {
    // Sorted so two servers can be diffed by eye.
    routes: routes.map((r) => `${r.method} ${r.path}`).sort(),
    startedAt: STARTED_AT,
    version: APP_VERSION,
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

route('GET', '/api/encryption/keys', async (_req, res, { db, user, ephemeralStoryKeys }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  if (!user.encryptionPilot) return send(res, 403, { error: 'private-story encryption is not enabled for this account' });
  const keys = await encryptionKeysForUser(db, user.id);
  send(res, 200, { enrolled: keys.userKey !== null, grants: ephemeralStoryKeys.list(user.id), ...keys });
});

route('POST', '/api/encryption/enroll', async (_req, res, { body, db, user }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  if (!user.encryptionPilot) return send(res, 403, { error: 'private-story encryption is not enabled for this account' });
  const enrollment = parseBody(encryptionEnrollmentBodySchema, body);
  try {
    await enrollEncryptionKeys(db, user.id, enrollment.userKey, enrollment.storyKeys);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'could not save encryption keys';
    const status = message.startsWith('encryption is already configured') ? 409 : 400;
    return send(res, status, { error: message });
  }
  send(res, 201, { enrolled: true });
});

route('POST', '/api/encryption/unlock', async (_req, res, { body, db, user, ephemeralStoryKeys }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  if (!user.encryptionPilot) return send(res, 403, { error: 'private-story encryption is not enabled for this account' });
  const { storyKeys } = parseBody(encryptionUnlockBodySchema, body);
  if (new Set(storyKeys.map((item) => item.storyId)).size !== storyKeys.length) {
    return send(res, 400, { error: 'duplicate private-story key' });
  }
  const persisted = await encryptionKeysForUser(db, user.id);
  if (!persisted.userKey) return send(res, 409, { error: 'configure private storage before unlocking it' });
  const permittedStoryIds = new Set(persisted.storyKeys.map((item) => item.storyId));
  if (storyKeys.some((item) => !permittedStoryIds.has(item.storyId))) {
    return send(res, 403, { error: 'can only unlock your enrolled stories' });
  }
  try {
    const grants = ephemeralStoryKeys.unlock(
      user.id,
      storyKeys.map((item) => ({ storyId: item.storyId, key: Buffer.from(item.key, 'base64') })),
    );
    send(res, 200, { grants });
  } catch {
    // Key bytes are deliberately not returned, logged, or placed in an error.
    send(res, 400, { error: 'invalid private-story key' });
  }
});

route('POST', '/api/encryption/lock', async (_req, res, { body, user, ephemeralStoryKeys }) => {
  if (!user) return send(res, 401, { error: 'sign-in required' });
  const { storyId } = parseBody(encryptionLockBodySchema, body);
  const lockedStoryIds = ephemeralStoryKeys.lock(user.id, storyId);
  send(res, 200, { lockedStoryIds });
});

route('GET', '/api/state', async (_req, res, { world }) => {
  const session = await world.session.get();
  send(res, 200, {
    session,
    worldTitle: await world.chronicle.getMeta('worldTitle', 'Untitled world'),
    counts: await world.graph.counts(),
    scenes: await world.chronicle.scenes(),
    threads: await world.threads.open(20),
    directives: await world.directives.active(),
    pendingConsequences: (await world.consequences.pending()).length,
    hiddenFired: await world.consequences.hiddenFiredCount(),
    divergences: await world.chronicle.divergences(),
    usage: await world.chronicle.usageTotals(),
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
route('GET', '/api/graph', async (_req, res, { world, url }) => {
  const layer = url.searchParams.get('layer');
  const type = url.searchParams.get('type');
  const minWeightRaw = url.searchParams.get('minWeight');
  const minWeight = minWeightRaw === null ? 0.5 : Number(minWeightRaw);
  const entities = await world.graph.list({
    limit: Number(url.searchParams.get('limit') ?? 400),
    ...(layer === 'canon' || layer === 'chronicle' ? { layer } : {}),
    ...(type ? { type: type as never } : {}),
  });
  const ids = new Set(entities.map((e) => e.id));
  const scene = (await world.session.get()).scene;
  const all = (await world.graph.allEdges(3000)).filter((e) => ids.has(e.subject) && ids.has(e.object));
  const live = all.filter((e) => e.validTo === null || e.validTo > scene);
  const edges = Number.isFinite(minWeight) && minWeight > 0 ? live.filter((e) => e.weight >= minWeight) : live;
  // Reported so the view can say "1,204 typed (8,900 mentions hidden)" rather
  // than leaving the reader to wonder where the rest went.
  send(res, 200, { entities, edges, scene, hiddenEdges: live.length - edges.length, minWeight });
});

route('GET', '/api/entity/:id', async (_req, res, { world, params }) => {
  const id = decodeURIComponent(params.id ?? '');
  const entity = await world.graph.get(id);
  if (!entity) return send(res, 404, { error: 'not found' });
  const scene = (await world.session.get()).scene;
  send(res, 200, {
    entity,
    canon: await world.graph.getCanon(id),
    sheet: await world.cast.get(id),
    edgesOut: await world.graph.edgesFrom(id, scene),
    edgesIn: await world.graph.edgesTo(id, scene),
    relationships: await world.cast.relationshipsOf(id),
    relationshipsToward: await world.cast.relationshipsToward(id),
    knowledge: await world.chronicle.knowledgeOf(id),
  });
});

route('GET', '/api/cast', async (_req, res, { world }) => {
  const sheets = await world.cast.list();
  send(
    res,
    200,
    // One batched lookup rather than one query per sheet: a real cast is
    // hundreds of characters, and this route renders all of them.
    await (async () => {
      const entities = await world.graph.getMany(sheets.map((sh) => sh.entityId));
      return sheets.map((sh) => ({ sheet: sh, entity: entities.get(sh.entityId) }));
    })(),
  );
});

route('PUT', '/api/sheet/:id', async (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const existing = await world.cast.get(id);
  if (!existing) return send(res, 404, { error: 'no sheet' });
  const patch = parseBody(sheetBodySchema, body);
  await world.cast.put({
    ...existing,
    identity: patch.identity ?? existing.identity,
    contract: patch.contract ?? existing.contract,
    voice: patch.voice ?? existing.voice,
    condition: patch.condition ?? existing.condition,
    // A patch's `appearance` never touches `referenceImagePath`/`seed` — those
    // two fields are written exactly once, by `IllustrationService` on a
    // successful portrait generation, not through this general-purpose sheet
    // editor. Explicitly stripped rather than merged-over, so an edit to the
    // description text cannot accidentally clear a reference that took a real
    // provider call to produce.
    appearance: patch.appearance
      ? {
          ...existing.appearance,
          ...(patch.appearance as Record<string, unknown>),
          referenceImagePath: existing.appearance.referenceImagePath,
          seed: existing.appearance.seed,
        }
      : existing.appearance,
    locks: (patch.locks as string[]) ?? existing.locks,
  });
  send(res, 200, await world.cast.get(id));
});

route('POST', '/api/sheet/:id/lock', async (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { path, locked } = parseBody(sheetLockBodySchema, body);
  if (locked === false) await world.cast.unlock(id, path);
  else await world.cast.lock(id, path);
  send(res, 200, await world.cast.get(id));
});

route('GET', '/api/book', async (_req, res, { world }) => {
  const turns = await world.chronicle.turns({ limit: 1000 });
  send(res, 200, {
    scenes: await world.chronicle.scenes(),
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
route('GET', '/api/export', async (_req, res, { world, url }) => {
  const format = url.searchParams.get('format') === 'text' ? 'text' : 'markdown';
  const title = (await world.chronicle.getMeta('worldTitle', '')) || 'book';
  const slugged =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'book';
  // Awaited. Unawaited, `res.end(body)` wrote the string "[object Promise]" as the
  // downloaded manuscript, and the rejected promise then reached the dispatcher's
  // catch — which tried to send a 500 over a response already sent, crashing the
  // process with ERR_HTTP_HEADERS_SENT. Two failures from one missing keyword, and
  // neither visible to typecheck: `res.end` accepts anything stringifiable.
  const body = format === 'text' ? await exportPlainText(world) : await exportMarkdown(world);
  const ext = format === 'text' ? 'txt' : 'md';
  res.writeHead(200, {
    'content-type': format === 'text' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${slugged}.${ext}"`,
    'cache-control': 'no-store',
  });
  res.end(body);
});

route('GET', '/api/turn/:id', async (_req, res, { world, params }) => {
  const turn = await world.chronicle.getTurn(decodeURIComponent(params.id ?? ''));
  if (!turn) return send(res, 404, { error: 'not found' });
  send(res, 200, turn);
});

route('POST', '/api/turn/:id/pin', async (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { pinned } = parseBody(turnPinBodySchema, body);
  await world.chronicle.setPinned(id, pinned !== false);
  send(res, 200, await world.chronicle.getTurn(id));
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
  const { note } = parseBody(regenerateBodySchema, body);
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
  const { input, overrideIntegrity } = parseBody(playBodySchema, body);

  // `world` explicit: the per-request (per-user, when login is on) world —
  // see `TakeTurnOptions.world`'s own doc comment for why this must not be
  // left to the engine's own captured getter once two users can each be
  // mid-turn on their own story at the same time.
  send(res, 200, await playTurn(engine, world, input, { overrideIntegrity }));
});

route('GET', '/api/threads', async (_req, res, { world }) => {
  send(res, 200, await world.threads.all());
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
route('POST', '/api/threads', async (_req, res, { world, body }) => {
  const b = parseBody(createThreadBodySchema, body);
  const created = await world.threads.create({
    title: b.title.trim(),
    stakes: b.stakes ?? '',
    tension: b.tension ?? 0.5,
    parties: b.parties ?? [],
    resolutions: b.resolutions ?? [],
    status: 'open',
    createdScene: (await world.session.get()).scene,
  });
  send(res, 200, created);
});

route('PUT', '/api/thread/:id', async (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (!(await world.threads.get(id))) return send(res, 404, { error: 'no thread' });
  const patch = parseBody(updateThreadBodySchema, body);
  await world.threads.update(id, patch);
  send(res, 200, await world.threads.get(id));
});

route('GET', '/api/consequences', async (_req, res, { world }) => {
  const all = await world.consequences.all();
  // Actor names in one batched lookup rather than one query per consequence.
  const actors = await world.graph.getMany(all.map((c) => c.actorId));
  send(
    res,
    200,
    all.map((c) => ({ ...c, actorName: actors.get(c.actorId)?.name ?? c.actorId })),
  );
});

/**
 * The causality map: player act to seeded chain to fired to ripening.
 * Being able to see that scene 3 is why scene 19 went the way it did is most of
 * the payoff of building the propagation engine at all.
 */
route('GET', '/api/causality', async (_req, res, { world }) => {
  const events = await world.chronicle.events({ limit: 500 });
  const consequences = await world.consequences.all(500);
  const nodes = events.map((e) => ({
    id: e.id,
    kind: 'event' as const,
    label: e.text.slice(0, 90),
    scene: e.scene,
    visibility: e.visibility,
    fromConsequenceId: e.fromConsequenceId,
  }));
  const links: Array<{ from: string; to: string; kind: string; maturity: string }> = [];
  const causalityActors = await world.graph.getMany(consequences.map((c) => c.actorId));
  for (const c of consequences) {
    nodes.push({
      id: c.id,
      kind: 'consequence' as never,
      label: `${causalityActors.get(c.actorId)?.name ?? c.actorId} ${c.action}`,
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

route('GET', '/api/facts', async (_req, res, { world }) => {
  const facts = await world.chronicle.facts(200);
  // Knowers per fact, then every knower's name in one batch. The naive shape was
  // one query per fact plus one per knower — on a long campaign that is hundreds
  // of round trips for a single panel render.
  const knowersByFact = new Map<string, Awaited<ReturnType<typeof world.chronicle.knowersOf>>>();
  for (const f of facts) knowersByFact.set(f.id, await world.chronicle.knowersOf(f.id));
  const knowerNames = await world.graph.getMany([...knowersByFact.values()].flat().map((k) => k.entityId));
  send(
    res,
    200,
    facts.map((f) => ({
      ...f,
      knowers: (knowersByFact.get(f.id) ?? []).map((k) => ({
        ...k,
        name: knowerNames.get(k.entityId)?.name ?? k.entityId,
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
route('POST', '/api/fact/:id/knowledge', async (_req, res, { world, params, body }) => {
  const factId = decodeURIComponent(params.id ?? '');
  const b = parseBody(knowledgeBodySchema, body);
  try {
    await world.chronicle.setKnowledge(
      factId,
      b.entityId,
      b.level,
      b.sinceScene ?? (await world.session.get()).scene,
      b.distortion ?? 0,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(res, message.includes('FOREIGN KEY') ? 404 : 500, {
      error: message.includes('FOREIGN KEY') ? 'no fact' : message,
    });
  }
  send(res, 200, { factId, knowers: await world.chronicle.knowersOf(factId) });
});

/** The undo: back to "never told", not to some fourth level meaning "explicitly does not know". */
route('DELETE', '/api/fact/:id/knowledge/:entityId', async (_req, res, { world, params }) => {
  const factId = decodeURIComponent(params.id ?? '');
  const entityId = decodeURIComponent(params.entityId ?? '');
  await world.chronicle.revokeKnowledge(factId, entityId);
  send(res, 200, { factId, knowers: await world.chronicle.knowersOf(factId) });
});

route('GET', '/api/directives', async (_req, res, { world }) => {
  send(res, 200, await world.directives.active());
});

/**
 * A directive steers the future and reports the recalculation, because silent
 * recalculation in a system with offscreen machinery is how you stop trusting it.
 */
route('POST', '/api/directive', async (_req, res, { world, body }) => {
  const b = parseBody(directiveBodySchema, body);
  send(res, 200, await createDirective(postgresDirectiveRepository(world), b));
});

route('DELETE', '/api/directive/:id', async (_req, res, { world, params }) => {
  await world.directives.setStatus(decodeURIComponent(params.id ?? ''), 'retired');
  send(res, 200, { ok: true });
});

route('GET', '/api/style', async (_req, res, { world }) => {
  send(res, 200, (await world.session.get()).style);
});

route('PUT', '/api/style', async (_req, res, { world, body }) => {
  const cur = await world.session.get();
  const next = { ...cur.style, ...parseBody(styleBodySchema, body) };
  await world.session.set({ style: next });
  send(res, 200, next);
});

route('GET', '/api/knobs', async (_req, res, { world }) => {
  send(res, 200, (await world.session.get()).knobs);
});

route('PUT', '/api/knobs', async (_req, res, { world, body }) => {
  const cur = await world.session.get();
  const next = { ...cur.knobs, ...parseBody(knobsBodySchema, body) };
  await world.session.set({ knobs: next });
  send(res, 200, next);
});

route('GET', '/api/frames', async (_req, res, { world }) => {
  const latest = (await world.chronicle.recentTurns(1))[0];
  send(res, 200, latest?.meta.frames ?? (latest?.meta.frameLog ? { narrate: latest.meta.frameLog } : {}));
});

// -------------------------------------------------------------- illustration

function requireIllustrations(
  res: ServerResponse,
  illustrations: IllustrationService | undefined,
): IllustrationService | null {
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
  const { profile } = parseBody(imageProfileBodySchema, body);
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
route('GET', '/api/illustrate/portrait/:id/prompt', async (_req, res, { world, params, url }) => {
  const entityId = decodeURIComponent(params.id ?? '');
  const entity = await world.graph.get(entityId);
  if (!entity) return send(res, 404, { error: 'no such entity' });
  const style = parseVisualStyle(url.searchParams.get('visualStyle'));
  const [sheet, session] = await Promise.all([world.cast.getOrBlank(entityId), world.session.get()]);
  send(
    res,
    200,
    composePortraitPrompt(entity, sheet, style ? { ...session.style, visualStyle: style } : session.style),
  );
});

route('GET', '/api/illustrate/scene/:turnId/prompt', async (_req, res, { world, params, url }) => {
  const turnId = decodeURIComponent(params.turnId ?? '');
  const turn = await world.chronicle.getTurn(turnId);
  if (!turn) return send(res, 404, { error: 'no such turn' });
  const style = parseVisualStyle(url.searchParams.get('visualStyle'));
  const firstEvent = turn.delta?.events[0];
  const session = await world.session.get();
  const locationId = firstEvent?.locationId ?? session.currentLocationId ?? null;
  // The cast and place in two batched reads rather than one query per participant
  // plus one per sheet.
  const participantIds = firstEvent?.participants ?? [];
  const [entities, sheets] = await Promise.all([
    world.graph.getMany(locationId ? [...participantIds, locationId] : participantIds),
    world.cast.getManyOrBlank(participantIds),
  ]);
  const location = locationId ? entities.get(locationId) : undefined;
  const present = participantIds
    .map((id) => entities.get(id))
    .filter((e): e is Entity => !!e)
    .map((entity) => ({ entity, sheet: sheets.get(entity.id) }));
  const styleContract = style ? { ...session.style, visualStyle: style } : session.style;
  send(res, 200, composeScenePrompt(location, present, styleContract, turn.bookProse.slice(0, 400)));
});

/** Generates or regenerates a character's portrait. Sets `appearance.referenceImagePath` on success (see `IllustrationService`). */
route('POST', '/api/illustrate/portrait/:id', async (_req, res, { world, illustrations, params, body }) => {
  const svc = requireIllustrations(res, illustrations);
  if (!svc) return;
  const entityId = decodeURIComponent(params.id ?? '');
  const { visualStyle: style } = parseBody(illustrationBodySchema, body);
  try {
    // `world` explicitly, not the service's own captured getter: this is
    // the per-request world (per-user when login is on, via
    // `currentStory.worldFor(user, ...)` above) — see
    // `IllustrationService.illustratePortrait`'s own doc comment for why
    // that distinction matters once two users can be generating against
    // two different stories at once.
    send(res, 200, await svc.illustratePortrait(entityId, style, world));
  } catch (err) {
    send(res, err instanceof NoImageProviderError ? 400 : 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Generates a scene image for an already-committed turn. */
route('POST', '/api/illustrate/scene/:turnId', async (_req, res, { world, illustrations, params, body }) => {
  const svc = requireIllustrations(res, illustrations);
  if (!svc) return;
  const turnId = decodeURIComponent(params.turnId ?? '');
  const turn = await world.chronicle.getTurn(turnId);
  if (!turn) return send(res, 404, { error: 'no such turn' });
  const { visualStyle: style } = parseBody(illustrationBodySchema, body);

  // Present cast and location come from the delta the turn already committed,
  // not from a fresh player-supplied list — the illustration must depict what
  // actually happened, and the delta is the one place that is recorded.
  const firstEvent = turn.delta?.events[0];
  const locationId = firstEvent?.locationId ?? (await world.session.get()).currentLocationId ?? null;
  const presentIds = firstEvent?.participants ?? [];

  try {
    // `world` explicitly here too, same reasoning as the portrait route above.
    send(
      res,
      200,
      await svc.illustrateScene(turnId, locationId, presentIds, turn.bookProse.slice(0, 400), style, world),
    );
  } catch (err) {
    send(res, err instanceof NoImageProviderError ? 400 : 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

route('GET', '/api/illustrations/turn/:turnId', async (_req, res, { world, params }) => {
  send(res, 200, await world.illustrations.forTurn(decodeURIComponent(params.turnId ?? '')));
});

route('GET', '/api/illustrations/entity/:id', async (_req, res, { world, params }) => {
  send(res, 200, await world.illustrations.forEntity(decodeURIComponent(params.id ?? '')));
});

route('DELETE', '/api/illustration/:id', async (_req, res, { world, params }) => {
  await world.illustrations.delete(decodeURIComponent(params.id ?? ''));
  send(res, 200, { ok: true });
});

/**
 * Serves generated image bytes. A separate path from `serveStatic`'s
 * `webRoot`, because the images directory lives beside the database
 * (`store/illustration.ts`), not inside the built UI bundle, and can be
 * anywhere the operator's `dbPath` puts it.
 */
route('GET', '/api/illustration/:id/image', async (_req, res, { world, params }) => {
  const illus = await world.illustrations.get(decodeURIComponent(params.id ?? ''));
  const bytes = illus ? await world.illustrations.readBytes(illus) : undefined;
  if (!bytes) return send(res, 404, { error: 'no image' });
  const mime = illus?.path?.includes('.jpg') ? 'image/jpeg' : 'image/png';
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, no-store' });
  res.end(bytes);
});

route('GET', '/api/anchors', async (_req, res, { world }) => {
  send(res, 200, await world.chronicle.anchors(20));
});

route('POST', '/api/anchor', async (_req, res, { world, body }) => {
  const { text, note } = (body ?? {}) as { text?: string; note?: string };
  if (!text) return send(res, 400, { error: 'text required' });
  await world.chronicle.addAnchor(text, note ?? '', (await world.session.get()).scene);
  send(res, 200, { ok: true });
});

route('POST', '/api/tick', (_req, res, { world }) => {
  const tick = tickConsequences(world);
  const notes = worldTick(world);
  send(res, 200, { tick, notes });
});

route('GET', '/api/chapters', async (_req, res, { world }) => {
  send(res, 200, { chapters: await world.chronicle.chapters(), scenes: await world.chronicle.scenes() });
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
route('GET', '/api/timeline', async (_req, res, { world }) => {
  const scenes = await world.chronicle.scenes();
  const chapters = await world.chronicle.chapters();
  const divergences = await world.chronicle.divergences();
  const turns = await world.chronicle.turns({ limit: 5000 });

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
    (await world.session.get()).scene,
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
    currentScene: (await world.session.get()).scene,
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
    const summary = await compactor.summariseScene(world, scene, force === true);
    return send(res, 200, { scene, summary });
  }
  const result = await compactor.backfill(world, (await world.session.get()).scene);
  send(res, 200, result);
});

/**
 * Closes the current scene by hand, the UI's equivalent of the CLI's `/scene`.
 * Without this, scene stays 1 forever unless the extractor happens to set
 * `sceneAdvance`, and hierarchical compaction never runs.
 */
route('POST', '/api/scene/close', async (_req, res, { world, engine }) => {
  const before = await world.session.get();
  const result = await engine.compaction().onSceneClosed(world, before.scene);
  await world.session.set({ scene: before.scene + 1, turn: 0 });
  await world.chronicle.upsertScene(before.scene + 1, { chapter: engine.compaction().chapterOf(before.scene + 1) });
  const summary = (await world.chronicle.scenes()).find((s) => s.scene === before.scene)?.summary ?? null;
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
route('POST', '/api/branch', async (_req, res, { world, db, body, user }) => {
  const { atScene, title } = parseBody(pgBranchBodySchema, body);

  // No `toPath` any more. Under SQLite this copied the world *file* and then
  // discarded every story but one, because handing someone a branch meant handing
  // them a file. A branch is a story now, so this is a fork — which is what the
  // route already meant, minus the filesystem.
  try {
    const result = await forkStory(db, world, {
      fromStoryId: world.storyId,
      atScene,
      ...(title ? { title } : {}),
      ...(user ? { ownerUserId: user.id } : {}),
    });
    send(res, 200, { storyId: result.story.id, atScene, copiedFrom: result.copiedFrom });
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
async function ownsStoryOrRespond(
  res: ServerResponse,
  db: Db,
  storyId: string,
  user: SessionUser | null,
): Promise<boolean> {
  if (!user) return true;
  const story = await getStory(db, storyId);
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
route('GET', '/api/stories', async (_req, res, { world, db, user }) => {
  const stories = user ? await listStoriesForUser(db, user.id) : await listStories(db);
  send(
    res,
    200,
    stories.map((st) => ({ ...st, current: st.id === world.storyId })),
  );
});

/**
 * Books that belong to nobody, so they can be claimed rather than lost.
 *
 * Imported SQLite saves arrive unowned by design — attributing them automatically
 * would hand one person's writing to whoever signs in first. The consequence was that
 * on a logged-in instance they were invisible: present in the database, absent from the
 * library, because `owner_user_id = $1` never matches NULL. This is how the owner finds
 * out they exist.
 */
route('GET', '/api/stories/unowned', async (_req, res, { db }) => {
  send(res, 200, await listUnownedStories(db));
});

/**
 * Claims unowned books: all of them, or one by `?storyId=`.
 *
 * Requires a signed-in user, because there is no one to claim *for* otherwise — with
 * login off every story is already visible and this flow has no purpose.
 */
route('POST', '/api/stories/claim', async (_req, res, { db, url, user }) => {
  if (!user) return send(res, 400, { error: 'sign in first: there is no owner to claim these for' });
  const storyId = url.searchParams.get('storyId') ?? undefined;
  const claimed = await claimUnownedStories(db, user.id, storyId);
  send(res, 200, { claimed });
});

/**
 * Starts a new, non-overlapping story sharing only canon — "start a new
 * story in this world" from the save browser. Does not switch to it: the
 * caller decides whether to open it immediately or leave the current story
 * as it is.
 */
route('POST', '/api/stories', async (_req, res, { world, db, body, user }) => {
  const { title } = parseBody(createStoryBodySchema, body);
  // The new story reads the same canon worlds the current one does. Under SQLite
  // that was implicit — every story in a file shared its canon — and omitting it
  // here produced a story with no sources, which fails as soon as anything tries to
  // read canon through it. Caught by the story-routes test.
  const story = await createStory(db, {
    title: title?.trim() ?? '',
    worldIds: world.sources.map((src) => src.worldId),
    ...(user ? { ownerUserId: user.id } : {}),
  });
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
route('POST', '/api/stories/fork', async (_req, res, { world, db, body, user }) => {
  const { title, atScene, fromStoryId } = parseBody(forkStoryBodySchema, body);
  const sourceId = fromStoryId || world.storyId;
  if (!(await ownsStoryOrRespond(res, db, sourceId, user))) return;
  try {
    send(
      res,
      201,
      await forkStory(db, world, {
        fromStoryId: sourceId,
        ...(title?.trim() ? { title: title.trim() } : {}),
        ...(atScene === undefined ? {} : { atScene }),
        ...(user ? { ownerUserId: user.id } : {}),
      }),
    );
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
route('POST', '/api/rollback', async (_req, res, { world, db, body, user }) => {
  const { scene, chapter, mode } = parseBody(rollbackBodySchema, body);
  if (!(await ownsStoryOrRespond(res, db, world.storyId, user))) return;
  const effectiveMode = mode ?? 'fork';
  // No shared pointer to switch. `forkStory` stamps the new story's
  // `last_played_at` as now, so the per-request resolution ("most recently played
  // of this user's stories") lands on it naturally — which is what the SQLite
  // version had to do explicitly for login-on and could not do safely for
  // login-off, because mutating a server-wide pointer dragged every other user
  // onto one caller's rollback.
  try {
    const result = await rollback(db, world, {
      ...(scene === undefined ? {} : { toScene: scene }),
      ...(chapter === undefined ? {} : { toChapter: chapter }),
      mode: effectiveMode,
      ...(user ? { ownerUserId: user.id } : {}),
    });
    send(res, 200, { ...result, storyId: result.story?.id ?? world.storyId });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Confirms a story is openable by this caller, and touches it so the next
 * request resolves to it.
 *
 * Not a server-wide switch any more. That was a process-level mutable pointer:
 * one user's switch changed what every other request saw, on the next request.
 * The client sends `?storyId=` (or simply plays, and lands on its most recently
 * played story), so this route's job is to validate ownership and update
 * `last_played_at` — no shared state to mutate.
 */
route('POST', '/api/stories/:id/switch', async (_req, res, { db, params, user }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (!(await ownsStoryOrRespond(res, db, id, user))) return;
  try {
    await db.query(`UPDATE stories SET last_played_at = now() WHERE id = $1`, [id]);
    send(res, 200, { current: id });
  } catch (err) {
    send(res, 404, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('PUT', '/api/stories/:id/title', async (_req, res, { db, params, body, user }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { title } = parseBody(renameBodySchema, body);
  if (!(await ownsStoryOrRespond(res, db, id, user))) return;
  // Renaming works on any story, not only the current one — the save browser needs
  // to rename an entry without opening it first.
  await db.query(`UPDATE stories SET title = $1 WHERE id = $2`, [title.trim(), id]);
  send(res, 200, { id, title: title.trim() });
});

/**
 * Deletes one story and everything scoped to it. Refuses the currently open
 * story (switch away first, so the server is never left holding a
 * `CurrentStory` pointing at something that no longer exists) and the last
 * story in a file (that is `POST /api/setup/reset`'s job — a deliberately
 * more destructive, whole-file operation).
 */
route('DELETE', '/api/stories/:id', async (_req, res, { world, db, params, user }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (id === world.storyId)
    return send(res, 409, { error: 'cannot delete the story that is currently open; switch to another one first' });
  if (!(await ownsStoryOrRespond(res, db, id, user))) return;
  try {
    await deleteStory(db, id);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ------------------------------------------------------------------- worlds
//
// The layer above stories. `/api/stories/*` moves between playthroughs inside
// one story to another; these are the canon worlds a story reads. A world is a
// row now, so there is no open-file handle and no server-wide "current world" —
// see `store/index-pg.ts` for why that singleton is gone.

/**
 * Every canon world, most recently played first.
 *
 * No "current" world any more. Under SQLite a world was an open *file* and the
 * server held one, so this route reported which — and `POST
 * /api/worlds/:slug/switch` changed it for every user at once, which was correct
 * for one laptop and wrong for a shared instance. A world is a row now, and which
 * ones a request reads comes from its story's `story_sources`.
 */
route('GET', '/api/worlds', async (_req, res, { world, db, user }) => {
  const reading = new Set(world.sources.map((src) => src.worldId));
  // Filtered by visibility, not merely annotated with it: a private world a caller
  // has no grant on must not appear at all, since its existence and title are the
  // leak. `worldsVisibleTo` resolves that in one query, so this stays a single
  // round trip regardless of how many worlds exist.
  const visible = new Map((await worldsVisibleTo(db, user)).map((v) => [v.worldId, v]));
  send(res, 200, {
    worlds: (await listWorlds(db)).filter((w) => visible.has(w.id)).map((w) => ({
      id: w.id,
      slug: w.slug,
      title: w.title,
      storyCount: w.storyCount,
      entityCount: w.entityCount,
      edgeCount: w.edgeCount,
      lastPlayedAt: w.lastPlayedAt,
      lastRefreshedAt: w.lastRefreshedAt,
      sources: w.sources,
      // "Is this story reading it", not "is the server holding it open".
      reading: reading.has(w.id),
      visibility: visible.get(w.id)!.visibility,
      // What *this* caller may do with it, so the UI can hide an action rather than
      // offering one that will 403.
      role: visible.get(w.id)!.role,
    })),
  });
});

/**
 * Creates an empty canon world and does *not* point the current story at it.
 *
 * Not switching is the deliberate half, unchanged in spirit from the SQLite
 * version: creating a world is the first step of a flow that continues in the
 * setup wizard, and the caller decides when to leave the story it has open.
 *
 * Admin-only now, which the file-based version could not express: a world is
 * system data, and `fabulist_play` has no write grant on `worlds`.
 */
route('POST', '/api/worlds', async (_req, res, { db, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const { title } = parseBody(createStoryBodySchema, body);
  try {
    send(res, 201, await createWorld(db, title?.trim() ?? ''));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Points the caller's story at a set of canon worlds, in precedence order.
 *
 * The replacement for `POST /api/worlds/:slug/switch`, and a strictly larger
 * capability: it takes a *list*, so this is also how a crossover is assembled.
 * Per story rather than per server, so one user changing worlds is invisible to
 * everyone else — the property the old switch route could not have.
 */
route('PUT', '/api/story/sources', async (_req, res, { world, db, body, user }) => {
  const { slugs } = parseBody(storySourcesBodySchema, body);
  const ids: number[] = [];
  for (const slug of slugs) {
    const found = await getWorldBySlug(db, slug);
    if (!found) return send(res, 404, { error: `no world "${slug}"` });
    // Reading a world through a story is still reading it, so the same check
    // applies here as to the list above. Without this, a private world would be
    // fully readable by anyone who could guess its slug.
    try {
      await assertWorldAccess(db, user, found.id, 'reader');
    } catch {
      return send(res, 404, { error: `no world "${slug}"` });
    }
    ids.push(found.id);
  }
  try {
    await setStorySources(db, world.storyId, ids);
    const refreshed = await World.forStory(db, world.storyId, world.illustrations.imagesDir, world.crypto);
    send(res, 200, { storyId: world.storyId, sources: refreshed.sources });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Retitles a world. Admin-only: a title is shared by every story reading it. */
route('PUT', '/api/worlds/:slug/title', async (_req, res, { db, params, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const slug = decodeURIComponent(params.slug ?? '');
  const { title } = parseBody(renameBodySchema, body);
  try {
    send(res, 200, await renameWorld(db, slug, title));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Deletes a canon world.
 *
 * Refuses while any story still reads it — `story_sources.world_id` is
 * ON DELETE RESTRICT, so the database enforces that rather than trusting a check
 * here. The SQLite version had to refuse the *open* world instead, a
 * live-file-handle concern that no longer exists, and had to refuse the last
 * world so the server had somewhere to land; a library with no worlds is an
 * ordinary empty state now.
 *
 * Emptying a world's canon while keeping its stories is `POST /api/canon/rebuild`.
 */
route('DELETE', '/api/worlds/:slug', async (_req, res, { db, params, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const slug = decodeURIComponent(params.slug ?? '');
  try {
    await deleteWorld(db, slug);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 409, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Makes a world public or private. Needs `owner` on that world.
 *
 * Deliberately not admin-only: the person who ingested a world is the one who knows
 * whether its source material should be shared, and requiring an admin for that
 * would either bottleneck it or push everyone to be an admin.
 */
route('PUT', '/api/worlds/:slug/visibility', async (_req, res, { db, params, body, user }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const { visibility } = parseBody(visibilityBodySchema, body);
  const found = await getWorldBySlug(db, slug);
  // 404 rather than 403 when the caller cannot see it at all: confirming that a
  // named private world exists is the leak.
  if (!found) return send(res, 404, { error: `no world "${slug}"` });
  try {
    await assertWorldAccess(db, user, found.id, 'owner');
    await setWorldVisibility(db, found.id, visibility);
    send(res, 200, { slug, visibility });
  } catch (err) {
    send(res, 403, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Who has an explicit grant on this world. Needs `owner`. */
route('GET', '/api/worlds/:slug/access', async (_req, res, { db, params, user }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const found = await getWorldBySlug(db, slug);
  if (!found) return send(res, 404, { error: `no world "${slug}"` });
  try {
    await assertWorldAccess(db, user, found.id, 'owner');
    send(res, 200, { slug, visibility: found.visibility, grants: await worldGrants(db, found.id) });
  } catch (err) {
    send(res, 403, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Grants a user a role on this world. Needs `owner`.
 *
 * `role` is `reader` unless stated, because that is the grant that makes a private
 * world usable and the one with the least consequence if it is wrong.
 */
route('POST', '/api/worlds/:slug/access', async (_req, res, { db, params, body, user }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const { userId, role } = parseBody(worldAccessBodySchema, body);
  const found = await getWorldBySlug(db, slug);
  if (!found) return send(res, 404, { error: `no world "${slug}"` });
  try {
    await assertWorldAccess(db, user, found.id, 'owner');
    await grantWorldAccess(db, found.id, userId, role ?? 'reader');
    send(res, 200, { slug, userId, role: role ?? 'reader' });
  } catch (err) {
    send(res, 403, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Revokes an explicit grant. A public world stays readable; a private one does not. */
route('DELETE', '/api/worlds/:slug/access/:userId', async (_req, res, { db, params, user }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const found = await getWorldBySlug(db, slug);
  if (!found) return send(res, 404, { error: `no world "${slug}"` });
  try {
    await assertWorldAccess(db, user, found.id, 'owner');
    await revokeWorldAccess(db, found.id, decodeURIComponent(params.userId ?? ''));
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 403, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------- blocklist
//
// Per user, because a phrase one player is tired of is not a property of the
// server. The SQLite table was global and — as its own schema comment recorded —
// read by nothing: `config.blocklist` was what actually fed the linter, so the
// table looked like a feature and was dead weight. These routes are what make it
// real.

route('GET', '/api/blocklist', async (_req, res, { db, user, world }) => {
  send(res, 200, await blocklistFor(db, user, { storyId: world.storyId, crypto: world.crypto }));
});

route('POST', '/api/blocklist', async (_req, res, { db, body, user, world }) => {
  const { pattern, note } = parseBody(personalBlocklistBodySchema, body);
  try {
    await blockPhrase(db, user, pattern, note ?? '', { storyId: world.storyId, crypto: world.crypto });
    send(res, 201, { pattern: pattern.trim(), note: note ?? '' });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('DELETE', '/api/blocklist/:pattern', async (_req, res, { db, params, user, world }) => {
  await unblockPhrase(db, user, decodeURIComponent(params.pattern ?? ''), { storyId: world.storyId, crypto: world.crypto });
  send(res, 200, { ok: true });
});

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
  const { input, overrideIntegrity } = parseBody(playBodySchema, body);

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
    const result = await playTurn(engine, world, input, {
      overrideIntegrity,
      onStage: (stage) => emit('stage', { stage }),
      onToken: (chunk) => emit('token', { chunk }),
    });
    emit('done', result);
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
  if (!checked.spec)
    return send(res, 200, { status: 'unavailable', issues: checked.issues, detail: 'the spec is not valid yet' });

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
  if (!checked.spec)
    return send(res, 200, { status: 'unavailable', issues: checked.issues, detail: 'the spec is not valid yet' });

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
  const { profile } = parseBody(profileBodySchema, body);

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

route('GET', '/api/search', async (_req, res, { world, url }) => {
  const q = url.searchParams.get('q') ?? '';
  send(res, 200, q ? await world.graph.search(q, 30) : []);
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
route('GET', '/api/setup/status', async (_req, res, { setup, world }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const session = await world.session.get();
  send(res, 200, {
    // Awaited. Unawaited, this serialised as `{}` — a truthy value — so the UI
    // opened the setup wizard over a perfectly populated world and there was no
    // way past it. Caught by loading the real page against a real server, which is
    // the only place a JSON-shape bug like this is visible.
    fresh: await svc.isFresh(),
    playerCharacterId: session.playerCharacterId,
    hasPlayer: !!(await world.cast.player()),
  });
});

/** "the witcher" becomes a list of real, verified wikis. */
route('POST', '/api/setup/resolve', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { query } = parseBody(setupResolveBodySchema, body);
  send(res, 200, { candidates: await svc.resolveWiki(query.trim()) });
});

/** Free text plus a chosen wiki becomes an editable plan. */
route('POST', '/api/setup/plan', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { wish, wiki } = parseBody(setupPlanBodySchema, body);
  send(res, 200, await svc.plan(wish.trim(), wiki));
});

/** What it would cost, before anything is spent. */
route('POST', '/api/setup/preview', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const parsed = parseBody(setupPreviewBodySchema, body);
  const { baseUrl, seeds, mode, excludeCategories, title } = parsed;
  // `maxPages`/`hops`/`passBMaxPages` accept a positive integer or "all", and a
  // bad one is a 400 rather than a silent fallback to the mode's preset — see
  // `limitsFromWire`/`parseBudget`. An unlimited budget is refused by the
  // service itself (dump-only), which surfaces here the same way.
  let limits: IngestLimits;
  try {
    limits = limitsFromWire(parsed);
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    send(
      res,
      200,
      await svc.preview(baseUrl, seeds, mode ?? 'mid', excludeCategories ?? [], title ?? '', undefined, limits),
    );
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
  const parsed = parseBody(setupDiscoverBodySchema, body);
  const { baseUrl, seeds, mode, excludeCategories, title, character } = parsed;
  const sketch = character ?? { existing: null, name: '', role: '', goals: [], vows: [] };
  try {
    const limits = limitsFromWire(parsed);
    send(
      res,
      200,
      svc.startDiscover(baseUrl, seeds, mode ?? 'mid', sketch, excludeCategories ?? [], title ?? '', limits),
    );
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

/** Commits a previewed scope. Returns a job to poll. */
route('POST', '/api/setup/ingest', (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { previewKey, character, style, opening } = parseBody(setupIngestBodySchema, body);
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
  const { description, style } = parseBody(setupCustomBodySchema, body);
  send(res, 200, svc.startCustomWorld(description.trim(), style));
});

route('POST', '/api/setup/sample', async (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, await svc.useSample());
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
route('POST', '/api/setup/pack', async (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { packId, scenarioId } = parseBody(setupPackBodySchema, body);
  try {
    // No pointer to rebind: `createStory` stamps `last_played_at`, so the chosen
    // scenario's story is what the next request resolves to. The client also gets
    // `storyId` back and records it, so a second tab is not dragged along.
    const result = await svc.usePack(packId, scenarioId);
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
route('GET', '/api/setup/characters', async (_req, res, { world }) => {
  // Three batched reads rather than two queries per candidate: this route ran 60
  // sheet lookups and 60 neighbourhood walks to render one picker.
  const listed = await world.graph.list({ type: 'Character', limit: 60 });
  const ids = listed.map((e) => e.id);
  const [sheets, degrees] = await Promise.all([world.cast.getManyOrBlank(ids), world.graph.neighboursMany(ids)]);
  const characters = listed
    .map((e) => ({
      id: e.id,
      name: e.name,
      summary: e.summary,
      salience: e.salience,
      hasVows: (sheets.get(e.id)?.contract.vows.length ?? 0) > 0,
      connections: (degrees.get(e.id) ?? []).length,
    }))
    .sort((a, b) => b.connections - a.connections);
  send(res, 200, characters);
});

/** Sets or replaces the protagonist after an ingest. */
route('POST', '/api/setup/player', async (_req, res, { setup, world, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const sketch = parseBody(setupPlayerBodySchema, body);
  const { assignPlayerCharacter, proposeOpening } = await import('../setup/apply-pg.ts');
  const assigned = await assignPlayerCharacter(world, {
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
route('GET', '/api/setup/ingest-health', async (_req, res, { setup, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, await svc.ingestHealth());
});

/**
 * Finishes an interrupted ingest, or extends one with a wider seed set or a
 * deeper mode. Needs no wiki/seeds/mode in the body at all for a plain
 * resume — `ingestHealth`'s persisted context already has them; the body's
 * fields exist only to widen the scope for "read more". Admin-only, same
 * reasoning as `GET /api/setup/ingest-health` above.
 */
route('POST', '/api/setup/continue', async (_req, res, { setup, body, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const parsed = parseBody(setupContinueBodySchema, body);
  const { seeds, mode, excludeCategories } = parsed;
  try {
    // Raising `maxPages` here is the "keep reading, further out" path: the
    // crawl re-runs at the wider budget and Pass B skips every page it already
    // finished, so widening a 600-page world to 20,000 pays only for the new
    // ones.
    const limits = limitsFromWire(parsed);
    // Awaited: unlike the SQLite sibling this one is async (it loads the
    // persisted ingest context from the database before it can start a job),
    // so serialising the promise sent `{}` — a job with no `id` and no
    // `progress` — and the panel polling it died on the first render.
    const job = await svc.continueIngest({ seeds, mode, excludeCategories, limits });
    send(res, 200, job);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Starts the caller's own story over. Canon and every other story are untouched.
 *
 * The SQLite `reset()` did both halves at once — it deleted 17 tables *including
 * `stories`* — so "rebuild this world" and "destroy every story in it" were the
 * same button. They are separate routes now, which is the user/system split made
 * reachable: see `POST /api/canon/rebuild` for the other half.
 */
route('POST', '/api/setup/reset', async (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  // `createStory` stamps `last_played_at`, so the replacement is what the next
  // request resolves to — no server-wide pointer to rebind.
  const storyId = await svc.resetMyStory();
  send(res, 200, { ok: true, storyId });
});

/**
 * Empties a canon world so the wizard can rebuild it, leaving every story's
 * chronicle and prose alone.
 *
 * Admin-only, and impossible before this migration: canon and stories shared a
 * file, so there was no way to rebuild one without destroying the other. Stories
 * reading the world keep their writing and will reference canon ids that no
 * longer resolve until it is re-ingested — which `pnpm integrity-pg` reports
 * honestly rather than hiding, and which is recoverable where deleting somebody's
 * novel is not.
 */
route('POST', '/api/canon/rebuild', async (_req, res, { setup, user, authConfig }) => {
  if (!requireAdmin(res, authConfig, user)) return;
  const svc = requireSetup(res, setup);
  if (!svc) return;
  try {
    send(res, 200, await svc.rebuildCanon());
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
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
    mcpAuth,
    mcpResourceUrl,
    authConfig,
  } = opts;
  const ephemeralStoryKeys = opts.ephemeralStoryKeys ?? new EphemeralStoryKeyStore();
  const dataRoot = opts.dataRoot ?? 'data';
  const db = opts.db;
  // Where illustration bytes live. Resolved once: it is a path, not state, and
  // every per-request `World` needs it to answer `illustrations.absolutePath`.
  const imagesDir = opts.imagesDir ?? join(dataRoot, 'images');
  /**
   * The fallback world, for requests with no signed-in user and no `?storyId=`.
   *
   * A getter rather than a resolved `World`, so a server built over the boot shim
   * (`serve-pg.ts`) still sees a story created after startup. Not a revived
   * `CurrentStory`: nothing writes to it, so one request cannot change what another
   * resolves — which was the entire problem with the singleton.
   */
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
  const mcpToolContextFor = async (verified: { userId: string; raw: Record<string, unknown> }): Promise<McpToolContext> => {
    const user = await withEncryptionRollout(db, mcpSessionUser(verified, authConfig));
    let selected: string | undefined;
    // Async now, and resolved per call rather than from a process-wide pointer.
    // `selected` still lives in this closure for exactly the reason it always did:
    // one client switching books must not drag every other reader along.
    const world = () =>
      worldFor(db, user, {
        ...(selected ? { storyIdOverride: selected } : {}),
        imagesDir,
        crypto: { keyForStory: (storyId) => (user ? ephemeralStoryKeys.get(user.id, storyId) : null) },
      });
    return {
      world,
      db,
      user,
      selectStory: (storyId: string) => {
        selected = storyId;
      },
      engine,
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
        const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJsonBody(req);
        await handleMcpRequest(req, res, body, {
          toolContext: mcpToolContextFor,
          auth: mcpAuth,
          resourceUrl: mcpResourceUrl,
        });
      } catch (err) {
        if (!res.headersSent) send(res, statusForError(err), { error: err instanceof Error ? err.message : String(err) });
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
      const user = await verifySession(authConfig, req, res);
      if (user) ephemeralStoryKeys.lock(user.id);
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
    // `/api/health` answers before the session gate.
    //
    // A healthcheck has no cookie, so with login on the gate would return 401 to it —
    // and a probe that has to treat 401 as success cannot distinguish "up" from
    // "unauthorised", which is exactly the ambiguity that made the previous
    // `/api/meta` healthcheck useless after this migration. It exposes one bit
    // (is the database reachable) and no data, so it is safe to answer unauthenticated.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const started = Date.now();
      try {
        await db.query('SELECT 1');
        return send(res, 200, { ok: true, database: 'reachable', ms: Date.now() - started });
      } catch (err) {
        return send(res, 503, {
          ok: false,
          database: 'unreachable',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (authConfig) {
      user = await verifySession(authConfig, req, res);
      if (!user) {
        const wantsHtml =
          (req.headers.accept ?? '').includes('text/html') &&
          !url.pathname.startsWith('/api/') &&
          url.pathname !== '/mcp';
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
      user = await withEncryptionRollout(db, user);
    }

    if (url.pathname.startsWith('/api/')) {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      const params = url.pathname.match(match.pattern)?.groups ?? {};
      const isRawBody = RAW_BODY_ROUTES.has(`${match.method} ${match.path}`);
      try {
        const body = isRawBody || req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJsonBody(req);
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
        // Resolved fresh per request from who is asking. The SQLite server held
        // "the open story" as process state, so one request's switch changed what
        // every other request saw; `worldFor` makes that unrepresentable.
        // `?storyId=` lets a user with several stories pick one for this request,
        // and `worldFor` verifies it is theirs before honouring it.
        //
        // `opts.world` is honoured when the server was built with an explicit one.
        // Without this a server constructed around a single fixed story still
        // resolved "most recently played" per request, so creating a story silently
        // moved what every subsequent request considered current — which made
        // `DELETE /api/stories/:id` refuse a brand-new story as "currently open".
        // Caught by the story-routes test. The per-user resolution is still the
        // path that matters in production, where `opts.world` is the boot shim and
        // a signed-in user always resolves their own.
        const storyIdParam = url.searchParams.get('storyId');
        const world = user || storyIdParam
          ? await worldFor(db, user, {
              ...(storyIdParam ? { storyIdOverride: storyIdParam } : {}),
              imagesDir,
              ...(user ? { crypto: { keyForStory: (storyId: string) => ephemeralStoryKeys.get(user.id, storyId) } } : {}),
            })
          : await getWorld();
        await match.handler(req, res, {
          world,
          db,
          engine,
          setup,
          registry,
          config,
          illustrations,
          imageRegistry,
          dataRoot,
          url,
          body,
          rawBody,
          params,
          user,
          authConfig,
          ephemeralStoryKeys,
        });
      } catch (err) {
        // Surface the message: this is a local single-user tool, and a silent
        // 500 during a session is worse than a leaked stack trace.
        //
        // `headersSent` guard: a route that has already replied and *then* throws
        // used to take the whole process down with ERR_HTTP_HEADERS_SENT, because
        // this tried to send a second response. A streaming route or a bug like the
        // unawaited export above is enough to get here, and one bad request should
        // not stop the server for everyone else. The error is still reported —
        // logged rather than sent, since the client already has its answer.
        if (res.headersSent) {
          console.error(`error after the response was sent for ${req.method} ${url.pathname}:`, err);
          res.end();
        } else {
          send(res, statusForError(err), { error: err instanceof Error ? err.message : String(err) });
        }
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
