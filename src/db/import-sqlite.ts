/**
 * The automatic SQLite -> Postgres importer.
 *
 * Runs at boot, once, and moves every `data/worlds/<slug>/world.db` into
 * Postgres. It is automatic because the alternative is worse: the existing save
 * files are somebody's actual novel, and `serve.ts` already sets the precedent
 * (`migrateLegacySave` moves a pre-multi-world save into the new layout at boot
 * rather than leaving it at a path nothing reads). Requiring a manual step would
 * mean an operator who upgrades and restarts finds an empty library.
 *
 * Total measured cost for all three real worlds — 45,034 canon entities and
 * 226,347 canon edges across 148 MB of SQLite — is **9.5 s** on the reference
 * machine (0.0 s / 2.8 s / 6.6 s for the 0.3 MB, 29 MB and 61 MB worlds), and it
 * scales with row count rather than file size. That is longer than the 3 s an
 * earlier estimate assumed from raw `COPY` timings: this uses batched
 * multi-row INSERTs instead, which is slower but goes through the same
 * constraint and type checking as any other write, so a malformed legacy row is
 * rejected here rather than corrupting a table. The tradeoff is deliberate —
 * correctness on a one-time operation beats speed — but it is why
 * `docker-compose.yml` allows a 120 s `start_period` and why `pnpm import-pg`
 * exists as a pre-deploy step for anyone with many worlds.
 *
 * ## The failure mode this is built around
 *
 * This deployment has already crash-looped at boot. `resolveCurrentStory`'s
 * comment in `src/store/world.ts` records it: a world with two stories made
 * `CurrentWorld.open` throw during startup, the container restarted under
 * `restart: unless-stopped`, and nginx served 502s until someone intervened. A
 * data importer that runs at boot is exactly the shape that turns that incident
 * from downtime into corruption, so:
 *
 *   - **One transaction per world.** A 119 MB world failing does not roll back
 *     or re-run the two that already succeeded.
 *   - **Advisory lock.** Two processes booting together, or one restarting into
 *     itself, cannot both import.
 *   - **Never retry automatically.** A world marked `failed` stays failed until
 *     an operator clears it. Automatic retry under a restart policy is the
 *     escalation path.
 *   - **Verify before commit.** Row counts must match the source and the
 *     integrity check must pass, inside the transaction, or it rolls back.
 *   - **Read-only source, never deleted.** The SQLite file is opened read-only
 *     and renamed to `*.pre-pg` only after its world verifies clean, so
 *     rollback is renaming it back.
 *   - **Degraded boot, not a dead one.** A failed import logs loudly and lets
 *     the server come up serving whatever did import.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Queryable } from './pg.ts';

/** A lock key private to this operation; any constant works so long as it is stable. */
const IMPORT_LOCK_KEY = 0x7ab_1157;

export interface ImportedWorld {
  slug: string;
  worldId: number;
  entities: number;
  edges: number;
  sheets: number;
  stories: number;
  pages: number;
  ms: number;
}

export interface ImportFailure {
  slug: string;
  error: string;
}

export interface ImportReport {
  /** False when another process holds the lock, or there was nothing to do. */
  ran: boolean;
  imported: ImportedWorld[];
  failed: ImportFailure[];
  skipped: string[];
  ms: number;
}

/** Every `data/worlds/<slug>/` holding a `world.db`. */
export function findSqliteWorlds(dataRoot = 'data'): Array<{ slug: string; dbPath: string; imagesDir: string }> {
  const root = join(dataRoot, 'worlds');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((slug) => ({ slug, dir: join(root, slug) }))
    .filter(({ dir }) => {
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'world.db'));
      } catch {
        return false;
      }
    })
    .map(({ slug, dir }) => ({ slug, dbPath: join(dir, 'world.db'), imagesDir: join(dir, 'images') }));
}

/**
 * Imports every not-yet-imported SQLite world.
 *
 * `opts.only` restricts to one slug (for `--reimport=<slug>`); `opts.force`
 * re-imports a world already marked `done` or `failed`, which is destructive and
 * therefore never the default.
 */
