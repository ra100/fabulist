#!/usr/bin/env node
/**
 * Provider doctor. Reports what is usable on this machine and how to fix what
 * is not, which is otherwise a series of confusing mid-session failures.
 */
import { loadConfig } from '../config/config.ts';
import { probeAll, usableProfiles } from '../providers/probe.ts';
import { profilesFor } from '../providers/http.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const cfg = loadConfig();
const offline = process.argv.includes('--offline');

console.log(`${DIM}probing providers…${RESET}\n`);
const results = await probeAll(cfg.providers, { offline });

const mark = (s: string) => (s === 'ready' ? `${GREEN}ready${RESET}` : s === 'unknown' ? `${DIM}   ?  ${RESET}` : `${YELLOW}  --  ${RESET}`);

for (const r of results) {
  console.log(`${mark(r.status)}  ${BOLD}${r.key.padEnd(20)}${RESET} ${DIM}${r.auth}${RESET}`);
  if (r.detail) console.log(`        ${DIM}${r.detail}${RESET}`);
  if (r.fix) console.log(`        ${YELLOW}→ ${r.fix}${RESET}`);
  if (r.note) console.log(`        ${DIM}note: ${r.note}${RESET}`);
}

const usable = usableProfiles(results, profilesFor(cfg.providers));
console.log(`\n${BOLD}profiles you can use now:${RESET} ${usable.length ? usable.join(', ') : `${DIM}none — mock only${RESET}`}`);
console.log(`${DIM}current profile: ${cfg.profile}${RESET}`);
if (usable.length && !usable.includes(cfg.profile) && cfg.profile !== 'mock') {
  console.log(`${YELLOW}"${cfg.profile}" is not fully available; the engine will fall back to the mock provider.${RESET}`);
}
