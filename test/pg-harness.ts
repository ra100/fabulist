/**
 * Postgres test harness: one isolated schema per test.
 *
 * SQLite gave every test `:memory:` — a private, zero-cost, torn-down-by-GC
 * database. Postgres has no equivalent, and the obvious substitutes are both
 * wrong: sharing one database serialises the suite and leaks state between
 * tests, while creating a *database* per test costs a template copy each time.
 *
 * A schema per test is the middle path. `search_path` makes unqualified table
 * names resolve to it so no query needs to know it exists, and tests stay
 * parallel-safe because two schemas cannot see each other.
 *
 * ## Why schemas are pooled rather than created per test
 *
 * Building a schema is not cheap: the DDL, the migrations and the grants took
 * ~140 ms of server time per test, and dropping it another ~40 ms. Across the
 * ~300 `withPg` calls in the suite that was ~70 s of Postgres CPU, more than
 * half of everything the database did in a full run, and on a 4-vCPU CI runner
 * it competed with the test processes for the same cores.
 *
 * So a finished schema is kept and handed to the next test, in any test
 * process, after being put back exactly as a fresh one would be:
 *
 *   - **Claimed by an advisory lock**, held on a dedicated connection for the
 *     whole test. Two tests can never share a slot, and a test process that
 *     dies releases its slot with its connection.
 *   - **Verified structurally before reuse.** A catalog fingerprint (tables,
 *     columns, constraints, indexes, triggers, grants, default privileges) is
 *     stored on the schema when it is built and recomputed on every claim, and
 *     the `migrations` rows are compared too. A test that ran DDL — dropping a
 *     column to replay a migration, dropping an index to prove a plan needs it
 *     — leaves a mismatch, and that slot is dropped and rebuilt from scratch.
 *     Planner statistics are checked the same way: a slot something ANALYZEd
 *     is rebuilt rather than handed on with another test's statistics.
 *   - **Emptied before use**, not after: every table except `migrations` is
 *     truncated and every sequence restarted. Doing it on claim is what makes
 *     a crashed test harmless — its leftovers are wiped by whoever takes the
 *     slot next.
 *
 * Slot names carry a hash of the schema, migrations and grants SQL, so
 * changing any of them builds new slots instead of reusing stale ones; slots
 * left behind by an older hash are dropped once nothing holds them.
 *
 * Skipping rather than failing when no server is configured is deliberate. The
 * suite has to stay runnable on a laptop with no Postgres — `node --test`
 * reports these as skipped, and CI sets FABULIST_TEST_PG so they actually run.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { Db, applyMigrations } from '../src/db/pg.ts';
import { usageSettled } from '../src/providers/metered.ts';

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

/**
 * Everything that decides what a fresh schema looks like. A change to any of it
 * changes the slot names, so old slots are never mistaken for current ones.
 */
const MIGRATIONS_DIR = join(here, '..', 'src', 'db', 'migrations-pg');
const POOL_VERSION = (() => {
  const hash = createHash('sha256').update(SCHEMA_SQL).update(ROLES_SQL);
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    hash.update(name).update(readFileSync(join(MIGRATIONS_DIR, name)));
  }
  return hash.digest('hex').slice(0, 7);
})();
const SLOT_PREFIX = 'tpool_';

/** Slot schema name and its advisory lock key: the hash prefix as int32, plus the slot number. */
function slotName(version: string, n: number): string {
  return `${SLOT_PREFIX}${version}_${n}`;
}
function lockKey(version: string): number {
  // Seven hex digits is 28 bits, which always fits the int4 advisory-lock key.
  return Number.parseInt(version, 16);
}

/**
 * A digest of the schema's structure, as the catalog sees it. Anything a test
 * could change with DDL and that a later test could observe is in here: tables
 * and their columns (including dropped ones, so a dropped-and-re-added column
 * is not mistaken for the original), defaults, constraints, indexes, triggers,
 * functions, policies, types, per-object grants and default privileges.
 */