export async function importSqliteWorlds(
  db: Db,
  opts: { dataRoot?: string; only?: string; force?: boolean; log?: (msg: string) => void } = {},
): Promise<ImportReport> {
  const dataRoot = opts.dataRoot ?? 'data';
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const report: ImportReport = { ran: false, imported: [], failed: [], skipped: [], ms: 0 };

  let candidates = findSqliteWorlds(dataRoot);
  if (opts.only) candidates = candidates.filter((c) => c.slug === opts.only);
  if (!candidates.length) {
    report.ms = Date.now() - started;
    return report;
  }

  // The lock is held on one session for the whole import, which is why this
  // takes a client rather than using the pool: an advisory lock belongs to a
  // session, and a pooled query would release it the moment the connection went
  // back to the pool.
  return db.withClient(async (client) => {
    const got = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [IMPORT_LOCK_KEY]);
    if (!got.rows[0]?.locked) {
      log('another process is importing SQLite worlds; skipping');
      report.ms = Date.now() - started;
      return report;
    }

    try {
      report.ran = true;
      // Smallest first: a fast success is better feedback than a slow one, and
      // if something is structurally wrong it fails in milliseconds rather than
      // after the 119 MB world.
      const ordered = candidates.sort((a, b) => statSync(a.dbPath).size - statSync(b.dbPath).size);

      for (const cand of ordered) {
        const prior = await client.query<{ state: string }>(`SELECT state FROM sqlite_import_log WHERE slug = $1`, [
          cand.slug,
        ]);
        const state = prior.rows[0]?.state;
        if (state && !opts.force) {
          // 'failed' blocks re-import deliberately — see this file's header.
          report.skipped.push(cand.slug);
          if (state === 'failed') {
            log(`${cand.slug}: previously failed to import; not retrying automatically (use --reimport=${cand.slug})`);
          }
          continue;
        }

        const t0 = Date.now();
        try {
          const imported = await importOneWorld(client, cand, { force: opts.force ?? false, log });
          imported.ms = Date.now() - t0;
          report.imported.push(imported);
          log(
            `${cand.slug}: ${imported.entities.toLocaleString()} canon entities, ${imported.edges.toLocaleString()} edges, ` +
              `${imported.stories} story/ies in ${(imported.ms / 1000).toFixed(1)}s`,
          );
          // Renamed only now, after the transaction committed and verified. The
          // file is never deleted: rollback is renaming it back.
          //
          // The `-wal`/`-shm` sidecars move with it. A WAL-mode database is
          // three files, and leaving the sidecars beside a renamed main file is
          // not cosmetic: `findSqliteWorlds` keys off `world.db`, so a stray
          // `world.db-wal` would sit next to a *future* `world.db` and SQLite
          // would open the new file against the old world's log. `store/backup.ts`
          // documents the same hazard from the other direction — a `cp` of the
          // main file alone once reported a save as clean while 4.1 MB of
          // committed rows sat in the sidecar it did not copy.
          try {
            renameSync(cand.dbPath, `${cand.dbPath}.pre-pg`);
            for (const suffix of ['-wal', '-shm']) {
              const side = `${cand.dbPath}${suffix}`;
              if (existsSync(side)) renameSync(side, `${cand.dbPath}.pre-pg${suffix}`);
            }
          } catch (err) {
            log(`${cand.slug}: imported, but could not rename the source file: ${msg(err)}`);
          }
        } catch (err) {
          report.failed.push({ slug: cand.slug, error: msg(err) });
          log(`${cand.slug}: IMPORT FAILED — ${msg(err)}`);
          // Recorded outside the rolled-back transaction, or the record would
          // roll back with it and the next boot would retry forever.
          await client.query(
            `INSERT INTO sqlite_import_log (slug, state, error, source_path)
             VALUES ($1,'failed',$2,$3)
             ON CONFLICT (slug) DO UPDATE SET state='failed', error=EXCLUDED.error, imported_at=now()`,
            [cand.slug, msg(err), cand.dbPath],
          );
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [IMPORT_LOCK_KEY]);
    }

    report.ms = Date.now() - started;
    return report;
  });
}

