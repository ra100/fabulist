/**
 * Postgres test harness: one throwaway schema per test.
 *
 * SQLite gave every test `:memory:` — a private, zero-cost, torn-down-by-GC
 * database. Postgres has no equivalent, and the obvious substitutes are both
 * wrong: sharing one database serialises the suite and leaks state between
 * tests, while creating a *database* per test costs a template copy each time.
 *
 * A schema per test is the middle path. `CREATE SCHEMA` is cheap, `search_path`
 * makes unqualified table names resolve to it so no query needs to know it
 * exists, and `DROP SCHEMA CASCADE` is a complete teardown. Tests stay
 * parallel-safe because two schemas cannot see each other.
 *
 * The one real cost is applying the schema per test (29 tables plus indexes).
 * `withPg` therefore caches the DDL text and runs it as a single multi-statement
 * query, which measured fast enough not to matter; if it ever does, the next
 * step is a template schema cloned with `CREATE SCHEMA ... LIKE`-style copying
 * rather than re-running DDL.
 *
 * Skipping rather than failing when no server is configured is deliberate. The
 * suite has to stay runnable on a laptop with no Postgres — `node --test`
 * reports these as skipped, and CI sets FABULIST_TEST_PG so they actually run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, applyMigrations } from '../src/db/pg.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, '..', 'src', 'db', 'schema-pg.sql'), 'utf8');
/**
 * The grants are applied per test schema too, not just in production.
 *
 * Skipping them here would leave the boundary untested exactly where it is
 * cheapest to test, and the first attempt at this file did skip them — a test
 * asserting the play role could still read canon failed with
 * `has_table_privilege(...) = false`, which is how the "ALL TABLES IN SCHEMA
 * public is a snapshot of one named schema" bug in the roles file was found.
 */
const ROLES_SQL = readFileSync(join(here, '..', 'src', 'db', 'schema-pg-roles.sql'), 'utf8');

/**
 * The test server's connection string.
 *
 * `FABULIST_TEST_PG` is the explicit opt-in. The fallback matches the dev
 * cluster this project starts locally (`pnpm pg:start`), so a developer who has
 * one running gets the tests without configuring anything.
 */
export function testConnectionString(): string | null {
  const connectionString = process.env.FABULIST_TEST_PG ?? process.env.DATABASE_URL ?? null;
  if (!connectionString && process.env.FABULIST_REQUIRE_TEST_PG === '1') {
    throw new Error('PostgreSQL tests are required, but FABULIST_TEST_PG and DATABASE_URL are not set');
  }
  return connectionString;
}

let counter = 0;

/**
 * Runs `fn` against an isolated schema, then drops it.
 *
 * Returns `false` when no Postgres is configured, so a caller can skip:
 *
 *     test('…', async (t) => {
 *       const ok = await withPg(async (db) => { … });
 *       if (!ok) t.skip('no Postgres configured');
 *     });
 */
export async function withPg(fn: (db: Db, schema: string) => Promise<void>): Promise<boolean> {
  const cs = testConnectionString();
  if (!cs) return false;

  // Unique per process *and* per call: two test files running concurrently in
  // separate processes would otherwise collide on a shared counter.
  const schema = `t_${process.pid}_${counter++}`;

  // Bootstrap connection, only to create the schema. Separate from the pool
  // below because the pool needs `search_path` set at connection time, and the
  // schema has to exist before any pooled client connects.
  const boot = new Db({ connectionString: cs, kind: 'ingest', max: 1 });
  try {
    await boot.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await boot.close();
  }

  // `options=-csearch_path=…` is what makes unqualified names resolve to this
  // test's schema on every pooled connection. Setting it per-query would be a
  // footgun: one forgotten SET and a test writes to `public`.
  const sep = cs.includes('?') ? '&' : '?';
  const db = new Db({
    connectionString: `${cs}${sep}options=-csearch_path%3D${schema}`,
    kind: 'ingest',
    max: 4,
    applicationName: `fabulist-test-${schema}`,
  });

  try {
    await db.query(SCHEMA_SQL);
    await applyMigrations(db);
    await db.query(ROLES_SQL);
    await fn(db, schema);
  } finally {
    await db.close();
    const cleanup = new Db({ connectionString: cs, kind: 'ingest', max: 1 });
    try {
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await cleanup.close();
    }
  }
  return true;
}

/**
 * Inserts a world and returns its id.
 *
 * `num()`-style conversion is applied here because `worlds.id` is BIGSERIAL and
 * `pg` returns BIGINT as a string — a test comparing `worldId === 1` against
 * `'1'` fails in a way that looks like a data bug rather than a type one.
 */
export async function makeWorld(db: Db, slug: string, title = slug): Promise<number> {
  const row = await db.one<{ id: string }>(`INSERT INTO worlds (slug, title) VALUES ($1, $2) RETURNING id`, [
    slug,
    title,
  ]);
  return Number(row!.id);
}

/** Inserts a story and points it at `worldIds` in the order given. */
export async function makeStory(db: Db, id: string, worldIds: number[], ownerUserId?: string): Promise<string> {
  await db.query(`INSERT INTO stories (id, owner_user_id, title) VALUES ($1, $2, $3)`, [id, ownerUserId ?? null, id]);
  for (const [i, worldId] of worldIds.entries()) {
    await db.query(`INSERT INTO story_sources (story_id, world_id, ordinal) VALUES ($1, $2, $3)`, [id, worldId, i + 1]);
  }
  return id;
}

/** Bulk canon entities, for tests that need enough rows to make a plan realistic. */
export async function seedCanon(db: Db, worldId: number, count: number, prefix = 'char'): Promise<void> {
  await db.query(
    `INSERT INTO canon_entities (world_id, id, type, name, summary, salience)
     SELECT $1, $2 || ':e' || g, 'Character', 'Entity ' || g, 'canon', (g % 100)::real / 100
     FROM generate_series(1, $3) g`,
    [worldId, prefix, count],
  );
}
