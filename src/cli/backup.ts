#!/usr/bin/env node
/**
 * Makes a safe copy of a save. See `store/backup.ts` for why this is not `cp`.
 *
 *   pnpm backup                          # data/backups/<stamp>.db (+ -images/)
 *   pnpm backup --to=data/before-ingest  # an explicit name
 *   pnpm backup path/to/other.db         # a save other than the configured one
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupSave, imagesDirFor, timestamp } from '../store/backup.ts';
import { loadConfig } from '../config/config.ts';

const args = process.argv.slice(2);
const positional = args.find((a) => !a.startsWith('--'));
const dbPath = positional ?? loadConfig().dbPath;

if (!existsSync(dbPath)) {
  console.error(`no save at ${dbPath}`);
  process.exit(2);
}

// Default destination sits beside the save, under `backups/`, stamped so
// repeated runs accumulate rather than overwrite — a backup command that
// silently replaces the previous backup is a footgun, not a safety net.
const toArg = args.find((a) => a.startsWith('--to='))?.slice('--to='.length);
const prefix = toArg ?? join(dirname(dbPath), 'backups', timestamp());

try {
  const res = backupSave(dbPath, prefix);
  const mb = (res.bytes / 1024 / 1024).toFixed(2);
  console.log(`${dbPath} -> ${res.dbPath} (${mb} MB)`);
  if (res.imagesPath) {
    console.log(`  ${res.imageCount} image(s) -> ${res.imagesPath}/`);
  } else if (!existsSync(imagesDirFor(dbPath))) {
    console.log('  no images directory to copy');
  } else {
    console.log('  images directory is empty');
  }
  console.log('  single file, no -wal/-shm: safe to copy, move or hand over');
} catch (err) {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
