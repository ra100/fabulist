#!/usr/bin/env node
/** Serves the API and the built inspector UI. */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CurrentWorld } from '../store/index.ts';
import { createWorldFile, listWorlds, migrateLegacySave, worldsRoot } from '../store/worlds.ts';
import { seedWorld } from '../seed/verrow.ts';
import { Engine } from '../loop/engine.ts';
import { createApiServer } from '../server/api.ts';
import { buildImageRegistry, buildSwappableRegistry, loadConfig } from '../config/config.ts';
import { makeProseGate } from '../lint/gate.ts';
import { SetupService } from '../setup/service.ts';
import { ConfigService } from '../config/service.ts';
import { IllustrationService } from '../illustration/service.ts';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? process.env.PORT ?? 4317);
const inMemory = args.includes('--memory');
// Loopback-only by default: right for "my laptop, my save file", wrong inside
// a container, where 127.0.0.1 is the container's own network namespace and
// unreachable through Docker's port mapping. `--host=0.0.0.0` (what the
// Dockerfile passes) opts into listening on every interface; the default is
// unchanged for anyone not passing the flag.
const hostArg = args.find((a) => a.startsWith('--host='));
const host = hostArg?.split('=')[1] ?? process.env.HOST ?? '127.0.0.1';

/**
 * Where config writes land. `--memory` means "throwaway", and that has to
 * include the config file: settings and the setup wizard *write* through
 * `ConfigService` (switching profile, keeping a provider spec), so a throwaway
 * server pointed at the real `fabulist.config.json` silently edits it. That
 * happened twice while browser-testing the provider UI — a kept `bedrock:sonnet`
 * and a switched profile, both of which had to be reverted by hand afterwards.
 *
 * `--config=<path>` overrides it explicitly, for the same reason
 * `--memory` exists at all.
 */
const configArg = args.find((a) => a.startsWith('--config='))?.slice('--config='.length);
const configPath = configArg ?? (inMemory ? join('data', '.memory-config.json') : 'fabulist.config.json');

const cfg = loadConfig(configPath);

/**
 * Boot resolves a *world directory*, not a bare database path.
 *
 * `cfg.dbPath` is now only the legacy pointer and the migration source. A world
 * is a directory under `data/worlds/` (see `store/worlds.ts`), because switching
 * worlds at runtime means closing one file and opening another — which the old
 * single-`dbPath` shape could not express, and which is why config still refuses
 * to let `dbPath` be patched.
 *
 * `--memory` keeps its own throwaway world so a quick test session never touches
 * a real one, and `--world=<slug>` overrides which world to open.
 *
 * `--data-root=<path>` (or `DATA_ROOT`) overrides the base `data` directory
 * everything above resolves under. This has to be settable independently of
 * `--config=`: the Dockerfile mounts a *volume* at `/data` and only that path
 * survives a container recreate, but pointing `--config=` at a file inside it
 * says nothing about where `worldsRoot()`/`listWorlds()`/`createWorldFile()`
 * put the actual SQLite world files — those defaulted to the bare `'data'`
 * relative to `WORKDIR /app`, i.e. the container's writable layer, not the
 * volume. A `docker compose pull && up -d` recreates the container and wipes
 * that layer, so every world silently vanished on redeploy until this flag
 * existed to route them into the same volume the config file already uses.
 */
const dataRootArg = args.find((a) => a.startsWith('--data-root='))?.slice('--data-root='.length);
const dataRootBase = dataRootArg ?? process.env.DATA_ROOT ?? 'data';
const dataRoot = inMemory ? join(dataRootBase, '.memory-worlds') : dataRootBase;
const worldArg = args.find((a) => a.startsWith('--world='))?.slice('--world='.length);

mkdirSync(worldsRoot(dataRoot), { recursive: true });
// The throwaway config lives under `data/`, which a fresh clone does not have
// until something writes a save there — and the first profile switch in a
// `--memory` session would otherwise fail on the missing directory.
mkdirSync(dirname(configPath), { recursive: true });

// A save from before the multi-world layout is somebody's actual novel, so it is
// moved into the new layout rather than left at a path nothing reads anymore.
// Only for real runs: a `--memory` session must never touch the real save.
if (!inMemory) {
  const migrated = migrateLegacySave(cfg.dbPath, dataRoot);
  if (migrated) {
    console.log(`moved ${cfg.dbPath} into ${migrated.dir} (worlds now live in one directory each)`);
  }
}

// Land on the requested world, else the most recently played, else create one.
// A fresh install gets an empty world so the wizard has somewhere to ingest into
// — the same role `World.open` on a nonexistent path used to play.
const existing = listWorlds(dataRoot);
const bootSlug =
  worldArg ??
  existing[0]?.slug ??
  createWorldFile(inMemory ? 'scratch world' : '', dataRoot).slug;

const currentWorld = CurrentWorld.open(bootSlug, dataRoot);
if (args.includes('--sample')) {
  seedWorld(currentWorld.world());
  console.log('seeded the Saint Verrow sample');
}

// The one thing every long-lived piece below resolves through, rather than
// each holding its own captured `World`: a story switch (POST
// /api/stories/:id/switch) *or* a world switch (POST /api/worlds/:slug/switch)
// takes effect on the very next request across all of them — Engine,
// SetupService, IllustrationService, and every plain route in api.ts — with no
// restart. See store/index.ts's CurrentStory/CurrentWorld for why.
const currentStory = currentWorld.stories();
const getWorld = () => currentWorld.world();

const { registry, notes } = buildSwappableRegistry(cfg);
const { registry: imageRegistry, notes: imageNotes } = buildImageRegistry(cfg);
// Both registries are handed to the config service so editing a provider — text
// or image, including an image host on another machine — takes effect on the
// next call rather than at the next restart.
const configService = new ConfigService({ registry, imageRegistry, path: configPath });
for (const n of notes) console.log(n);
if (cfg.profile === 'mock') console.log('tip: pnpm providers — the UI can switch profile without a restart');

for (const n of imageNotes) console.log(n);
const illustrations = new IllustrationService({ world: getWorld, providers: imageRegistry });

const engine = new Engine({
  world: getWorld,
  providers: registry,
  // Live settings, so editing the blocklist affects the very next turn.
  proseGate: makeProseGate({ live: () => configService.lintOptions() }),
});

const webRoot = existsSync('web/dist') ? 'web/dist' : undefined;
if (!webRoot) console.log('web/dist not built; serving the API only (pnpm build:web)');

const setup = new SetupService({ world: getWorld, providers: registry });
if (setup.isFresh()) console.log('no world yet - the UI will open the setup wizard');

const server = createApiServer({
  world: getWorld,
  engine,
  webRoot,
  setup,
  registry,
  config: configService,
  illustrations,
  imageRegistry,
  currentStory,
  currentWorld,
  dataRoot,
});
server.listen(port, host, () => {
  console.log(`fabulist on http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    currentWorld.close();
    process.exit(0);
  });
}
