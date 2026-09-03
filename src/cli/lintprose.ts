#!/usr/bin/env node
/** Lints prose from a file or stdin. Useful for tuning the personal blocklist. */
import { readFileSync } from 'node:fs';
import { lintProse } from '../lint/engine.ts';
import { loadConfig } from '../config/config.ts';

const args = process.argv.slice(2);
const profile = args.includes('--doc') ? 'prose-doc' : 'fiction';
const file = args.find((a) => !a.startsWith('--'));

const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const cfg = loadConfig();
const report = lintProse(text, { profile, blocklist: cfg.blocklist, threshold: cfg.proseLintThreshold });

console.log(`profile: ${report.profile}  score: ${report.score}  ${report.tripped ? 'TRIPPED' : 'clean'}`);
for (const f of report.findings) {
  console.log(`  [${f.severity}] ${f.rule} @${f.offset}: ${f.message}`);
  if (f.excerpt) console.log(`      "${f.excerpt}"`);
}
if (!report.findings.length) console.log('  no findings');
