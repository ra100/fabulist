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
import type { CurrentStory, World } from '../store/index.ts';
import { forkStory } from '../loop/branch.ts';
import { createStory, deleteStory, listStories } from '../store/world.ts';
import {
  applyDirectiveRecalc,
  seedConsequences,
  tickConsequences,
  worldTick,
} from '../consequence/propagate.ts';
import type { Condition, Directive, Entity, Knobs, StyleContract, VisualStyle } from '../domain/types.ts';
import { branchSave } from '../loop/branch.ts';
import type { SetupService } from '../setup/service.ts';
import type { SwappableRegistry } from '../providers/provider.ts';
import type { SwappableImageRegistry } from '../providers/image.ts';
import { switchImageProfile, switchProfile } from '../config/config.ts';
import { probeImageProviders } from '../providers/imageConfig.ts';
import { ROUTABLE_ROLES, validateImageSpec, validateSpec, type ConfigService } from '../config/service.ts';
import { seedConsequences as seedCons, tickConsequences as tickCons, worldTick as wTick } from '../consequence/propagate.ts';
import { type IllustrationService, NoImageProviderError } from '../illustration/service.ts';
import { composePortraitPrompt, composeScenePrompt } from '../illustration/composer.ts';

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
  url: URL;
  body: unknown;
  params: Record<string, string>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
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

// ------------------------------------------------------------------- routes

const routes: Array<{ method: string; path: string; pattern: RegExp; handler: Handler }> = [];

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

