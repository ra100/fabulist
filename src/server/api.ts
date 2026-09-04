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
import type { World } from '../store/index.ts';
import {
  applyDirectiveRecalc,
  seedConsequences,
  tickConsequences,
  worldTick,
} from '../consequence/propagate.ts';
import type { Condition, Directive, Knobs, StyleContract } from '../domain/types.ts';
import { branchSave } from '../loop/branch.ts';
import type { SetupService } from '../setup/service.ts';
import type { SwappableRegistry } from '../providers/provider.ts';
import { switchProfile } from '../config/config.ts';
import { ROUTABLE_ROLES, validateSpec, type ConfigService } from '../config/service.ts';
import { seedConsequences as seedCons, tickConsequences as tickCons, worldTick as wTick } from '../consequence/propagate.ts';

export interface ServerOptions {
  world: World;
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
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void;

interface RouteContext {
  world: World;
  engine: Engine;
  setup: SetupService | undefined;
  registry: SwappableRegistry | undefined;
  config: ConfigService | undefined;
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

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  // `:name` becomes a named capture, so params come out typed as strings.
  const pattern = new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`,
  );
  routes.push({ method, pattern, handler });
}

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

route('POST', '/api/play', async (_req, res, { engine, world, body }) => {
  const { input, overrideIntegrity } = (body ?? {}) as { input?: string; overrideIntegrity?: boolean };
  if (!input || !input.trim()) return send(res, 400, { error: 'input required' });

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
  if (!input || !input.trim()) return send(res, 400, { error: 'input required' });

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

  const result = switchProfile(registry, profile);
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
  const { world, engine, webRoot, setup, registry, config } = opts;

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
        await match.handler(req, res, { world, engine, setup, registry, config, url, body, params });
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
