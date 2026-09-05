#!/usr/bin/env node
/**
 * Reports references that resolve to nothing. See `.design/DBFIXES.md` B3 and
 * `store/integrity.ts` for why the database cannot enforce these itself.
 *
 * Read-only: it never repairs. A dangling reference means something upstream
 * (a fork, a truncate, a hand-edit) is wrong, and deleting the evidence would
 * remove the only signal that it happened.
 *
 * Exits non-zero when anything is dangling, so it works as a gate in a script
 * as well as a thing to read.
 */
import { existsSync } from 'node:fs';
import { openDb } from '../db/db.ts';
import { checkIntegrity, formatIntegrityReport } from '../store/integrity.ts';
import { loadConfig } from '../config/config.ts';

const args = process.argv.slice(2);
const pathArg = args.find((a) => !a.startsWith('--'));
const dbPath = pathArg ?? loadConfig().dbPath;

if (!existsSync(dbPath)) {
  console.error(`no world file at ${dbPath}`);
  process.exit(2);
}

// openDb, not World.open: a file with several stories makes World.open refuse
// to guess which one is meant, and this check is deliberately whole-file
// anyway — cross-story leaks are the failures worth catching.
const db = openDb(dbPath);
try {
  const report = checkIntegrity(db);
  console.log(`${dbPath}`);
  console.log(formatIntegrityReport(report));
  if (!report.ok) process.exitCode = 1;
} finally {
  db.close();
}
