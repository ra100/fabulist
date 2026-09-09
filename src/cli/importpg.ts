#!/usr/bin/env node
/**
 * Imports SQLite worlds into Postgres.
 *
 * The same code `serve.ts` runs at boot, exposed as a command for three cases
 * the automatic path deliberately does not cover:
 *
 *   - **A controlled deploy.** Run the import before starting the server, so a
 *     long import happens while nothing is serving rather than inside a boot the
 *     healthcheck is timing.
 *   - **Retrying a failure.** A world marked `failed` is never retried
 *     automatically (see import-sqlite.ts's header — this deployment has already
 *     crash-looped at boot once, and a self-retrying data importer is how that
 *     becomes corruption). `--reimport=<slug>` is the deliberate override.
 *   - **Inspecting what would happen.** `--dry-run` reports the candidates and
 *     their sizes without touching Postgres.
 *
 * Usage:
 *   pnpm import-pg                        # import everything not yet imported
 *   pnpm import-pg --dry-run
 *   pnpm import-pg --reimport=saint-verrow
 *   pnpm import-pg --data-root=/data
 *
 * Connection comes from DATABASE_URL, matching every other Postgres tool.
 */
import { statSync } from 'node:fs';
import { applySchema, Db } from '../db/pg.ts';
import { findSqliteWorlds, importSqliteWorlds } from '../db/import-sqlite.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const dataRoot = flag('data-root') ?? process.env.DATA_ROOT ?? 'data';
const reimport = flag('reimport');
const dryRun = args.includes('--dry-run');

const candidates = findSqliteWorlds(dataRoot);
if (!candidates.length) {
  console.log(`no SQLite worlds under ${dataRoot}/worlds — nothing to import`);
  process.exit(0);
}

if (dryRun) {
  console.log(`${candidates.length} SQLite world(s) under ${dataRoot}/worlds:`);
  for (const c of candidates) {
    const mb = (statSync(c.dbPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ${c.slug.padEnd(28)} ${mb.padStart(8)} MB  ${c.dbPath}`);
  }
  console.log('\n--dry-run: nothing was imported');
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Start a local server with `pnpm pg:start`, which prints one.');
  process.exit(2);
}

// The ingest role: an import writes canon, which the play role cannot do.
const db = new Db({ connectionString, kind: 'ingest', applicationName: 'fabulist-import' });
try {
  await applySchema(db);
  const report = await importSqliteWorlds(db, {
    dataRoot,
    only: reimport,
    // --reimport is destructive by design: it deletes the world's existing rows
    // and re-reads the file. That is the whole point of asking for it by name.
    force: Boolean(reimport),
    log: (m) => console.log(m),
  });

  if (!report.ran) {
    console.log('another process holds the import lock; nothing done');
  }
  if (report.skipped.length) {
    console.log(`skipped (already imported): ${report.skipped.join(', ')}`);
  }
  console.log(
    `\nimported ${report.imported.length} world(s) in ${(report.ms / 1000).toFixed(1)}s` +
      (report.failed.length ? `, ${report.failed.length} failed` : ''),
  );
  for (const f of report.failed) console.error(`  FAILED ${f.slug}: ${f.error}`);

  // Non-zero on any failure so a deploy script can stop rather than start a
  // server against a half-populated database.
  process.exit(report.failed.length ? 1 : 0);
} finally {
  await db.close();
}