const FINGERPRINT_SQL = `
SELECT md5(concat_ws('|',
  (SELECT string_agg(concat_ws(':', c.relname, c.relkind, c.relacl::text, c.relrowsecurity, c.relpersistence), ',' ORDER BY c.relname)
     FROM pg_class c WHERE c.relnamespace = n.oid),
  (SELECT string_agg(concat_ws(':', c.relname, a.attnum, a.attname, a.atttypid, a.atttypmod, a.attnotnull, a.attisdropped,
                               a.attidentity, a.attgenerated, a.attacl::text, pg_get_expr(d.adbin, d.adrelid)), ',' ORDER BY c.relname, a.attnum)
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = n.oid AND a.attnum > 0),
  (SELECT string_agg(concat_ws(':', co.conname, pg_get_constraintdef(co.oid)), ',' ORDER BY co.conname, pg_get_constraintdef(co.oid))
     FROM pg_constraint co WHERE co.connamespace = n.oid),
  (SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY pg_get_indexdef(i.indexrelid))
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = n.oid),
  (SELECT string_agg(concat_ws(':', t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)), ',' ORDER BY t.tgname)
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = n.oid AND NOT t.tgisinternal),
  (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), p.proacl::text), ',' ORDER BY p.proname, md5(p.prosrc))
     FROM pg_proc p WHERE p.pronamespace = n.oid),
  (SELECT string_agg(concat_ws(':', po.polname, po.polcmd, pg_get_expr(po.polqual, po.polrelid)), ',' ORDER BY po.polname)
     FROM pg_policy po JOIN pg_class c ON c.oid = po.polrelid WHERE c.relnamespace = n.oid),
  (SELECT string_agg(concat_ws(':', ty.typname, ty.typtype), ',' ORDER BY ty.typname)
     FROM pg_type ty WHERE ty.typnamespace = n.oid AND ty.typtype NOT IN ('b', 'c')),
  (SELECT string_agg(concat_ws(':', da.defaclrole, da.defaclobjtype, da.defaclacl::text), ',' ORDER BY da.defaclrole, da.defaclobjtype)
     FROM pg_default_acl da WHERE da.defaclnamespace = n.oid),
  n.nspacl::text
)) AS fp
FROM pg_namespace n WHERE n.nspname = $1`;

/**
 * What a slot is compared against on claim: the catalog fingerprint plus the
 * `migrations` rows (a test that deletes one to replay a migration changes
 * data, not structure). Stored as the schema's comment when the slot is built.
 */
async function slotState(lock: Client, schema: string): Promise<string | null> {
  const fp = await lock.query<{ fp: string }>(FINGERPRINT_SQL, [schema]);
  if (!fp.rows[0]) return null;
  const versions = await lock.query<{ v: string | null }>(
    `SELECT string_agg(version || ':' || name, ',' ORDER BY version) AS v FROM ${schema}.migrations`,
  );
  return `${fp.rows[0].fp}/${versions.rows[0]?.v ?? ''}`;
}

/** True when the slot can be handed out as-is after emptying it. */
async function slotIsPristine(lock: Client, schema: string): Promise<boolean> {
  const stored = await lock.query<{ comment: string | null; analyzed: boolean }>(
    `SELECT obj_description(n.oid, 'pg_namespace') AS comment,
            EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = n.nspname) AS analyzed
       FROM pg_namespace n WHERE n.nspname = $1`,
    [schema],
  );
  const row = stored.rows[0];
  if (!row?.comment || row.analyzed) return false;
  try {
    return (await slotState(lock, schema)) === row.comment;
  } catch {
    // e.g. a test dropped the migrations table: not pristine, rebuild it.
    return false;
  }
}

/**
 * Tables in the order they can be emptied with DELETE: every table after all
 * the tables holding a foreign key into it. The same for every pristine slot,
 * since the fingerprint proved they are structurally identical, so it is worked
 * out once per process. `null` when the foreign keys form a cycle.
 */
