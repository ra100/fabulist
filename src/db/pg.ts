/**
 * The database layer: a `pg` pool, two roles, and a transaction helper.
 *
 * ## Why this replaced node:sqlite
 *
 * Not for throughput. Both engines were measured on the real corpora at the
 * target scale (20 worlds, 450k canon entities, 2.26M canon edges, 100 users)
 * and neither was near its limit — SQLite sustained 23,004 write-tx/sec and
 * logged zero SQLITE_BUSY with two processes on one WAL file. The reasons are:
 *
 *   - **The user/system boundary becomes a GRANT** (`schema-pg-roles.sql`).
 *     With canon and stories in separate tables and separate roles, "the play
 *     path cannot corrupt canon" is enforced by the database instead of by
 *     review. This is the main reason.
 *   - **Crossover stops being capped.** Composing worlds under SQLite meant
 *     ATTACHing one file per world, and SQLite refuses the 11th attach
 *     (measured: "too many attached databases - max 10"), so a crossover could
 *     never exceed 8 sources. Here it is a join.
 *   - **Postgres was already running on the deployment.** No new
 *     infrastructure, backup story, or monitoring.
 *
 * The cost was converting ~441 synchronous calls to async, which is why every
 * store method now returns a promise.
 *
 * ## Two pools, deliberately
 *
 * `play` and `ingest` connect as different roles *and* have different sizes,
 * for two independent reasons.
 *
 * The role split is the safety property above. The size split is a measured
 * throughput one: with four concurrent ingest clients writing canon, turn-commit
 * latency went from 6.6 ms to 40 ms — a 6x regression for the person actually
 * playing. Capping the ingest pool small means an ingest cannot consume the
 * connections a player needs, so a background crawl degrades itself rather than
 * the foreground.
 *
 * There is also a hard ceiling to respect: Postgres' default
 * `max_connections` is 100, and a benchmark of 100 players plus one ingest
 * aborted outright with `FATAL: sorry, too many clients already`. That is a
 * server-side setting this code cannot fix, so `assertCapacity` probes it at
 * startup and says so plainly rather than letting the failure surface as a
 * request error under load.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The subset of `pg` every store and the overlay depend on.
 *
 * Narrow on purpose: a store that accepts `Queryable` works unchanged against
 * the pool, against a single checked-out client, and against a transaction —
 * which is what lets `tx()` hand the same store code a client without every
 * method needing a "and also, in a transaction" variant. Anything wanting a
 * pool-only feature (listen/notify, say) asks for `Db` explicitly.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export interface DbOptions {
  connectionString: string;
  /** Which role's pool this is; picks the size defaults and names it in errors. */
  kind?: 'play' | 'ingest';
  max?: number;
  /** Statement timeout in ms. Guards the play pool against one pathological query pinning a connection. */
  statementTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Pool sizes.
 *
 * `play` at 20: enough that 100 concurrent users queue rather than fail, since
 * the measured per-request time is ~2 ms and the queue drains far faster than
 * requests arrive.
 *
 * `ingest` at 3: small enough that it cannot starve `play` (see the 6.6 -> 40 ms
 * measurement above), large enough that Pass A's batch writes and Pass B's
 * per-page updates are not serialised behind each other.
 */
/**
 * Pool sizes, defaulted for one person on one server rather than for the load
 * ceiling.
 *
 * Each pooled connection is a *process* in Postgres, and measured on this schema it
 * costs about 1.8 MB of server memory: an idle Postgres container sits at 20 MB, and
 * holding 23 connections open takes it to 62 MB. So the old default of 20 play
 * connections spent ~36 MB to serve a concurrency nobody had — the number was chosen
 * for the 100-user load test, which is the wrong default for the common case.
 *
 * Four is enough for a handful of simultaneous readers, and a turn holds a
 * connection only while it queries — the seconds a turn spends waiting on a model
 * are spent with the connection *returned* to the pool. `FABULIST_PG_POOL` raises it
 * for an instance that genuinely has concurrent players; the load test at 100 users
 * used 20 and is what that setting is for.
 *
 * Ingest stays at 2. It is one crawl at a time by design, and the second connection
 * is what lets a batch flush while the next page parses.
 */
/**
 * The connection string every Postgres entry point should use.
 *
 * One place, because having more than one was a real trap: `serve-pg` accepted
 * `FABULIST_PG` *or* `DATABASE_URL`, while `importpg` and `integritypg` accepted only
 * `DATABASE_URL`. So a deployment configured the documented way — `FABULIST_PG` in
 * `app.env`, which is what docker-compose.yml sets — ran the server fine and then failed
 * every maintenance command with "DATABASE_URL is not set", pointing at `pnpm pg:start`
 * as though no database existed. Reported from a live instance while trying to re-run an
 * import.
 *
 * `FABULIST_PG` wins: it is the project's own name and the one the compose file and CI
 * set. `DATABASE_URL` stays supported because it is the convention every other Postgres
 * tool reads, and dropping it would break anyone who had followed that.
 *
 * Returns undefined rather than defaulting, so a CLI can print its own guidance; the
 * server supplies its own localhost fallback because a dev server with no configuration
 * should still start.
 */
export function connectionStringFromEnv(): string | undefined {
  return process.env.FABULIST_PG ?? process.env.DATABASE_URL ?? undefined;
}