route('GET', '/api/graph', (_req, res, { world, url }) => {
  const layer = url.searchParams.get('layer');
  const type = url.searchParams.get('type');
  const entities = world.graph.list({
    limit: Number(url.searchParams.get('limit') ?? 400),
    ...(layer === 'canon' || layer === 'chronicle' ? { layer } : {}),
    ...(type ? { type: type as never } : {}),
  });
  const ids = new Set(entities.map((e) => e.id));
  const scene = world.session.get().scene;
  const edges = world.graph
    .allEdges(3000)
    .filter((e) => ids.has(e.subject) && ids.has(e.object))
    .filter((e) => e.validTo === null || e.validTo > scene);
  send(res, 200, { entities, edges, scene });
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
route('POST', '/api/turn/:id/regenerate', async (_req, res, { engine, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { note } = (body ?? {}) as { note?: string };
  try {
    const turn = await engine.regenerateProse(id, note?.trim() ? { note: note.trim() } : {});
    send(res, 200, turn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, message.includes('pinned') ? 409 : 404, { error: message });
  }
});

route('POST', '/api/play', async (_req, res, { engine, world, body }) => {
  const { input, overrideIntegrity } = (body ?? {}) as { input?: string; overrideIntegrity?: boolean };
  if (!input?.trim()) return send(res, 400, { error: 'input required' });

  const outcome = await engine.takeTurn(input, { overrideIntegrity: overrideIntegrity === true });

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

route('PUT', '/api/thread/:id', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
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

/** Which image providers are usable here, mirroring `/api/providers` for text. */
route('GET', '/api/images/providers', async (_req, res, { imageRegistry, config }) => {
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

/** Same refuse-and-explain contract as `/api/providers/profile`. `profile: null` (or omitted) turns illustration off. */
route('POST', '/api/images/profile', (_req, res, { imageRegistry, body, config }) => {
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
route('POST', '/api/illustrate/portrait/:id', async (_req, res, { illustrations, params, body }) => {
  const svc = requireIllustrations(res, illustrations);
  if (!svc) return;
  const entityId = decodeURIComponent(params.id ?? '');
  const style = parseVisualStyle((body as { visualStyle?: unknown } | undefined)?.visualStyle);
  try {
    send(res, 200, await svc.illustratePortrait(entityId, style));
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
    send(res, 200, await svc.illustrateScene(turnId, locationId, presentIds, turn.bookProse.slice(0, 400), style));
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

/** Every story in this world file, most recently played first. */
route('GET', '/api/stories', (_req, res, { world }) => {
  const stories = listStories(world.db).sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt));
  send(res, 200, stories);
});

/**
 * Starts a new, non-overlapping story sharing only canon — "start a new
 * story in this world" from the save browser. Does not switch to it: the
 * caller decides whether to open it immediately or leave the current story
 * as it is.
 */
route('POST', '/api/stories', (_req, res, { world, body }) => {
  const { title } = (body ?? {}) as { title?: string };
  const story = createStory(world.db, { title: title?.trim() ?? '' });
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
 */
route('POST', '/api/stories/fork', (_req, res, { world, body }) => {
  const { title, atScene, fromStoryId } = (body ?? {}) as { title?: string; atScene?: number; fromStoryId?: string };
  try {
    send(res, 201, forkStory(world, { fromStoryId: fromStoryId || world.storyId, title: title?.trim(), atScene }));
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Switches which story every subsequent request operates on. Takes effect immediately, no restart. */
route('POST', '/api/stories/:id/switch', (_req, res, { currentStory, params }) => {
  const cs = requireCurrentStory(res, currentStory);
  if (!cs) return;
  const id = decodeURIComponent(params.id ?? '');
  try {
    cs.switchTo(id);
    send(res, 200, { current: id });
  } catch (err) {
    send(res, 404, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('PUT', '/api/stories/:id/title', (_req, res, { world, params, body }) => {
  const id = decodeURIComponent(params.id ?? '');
  const { title } = (body ?? {}) as { title?: string };
  if (typeof title !== 'string') return send(res, 400, { error: 'title is required' });
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
route('DELETE', '/api/stories/:id', (_req, res, { world, params }) => {
  const id = decodeURIComponent(params.id ?? '');
  if (id === world.storyId) return send(res, 409, { error: 'cannot delete the story that is currently open; switch to another one first' });
  try {
    deleteStory(world.db, id);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * What is usable on this machine. Read-only and slightly slow (it touches local
 * servers and credential helpers), so the UI fetches it on demand rather than
 * with the rest of the state.
 */
route('GET', '/api/providers', async (_req, res, ctx) => {
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

function requireConfig(res: ServerResponse, config: ConfigService | undefined): ConfigService | null {
  if (!config) {
    send(res, 503, { error: 'configuration editing is not enabled on this server' });
    return null;
  }
  return config;
}

route('GET', '/api/config', (_req, res, { config }) => {
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

route('PUT', '/api/config', (_req, res, { config, body }) => {
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, svc.patch((body ?? {}) as never));
});

route('PUT', '/api/config/provider/:key', (_req, res, { config, params, body }) => {
  const svc = requireConfig(res, config);
  if (!svc) return;
  const key = decodeURIComponent(params.key ?? '');
  send(res, 200, svc.putProvider(key, (body ?? {}) as never));
});

route('DELETE', '/api/config/provider/:key', (_req, res, { config, params }) => {
  const svc = requireConfig(res, config);
  if (!svc) return;
  send(res, 200, svc.removeProvider(decodeURIComponent(params.key ?? '')));
});

/** Validates and probes one spec without saving it, so "test" precedes "keep". */
route('POST', '/api/config/provider/test', async (_req, res, { body }) => {
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
route('PUT', '/api/config/image-provider/:key', (_req, res, { config, params, body }) => {
  const svc = requireConfig(res, config);
  if (!svc) return;
  const key = decodeURIComponent(params.key ?? '');
  send(res, 200, svc.putImageProvider(key, (body ?? {}) as never));
});

route('DELETE', '/api/config/image-provider/:key', (_req, res, { config, params }) => {
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
route('POST', '/api/config/image-provider/test', async (_req, res, { body }) => {
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

route('POST', '/api/config/blocklist', (_req, res, { config, body }) => {
  const svc = requireConfig(res, config);
  if (!svc) return;
  const { phrase, remove } = (body ?? {}) as { phrase?: string; remove?: boolean };
  if (!phrase) return send(res, 400, { error: 'phrase is required' });
  send(res, 200, remove === true ? svc.removeBlocked(phrase) : svc.addBlocked(phrase));
});

/** Switches provider profile without a restart. */
route('POST', '/api/providers/profile', (_req, res, ctx) => {
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

route('GET', '/api/setup/status', (_req, res, { setup, world }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const session = world.session.get();
  send(res, 200, {
    fresh: svc.isFresh(),
    counts: world.graph.counts(),
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
    baseUrl?: string; seeds?: string[]; mode?: 'skim' | 'mid' | 'deep'; excludeCategories?: string[]; title?: string;
  };
  if (!baseUrl || !seeds?.length) return send(res, 400, { error: 'baseUrl and seeds are required' });
  send(res, 200, await svc.preview(baseUrl, seeds, mode ?? 'mid', excludeCategories ?? [], title ?? ''));
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
    baseUrl?: string; seeds?: string[]; mode?: 'skim' | 'mid' | 'deep'; excludeCategories?: string[]; title?: string;
    character?: never;
  };
  if (!baseUrl || !seeds?.length) return send(res, 400, { error: 'baseUrl and seeds are required' });
  const sketch = character ?? { existing: null, name: '', role: '', goals: [], vows: [] };
  send(res, 200, svc.startDiscover(baseUrl, seeds, mode ?? 'mid', sketch, excludeCategories ?? [], title ?? ''));
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
 */
route('GET', '/api/setup/ingest-health', (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  send(res, 200, svc.ingestHealth());
});

/**
 * Finishes an interrupted ingest, or extends one with a wider seed set or a
 * deeper mode. Needs no wiki/seeds/mode in the body at all for a plain
 * resume — `ingestHealth`'s persisted context already has them; the body's
 * fields exist only to widen the scope for "read more".
 */
route('POST', '/api/setup/continue', (_req, res, { setup, body }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  const { seeds, mode, excludeCategories } = (body ?? {}) as {
    seeds?: string[]; mode?: 'skim' | 'mid' | 'deep'; excludeCategories?: string[];
  };
  try {
    const job = svc.continueIngest({ seeds, mode, excludeCategories });
    send(res, 200, job);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

route('POST', '/api/setup/reset', (_req, res, { setup }) => {
  const svc = requireSetup(res, setup);
  if (!svc) return;
  svc.reset();
  send(res, 200, { ok: true });
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

export function createApiServer(opts: ServerOptions) {
  const { engine, webRoot, setup, registry, config, illustrations, imageRegistry, currentStory } = opts;
  const getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      const params = url.pathname.match(match.pattern)?.groups ?? {};
      try {
        const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
        // Resolved fresh per request, not once at server construction: a
        // story switch must take effect on the very next request, not after
        // a restart. Every route body still just reads `world` as a plain
        // value — the getter is dereferenced exactly once, here.
        const world = getWorld();
        await match.handler(req, res, { world, engine, setup, registry, config, illustrations, imageRegistry, currentStory, url, body, params });
      } catch (err) {
        // Surface the message: this is a local single-user tool, and a silent
        // 500 during a session is worse than a leaked stack trace.
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (webRoot && serveStatic(res, webRoot, url.pathname)) return;
    send(res, 404, { error: 'not found' });
  });

  return server;
}

export function listRoutes(): string[] {
  return routes.map((r) => `${r.method} ${r.pattern.source}`);
}