let deleteOrder: string[] | null | undefined;
async function tablesInDeleteOrder(lock: Client, schema: string): Promise<string[] | null> {
  if (deleteOrder !== undefined) return deleteOrder;
  const tables = await lock.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 AND tablename <> 'migrations' ORDER BY 1`,
    [schema],
  );
  const fks = await lock.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_class p ON p.oid = co.confrelid
      WHERE co.contype = 'f' AND co.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
        AND co.conrelid <> co.confrelid`,
    [schema],
  );
  // Children first: a table is ready once nothing still pending references it.
  const pending = new Set(tables.rows.map((r) => r.name));
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((t) => !fks.rows.some((fk) => fk.parent === t && pending.has(fk.child)));
    if (!ready.length) return (deleteOrder = null);
    for (const t of ready) {
      order.push(t);
      pending.delete(t);
    }
  }
  return (deleteOrder = order);
}

/**
 * Empties every table but `migrations` and restarts every sequence.
 *
 * DELETE on just the tables that hold rows, not TRUNCATE on all of them:
 * TRUNCATE swaps in new files for every table and index it names — and a
 * foreign key forces naming nearly the whole schema — which measured ~100 ms
 * per test, while a typical test leaves rows in a handful of small tables. The
 * difference DELETE leaves (dead tuples until autovacuum) is not visible to a
 * query; the one thing it could sway is a plan, and the plan tests ANALYZE,
 * which marks the slot for a rebuild anyway (see `slotIsPristine`).
 */
async function emptySlot(lock: Client, schema: string): Promise<void> {
  const order = await tablesInDeleteOrder(lock, schema);
  if (!order) {
    const all = await lock.query<{ list: string | null }>(
      `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS list
         FROM pg_tables WHERE schemaname = $1 AND tablename <> 'migrations'`,
      [schema],
    );
    if (all.rows[0]?.list) await lock.query(`TRUNCATE ${all.rows[0].list}`);
  } else if (order.length) {
    const probe = order
      .map((t, i) => `SELECT ${i} AS i WHERE EXISTS (SELECT 1 FROM ${schema}.${quoteIdent(t)})`)
      .join(' UNION ALL ');
    const filled = new Set((await lock.query<{ i: number }>(probe)).rows.map((r) => r.i));
    const deletes = order.filter((_, i) => filled.has(i)).map((t) => `DELETE FROM ${schema}.${quoteIdent(t)};`);
    if (deletes.length) await lock.query(deletes.join('\n'));
  }
  await lock.query(
    `SELECT setval(format('%I.%I', schemaname, sequencename)::regclass, start_value, false)
       FROM pg_sequences WHERE schemaname = $1`,
    [schema],
  );
}

