#!/usr/bin/env node
/**
 * Serves the API and the built inspector UI, on Postgres.
 *
 * ## Boot is now a sequence that can partially fail, and that is the point
 *
 * The SQLite server opened a file and was ready. This one has to reach a database
 * over a socket, check it can get enough connections, apply the schema, and
 * possibly import somebody's existing saves — any of which can fail, and the
 * failure modes are not equivalent:
 *
 *   - **No database at all** is fatal. There is nothing to serve.
 *   - **A failed world import is not.** This is the hazard with history: a
 *     deployed instance already crash-looped at boot once under
 *     `restart: unless-stopped` (see `resolveCurrentStory`'s comment in
 *     `store/world.ts`), and an importer that refuses to start the server because
 *     one world of five would not convert reproduces exactly that. So a failed
 *     import is reported loudly, recorded in `sqlite_import_log`, and the server
 *     starts anyway serving the worlds that did import. The unconverted `world.db`
 *     is left untouched on disk, so nothing is lost and `pnpm import-pg
 *     --reimport=<slug>` can retry after the cause is fixed.
 *
 * `--skip-import` exists for the same reason: an operator who has just watched an
 * import fail needs to be able to start the server *without* it retrying.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Db, applyRoles, applySchema, checkCapacity } from '../db/pg.ts';
import { findSqliteWorlds, importSqliteWorlds } from '../db/import-sqlite.ts';
import { createWorld, listWorlds, worldFor } from '../store/index-pg.ts';
import { listStories } from '../store/world-pg.ts';
import { seedWorld } from '../seed/verrow-pg.ts';
import { Engine } from '../loop/engine-pg.ts';
import { createApiServer } from '../server/api-pg.ts';
import { buildImageRegistry, buildSwappableRegistry, loadConfig } from '../config/config.ts';
import { makeProseGate } from '../lint/gate.ts';
import { SetupService } from '../setup/service-pg.ts';
import { ConfigService } from '../config/service.ts';
import { IllustrationService } from '../illustration/service-pg.ts';
import { buildMcpAuth } from '../mcp/auth.ts';
import { resolveAuthConfig } from '../auth/config.ts';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? process.env.PORT ?? 4317);
// Loopback-only by default: right for "my laptop", wrong inside a container, where
// 127.0.0.1 is the container's own namespace and unreachable through Docker's port
// mapping. `--host=0.0.0.0` (what the Dockerfile passes) opts into every interface.
const hostArg = args.find((a) => a.startsWith('--host='));
const host = hostArg?.split('=')[1] ?? process.env.HOST ?? '127.0.0.1';

const configArg = args.find((a) => a.startsWith('--config='))?.slice('--config='.length);
const configPath = configArg ?? 'fabulist.config.json';
const cfg = loadConfig(configPath);

const dataRootArg = args.find((a) => a.startsWith('--data-root='))?.slice('--data-root='.length);
const dataRoot = dataRootArg ?? process.env.DATA_ROOT ?? 'data';
mkdirSync(dirname(configPath), { recursive: true });
mkdirSync(join(dataRoot, 'images'), { recursive: true });

/**
 * How many connections this process will hold at peak.
 *
 * Two pools: play (serving turns) and ingest (one wiki crawl at a time). Checked
 * against the server's `max_connections` *before* the pools are built, because the
 * failure without it is not a clear error — measured directly, 100 concurrent
 * players plus one ingest against the default `max_connections=100` produces
 * `FATAL: sorry, too many clients already` on arbitrary requests, which looks like
 * random breakage rather than a capacity limit.
 */
const PLAY_POOL = Number(process.env.FABULIST_PG_POOL ?? 20);
const INGEST_POOL = 3;

const connectionString =
  process.env.FABULIST_PG ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/fabulist';

const play = new Db({ connectionString, kind: 'play', max: PLAY_POOL });
const ingest = new Db({ connectionString, kind: 'ingest', max: INGEST_POOL });