/**
 * One world, one transaction.
 *
 * Everything between BEGIN and COMMIT either lands or does not. The verification
 * at the end runs *inside* the transaction on purpose: a count mismatch or a
 * dangling reference has to be able to abort the commit, which it cannot do if
 * the check runs afterwards.
 */
async function importOneWorld(
  client: Queryable,
  cand: { slug: string; dbPath: string; imagesDir: string },
  opts: { force: boolean; log: (msg: string) => void },
): Promise<ImportedWorld> {
  const src = new DatabaseSync(cand.dbPath, { readOnly: true });
  try {
    const meta = readMeta(src);
    const counts = sourceCounts(src);

    await client.query('BEGIN');
    try {
      if (opts.force) {
        // Ordered so foreign keys never block: stories cascade to their own
        // rows, worlds cascade to canon. story_sources references both, so it
        // goes with the stories.
        await client.query(
          `DELETE FROM stories WHERE id IN (
             SELECT s.id FROM stories s JOIN story_sources ss ON ss.story_id = s.id
             JOIN worlds w ON w.id = ss.world_id WHERE w.slug = $1)`,
          [cand.slug],
        );
        await client.query(`DELETE FROM worlds WHERE slug = $1`, [cand.slug]);
      }

      // An *empty* world already holding this slug is adopted rather than collided
      // with.
      //
      // This is a real failure, not a hypothetical: a boot that finds no worlds
      // creates an empty one for the setup wizard, and `slugify('')` is `world`. On
      // this deployment an earlier boot had done exactly that while the import was
      // still failing for unrelated reasons, so a genuine `data/worlds/world/world.db`
      // then hit `duplicate key value violates unique constraint "worlds_slug_key"`
      // and was recorded as `failed` — which deliberately blocks automatic retry, so
      // it stayed broken.
      //
      // Adoption is strictly limited to a world with no canon of its own: it reuses
      // the row's id, so any story already pointing at it keeps working, and a world
      // with content still collides loudly rather than being silently overwritten.
      // `FOR UPDATE` because the boot path that creates placeholders can be running
      // concurrently in another process.
      const existing = await client.query<{ id: string; entities: string }>(
        `SELECT w.id, (SELECT count(*) FROM canon_entities ce WHERE ce.world_id = w.id) AS entities
           FROM worlds w WHERE w.slug = $1 FOR UPDATE`,
        [cand.slug],
      );
      let worldId: number;
      if (existing.rows[0] && existing.rows[0].entities === '0') {
        worldId = Number(existing.rows[0].id);
        await client.query(`UPDATE worlds SET title = $2, ingest_context = $3::jsonb WHERE id = $1`, [
          worldId,
          meta.worldTitle,
          meta.ingestContext,
        ]);
        opts.log(`${cand.slug}: adopting the empty world already using this slug`);
      } else {
        const worldRow = await client.query<{ id: string }>(
          `INSERT INTO worlds (slug, title, ingest_context) VALUES ($1,$2,$3::jsonb) RETURNING id`,
          [cand.slug, meta.worldTitle, meta.ingestContext],
        );
        worldId = Number(worldRow.rows[0]!.id);
      }

      await copyCanonEntities(client, src, worldId);
      await copyCanonEdges(client, src, worldId);
      await copyCanonSheets(client, src, worldId);
      await copyIngestPages(client, src, worldId);
      await copyWorldSources(client, src, worldId, meta.ingestContext);
      const stories = await copyStories(client, src, worldId);

      const verified = await verify(client, src, worldId, counts);
      if (verified.length) {
        throw new Error(`verification failed: ${verified.join('; ')}`);
      }

      await client.query(
        `INSERT INTO sqlite_import_log (slug, state, world_id, entities, edges, stories, source_path)
         VALUES ($1,'done',$2,$3,$4,$5,$6)
         ON CONFLICT (slug) DO UPDATE SET state='done', world_id=EXCLUDED.world_id,
           entities=EXCLUDED.entities, edges=EXCLUDED.edges, stories=EXCLUDED.stories,
           error=NULL, imported_at=now()`,
        [cand.slug, worldId, counts.canonEntities, counts.canonEdges, stories, cand.dbPath],
      );

      await client.query('COMMIT');
      return {
        slug: cand.slug,
        worldId,
        entities: counts.canonEntities,
        edges: counts.canonEdges,
        sheets: counts.canonSheets,
        stories,
        pages: counts.pages,
        ms: 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    src.close();
  }
}

// ------------------------------------------------------------------ reading

function readMeta(src: DatabaseSync): { worldTitle: string; ingestContext: string } {
  const get = (key: string): string => {
    const r = src.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
    return r?.value ?? '';
  };
  const raw = get('ingestContext');
  // Validated rather than trusted: this lands in a jsonb column, and a
  // hand-edited or truncated row would abort the whole world's transaction on a
  // parse error at COPY time — with a Postgres error, not a useful one.
  let ctx = '{}';
  if (raw) {
    try {
      JSON.parse(raw);
      ctx = raw;
    } catch {
      ctx = '{}';
    }
  }
  return { worldTitle: get('worldTitle'), ingestContext: ctx };
}

interface SourceCounts {
  canonEntities: number;
  canonEdges: number;
  canonSheets: number;
  chronEntities: number;
  chronEdges: number;
  chronSheets: number;
  stories: number;
  turns: number;
  events: number;
  pages: number;
}

function sourceCounts(src: DatabaseSync): SourceCounts {
  const n = (sql: string): number => Number((src.prepare(sql).get() as { n: number }).n);
  return {
    canonEntities: n(`SELECT COUNT(*) n FROM entities WHERE layer='canon'`),
    canonEdges: n(`SELECT COUNT(*) n FROM edges WHERE layer='canon'`),
    canonSheets: n(`SELECT COUNT(*) n FROM sheets WHERE layer='canon'`),
    chronEntities: n(`SELECT COUNT(*) n FROM entities WHERE layer='chronicle'`),
    chronEdges: n(`SELECT COUNT(*) n FROM edges WHERE layer='chronicle'`),
    chronSheets: n(`SELECT COUNT(*) n FROM sheets WHERE layer='chronicle'`),
    stories: n(`SELECT COUNT(*) n FROM stories`),
    turns: n(`SELECT COUNT(*) n FROM turns`),
    events: n(`SELECT COUNT(*) n FROM events`),
    pages: n(`SELECT COUNT(*) n FROM ingest_pages`),
  };
}

/**
 * Rows are pushed in batches of multi-row INSERTs rather than one statement per
 * row: the 119 MB world holds 152,456 canon edges, and a round trip each would
 * dominate the import. 500 is comfortably under Postgres' 65,535-parameter
 * ceiling for the widest table here (11 columns x 500 = 5,500 parameters).
 */
const BATCH = 500;

async function insertBatched(
  client: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  extra = '',
): Promise<void> {
  if (!rows.length) return;
  const width = columns.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk
      .map((_, r) => `(${columns.map((__, c) => `$${r * width + c + 1}`).join(',')})`)
      .join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ${extra}`, chunk.flat());
  }
}

/** SQLite stores JSON as TEXT; a blank or malformed value must not abort a jsonb insert. */
function json(raw: unknown, fallback = '{}'): string {
  if (typeof raw !== 'string' || !raw.length) return fallback;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return fallback;
  }
}

/** SQLite has no boolean; it stores 0/1. */
function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

/** An empty timestamp string is NULL, not the epoch. */
function ts(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

async function copyCanonEntities(client: Queryable, src: DatabaseSync, worldId: number): Promise<void> {
  const rows = src
    .prepare(
      `SELECT id,type,name,summary,provenance,confidence,salience,depth_level,props,created_scene
         FROM entities WHERE layer='canon'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'canon_entities',
    ['world_id', 'id', 'type', 'name', 'summary', 'provenance', 'confidence', 'salience', 'depth_level', 'props', 'created_scene'],
    rows.map((r) => [
      worldId, r.id, r.type, r.name, r.summary ?? '', r.provenance ?? 'authored',
      r.confidence ?? 1, r.salience ?? 0.5, r.depth_level ?? 0, json(r.props), r.created_scene ?? 0,
    ]),
    // A pre-split file could not hold two canon rows for one id (its own unique
    // index forbade it), so a conflict here means the source is corrupt —
    // better to know than to silently drop rows.
    '',
  );
}

async function copyCanonEdges(client: Queryable, src: DatabaseSync, worldId: number): Promise<void> {
  const rows = src
    .prepare(
      `SELECT subject,predicate,object,valid_from,valid_to,weight,provenance,confidence,evidence
         FROM edges WHERE layer='canon'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'canon_edges',
    ['world_id', 'subject', 'predicate', 'object', 'valid_from', 'valid_to', 'weight', 'provenance', 'confidence', 'evidence'],
    rows.map((r) => [
      worldId, r.subject, r.predicate, r.object, r.valid_from ?? 0, r.valid_to ?? null,
      r.weight ?? 0.5, r.provenance ?? 'authored', r.confidence ?? 1, r.evidence ?? null,
    ]),
    // The partial unique index only covers live edges, and a legacy file may
    // hold a canon edge whose identity repeats with different validity windows.
    'ON CONFLICT DO NOTHING',
  );
}

async function copyCanonSheets(client: Queryable, src: DatabaseSync, worldId: number): Promise<void> {
  const rows = src
    .prepare(
      `SELECT entity_id,identity,contract,voice,condition,appearance,locks FROM sheets WHERE layer='canon'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'canon_sheets',
    ['world_id', 'entity_id', 'identity', 'contract', 'voice', 'condition', 'appearance', 'locks'],
    rows.map((r) => [
      worldId, r.entity_id, json(r.identity), json(r.contract), json(r.voice),
      json(r.condition), json(r.appearance), json(r.locks, '[]'),
    ]),
  );
}

async function copyIngestPages(client: Queryable, src: DatabaseSync, worldId: number): Promise<void> {
  const rows = src
    .prepare(`SELECT page_id,wiki,title,revision,depth,hops,score,fetched_at,passb_status FROM ingest_pages`)
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'ingest_pages',
    ['world_id', 'wiki', 'page_id', 'title', 'revision', 'depth', 'hops', 'score', 'fetched_at', 'passb_status'],
    rows.map((r) => [
      worldId, r.wiki ?? 'wiki', String(r.page_id), r.title ?? '', r.revision ?? '',
      r.depth ?? 0, r.hops ?? 0, r.score ?? 0, ts(r.fetched_at), r.passb_status ?? '',
    ]),
    'ON CONFLICT DO NOTHING',
  );
}

