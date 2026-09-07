#!/usr/bin/env node
/**
 * `pnpm dlx fabulist` / `npx fabulist` entrypoint.
 *
 * `serve.ts` already runs directly under Node 24 with no build step (see
 * PLAN.md's stack decisions) — this shim's only job is silencing
 * `node:sqlite`'s experimental-feature warning for a first-time user who has
 * no reason to know what that means, the same way package.json's own `serve`
 * script passes `--disable-warning=ExperimentalWarning` for local dev.
 *
 * That flag has to be on the command line of the process that imports
 * `node:sqlite` — Node parses `--disable-warning` (and `NODE_OPTIONS`) at its
 * own startup, before any script runs, so setting `process.env.NODE_OPTIONS`
 * from inside this file has no effect on this process (checked directly
 * rather than assumed). Re-exec once, with the flag actually on the argv this
 * time, rather than ship a warning-suppression comment that doesn't suppress
 * anything.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serveTs = join(here, '..', 'src', 'cli', 'serve.ts');

const result = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', serveTs, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
