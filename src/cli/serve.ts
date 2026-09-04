#!/usr/bin/env node
/** Serves the API and the built inspector UI. */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { seedWorld } from '../seed/verrow.ts';
import { Engine } from '../loop/engine.ts';
import { createApiServer } from '../server/api.ts';
import { buildRegistry, loadConfig } from '../config/config.ts';
import { makeProseGate } from '../lint/gate.ts';
import { SetupService } from '../setup/service.ts';

const cfg = loadConfig();
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? process.env.PORT ?? 4317);
const inMemory = args.includes('--memory');
const dbPath = inMemory ? ':memory:' : cfg.dbPath;

if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
const world = World.open(dbPath);
if (args.includes('--sample')) {
  seedWorld(world);
  console.log('seeded the Saint Verrow sample');
}

const { registry, notes } = buildRegistry(cfg);
for (const n of notes) console.log(n);

const engine = new Engine({
  world,
  providers: registry,
  proseGate: makeProseGate({ threshold: cfg.proseLintThreshold, blocklist: cfg.blocklist }),
});

const webRoot = existsSync('web/dist') ? 'web/dist' : undefined;
if (!webRoot) console.log('web/dist not built; serving the API only (pnpm build:web)');

const setup = new SetupService({ world, providers: registry });
if (setup.isFresh()) console.log('no world yet - the UI will open the setup wizard');

const server = createApiServer({ world, engine, webRoot, setup });
server.listen(port, '127.0.0.1', () => {
  console.log(`story engine on http://127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    world.close();
    process.exit(0);
  });
}