/**
 * Derives `world_sources` from what the file actually recorded.
 *
 * `ingest_pages` knows which wikis were read and at which revisions; the
 * `ingestContext` blob knows the base URL. Neither alone is enough, and the
 * SQLite schema summarised this nowhere — `.design/DBFIXES.md` asked for
 * exactly this manifest, and refresh needs it.
 */
async function copyWorldSources(
  client: Queryable,
  src: DatabaseSync,
  worldId: number,
  ingestContext: string,
): Promise<void> {
  const ctx = JSON.parse(ingestContext) as { baseUrl?: string; wikiName?: string };
  const wikis = src
    .prepare(
      `SELECT wiki, COUNT(*) n, MAX(revision) rev, MAX(fetched_at) fetched FROM ingest_pages GROUP BY wiki`,
    )
    .all() as Array<{ wiki: string; n: number; rev: string; fetched: string }>;
  if (!wikis.length) return;
  await insertBatched(
    client,
    'world_sources',
    ['world_id', 'wiki', 'base_url', 'revision_watermark', 'last_refreshed_at', 'page_count'],
    wikis.map((w) => [
      worldId,
      w.wiki,
      // The context records one base URL; it belongs to the wiki it names. A
      // second wiki in the same world has no recorded URL, and inventing one
      // would make a later refresh fetch from the wrong place.
      ctx.wikiName === w.wiki ? (ctx.baseUrl ?? '') : '',
      w.rev ?? '',
      ts(w.fetched),
      w.n,
    ]),
    'ON CONFLICT DO NOTHING',
  );
}