/** The message to print when neither variable is set. Shared so all three agree. */
export const NO_CONNECTION_STRING =
  'Set FABULIST_PG (or DATABASE_URL) to your Postgres connection string.\n' +
  '  Docker deployments already have it in app.env; inside the container it is exported.\n' +
  '  For a local server: pnpm pg:start, which prints one.';

const POOL_DEFAULTS = { play: 4, ingest: 2 } as const;

export class Db implements Queryable {
  readonly pool: Pool;
  readonly kind: 'play' | 'ingest';

  constructor(opts: DbOptions) {
    this.kind = opts.kind ?? 'play';
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? POOL_DEFAULTS[this.kind],
      application_name: opts.applicationName ?? `fabulist-${this.kind}`,
      // A statement timeout on the play pool bounds the damage of a bad plan:
      // the overlay query is 1.7 ms when its indexes are present and 1220 ms
      // when they are not, and the second case should fail loudly rather than
      // hold a connection for over a second under load.
      statement_timeout: opts.statementTimeoutMs ?? (this.kind === 'play' ? 15_000 : 0),
    });
    // An idle client erroring (server restart, network blip) emits on the pool.
    // Unhandled, that is an uncaught exception that takes the process down —
    // exactly the crash-loop shape this codebase has already been burned by
    // once. The pool discards the bad client itself; this only stops the throw.
    this.pool.on('error', (err) => {
      console.error(`[db:${this.kind}] idle client error: ${err.message}`);
    });
  }

  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(sql, params);
  }

  /** Exactly one row, or undefined. */
  async one<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R | undefined> {
    const { rows } = await this.query<R>(sql, params);
    return rows[0];
  }

  async many<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]> {
    const { rows } = await this.query<R>(sql, params);
    return rows;
  }

  /**
   * Runs `fn` inside a transaction on one checked-out client.
   *
   * The client is passed in rather than the pool, and that is not a
   * convenience: `pool.query` may hand each call a *different* connection, so a
   * BEGIN issued through the pool can commit on one connection while the work
   * lands on another. Every statement in a transaction has to go through the
   * same client, which is why `Queryable` exists and why stores accept it.
   */
  async tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      // Rollback can itself fail if the connection died mid-transaction. The
      // original error is the useful one, so a failed rollback is swallowed
      // rather than allowed to mask it.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection is gone; releasing it below is all that is left to do */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Takes one client for a caller that needs statement-to-statement continuity
   * without a transaction — advisory locks, mainly, which are held by *session*
   * and would be released the moment a pooled connection went back.
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Applies the schema. Idempotent — every statement in `schema-pg.sql` is
 * `IF NOT EXISTS` — so this runs on every boot and is how a fresh database
 * becomes a usable one without a separate migration step.
 */
export async function applySchema(db: Queryable): Promise<void> {
  await db.query(readFileSync(join(here, 'schema-pg.sql'), 'utf8'));
}

/**
 * Applies the role grants. Separate from `applySchema` because it needs
 * privileges the application role does not have (CREATE ROLE), so a deployment
 * may run it once as an administrator and never again — while `applySchema`
 * runs on every boot.
 */
export async function applyRoles(db: Queryable): Promise<void> {
  await db.query(readFileSync(join(here, 'schema-pg-roles.sql'), 'utf8'));
}

/**
 * Checks the server has room for the pools this process intends to open.
 *
 * Exists because the failure it prevents is not graceful: a benchmark of 100
 * players plus one ingest against the default `max_connections = 100` did not
 * slow down, it aborted with `FATAL: sorry, too many clients already`. Under a
 * container restart policy that is a crash-loop, and the cause is invisible in
 * application logs unless something says it out loud.
 *
 * Returns a warning string rather than throwing: a too-small `max_connections`
 * is a real problem but not a reason to refuse to boot, and a server that comes
 * up complaining is more useful than one that does not come up.
 */
export async function checkCapacity(db: Queryable, needed: number): Promise<string | null> {
  const { rows } = await db.query<{ max_connections: string; reserved: string; in_use: string }>(
    `SELECT current_setting('max_connections') AS max_connections,
            current_setting('superuser_reserved_connections') AS reserved,
            (SELECT count(*)::text FROM pg_stat_activity) AS in_use`,
  );
  const r = rows[0];
  if (!r) return null;
  const usable = Number(r.max_connections) - Number(r.reserved);
  if (usable >= needed + 10) return null;
  return (
    `max_connections is ${r.max_connections} (${usable} usable after reserved), but this process wants up to ${needed} ` +
    `connections and ${r.in_use} are already in use. Raise max_connections to at least ${needed + 20}: at the default of 100, ` +
    `100 concurrent players plus one ingest fails outright with "sorry, too many clients already", not gradually.`
  );
}

/**
 * `jsonb` columns come back already parsed, so this is only for the columns
 * that are still TEXT and for tolerating a hand-edited row. Kept because the
 * SQLite version's callers expect a total function that never throws — a
 * malformed value falls back rather than failing the read.
 */
export function jsonGet<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * Postgres returns BIGINT as a string, because a 64-bit integer does not fit a
 * JS number safely. Every id in this schema is well within Number.MAX_SAFE_INTEGER,
 * so converting is correct here — but it has to be deliberate, since
 * `world_id === 1` silently fails against the string `'1'`.
 */
export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
