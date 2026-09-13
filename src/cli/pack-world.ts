#!/usr/bin/env node
/** Builds a portable, checksummed directory for publishing as a release asset. */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createReleasePack } from '../store/release-pack.ts';

const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith('--'));
const to = args.find((arg) => arg.startsWith('--to='))?.slice('--to='.length);
const help = args.some((arg) => arg === '--help' || arg === '-h');

if (help || !source || !to) {
  console.error('usage: pnpm pack-world <source.db> --to=releases/<slug>');
  console.error('creates <slug>/world.db, optional images/, manifest.json, and SHA256SUMS');
  process.exit(help ? 0 : 2);
}

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const result = createReleasePack(resolve(source), resolve(to), packageJson.version);
console.log(
  `${basename(result.dir)}/world.db ready (${result.manifest.world.entityCount} entities, ${result.imageCount} images)`,
);
console.log(`  ${result.dir}`);
