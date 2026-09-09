/**
 * Canon refresh: re-reading a world's source material in place, without
 * touching anybody's story.
 *
 * ## Why this could not exist before
 *
 * Under SQLite a world was one file holding both canon and every story played in
 * it, so the only whole-world rebuild available was `SetupService.reset()` — which
 * deleted 17 tables *including `stories`*. Refresh and destroy were the same
 * operation. Worse, nothing could answer "what changed upstream": `ingest_pages`
 * recorded a `revision` per page and no code ever read it back.
 *
 * Both halves are fixed structurally rather than by care. Canon lives in its own
 * tables that the play role cannot write, so a refresh physically cannot reach a
 * story; and `worlds.revision_watermark` plus per-page revisions make staleness a
 * question with an answer.
 *
 * ## The three rules
 *
 * 1. **Never delete a canon id.** An entity that disappears upstream is marked
 *    `retired_at_revision`, not removed. No foreign key can span the overlay (see
 *    `integrity-pg.ts`), so deleting a row a story still references would produce
 *    a dangling pointer nothing would catch until a turn failed. Retiring makes it
 *    invisible to new reads while leaving the row for the integrity check to
 *    report on.
 *
 * 2. **One transaction, gated on integrity.** The whole refresh commits or does
 *    not, and `checkIntegrity` runs *inside* it scoped to this world. A refresh
 *    that would dangle references rolls back with the old canon intact — the
 *    alternative being a half-refreshed world that reads fine until a player
 *    walks into the wrong room.
 *
 * 3. **Deterministic ids make it a diff.** `slugId` derives an id from (type,
 *    title), so re-reading the same page converges on the same row and the whole
 *    operation is an upsert rather than a rebuild. That property is what
 *    `ingest/passA.ts` was written for and is load-bearing here.
 */
import type { Db, Queryable } from '../db/pg.ts';
import { checkIntegrity, formatIntegrityReport } from '../store/integrity-pg.ts';

export interface RefreshPlan {
  worldId: number;
  slug: string;
  /** Pages whose upstream revision differs from what is stored. */
  changed: Array<{ wiki: string; pageId: string; title: string; storedRevision: string; upstreamRevision: string }>;
  /** Pages present upstream that this world has never read. */
  added: Array<{ wiki: string; pageId: string; title: string; upstreamRevision: string }>;
  /** Pages this world has read that are gone upstream — candidates for retirement. */
  removed: Array<{ wiki: string; pageId: string; title: string }>;
  unchanged: number;
}

/** What upstream currently says, per wiki. Supplied by the caller so this module does no I/O. */
export interface UpstreamPage {
  wiki: string;
  pageId: string;
  title: string;
  revision: string;
}

/**
 * Compares stored `ingest_pages` against what upstream reports.
 *
 * Takes the upstream listing rather than fetching it: the crawler already knows
 * how to talk to a wiki (and how to be rate-limited, resumed and budgeted), and a
 * planner that did its own I/O could not be tested without a network. This is the
 * first thing in the codebase to actually read `ingest_pages.revision`.
 */
export async function planRefresh(
  db: Queryable,
  worldId: number,
  upstream: UpstreamPage[],
): Promise<RefreshPlan> {
  const world = await db.query<{ slug: string }>(`SELECT slug FROM worlds WHERE id = $1`, [worldId]);
  if (!world.rows[0]) throw new Error(`no world ${worldId}`);

  const { rows: stored } = await db.query<{ wiki: string; page_id: string; title: string; revision: string }>(
    `SELECT wiki, page_id, title, revision FROM ingest_pages WHERE world_id = $1`,
    [worldId],
  );

  const key = (wiki: string, pageId: string) => `${wiki}\u0000${pageId}`;
  const storedByKey = new Map(stored.map((r) => [key(r.wiki, r.page_id), r]));
  const upstreamByKey = new Map(upstream.map((p) => [key(p.wiki, p.pageId), p]));

  const plan: RefreshPlan = { worldId, slug: world.rows[0].slug, changed: [], added: [], removed: [], unchanged: 0 };

  for (const p of upstream) {
    const s = storedByKey.get(key(p.wiki, p.pageId));
    if (!s) {
      plan.added.push({ wiki: p.wiki, pageId: p.pageId, title: p.title, upstreamRevision: p.revision });
    } else if (s.revision !== p.revision) {
      plan.changed.push({
        wiki: p.wiki,
        pageId: p.pageId,
        title: p.title,
        storedRevision: s.revision,
        upstreamRevision: p.revision,
      });
    } else {
      plan.unchanged += 1;
    }
  }

  for (const s of stored) {
    // Only counted as removed when this wiki was actually listed: a refresh of
    // one wiki in a two-wiki world must not retire the other wiki's pages just
    // because they were not in this listing.
    const wikiWasListed = upstream.some((p) => p.wiki === s.wiki);
    if (wikiWasListed && !upstreamByKey.has(key(s.wiki, s.page_id))) {
      plan.removed.push({ wiki: s.wiki, pageId: s.page_id, title: s.title });
    }
  }

  return plan;
}

