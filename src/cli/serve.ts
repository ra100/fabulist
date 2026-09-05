#!/usr/bin/env node
/** Serves the API and the built inspector UI. */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { World } from '../store/index.ts';
import { seedWorld } from '../seed/verrow.ts';
import { Engine } from '../loop/engine.ts';
import { createApiServer } from '../server/api.ts';
import { buildImageRegistry, buildSwappableRegistry, loadConfig } from '../config/config.ts';
import { makeProseGate } from '../lint/gate.ts';
import { SetupService } from '../setup/service.ts';
import { ConfigService } from '../config/service.ts';
import { IllustrationService } from '../illustration/service.ts';

const cfg = loadConfig();
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? process.env.PORT ?? 4317);
const inMemory = args.includes('--memory');
const dbPath = inMemory ? ':memory:' : cfg.dbPath;
// Images live beside the database rather than inside it (see `store/illustration.ts`),
// so an in-memory run keeps them in-memory-adjacent too: a throwaway `data/images`
// directory next to `:memory:`'s nonexistent file would otherwise litter the
// working directory every time `--memory` is used for a quick test session.
const imagesDir = inMemory ? join('data', '.memory-images') : join(dirname(dbPath), 'images');

if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
const world = World.open(dbPath, undefined, imagesDir);
if (args.includes('--sample')) {
  seedWorld(world);
  console.log('seeded the Saint Verrow sample');
}

const { registry, notes } = buildSwappableRegistry(cfg);
const configService = new ConfigService({ registry });
for (const n of notes) console.log(n);
if (cfg.profile === 'mock') console.log('tip: pnpm providers — the UI can switch profile without a restart');

const { registry: imageRegistry, notes: imageNotes } = buildImageRegistry(cfg);
for (const n of imageNotes) console.log(n);
const illustrations = new IllustrationService({ world, providers: imageRegistry });

const engine = new Engine({
  world,
  providers: registry,
  // Live settings, so editing the blocklist affects the very next turn.
  proseGate: makeProseGate({ live: () => configService.lintOptions() }),
});

const webRoot = existsSync('web/dist') ? 'web/dist' : undefined;
if (!webRoot) console.log('web/dist not built; serving the API only (pnpm build:web)');

const setup = new SetupService({ world, providers: registry });
if (setup.isFresh()) console.log('no world yet - the UI will open the setup wizard');

const server = createApiServer({ world, engine, webRoot, setup, registry, config: configService, illustrations, imageRegistry });
server.listen(port, '127.0.0.1', () => {
  console.log(`fabulist on http://127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    world.close();
    process.exit(0);
  });
}
