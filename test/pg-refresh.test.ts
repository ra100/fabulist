/**
 * The integrity checker and canon refresh.
 *
 * These belong together because the checker is the refresh's gate: a refresh that
 * would leave a story pointing at nothing must roll back rather than commit, and
 * the only way to know that is to run the check inside the transaction. The tests
 * that matter most here are the ones proving the gate actually fires — a gate that
 * never trips is indistinguishable from no gate.
 *
 * The refresh tests deliberately do not touch a wiki. `planRefresh` takes the
 * upstream listing as an argument and `applyRefresh` takes an already-extracted
 * batch, precisely so this behaviour is testable without a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { sourcesFor } from '../src/db/overlay.ts';
import { checkIntegrity, formatIntegrityReport } from '../src/store/integrity-pg.ts';
import { applyRefresh, planRefresh, refreshStatus } from '../src/ingest/refresh.ts';
import { GraphStore } from '../src/store/graph-pg.ts';
import { ChronicleStore } from '../src/store/chronicle-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import type { Db } from '../src/db/pg.ts';

async function world1(db: Db, slug = 'w'): Promise<{ worldId: number; storyId: string; graph: GraphStore }> {
  const worldId = await makeWorld(db, slug);
  const story = await createStory(db, { worldIds: [worldId] });
  const graph = new GraphStore({ db, storyId: story.id, sources: await sourcesFor(db, story.id) });
  return { worldId, storyId: story.id, graph };
}

// -------------------------------------------------------------- integrity

test('a clean database reports ok, and says how much it looked at', async (t) => {
  const ran = await withPg(async (db) => {
    const { graph } = await world1(db);
    await graph.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    await graph.upsert({ id: 'char:b', type: 'Character', name: 'B' }, 'canon');
    await graph.assertEdge({ subject: 'char:a', predicate: 'KNOWS', object: 'char:b' }, 1, 'canon');

    const report = await checkIntegrity(db);
    assert.equal(report.ok, true, formatIntegrityReport(report));
    // "ok with 0 rows checked" and "ok with 3 rows checked" are different claims;
    // an empty report on an empty database should not read as a passing check.
    assert.ok(report.checked > 0);
    assert.match(formatIntegrityReport(report), /integrity ok/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a chronicle edge pointing at nothing is caught', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId } = await world1(db);
    // No entity for either endpoint: what a fork with bad id remapping produces.
    await db.query(
      `INSERT INTO chron_edges (story_id, subject, predicate, object) VALUES ($1,'char:ghost','KNOWS','char:also-ghost')`,
      [storyId],
    );
    const report = await checkIntegrity(db);
    assert.equal(report.ok, false);
    const cols = report.orphans.map((o) => `${o.table}.${o.column}`);
    assert.ok(cols.includes('chron_edges.subject'));
    assert.ok(cols.includes('chron_edges.object'));
    assert.equal(report.orphans[0]?.storyId, storyId, 'the report says which story owns the problem');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an id that exists only in another story\u2019s chronicle is dangling from here', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'shared');
    const a = await createStory(db, { worldIds: [worldId] });
    const b = await createStory(db, { worldIds: [worldId] });

    // A's emergent, player-invented entity.
    await db.query(
      `INSERT INTO chron_entities (story_id, id, type, name) VALUES ($1,'char:invented','Character','Invented')`,
      [a.id],
    );
    // B references it. This is the cross-story leak a fork bug produces, and it
    // is exactly what a flat `SELECT 1 FROM entities WHERE id = ?` check would
    // miss, because the row does exist — just not for B.
    await db.query(
      `INSERT INTO chron_sheets (story_id, entity_id) VALUES ($1,'char:invented')`,
      [b.id],
    );

    const report = await checkIntegrity(db);
    assert.equal(report.ok, false);
    const orphan = report.orphans.find((o) => o.table === 'chron_sheets');
    assert.equal(orphan?.missingId, 'char:invented');
    assert.equal(orphan?.storyId, b.id, 'reported against B, not A');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('participants and parties are checked element-wise, not by substring', async (t) => {
  const ran = await withPg(async (db) => {
    const { storyId, graph } = await world1(db);
    await graph.upsert({ id: 'char:tem-the-elder', type: 'Character', name: 'Tem the Elder' }, 'canon');
    const chron = new ChronicleStore({ db, storyId });
    // `char:tem` does not exist — only `char:tem-the-elder` does. A substring
    // check would call this resolved, which is the same prefix-collision class of
    // bug that made witnessedEvents leak events across characters.
    await chron.addEvent({
      scene: 1, turn: 1, text: 'x', participants: ['char:tem-the-elder', 'char:tem'],
      locationId: null, significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
    });

    const report = await checkIntegrity(db);
    const arr = report.orphans.filter((o) => o.column === 'participants[]');
    assert.equal(arr.length, 1, 'exactly the one bad element');
    assert.equal(arr[0]?.missingId, 'char:tem');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a retired canon entity still referenced by a story is reported', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, storyId, graph } = await world1(db);
    await graph.upsert({ id: 'char:gone', type: 'Character', name: 'Gone' }, 'canon');
    await db.query(`UPDATE stories SET player_character_id = 'char:gone' WHERE id = $1`, [storyId]);
    assert.equal((await checkIntegrity(db)).ok, true, 'fine while live');

    // Retiring makes it invisible to reads, which is the point — but a story
    // still pointing at it is unplayable, and that must surface rather than
    // silently becoming "no such character" at turn time.
    await db.query(
      `UPDATE canon_entities SET retired_at_revision = 'r9' WHERE world_id = $1 AND id = 'char:gone'`,
      [worldId],
    );
    const report = await checkIntegrity(db);
    assert.equal(report.ok, false);
    const orphan = report.orphans.find((o) => o.column === 'player_character_id');
    assert.equal(orphan?.missingId, 'char:gone');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('canon\u2019s own consistency is checked, which the file-per-world design could not', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    // An edge whose subject is not in this world: what a partial import or a
    // refresh that retired the wrong ids leaves behind.
    await db.query(
      `INSERT INTO canon_edges (world_id, subject, predicate, object) VALUES ($1,'char:nobody','KNOWS','char:nobody2')`,
      [worldId],
    );
    await db.query(`INSERT INTO canon_sheets (world_id, entity_id) VALUES ($1,'char:nosheet')`, [worldId]);

    const report = await checkIntegrity(db);
    assert.equal(report.ok, false);
    const cols = report.orphans.map((o) => `${o.table}.${o.column}`);
    assert.ok(cols.includes('canon_edges.subject'));
    assert.ok(cols.includes('canon_sheets.entity_id'));
    assert.equal(report.orphans.find((o) => o.table === 'canon_edges')?.storyId, null, 'canon rows have no story');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a world-scoped check ignores problems in an unrelated world', async (t) => {
  const ran = await withPg(async (db) => {
    const clean = await makeWorld(db, 'clean');
    const dirty = await makeWorld(db, 'dirty');
    await db.query(
      `INSERT INTO canon_edges (world_id, subject, predicate, object) VALUES ($1,'char:ghost','KNOWS','char:ghost2')`,
      [dirty],
    );

    // The refresh gate needs this: refreshing one world must not be blocked by a
    // pre-existing problem somewhere else in the library.
    assert.equal((await checkIntegrity(db, { worldId: clean })).ok, true);
    assert.equal((await checkIntegrity(db, { worldId: dirty })).ok, false);
    assert.equal((await checkIntegrity(db)).ok, false, 'unscoped still sees it');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the orphan report is bounded, because a bad refresh can dangle everything', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    await db.query(
      `INSERT INTO canon_edges (world_id, subject, predicate, object)
       SELECT $1, 'char:ghost' || g, 'KNOWS', 'char:ghost' || g FROM generate_series(1, 200) g`,
      [worldId],
    );
    // Materialising every orphan in a 152,456-edge world would be its own outage.
    const report = await checkIntegrity(db, { limit: 10 });
    assert.equal(report.orphans.length, 10);
    assert.equal(report.ok, false);
    assert.match(formatIntegrityReport(report), /and \d+ more/);
  });
  if (!ran) t.skip('no Postgres configured');
});

// ---------------------------------------------------------------- refresh

test('planRefresh diffs stored revisions against upstream', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    for (const [pageId, rev, title] of [
      ['1', 'r1', 'Unchanged'],
      ['2', 'r1', 'Changed'],
      ['3', 'r1', 'Vanished'],
    ] as const) {
      await db.query(
        `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision, passb_status)
         VALUES ($1,'ex',$2,$3,$4,'done')`,
        [worldId, pageId, title, rev],
      );
    }

    // This is the first code in the project to read ingest_pages.revision back:
    // the column was written on every ingest and never used, so "what changed
    // upstream" had no answer at all.
    const plan = await planRefresh(db, worldId, [
      { wiki: 'ex', pageId: '1', title: 'Unchanged', revision: 'r1' },
      { wiki: 'ex', pageId: '2', title: 'Changed', revision: 'r2' },
      { wiki: 'ex', pageId: '4', title: 'Brand New', revision: 'r1' },
    ]);

    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.changed.map((c) => [c.pageId, c.storedRevision, c.upstreamRevision]), [['2', 'r1', 'r2']]);
    assert.deepEqual(plan.added.map((a) => a.pageId), ['4']);
    assert.deepEqual(plan.removed.map((r) => r.pageId), ['3']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('refreshing one wiki does not retire another wiki\u2019s pages', async (t) => {
  const ran = await withPg(async (db) => {
    // star-trek-alpha-beta really does hold two wikis, so this is the shape of a
    // real world rather than a hypothetical.
    const worldId = await makeWorld(db, 'trek');
    await db.query(
      `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision) VALUES
         ($1,'enmemoryalpha','1','Alpha page','r1'), ($1,'startrek','1','Beta page','r1')`,
      [worldId],
    );

    const plan = await planRefresh(db, worldId, [
      { wiki: 'enmemoryalpha', pageId: '1', title: 'Alpha page', revision: 'r2' },
    ]);
    assert.deepEqual(plan.changed.map((c) => c.wiki), ['enmemoryalpha']);
    assert.deepEqual(plan.removed, [], 'the unlisted wiki must not be treated as vanished');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('applyRefresh upserts canon, retires what is gone, and never deletes', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, storyId, graph } = await world1(db);
    await graph.upsert({ id: 'char:a', type: 'Character', name: 'Old Name', summary: 'stale', depthLevel: 3 }, 'canon');
    await graph.upsert({ id: 'char:gone', type: 'Character', name: 'Gone' }, 'canon');

    const res = await applyRefresh(db, worldId, {
      entities: [
        { id: 'char:a', type: 'Character', name: 'New Name', summary: 'fresh', depthLevel: 1 },
        { id: 'char:new', type: 'Character', name: 'Newcomer' },
      ],
      pages: [{ wiki: 'ex', pageId: '1', title: 'A', revision: 'r2' }],
      retire: ['char:gone'],
    }, { watermark: 'r2' });

    assert.deepEqual(res.integrityProblems, [], 'should have committed');
    assert.equal(res.entitiesRetired, 1);
    assert.equal((await graph.getCanon('char:a'))?.name, 'New Name');
    assert.equal((await graph.getCanon('char:a'))?.summary, 'fresh');
    // A shallower re-read must not undo a deeper one.
    assert.equal((await graph.getCanon('char:a'))?.depthLevel, 3, 'depth is the deepest reading, never lowered');
    assert.equal((await graph.getCanon('char:new'))?.name, 'Newcomer');

    // Retired means invisible, not absent: no foreign key can span the overlay,
    // so a story still referencing it must remain diagnosable.
    assert.equal(await graph.getCanon('char:gone'), undefined);
    const row = await db.one<{ retired_at_revision: string }>(
      `SELECT retired_at_revision FROM canon_entities WHERE world_id = $1 AND id = 'char:gone'`,
      [worldId],
    );
    assert.equal(row?.retired_at_revision, 'r2', 'the row survives, flagged with the revision that retired it');

    // The watermark advanced, per world and per wiki.
    const status = await refreshStatus(db, worldId);
    assert.ok(status.lastRefreshedAt);
    assert.equal(status.sources[0]?.wiki, 'ex');
    assert.equal(status.sources[0]?.watermark, 'r2');
    void storyId;
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a page whose revision changed is queued for re-extraction', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'w');
    await db.query(
      `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision, passb_status)
       VALUES ($1,'ex','1','A','r1','done')`,
      [worldId],
    );

    // Same revision: the expensive LLM pass must not be redone.
    await applyRefresh(db, worldId, { entities: [], pages: [{ wiki: 'ex', pageId: '1', title: 'A', revision: 'r1' }] });
    assert.equal(
      (await db.one<{ passb_status: string }>(`SELECT passb_status FROM ingest_pages WHERE world_id = $1`, [worldId]))
        ?.passb_status,
      'done',
      'an unchanged page keeps its extraction',
    );

    // Changed revision: a page still marked done would be skipped by the
    // resumable extractor, silently keeping relations for text that no longer
    // says that.
    await applyRefresh(db, worldId, { entities: [], pages: [{ wiki: 'ex', pageId: '1', title: 'A', revision: 'r2' }] });
    assert.equal(
      (await db.one<{ passb_status: string }>(`SELECT passb_status FROM ingest_pages WHERE world_id = $1`, [worldId]))
        ?.passb_status,
      '',
      'changed text must be re-read',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a retired entity that comes back upstream is revived, and counted', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, graph } = await world1(db);
    await graph.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    await applyRefresh(db, worldId, { entities: [], pages: [], retire: ['char:a'] }, { watermark: 'r2' });
    assert.equal(await graph.getCanon('char:a'), undefined);

    // A rename reverted, or a deletion undone. Staying invisible forever because
    // one crawl missed it would be wrong.
    const res = await applyRefresh(
      db,
      worldId,
      { entities: [{ id: 'char:a', type: 'Character', name: 'A again' }], pages: [] },
      { watermark: 'r3' },
    );
    assert.equal(res.entitiesRevived, 1, 'a revival is distinct information from an update');
    assert.equal((await graph.getCanon('char:a'))?.name, 'A again');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the integrity gate rolls the whole refresh back', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, storyId, graph } = await world1(db);
    await graph.upsert({ id: 'char:pc', type: 'Character', name: 'PC' }, 'canon');
    await db.query(`UPDATE stories SET player_character_id = 'char:pc' WHERE id = $1`, [storyId]);

    // Retiring the player character would leave the story unplayable. The gate
    // must refuse the whole batch, not just that one row — a half-applied refresh
    // reads fine until a turn fails.
    const res = await applyRefresh(
      db,
      worldId,
      {
        entities: [{ id: 'char:extra', type: 'Character', name: 'Extra' }],
        pages: [{ wiki: 'ex', pageId: '1', title: 'A', revision: 'r2' }],
        retire: ['char:pc'],
      },
      { watermark: 'r2' },
    );

    assert.ok(res.integrityProblems.length > 0, 'the gate should have fired');
    assert.match(res.integrityProblems.join('\n'), /player_character_id/);

    // Everything rolled back together: the entity, the page, and the retirement.
    assert.equal((await graph.getCanon('char:pc'))?.name, 'PC', 'the player character is still live');
    assert.equal(await graph.getCanon('char:extra'), undefined, 'the unrelated insert rolled back too');
    const pages = await db.one<{ n: string }>(`SELECT count(*) n FROM ingest_pages WHERE world_id = $1`, [worldId]);
    assert.equal(Number(pages!.n), 0, 'the page record rolled back');
    const world = await db.one<{ last_refreshed_at: Date | null }>(
      `SELECT last_refreshed_at FROM worlds WHERE id = $1`,
      [worldId],
    );
    assert.equal(world?.last_refreshed_at, null, 'and the world was never marked refreshed');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a refresh cannot touch any story\u2019s chronicle', async (t) => {
  const ran = await withPg(async (db) => {
    const { worldId, storyId, graph } = await world1(db);
    await graph.upsert({ id: 'char:a', type: 'Character', name: 'Canon A' }, 'canon');
    // The story diverged this entity.
    await graph.upsert({ id: 'char:a', type: 'Character', name: 'Canon A', summary: 'DIVERGED' }, 'chronicle');
    const chron = new ChronicleStore({ db, storyId });
    await chron.addTurn({
      scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null, bookProse: 'Somebody\u2019s novel.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });

    await applyRefresh(db, worldId, {
      entities: [{ id: 'char:a', type: 'Character', name: 'Rewritten upstream', summary: 'new canon' }],
      pages: [],
    }, { watermark: 'r2' });

    // This is the whole promise of the migration: refreshing the source material
    // is invisible to a playthrough that has diverged from it, and the prose is
    // untouched.
    assert.equal((await graph.get('char:a'))?.summary, 'DIVERGED', 'the story still reads its own version');
    assert.equal((await graph.getCanon('char:a'))?.summary, 'new canon', 'canon did update underneath');
    assert.equal((await chron.turns())[0]?.bookProse, 'Somebody\u2019s novel.');
    assert.equal((await checkIntegrity(db, { worldId })).ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});