export interface RefreshResult {
  worldId: number;
  slug: string;
  entitiesUpserted: number;
  entitiesRetired: number;
  entitiesRevived: number;
  pagesRecorded: number;
  watermark: string;
  /** Non-empty only when the refresh was rolled back. */
  integrityProblems: string[];
}

/** What the caller has re-extracted for the pages it decided to re-read. */
export interface RefreshBatch {
  entities: Array<{
    id: string;
    type: string;
    name: string;
    summary?: string;
    provenance?: string;
    confidence?: number;
    salience?: number;
    depthLevel?: number;
    props?: Record<string, unknown>;
  }>;
  /** Pages read in this batch, to advance the stored revisions. */
  pages: Array<{ wiki: string; pageId: string; title: string; revision: string; depth?: number; hops?: number; score?: number }>;
  /** Ids to retire — derived from `RefreshPlan.removed` by the caller, which knows the id scheme. */
  retire?: string[];
}

/**
 * Applies a refresh batch to one world, in a single transaction, gated on
 * integrity.
 *
 * Needs the ingest role: every write here is to a canon table the play role has
 * no grant on.
 *
 * `revision` is the new watermark — the highest revision this refresh observed —
 * recorded on the world so the next planner knows where it left off.
 */
export async function applyRefresh(
  db: Db,
  worldId: number,
  batch: RefreshBatch,
  opts: { watermark?: string } = {},
): Promise<RefreshResult> {
  const slugRow = await db.one<{ slug: string }>(`SELECT slug FROM worlds WHERE id = $1`, [worldId]);
  if (!slugRow) throw new Error(`no world ${worldId}`);

  const result: RefreshResult = {
    worldId,
    slug: slugRow.slug,
    entitiesUpserted: 0,
    entitiesRetired: 0,
    entitiesRevived: 0,
    pagesRecorded: 0,
    watermark: opts.watermark ?? '',
    integrityProblems: [],
  };

  try {
    await db.tx(async (tx) => {
      // Which of this batch's ids are currently retired, measured *before* the
      // upsert clears the flag. "12 entities came back" is materially different
      // information for an operator than "12 updated" — a page returning from the
      // dead usually means a rename or a reverted deletion upstream — and it
      // cannot be recovered afterwards.
      if (batch.entities.length) {
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*) n FROM canon_entities
            WHERE world_id = $1 AND id = ANY($2) AND retired_at_revision IS NOT NULL`,
          [worldId, batch.entities.map((e) => e.id)],
        );
        result.entitiesRevived = Number(rows[0]?.n ?? 0);
      }

      for (const e of batch.entities) {
        // `retired_at_revision = NULL` on conflict is the revive: a page that
        // vanished upstream and came back (a move, a rename reverted, a
        // vandalism revert) must become visible again rather than staying
        // invisible forever because one crawl missed it.
        const { rowCount } = await tx.query(
          `INSERT INTO canon_entities
             (world_id, id, type, name, summary, provenance, confidence, salience, depth_level, props, retired_at_revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NULL)
           ON CONFLICT (world_id, id) DO UPDATE SET
             type = EXCLUDED.type,
             name = EXCLUDED.name,
             summary = EXCLUDED.summary,
             provenance = EXCLUDED.provenance,
             confidence = EXCLUDED.confidence,
             -- Salience and depth are the *deepest* reading, never lowered by a
             -- shallower pass: a refresh that happened to skim a page must not
             -- undo what a deep read already established.
             salience = GREATEST(canon_entities.salience, EXCLUDED.salience),
             depth_level = GREATEST(canon_entities.depth_level, EXCLUDED.depth_level),
             props = EXCLUDED.props,
             retired_at_revision = NULL`,
          [
            worldId,
            e.id,
            e.type,
            e.name,
            e.summary ?? '',
            e.provenance ?? 'authored',
            e.confidence ?? 1,
            e.salience ?? 0.5,
            e.depthLevel ?? 0,
            JSON.stringify(e.props ?? {}),
          ],
        );
        result.entitiesUpserted += rowCount ?? 0;
      }

      for (const id of batch.retire ?? []) {
        // Retire, never delete — see this file's header. Only live rows are
        // touched, so re-running a refresh does not rewrite the revision that
        // originally retired something.
        const { rowCount } = await tx.query(
          `UPDATE canon_entities SET retired_at_revision = $1
             WHERE world_id = $2 AND id = $3 AND retired_at_revision IS NULL`,
          [opts.watermark || 'retired', worldId, id],
        );
        result.entitiesRetired += rowCount ?? 0;
      }

      for (const p of batch.pages) {
        const { rowCount } = await tx.query(
          `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision, depth, hops, score, fetched_at, passb_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'')
           ON CONFLICT (world_id, wiki, page_id) DO UPDATE SET
             title = EXCLUDED.title,
             revision = EXCLUDED.revision,
             depth = GREATEST(ingest_pages.depth, EXCLUDED.depth),
             hops = LEAST(ingest_pages.hops, EXCLUDED.hops),
             score = EXCLUDED.score,
             fetched_at = now(),
             -- Reset so the next Pass B re-reads a page whose text changed. A
             -- page still marked 'done' from the previous revision would be
             -- skipped by the resumable extractor, silently keeping stale
             -- relations for text that no longer says that.
             passb_status = CASE WHEN ingest_pages.revision <> EXCLUDED.revision THEN '' ELSE ingest_pages.passb_status END`,
          [worldId, p.wiki, p.pageId, p.title, p.revision, p.depth ?? 0, p.hops ?? 0, p.score ?? 0],
        );
        result.pagesRecorded += rowCount ?? 0;
      }

      // Advance the watermark per wiki as well as per world, so a two-wiki world
      // (star-trek-alpha-beta has enmemoryalpha + startrek) tracks each source
      // independently rather than letting one refresh imply the other happened.
      const wikis = [...new Set(batch.pages.map((p) => p.wiki))];
      for (const wiki of wikis) {
        const highest = batch.pages
          .filter((p) => p.wiki === wiki)
          .map((p) => p.revision)
          .sort()
          .at(-1);
        await tx.query(
          `INSERT INTO world_sources (world_id, wiki, revision_watermark, last_refreshed_at, page_count)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (world_id, wiki) DO UPDATE SET
             revision_watermark = EXCLUDED.revision_watermark,
             last_refreshed_at = now(),
             page_count = (SELECT count(*) FROM ingest_pages ip WHERE ip.world_id = $1 AND ip.wiki = $2)`,
          [worldId, wiki, highest ?? '', batch.pages.filter((p) => p.wiki === wiki).length],
        );
      }

      await tx.query(
        `UPDATE worlds SET revision_watermark = COALESCE(NULLIF($1,''), revision_watermark), last_refreshed_at = now()
           WHERE id = $2`,
        [opts.watermark ?? '', worldId],
      );

      // The gate. Scoped to this world so a pre-existing problem elsewhere in the
      // library does not block an unrelated refresh, and inside the transaction so
      // failing it can actually abort the commit.
      const report = await checkIntegrity(tx, { worldId, limit: 50 });
      if (!report.ok) {
        result.integrityProblems = report.orphans.map(
          (o) => `${o.table}.${o.column} row ${o.rowKey} -> missing ${o.missingId}`,
        );
        throw new RefreshAborted(formatIntegrityReport(report));
      }
    });
  } catch (err) {
    if (err instanceof RefreshAborted) return result;
    throw err;
  }

  return result;
}

/** Thrown to roll the refresh transaction back; converted into a report, not propagated. */
export class RefreshAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshAborted';
  }
}

/**
 * Whether a world looks stale enough to be worth refreshing, for a UI hint.
 *
 * Deliberately not a policy ("refresh weekly"): wikis move at wildly different
 * rates, and the honest signal is when this world was last read plus how many
 * pages it has, not a schedule invented here.
 */
export async function refreshStatus(
  db: Queryable,
  worldId: number,
): Promise<{
  lastRefreshedAt: string | null;
  sources: Array<{ wiki: string; lastRefreshedAt: string | null; watermark: string; pageCount: number; pagesNeedingPassB: number }>;
}> {
  const world = await db.query<{ last_refreshed_at: Date | null }>(
    `SELECT last_refreshed_at FROM worlds WHERE id = $1`,
    [worldId],
  );
  const { rows } = await db.query<{
    wiki: string;
    last_refreshed_at: Date | null;
    revision_watermark: string;
    page_count: number;
    pending: string;
  }>(
    `SELECT ws.wiki, ws.last_refreshed_at, ws.revision_watermark, ws.page_count,
            (SELECT count(*) FROM ingest_pages ip
              WHERE ip.world_id = ws.world_id AND ip.wiki = ws.wiki AND ip.passb_status <> 'done') pending
       FROM world_sources ws WHERE ws.world_id = $1 ORDER BY ws.wiki`,
    [worldId],
  );
  return {
    lastRefreshedAt: world.rows[0]?.last_refreshed_at?.toISOString() ?? null,
    sources: rows.map((r) => ({
      wiki: r.wiki,
      lastRefreshedAt: r.last_refreshed_at?.toISOString() ?? null,
      watermark: r.revision_watermark,
      pageCount: r.page_count,
      pagesNeedingPassB: Number(r.pending),
    })),
  };
}
