#!/usr/bin/env node
/** Creates or resets the save with hand-authored canon. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { seedWorld } from '../seed/verrow.ts';
import { loadConfig } from '../config/config.ts';

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const world = World.open(cfg.dbPath);
seedWorld(world);
const c = world.graph.counts();
console.log(`seeded ${cfg.dbPath}: ${c.entities} entities, ${c.edges} edges, ${world.cast.list().length} sheets`);
world.close();