/**
 * Stories and every table scoped to one, plus the `story_sources` row that
 * points each story at this world — which is what turns a per-file world into a
 * composable source.
 */
async function copyStories(client: Queryable, src: DatabaseSync, worldId: number): Promise<number> {
  const stories = src.prepare(`SELECT * FROM stories`).all() as Array<Record<string, unknown>>;
  if (!stories.length) return 0;

  // Inserted with forked_from NULL first, then patched: a fork's parent may
  // appear later in the list, and the self-referencing foreign key would reject
  // the row. Two passes is simpler than topologically sorting them.
  await insertBatched(
    client,
    'stories',
    ['id', 'owner_user_id', 'title', 'scene', 'turn', 'player_character_id', 'current_location_id', 'style', 'knobs', 'forked_at_scene', 'created_at', 'last_played_at'],
    stories.map((s) => [
      s.id, s.owner_user_id ?? null, s.title ?? '', s.scene ?? 1, s.turn ?? 0,
      s.player_character_id ?? '', s.current_location_id ?? null, json(s.style), json(s.knobs),
      s.forked_at_scene ?? null, ts(s.created_at), ts(s.last_played_at),
    ]),
  );
  for (const s of stories) {
    if (s.forked_from) {
      await client.query(`UPDATE stories SET forked_from = $1 WHERE id = $2`, [s.forked_from, s.id]);
    }
  }

  await insertBatched(
    client,
    'story_sources',
    ['story_id', 'world_id', 'ordinal'],
    stories.map((s) => [s.id, worldId, 1]),
  );

  // Chronicle rows: what used to be `layer='chronicle'`.
  const chronEntities = src
    .prepare(
      `SELECT story_id,id,type,name,summary,provenance,confidence,salience,depth_level,props,created_scene
         FROM entities WHERE layer='chronicle'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'chron_entities',
    ['story_id', 'id', 'type', 'name', 'summary', 'provenance', 'confidence', 'salience', 'depth_level', 'props', 'created_scene'],
    chronEntities.map((r) => [
      r.story_id, r.id, r.type, r.name, r.summary ?? '', r.provenance ?? 'authored',
      r.confidence ?? 1, r.salience ?? 0.5, r.depth_level ?? 0, json(r.props), r.created_scene ?? 0,
    ]),
  );

  const chronEdges = src
    .prepare(
      `SELECT story_id,subject,predicate,object,valid_from,valid_to,weight,provenance,confidence,evidence
         FROM edges WHERE layer='chronicle'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'chron_edges',
    ['story_id', 'subject', 'predicate', 'object', 'valid_from', 'valid_to', 'weight', 'provenance', 'confidence', 'evidence'],
    chronEdges.map((r) => [
      r.story_id, r.subject, r.predicate, r.object, r.valid_from ?? 0, r.valid_to ?? null,
      r.weight ?? 0.5, r.provenance ?? 'authored', r.confidence ?? 1, r.evidence ?? null,
    ]),
    'ON CONFLICT DO NOTHING',
  );

  const chronSheets = src
    .prepare(
      `SELECT story_id,entity_id,identity,contract,voice,condition,appearance,locks,is_player
         FROM sheets WHERE layer='chronicle'`,
    )
    .all() as Array<Record<string, unknown>>;
  await insertBatched(
    client,
    'chron_sheets',
    ['story_id', 'entity_id', 'identity', 'contract', 'voice', 'condition', 'appearance', 'locks', 'is_player'],
    chronSheets.map((r) => [
      r.story_id, r.entity_id, json(r.identity), json(r.contract), json(r.voice),
      json(r.condition), json(r.appearance), json(r.locks, '[]'), bool(r.is_player),
    ]),
  );

  // Carry the player flag across the layer boundary.
  //
  // The SQLite schema allowed `is_player` on a *canon* sheet, and real saves use
  // it: `saint-verrow` marks `char:brother-anselm` as the player on its canon
  // row. The Postgres schema deliberately keeps `is_player` on chronicle only —
  // who the protagonist is, is a property of a playthrough, not of the source
  // material, and two stories in one world have different players — so a
  // straight table-for-table copy silently dropped it and `cast.player()`
  // returned undefined for an imported save. Caught by reading the imported data
  // back through the stores, not by a unit test.
  //
  // `stories.player_character_id` is the authoritative answer (it is what every
  // frame builder actually reads), so it seeds the chronicle sheet here. Written
  // with ON CONFLICT so a story that already had a chronicle sheet for its player
  // keeps the rest of that sheet and only gains the flag.
  for (const s of stories) {
    const pc = s.player_character_id;
    if (typeof pc !== 'string' || !pc) continue;
    await client.query(
      `INSERT INTO chron_sheets (story_id, entity_id, is_player) VALUES ($1,$2,true)
       ON CONFLICT (story_id, entity_id) DO UPDATE SET is_player = true`,
      [s.id, pc],
    );
  }

  // The remaining story-scoped tables. Declared as data rather than as 13
  // near-identical functions: the column lists differ only in names, and a
  // table added later is one row here instead of a new function somebody
  // forgets to call — the exact failure mode that made SetupService.reset()
  // silently omit `illustrations` and then `stories`.
  const plain: Array<{
    table: string;
    from: string;
    columns: string[];
    jsonCols?: string[];
    boolCols?: string[];
    tsCols?: string[];
  }> = [
    { table: 'facts', from: 'facts', columns: ['id', 'story_id', 'text', 'scene'] },
    { table: 'fact_knowledge', from: 'fact_knowledge', columns: ['fact_id', 'entity_id', 'level', 'since_scene', 'distortion'] },
    { table: 'threads', from: 'threads', columns: ['id', 'story_id', 'title', 'stakes', 'tension', 'parties', 'resolutions', 'status', 'created_scene'], jsonCols: ['parties', 'resolutions'] },
    { table: 'events', from: 'events', columns: ['id', 'story_id', 'scene', 'turn', 'text', 'participants', 'location_id', 'significance', 'visibility', 'from_consequence_id'], jsonCols: ['participants'] },
    { table: 'consequences', from: 'consequences', columns: ['id', 'story_id', 'cause_event_id', 'trigger', 'actor_id', 'action', 'visibility', 'maturity', 'depth', 'significance', 'created_scene', 'fired_scene', 'superseded_by'], jsonCols: ['trigger'] },
    { table: 'turns', from: 'turns', columns: ['id', 'story_id', 'scene', 'turn', 'raw_input', 'intent', 'delta', 'book_prose', 'pinned', 'meta', 'created_at'], jsonCols: ['delta', 'meta'], boolCols: ['pinned'], tsCols: ['created_at'] },
    { table: 'scenes', from: 'scenes', columns: ['story_id', 'scene', 'title', 'summary', 'location_id', 'chapter'] },
    { table: 'chapters', from: 'chapters', columns: ['story_id', 'chapter', 'title', 'summary'] },
    { table: 'directives', from: 'directives', columns: ['id', 'story_id', 'text', 'scope', 'strength', 'lifetime_scenes', 'status', 'created_scene'] },
    { table: 'divergences', from: 'divergences', columns: ['story_id', 'scene', 'kind', 'detail', 'canon'] },
    { table: 'relationships', from: 'relationships', columns: ['story_id', 'from_id', 'to_id', 'trust', 'affection', 'respect', 'note'] },
    { table: 'style_anchors', from: 'style_anchors', columns: ['story_id', 'text', 'note', 'scene'] },
    { table: 'illustrations', from: 'illustrations', columns: ['id', 'story_id', 'kind', 'turn_id', 'entity_id', 'location_id', 'visual_style', 'prompt', 'negative_prompt', 'seed', 'provider', 'status', 'path', 'error', 'created_scene', 'created_at'], tsCols: ['created_at'] },
  ];

  for (const spec of plain) {
    const rows = src.prepare(`SELECT ${spec.columns.join(',')} FROM ${spec.from}`).all() as Array<Record<string, unknown>>;
    await insertBatched(
      client,
      spec.table,
      spec.columns,
      rows.map((r) =>
        spec.columns.map((c) => {
          const v = r[c];
          if (spec.jsonCols?.includes(c)) return v == null ? null : json(v, c === 'participants' || c === 'parties' || c === 'resolutions' ? '[]' : '{}');
          if (spec.boolCols?.includes(c)) return bool(v);
          if (spec.tsCols?.includes(c)) return ts(v);
          return v ?? null;
        }),
      ),
      'ON CONFLICT DO NOTHING',
    );
  }

  return stories.length;
}

