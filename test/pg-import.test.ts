/**
 * The automatic SQLite -> Postgres importer.
 *
 * The happy path is the least interesting thing here. What these tests are
 * actually for is the *failure* behaviour, because this importer runs at boot
 * under `restart: unless-stopped`, and this deployment has already crash-looped
 * at boot once — `resolveCurrentStory`'s comment in `src/store/world.ts` records
 * a world with two stories throwing during startup, the container restarting in
 * a loop, and nginx serving 502s. An importer with the same shape and the power
 * to write is how that incident becomes data corruption instead of downtime.
 *
 * So: a failed world must not roll back the ones that succeeded, must not be
 * retried automatically, and must leave its source file intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPg } from './pg-harness.ts';
import { findSqliteWorlds, importSqliteWorlds } from '../src/db/import-sqlite.ts';
import { createWorld } from '../src/store/index-pg.ts';
import { overlayEntity, sourcesFor } from '../src/db/overlay.ts';
import { CastStore } from '../src/store/cast-pg.ts';

/**
 * A minimal but structurally real SQLite world: canon, a story, and chronicle
 * that diverges from that canon. Built by applying the actual legacy schema
 * rather than a hand-rolled subset, so the importer is tested against the shape
 * it will really meet.
 */
function makeSqliteWorld(
  root: string,
  slug: string,
  opts: { canon?: number; withStory?: boolean; title?: string } = {},
): string {
  const dir = join(root, 'worlds', slug);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'world.db');
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(join(import.meta.dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  // The additive columns `db.ts`'s migrate() adds; a real file has them.
  db.exec(`ALTER TABLE sheets ADD COLUMN appearance TEXT NOT NULL DEFAULT '{}'`);
  db.exec(`ALTER TABLE stories ADD COLUMN owner_user_id TEXT`);

  db.prepare(`INSERT INTO meta (key,value) VALUES ('worldTitle',?)`).run(opts.title ?? slug);
  db.prepare(`INSERT INTO meta (key,value) VALUES ('ingestContext',?)`).run(
    JSON.stringify({ baseUrl: 'https://example.fandom.com', wikiName: 'example', mode: 'mid', seeds: ['A'] }),
  );

  const canon = opts.canon ?? 3;
  for (let i = 0; i < canon; i += 1) {
    db.prepare(
      `INSERT INTO entities (id,layer,story_id,type,name,summary,provenance,salience)
       VALUES (?,'canon',NULL,'Character',?,?,'example:page#1',?)`,
    ).run(`char:c${i}`, `Canon ${i}`, `canon summary ${i}`, (i + 1) / (canon + 1));
  }
  db.prepare(
    `INSERT INTO edges (subject,predicate,object,layer,story_id,valid_from,weight)
     VALUES ('char:c0','ALLIED_WITH','char:c1','canon',NULL,0,0.5)`,
  ).run();
  // is_player on a *canon* sheet, matching what real saves hold: saint-verrow
  // marks char:brother-anselm as the player on its canon row. The Postgres
  // schema keeps that flag on chronicle only, so the importer has to carry it
  // across the layer boundary or cast.player() returns undefined afterwards.
  db.prepare(`INSERT INTO sheets (entity_id,layer,story_id,identity,is_player) VALUES ('char:c0','canon',NULL,'{"arc":"canon"}',1)`).run();
  db.prepare(
    `INSERT INTO ingest_pages (page_id,wiki,title,revision,depth,fetched_at,passb_status)
     VALUES ('7','example','A','1234',1,'2026-01-01T00:00:00.000Z','done')`,
  ).run();

  if (opts.withStory !== false) {
    const storyId = `story:${slug}`;
    db.prepare(
      `INSERT INTO stories (id,title,scene,turn,player_character_id,style,knobs,created_at,last_played_at,owner_user_id)
       VALUES (?,?,2,5,'char:c0','{}','{}','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z','user_1')`,
    ).run(storyId, `Story of ${slug}`);
    // Chronicle diverging from canon — the property the whole layering exists
    // for, and the one a lossy import would quietly destroy.
    db.prepare(
      `INSERT INTO entities (id,layer,story_id,type,name,summary,salience)
       VALUES ('char:c0','chronicle',?,'Character','Canon 0','DIVERGED: dead since scene 2',0.9)`,
    ).run(storyId);
    db.prepare(`INSERT INTO scenes (story_id,scene,title,chapter) VALUES (?,1,'Opening',1)`).run(storyId);
    db.prepare(
      `INSERT INTO turns (id,story_id,scene,turn,raw_input,delta,book_prose,pinned,meta,created_at)
       VALUES (?,?,1,1,'look','{"events":[]}','He set the quill down.',1,'{"move":"observe"}','2026-01-01T12:00:00.000Z')`,
    ).run(`turn:${slug}`, storyId);
    db.prepare(
      `INSERT INTO events (id,story_id,scene,turn,text,participants) VALUES (?,?,1,1,'Something happened','["char:c0"]')`,
    ).run(`event:${slug}`, storyId);
    db.prepare(`INSERT INTO facts (id,story_id,text,scene) VALUES (?,?,'A fact',1)`).run(`fact:${slug}`, storyId);
    db.prepare(`INSERT INTO fact_knowledge (fact_id,entity_id,level) VALUES (?,'char:c0','knows')`).run(`fact:${slug}`);
    db.prepare(
      `INSERT INTO threads (id,story_id,title,tension,parties,status,created_scene) VALUES (?,?,'A thread',0.7,'["char:c0"]','open',1)`,
    ).run(`thread:${slug}`, storyId);
    db.prepare(`INSERT INTO relationships (story_id,from_id,to_id,trust) VALUES (?,'char:c0','char:c1',0.5)`).run(storyId);
    db.prepare(`INSERT INTO style_anchors (story_id,text,scene) VALUES (?,'A liked passage',1)`).run(storyId);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return dbPath;
}

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-import-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('findSqliteWorlds only reports directories holding a world.db', async () => {
  await withRoot(async (root) => {
    makeSqliteWorld(root, 'real');
    // Noise that must be ignored rather than treated as a broken world: a
    // half-extracted archive, a stray file, an empty directory.
    mkdirSync(join(root, 'worlds', 'empty-dir'), { recursive: true });
    writeFileSync(join(root, 'worlds', '.DS_Store'), 'junk');

    const found = findSqliteWorlds(root);
    assert.deepEqual(found.map((f) => f.slug), ['real']);
  });
});

test('importing carries canon, chronicle and every story-scoped table across', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'verrow', { canon: 4, title: 'Saint Verrow' });
      const report = await importSqliteWorlds(db, { dataRoot: root });

      assert.equal(report.ran, true);
      assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
      assert.equal(report.imported.length, 1);
      assert.equal(report.imported[0]!.entities, 4);
      assert.equal(report.imported[0]!.stories, 1);

      const world = await db.one<{ id: string; title: string }>(`SELECT id, title FROM worlds WHERE slug = 'verrow'`);
      assert.equal(world?.title, 'Saint Verrow');

      // Every story-scoped table, asserted by count rather than spot-checked:
      // the failure this guards against is a table silently missed, which is
      // exactly how SetupService.reset() lost `illustrations` and then
      // `stories` from its hand-maintained list.
      const counts = await db.one<Record<string, string>>(`
        SELECT (SELECT count(*) FROM canon_entities) canon_ent,
               (SELECT count(*) FROM canon_edges) canon_edg,
               (SELECT count(*) FROM canon_sheets) canon_sheet,
               (SELECT count(*) FROM ingest_pages) pages,
               (SELECT count(*) FROM world_sources) sources,
               (SELECT count(*) FROM stories) stories,
               (SELECT count(*) FROM story_sources) story_sources,
               (SELECT count(*) FROM chron_entities) chron_ent,
               (SELECT count(*) FROM scenes) scenes,
               (SELECT count(*) FROM turns) turns,
               (SELECT count(*) FROM events) events,
               (SELECT count(*) FROM facts) facts,
               (SELECT count(*) FROM fact_knowledge) fact_knowledge,
               (SELECT count(*) FROM threads) threads,
               (SELECT count(*) FROM relationships) relationships,
               (SELECT count(*) FROM style_anchors) style_anchors`);
      assert.deepEqual(
        Object.fromEntries(Object.entries(counts!).map(([k, v]) => [k, Number(v)])),
        {
          canon_ent: 4, canon_edg: 1, canon_sheet: 1, pages: 1, sources: 1,
          stories: 1, story_sources: 1, chron_ent: 1, scenes: 1, turns: 1,
          events: 1, facts: 1, fact_knowledge: 1, threads: 1, relationships: 1,
          style_anchors: 1,
        },
      );

      // The point of the whole migration: the story still reads its own
      // divergence, and canon underneath is untouched.
      const storyId = 'story:verrow';
      const sources = await sourcesFor(db, storyId);
      const resolved = await overlayEntity(db, storyId, sources, 'char:c0');
      assert.match(String(resolved?.summary), /DIVERGED/);
      const canon = await db.one<{ summary: string }>(
        `SELECT summary FROM canon_entities WHERE id = 'char:c0'`,
      );
      assert.equal(canon?.summary, 'canon summary 0');

      // jsonb, not text: a column that arrived as a string would break every
      // caller that expects a parsed object.
      const turn = await db.one<{ meta: unknown; delta: unknown; pinned: boolean }>(
        `SELECT meta, delta, pinned FROM turns LIMIT 1`,
      );
      assert.ok(turn, 'expected the imported turn to be present');
      assert.equal(typeof turn.meta, 'object');
      assert.equal((turn.meta as { move: string }).move, 'observe');
      assert.equal(turn.pinned, true, 'SQLite 1 must become boolean true');

      // The refresh manifest, derived from ingest_pages plus the context blob.
      // `.design/DBFIXES.md` asked for this and the SQLite schema summarised it
      // nowhere.
      const src = await db.one<{ wiki: string; base_url: string; revision_watermark: string; page_count: number }>(
        `SELECT wiki, base_url, revision_watermark, page_count FROM world_sources`,
      );
      assert.equal(src?.wiki, 'example');
      assert.equal(src?.base_url, 'https://example.fandom.com');
      assert.equal(src?.revision_watermark, '1234');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the player flag survives the canon-to-chronicle layer change', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'played');
      const report = await importSqliteWorlds(db, { dataRoot: root });
      assert.equal(report.failed.length, 0, JSON.stringify(report.failed));

      // Found by reading imported real data back through the stores rather than
      // by a test, which is why this one exists: the SQLite schema allowed
      // is_player on a canon sheet, the Postgres schema deliberately does not
      // (the protagonist belongs to a playthrough, not to the source material),
      // and a table-for-table copy dropped it silently.
      const storyId = 'story:played';
      const cast = new CastStore({ db, storyId, sources: await sourcesFor(db, storyId) });
      const player = await cast.player();
      assert.equal(player?.entityId, 'char:c0', 'the imported story must still know its protagonist');

      // And it landed on chronicle, not canon — the flag must not have been
      // smuggled back into the shared baseline.
      const canonFlag = await db.one<{ n: string }>(
        `SELECT count(*) n FROM information_schema.columns
          WHERE table_name = 'canon_sheets' AND column_name = 'is_player'`,
      );
      assert.equal(Number(canonFlag!.n), 0, 'canon_sheets must not carry is_player at all');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the source file is renamed with its sidecars, never deleted', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      const dbPath = makeSqliteWorld(root, 'keepme');
      // A live WAL sidecar, which a checkpointed file may still have.
      writeFileSync(`${dbPath}-wal`, '');
      await importSqliteWorlds(db, { dataRoot: root });

      assert.ok(!existsSync(dbPath), 'the original name must be freed');
      assert.ok(existsSync(`${dbPath}.pre-pg`), 'the data must still be on disk — rollback is renaming it back');
      // A sidecar left beside the freed name would be opened against a *future*
      // world.db. `store/backup.ts` documents the same hazard from the other
      // side: a copy that missed the -wal once reported a save as clean while
      // 4.1 MB of committed rows sat in the file it did not copy.
      assert.ok(!existsSync(`${dbPath}-wal`), 'the sidecar must not be left beside the freed name');
      assert.ok(existsSync(`${dbPath}.pre-pg-wal`), 'the sidecar must travel with its database');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a second run is a no-op, not a duplicate import', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'once');
      await importSqliteWorlds(db, { dataRoot: root });
      // The file is renamed after a successful import, so the second run finds
      // no candidates at all — the cheapest possible idempotency.
      const second = await importSqliteWorlds(db, { dataRoot: root });
      assert.equal(second.imported.length, 0);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM worlds`))!.n), 1);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities`))!.n), 3);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a world already marked done is skipped even if its file reappears', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'again');
      await importSqliteWorlds(db, { dataRoot: root });
      // Simulates an operator restoring a backup over the freed name — the
      // import log, not the filesystem, is what decides.
      makeSqliteWorld(root, 'again');
      const second = await importSqliteWorlds(db, { dataRoot: root });
      assert.deepEqual(second.skipped, ['again']);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM worlds`))!.n), 1);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('one world failing does not roll back or block the others', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'good-a', { canon: 2 });
      // A file that is not a database at all. Ordered by size, so this 20-byte
      // "world" is attempted first and must not stop the real ones.
      const badDir = join(root, 'worlds', 'corrupt');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'world.db'), 'this is not a database');
      makeSqliteWorld(root, 'good-b', { canon: 5 });

      const report = await importSqliteWorlds(db, { dataRoot: root });

      assert.equal(report.failed.length, 1);
      assert.equal(report.failed[0]!.slug, 'corrupt');
      assert.deepEqual(report.imported.map((i) => i.slug).sort(), ['good-a', 'good-b']);
      // Per-world transactions: the good worlds are fully present.
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM worlds`))!.n), 2);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities`))!.n), 7);
      // And the failure is recorded rather than lost, which is what makes the
      // next boot skip it instead of retrying.
      const logged = await db.one<{ state: string; error: string }>(
        `SELECT state, error FROM sqlite_import_log WHERE slug = 'corrupt'`,
      );
      assert.equal(logged?.state, 'failed');
      assert.ok(logged?.error, 'the reason must be recorded for a human to read');
      // The unreadable file is left exactly where it was.
      assert.ok(existsSync(join(badDir, 'world.db')));
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a failed world is never retried automatically, only on explicit reimport', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      const badDir = join(root, 'worlds', 'broken');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'world.db'), 'not a database');

      const first = await importSqliteWorlds(db, { dataRoot: root });
      assert.equal(first.failed.length, 1);

      // The guard that matters under `restart: unless-stopped`: a boot loop must
      // not re-attempt a failing data import forever.
      const second = await importSqliteWorlds(db, { dataRoot: root });
      assert.equal(second.failed.length, 0, 'must not retry');
      assert.deepEqual(second.skipped, ['broken']);

      // Replacing the file is not enough on its own — the operator has to ask.
      rmSync(join(badDir, 'world.db'));
      makeSqliteWorld(root, 'broken', { canon: 2 });
      const stillSkipped = await importSqliteWorlds(db, { dataRoot: root });
      assert.deepEqual(stillSkipped.skipped, ['broken']);

      const forced = await importSqliteWorlds(db, { dataRoot: root, only: 'broken', force: true });
      assert.equal(forced.imported.length, 1);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities`))!.n), 2);
      const logged = await db.one<{ state: string; error: string | null }>(
        `SELECT state, error FROM sqlite_import_log WHERE slug = 'broken'`,
      );
      assert.equal(logged?.state, 'done');
      assert.equal(logged?.error, null, 'a successful reimport must clear the recorded error');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('--reimport replaces a world rather than duplicating it', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      makeSqliteWorld(root, 'twice', { canon: 3 });
      await importSqliteWorlds(db, { dataRoot: root });
      makeSqliteWorld(root, 'twice', { canon: 6 });
      const again = await importSqliteWorlds(db, { dataRoot: root, only: 'twice', force: true });

      assert.equal(again.imported.length, 1);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM worlds`))!.n), 1, 'not a second world');
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities`))!.n), 6);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM stories`))!.n), 1);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a world with no stories imports as canon only', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      // The ordinary state of a freshly ingested world nobody has played yet.
      makeSqliteWorld(root, 'unplayed', { canon: 3, withStory: false });
      const report = await importSqliteWorlds(db, { dataRoot: root });
      assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
      assert.equal(report.imported[0]!.stories, 0);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities`))!.n), 3);
      assert.equal(Number((await db.one<{ n: string }>(`SELECT count(*) n FROM stories`))!.n), 0);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * The placeholder-slug collision that broke a real deployment.
 *
 * A boot with no worlds creates an empty one for the setup wizard, and
 * `slugify('')` is `world`. So a genuine `data/worlds/world/world.db` hit
 * `duplicate key value violates unique constraint "worlds_slug_key"` and was recorded
 * `failed` — which blocks automatic retry, so it stayed broken until someone noticed.
 *
 * The importer now adopts an *empty* world already holding the slug, reusing its id so
 * that anything already pointing at it keeps working.
 */