async function boot(): Promise<void> {
  // 1. Reachability and capacity. Both fatal: there is nothing to serve without a
  //    database, and starting with too few connections just defers the failure to
  //    whichever player happens to be mid-turn when the pool runs dry.
  try {
    const warning = await checkCapacity(play, PLAY_POOL + INGEST_POOL);
    if (warning) console.warn(`warning: ${warning}`);
  } catch (err) {
    console.error(`cannot reach Postgres at ${connectionString.replace(/:[^:@/]*@/, ':***@')}`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error('set FABULIST_PG (or DATABASE_URL), and see deploy/pg-dev.sh for a local server');
    process.exit(1);
  }

  // 2. Schema, idempotently. `applySchema` is CREATE TABLE IF NOT EXISTS
  //    throughout, so this is also the upgrade path for a new table.
  await applySchema(ingest);
  await applyRoles(ingest);

  // 3. The automatic first-boot import.
  //
  //    A user who has been playing on SQLite should not have to run a command to
  //    keep their novels: they upgrade, restart, and their worlds are there. This
  //    runs on every boot but does nothing when there is nothing new — the log
  //    table records what has been imported, and the source file is renamed to
  //    `*.pre-pg` once it succeeds, so a second boot finds no candidates.
  if (!args.includes('--skip-import')) {
    const pending = findSqliteWorlds(dataRoot);
    if (pending.length) {
      console.log(`found ${pending.length} SQLite world(s) to import: ${pending.map((p) => p.slug).join(', ')}`);
      const report = await importSqliteWorlds(ingest, { dataRoot, log: (m) => console.log(`  ${m}`) });
      for (const w of report.imported) {
        console.log(
          `imported ${w.slug}: ${w.entities} canon entities, ${w.edges} edges, ${w.stories} stor${w.stories === 1 ? 'y' : 'ies'} in ${(w.ms / 1000).toFixed(1)}s`,
        );
      }
      for (const f of report.failed) {
        // Loud, and not fatal. See this file's header for why a failed import must
        // not stop the server: an instance that crash-loops on one bad world is
        // strictly worse than one serving the other four.
        console.error(`FAILED to import ${f.slug}: ${f.error}`);
        console.error(`  ${f.slug}'s world.db is untouched. Retry with: pnpm import-pg --reimport=${f.slug}`);
      }
      if (report.imported.length || report.failed.length) {
        console.log(`import finished in ${(report.ms / 1000).toFixed(1)}s`);
      }
    }
  }

  // 4. Somewhere to land. A fresh install gets an empty world so the wizard has
  //    somewhere to ingest into — the role `World.open` on a nonexistent path used
  //    to play.
  const worlds = await listWorlds(play);
  if (!worlds.length) {
    const created = await createWorld(ingest, '');
    console.log(`created an empty world (${created.slug}) for the setup wizard`);
  }

  const imagesDir = join(dataRoot, 'images');

  /**
   * The world for requests with no signed-in user.
   *
   * **Resolved per request, never cached.** A cached `World` is wrong here and it
   * cost a real bug: this was resolved once and refreshed on a 30-second timer, so
   * after `PUT /api/story/sources` added a second canon world the very next request
   * still read the one-world snapshot. The browser showed the checkbox snapping
   * back, the database was correct, and the write had returned 200 — a stale read
   * with no error anywhere. Caught by clicking the real control in a real browser,
   * which is the only place it was visible.
   *
   * `World.forStory` is two small queries and this path serves only login-off
   * requests, so resolving every time is cheap. A cache with a refresh interval is
   * precisely the shape whose failures this migration set out to remove.
   */
  const resolveWorld = () => worldFor(play, null, { imagesDir });

  if (args.includes('--sample')) {
    await seedWorld(await resolveWorld());
    console.log('seeded the Saint Verrow sample');
  }

  const { registry, notes } = buildSwappableRegistry(cfg);
  const { registry: imageRegistry, notes: imageNotes } = buildImageRegistry(cfg);
  const configService = new ConfigService({ registry, imageRegistry, path: configPath });
  for (const n of notes) console.log(n);
  if (cfg.profile === 'mock') console.log('tip: pnpm providers — the UI can switch profile without a restart');
  for (const n of imageNotes) console.log(n);

  const illustrations = new IllustrationService({ world: resolveWorld, providers: imageRegistry });
  const engine = new Engine({
    world: resolveWorld,
    db: play,
    providers: registry,
    // Live settings, so editing the blocklist affects the very next turn.
    proseGate: makeProseGate({ live: () => configService.lintOptions() }),
  });

  const webRoot = existsSync('web/dist') ? 'web/dist' : undefined;
  if (!webRoot) console.log('web/dist not built; serving the API only (pnpm build:web)');

  // Ingest writes canon, so the setup service gets the ingest pool. This is the
  // grant boundary made concrete: `fabulist_play` has no write access to
  // `canon_entities`, so a bug in a play route cannot corrupt source material even
  // if it tries.
  const setup = new SetupService({ world: resolveWorld, db: ingest, providers: registry });
  if (await setup.isFresh()) console.log('no canon yet - the UI will open the setup wizard');

  const stories = await listStories(play);
  console.log(`${worlds.length || 1} world(s), ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}`);

  const mcpAuth = buildMcpAuth();
  const mcpResourceUrl =
    process.env.MCP_RESOURCE_URL ?? (host === '127.0.0.1' ? `http://127.0.0.1:${port}/mcp` : undefined);
  if (mcpAuth && !mcpResourceUrl) {
    console.error(
      `MCP auth is configured (${mcpAuth.describe()}) but MCP_RESOURCE_URL is not set, and --host=${host} means there is no ` +
        `safe default to fall back to. Set MCP_RESOURCE_URL to the URL a remote client actually reaches (e.g. ` +
        `https://your-domain.example/mcp). /mcp will not be mounted until this is set.`,
    );
  } else if (mcpAuth && mcpResourceUrl) {
    console.log(mcpAuth.describe());
    console.log(`/mcp mounted at ${mcpResourceUrl}`);
  } else {
    console.log('/mcp not mounted (set MCP_OAUTH_ISSUER or MCP_DEV_TOKEN to enable it)');
  }

  const authConfig = resolveAuthConfig(cfg);
  console.log(
    authConfig
      ? 'login required (WorkOS AuthKit)'
      : 'login not required \u2014 every route is open (set AUTH_REQUIRE_LOGIN=true to change this)',
  );

  const server = createApiServer({
    world: resolveWorld,
    db: play,
    engine,
    webRoot,
    setup,
    registry,
    config: configService,
    illustrations,
    imageRegistry,
    dataRoot,
    imagesDir,
    mcpAuth: mcpAuth ?? undefined,
    mcpResourceUrl,
    authConfig: authConfig ?? undefined,
  });
  server.listen(port, host, () => {
    console.log(`fabulist on http://${host}:${port}`);
  });


  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      server.close();
      void Promise.all([play.close(), ingest.close()]).finally(() => process.exit(0));
    });
  }
}

boot().catch((err) => {
  console.error('failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
