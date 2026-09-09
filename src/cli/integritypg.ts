#!/usr/bin/env node
/**
 * Referential integrity check against Postgres.
 *
 * The Postgres counterpart of `pnpm integrity`. Exits non-zero when anything
 * dangles, so it works as a deploy gate or a cron check as well as a thing a
 * human runs after a fork or an import.
 *
 * Usage:
 *   pnpm integrity-pg                    # whole library
 *   pnpm integrity-pg --world=saint-verrow
 *   pnpm integrity-pg --limit=50
 *
 * A note on timing, because the first run surprises people: cold, this reads
 * every row of twelve tables from disk and took 124 seconds on the real corpora;
 * warm it is 56 ms. Scoping to one world with `--world=` avoids most of that.
 */
import { Db, NO_CONNECTION_STRING, connectionStringFromEnv } from '../db/pg.ts';
import { checkIntegrity, formatIntegrityReport } from '../store/integrity-pg.ts';
import { getWorldBySlug } from '../store/index-pg.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const connectionString = connectionStringFromEnv();
if (!connectionString) {
  console.error(NO_CONNECTION_STRING);
  process.exit(2);
}

// The play role suffices: this only ever reads.
const db = new Db({ connectionString, kind: 'play', applicationName: 'fabulist-integrity' });
try {
  const slug = flag('world');
  let worldId: number | undefined;
  if (slug) {
    const world = await getWorldBySlug(db, slug);
    if (!world) {
      console.error(`no world "${slug}"`);
      process.exit(2);
    }
    worldId = world.id;
  }

  const limitArg = flag('limit');
  const started = Date.now();
  const report = await checkIntegrity(db, {
    worldId,
    ...(limitArg ? { limit: Number(limitArg) } : {}),
  });
  console.log(formatIntegrityReport(report));
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s${slug ? `, scoped to ${slug}` : ''})`);
  process.exit(report.ok ? 0 : 1);
} finally {
  await db.close();
}