// ------------------------------------------------------------- verification

/**
 * Compares what landed against what the source held, and checks the overlay for
 * dangling references. Runs inside the transaction so a mismatch can abort the
 * commit.
 *
 * Counting rather than checksumming: a count catches the failure that actually
 * happens (a batch silently dropped by an ON CONFLICT, a table missed
 * entirely), and a checksum over JSON text would false-positive on legitimate
 * normalisation — Postgres reserialises jsonb, so the bytes are not expected to
 * match.
 */
async function verify(
  client: Queryable,
  src: DatabaseSync,
  worldId: number,
  counts: SourceCounts,
): Promise<string[]> {
  const problems: string[] = [];
  const storyIds = (src.prepare(`SELECT id FROM stories`).all() as Array<{ id: string }>).map((r) => r.id);

  const got = async (sql: string, params: unknown[]): Promise<number> => {
    const { rows } = await client.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };

  const canonEnt = await got(`SELECT COUNT(*) n FROM canon_entities WHERE world_id = $1`, [worldId]);
  if (canonEnt !== counts.canonEntities) problems.push(`canon entities ${canonEnt} != ${counts.canonEntities}`);

  const canonSheets = await got(`SELECT COUNT(*) n FROM canon_sheets WHERE world_id = $1`, [worldId]);
  if (canonSheets !== counts.canonSheets) problems.push(`canon sheets ${canonSheets} != ${counts.canonSheets}`);

  if (storyIds.length) {
    const turns = await got(`SELECT COUNT(*) n FROM turns WHERE story_id = ANY($1)`, [storyIds]);
    if (turns !== counts.turns) problems.push(`turns ${turns} != ${counts.turns}`);
    const events = await got(`SELECT COUNT(*) n FROM events WHERE story_id = ANY($1)`, [storyIds]);
    if (events !== counts.events) problems.push(`events ${events} != ${counts.events}`);
    const chronEnt = await got(`SELECT COUNT(*) n FROM chron_entities WHERE story_id = ANY($1)`, [storyIds]);
    if (chronEnt !== counts.chronEntities) problems.push(`chronicle entities ${chronEnt} != ${counts.chronEntities}`);
  }

  // Canon edges are the one count allowed to shrink: the live-uniqueness index
  // legitimately collapses duplicates a legacy file could hold. A *rise* would
  // mean duplication, which is a real failure.
  const canonEdg = await got(`SELECT COUNT(*) n FROM canon_edges WHERE world_id = $1`, [worldId]);
  if (canonEdg > counts.canonEdges) problems.push(`canon edges ${canonEdg} > ${counts.canonEdges} (duplicated)`);

  // The referential check `store/integrity.ts` performs, expressed against the
  // overlay: an edge endpoint must resolve to either canon in this world or
  // this story's own chronicle.
  const dangling = await got(
    `SELECT COUNT(*) n FROM canon_edges e
      WHERE e.world_id = $1
        AND NOT EXISTS (SELECT 1 FROM canon_entities c WHERE c.world_id = e.world_id AND c.id = e.subject)`,
    [worldId],
  );
  if (dangling) problems.push(`${dangling} canon edge(s) whose subject resolves to no canon entity`);

  return problems;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