function quoteIdent(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

/** Builds a slot from nothing: exactly what every test used to get, then records its state. */
async function buildSlot(cs: string, lock: Client, schema: string): Promise<void> {
  await lock.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await lock.query(`CREATE SCHEMA ${schema}`);
  const db = new Db({ connectionString: scopedTo(cs, schema), kind: 'ingest', max: 1 });
  try {
    await db.query(SCHEMA_SQL);
    await applyMigrations(db);
    await db.query(ROLES_SQL);
  } finally {
    await db.close();
  }
  const state = await slotState(lock, schema);
  await lock.query(`COMMENT ON SCHEMA ${schema} IS ${quoteLiteral(state ?? '')}`);
}

function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * Drops slots from older schema versions, once per process. Each is taken by
 * its own advisory lock first, so a run of an older checkout still using one
 * against the same database keeps it.
 */
let staleSwept = false;
async function sweepStaleSlots(lock: Client): Promise<void> {
  if (staleSwept) return;
  staleSwept = true;
  const { rows } = await lock.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE '${SLOT_PREFIX}%' AND nspname NOT LIKE $1`,
    [`${SLOT_PREFIX}${POOL_VERSION}_%`],
  );
  for (const { nspname } of rows) {
    const m = /^tpool_([0-9a-f]{7})_(\d+)$/.exec(nspname);
    if (!m) continue;
    const key = [lockKey(m[1]!), Number(m[2])];
    const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', key);
    if (!got.rows[0]?.ok) continue;
    try {
      await lock.query(`DROP SCHEMA IF EXISTS ${nspname} CASCADE`);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1, $2)', key);
    }
  }
}

/**
 * Takes the lowest free slot, making it pristine first. The lock is a session
 * lock on `lock`, so it lasts until that connection unlocks or closes.
 */
async function claimSlot(cs: string, lock: Client): Promise<{ schema: string; n: number }> {
  await sweepStaleSlots(lock);
  const key = lockKey(POOL_VERSION);
  for (let n = 0; ; n++) {
    const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [key, n]);
    if (!got.rows[0]?.ok) continue;
    const schema = slotName(POOL_VERSION, n);
    try {
      if (await slotIsPristine(lock, schema)) await emptySlot(lock, schema);
      else await buildSlot(cs, lock, schema);
    } catch (err) {
      await lock.query('SELECT pg_advisory_unlock($1, $2)', [key, n]);
      throw err;
    }
    return { schema, n };
  }
}

function scopedTo(cs: string, schema: string): string {
  // `options=-csearch_path=…` is what makes unqualified names resolve to this
  // test's schema on every pooled connection. Setting it per-query would be a
  // footgun: one forgotten SET and a test writes to `public`.
  const sep = cs.includes('?') ? '&' : '?';
  return `${cs}${sep}options=-csearch_path%3D${schema}`;
}

/**
 * Pools that connect to the same schema but `SET ROLE` to the two group roles,
 * so a test can run application code under the grants production will enforce.
 * Built on first access — most tests never touch them, and each pool is a
 * connection per client. The owner `db` stays the place for fixtures and
 * assertions: it can see and write everything.
 */
export interface RolePools {
  readonly play: Db;
  readonly ingest: Db;
}

/**
 * Runs `fn` against an isolated, empty schema that no other test can touch
 * while it runs.
 *
 * Returns `false` when no Postgres is configured, so a caller can skip:
 *
 *     test('…', async (t) => {
 *       const ok = await withPg(async (db) => { … });
 *       if (!ok) t.skip('no Postgres configured');
 *     });
 */
export async function withPg(fn: (db: Db, schema: string, roles: RolePools) => Promise<void>): Promise<boolean> {
  const cs = testConnectionString();
  if (!cs) return false;

  // Holds the slot's advisory lock for the whole test, and nothing else.
  const lock = new Client({ connectionString: cs, application_name: 'fabulist-test-slot' });
  await lock.connect();
  try {
    const { schema, n } = await claimSlot(cs, lock);
    const scoped = scopedTo(cs, schema);
    const db = new Db({
      connectionString: scoped,
      kind: 'ingest',
      max: 4,
      applicationName: `fabulist-test-${schema}`,
    });

    // `search_path` comes from the connection string, so it survives `SET ROLE`.
    let play: Db | undefined;
    let ingest: Db | undefined;
    const roles: RolePools = {
      get play() {
        return (play ??= new Db({ connectionString: scoped, kind: 'play', role: 'fabulist_play', max: 4 }));
      },
      get ingest() {
        return (ingest ??= new Db({ connectionString: scoped, kind: 'ingest', role: 'fabulist_ingest', max: 2 }));
      },
    };

    try {
      await fn(db, schema, roles);
    } finally {
      // Metering is fire-and-forget; a write still queued when its pool ends would never settle.
      await usageSettled();
      // Before the slot goes back: the next test's TRUNCATE would wait on an open connection.
      await Promise.all([play?.close(), ingest?.close()]);
      await db.close();
      await lock.query('SELECT pg_advisory_unlock($1, $2)', [lockKey(POOL_VERSION), n]);
    }
  } finally {
    await lock.end();
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