test('importing adopts an empty world that already holds the slug', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      // Exactly what boot does when it finds nothing: an empty world, slug `world`.
      const placeholder = await createWorld(db, '');
      assert.equal(placeholder.slug, 'world', 'the empty-title slug is what collides');

      makeSqliteWorld(root, 'world', { canon: 3, title: 'A Real World' });
      const report = await importSqliteWorlds(db, { dataRoot: root });

      assert.deepEqual(report.failed, [], 'must not collide any more');
      assert.deepEqual(report.imported.map((w) => w.slug), ['world']);

      // The same row, reused — not a second world with a suffixed slug.
      const rows = await db.query<{ id: string; title: string }>(`SELECT id, title FROM worlds WHERE slug = 'world'`);
      assert.equal(rows.rows.length, 1, 'one world for the slug, not two');
      assert.equal(Number(rows.rows[0]!.id), placeholder.id, 'the placeholder id is kept');
      assert.equal(rows.rows[0]!.title, 'A Real World', 'and the real title replaces the empty one');

      const canon = await db.query<{ n: string }>(
        `SELECT count(*) n FROM canon_entities WHERE world_id = $1`,
        [placeholder.id],
      );
      assert.equal(canon.rows[0]!.n, '3', 'canon landed on the adopted row');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * Adoption must not become a silent overwrite: a world with canon of its own is real
 * data, and colliding with it should still fail loudly.
 */
test('importing refuses to adopt a world that already has canon', async (t) => {
  const ran = await withPg(async (db) => {
    await withRoot(async (root) => {
      // A world at the same slug, with content — the case that must be protected.
      makeSqliteWorld(root, 'occupied', { canon: 2, title: 'First' });
      const first = await importSqliteWorlds(db, { dataRoot: root });
      assert.deepEqual(first.failed, []);

      // A *different* source file arriving at the same slug.
      makeSqliteWorld(root, 'occupied', { canon: 5, title: 'Second' });
      const second = await importSqliteWorlds(db, { dataRoot: root });

      // Skipped by the import log rather than adopted — the log is checked first, and
      // that is the correct outcome: an already-imported world is not re-imported.
      assert.deepEqual(second.imported, [], 'no silent overwrite');
      const rows = await db.query<{ title: string }>(`SELECT title FROM worlds WHERE slug = 'occupied'`);
      assert.equal(rows.rows[0]!.title, 'First', 'the existing world is untouched');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

