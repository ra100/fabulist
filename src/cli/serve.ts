#!/usr/bin/env node
/** Serves the API and the built inspector UI. */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CurrentStory, World } from '../store/index.ts';
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
const dbPath = inMemory ? ':memory:' : cfg.dbPath;
// Images live beside the database rather than inside it (see `store/illustration.ts`),
// so an in-memory run keeps them in-memory-adjacent too: a throwaway `data/images`
// directory next to `:memory:`'s nonexistent file would otherwise litter the
// working directory every time `--memory` is used for a quick test session.
const imagesDir = inMemory ? join('data', '.memory-images') : join(dirname(dbPath), 'images');

if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
// The throwaway config lives under `data/`, which a fresh clone does not have
// until something writes a save there — and the first profile switch in a
// `--memory` session would otherwise fail on the missing directory.
mkdirSync(dirname(configPath), { recursive: true });
const bootWorld = World.open(dbPath, undefined, imagesDir);
if (args.includes('--sample')) {
  seedWorld(bootWorld);
  console.log('seeded the Saint Verrow sample');
}

// The one thing every long-lived piece below resolves through, rather than
// each holding its own captured `World`: a story switch (POST
// /api/stories/:id/switch) takes effect on the very next request across all
// of them — Engine, SetupService, IllustrationService, and every plain route
// in api.ts — with no restart. See store/index.ts's CurrentStory for why.
const currentStory = new CurrentStory(bootWorld.db, bootWorld.storyId, imagesDir);
const getWorld = () => currentStory.world();

const { registry, notes } = buildSwappableRegistry(cfg);
const configService = new ConfigService({ registry, path: configPath });
for (const n of notes) console.log(n);
if (cfg.profile === 'mock') console.log('tip: pnpm providers — the UI can switch profile without a restart');

const { registry: imageRegistry, notes: imageNotes } = buildImageRegistry(cfg);
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
});
server.listen(port, '127.0.0.1', () => {
  console.log(`fabulist on http://127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    bootWorld.close();
    process.exit(0);
  });
}
