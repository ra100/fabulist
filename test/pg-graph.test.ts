/**
 * GraphStore against Postgres: behavioural parity with the SQLite original,
 * plus the properties only the split can offer.
 *
 * These mirror `test/store.test.ts`'s graph cases deliberately — same
 * assertions, same names where possible — because the migration's promise is
 * that behaviour does not change, and the cheapest way to keep that honest is
 * for the two suites to be comparable line by line.
 *
 * What is genuinely new: a store reads N canon worlds (crossover), a canon
 * write needs a target world, and the play role cannot write canon at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStory, makeWorld, withPg } from './pg-harness.ts';
import { sourcesFor } from '../src/db/overlay.ts';
import { GraphStore } from '../src/store/graph-pg.ts';
import type { Db } from '../src/db/pg.ts';

/** A store bound to one story and its sources, the way the server will build it. */
async function graphFor(db: Db, storyId: string): Promise<GraphStore> {
  return new GraphStore({ db, storyId, sources: await sourcesFor(db, storyId) });
}

async function oneWorldStory(db: Db, slug = 'w', storyId = 'story:a'): Promise<GraphStore> {
  const w = await makeWorld(db, slug);
  await makeStory(db, storyId, [w]);
  return graphFor(db, storyId);
}

test('canon stays pristine while chronicle overlays it', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert(
      { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'A living monk.' },
      'canon',
    );
    assert.equal((await g.get('char:anselm'))?.summary, 'A living monk.');

    // The playthrough kills him: shadow the node, do not mutate canon.
    await g.upsert(
      { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'Dead since scene 12.' },
      'chronicle',
    );

    assert.equal((await g.get('char:anselm'))?.summary, 'Dead since scene 12.');
    assert.equal((await g.get('char:anselm'))?.layer, 'chronicle');
    assert.equal((await g.getCanon('char:anselm'))?.summary, 'A living monk.');
    assert.equal((await g.getCanon('char:anselm'))?.layer, 'canon');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('edges expire rather than being deleted, so history survives', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    for (const id of ['char:a', 'char:b']) await g.upsert({ id, type: 'Character', name: id }, 'canon');
    await g.assertEdge({ subject: 'char:a', predicate: 'ALLIED_WITH', object: 'char:b' }, 1, 'canon');

    assert.equal((await g.edgesFrom('char:a', 5)).length, 1, 'allied at scene 5');
    assert.equal(await g.retireEdge('char:a', 'ALLIED_WITH', 'char:b', 8), true);
    assert.equal((await g.edgesFrom('char:a', 5)).length, 1, 'still allied at scene 5');
    assert.equal((await g.edgesFrom('char:a', 9)).length, 0, 'no longer allied at scene 9');
    assert.equal((await g.edgesFrom('char:a')).length, 0, 'not live now');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('re-asserting a live edge updates its weight rather than duplicating it', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.assertEdge({ subject: 'char:a', predicate: 'TRUSTS', object: 'char:b', weight: 0.3 }, 1);
    await g.assertEdge({ subject: 'char:a', predicate: 'TRUSTS', object: 'char:b', weight: 0.9 }, 2);
    const edges = await g.edgesFrom('char:a');
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.weight, 0.9);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('retiring a canon edge copies it into chronicle, leaving canon live for others', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'shared');
    await makeStory(db, 'story:a', [w]);
    await makeStory(db, 'story:b', [w]);
    const a = await graphFor(db, 'story:a');
    const b = await graphFor(db, 'story:b');
    await a.assertEdge({ subject: 'char:x', predicate: 'ALLIED_WITH', object: 'char:y' }, 1, 'canon');

    assert.equal(await a.retireEdge('char:x', 'ALLIED_WITH', 'char:y', 4), true);
    assert.equal((await a.edgesFrom('char:x')).length, 0, 'A retired it');
    assert.equal((await b.edgesFrom('char:x')).length, 1, 'B must still see canon live');

    // Canon itself is untouched — the row still has no valid_to.
    const canon = await db.one<{ valid_to: number | null }>(
      `SELECT valid_to FROM canon_edges WHERE world_id = $1`,
      [w],
    );
    assert.equal(canon?.valid_to, null, 'canon must never be mutated by a playthrough');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('two stories overlay the same canon independently', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'shared');
    await makeStory(db, 'story:a', [w]);
    await makeStory(db, 'story:b', [w]);
    const a = await graphFor(db, 'story:a');
    const b = await graphFor(db, 'story:b');

    await a.upsert({ id: 'char:k', type: 'Character', name: 'K', summary: 'canon' }, 'canon');
    await a.upsert({ id: 'char:k', type: 'Character', name: 'K', summary: 'A diverged' }, 'chronicle');

    assert.equal((await a.get('char:k'))?.summary, 'A diverged');
    assert.equal((await b.get('char:k'))?.summary, 'canon');

    // And an emergent entity in A is invisible to B entirely.
    await a.upsert({ id: 'char:invented', type: 'Character', name: 'Invented' }, 'chronicle');
    assert.ok(await a.has('char:invented'));
    assert.equal(await b.has('char:invented'), false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('salience decay touches only this story\u2019s chronicle rows', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'shared');
    await makeStory(db, 'story:a', [w]);
    await makeStory(db, 'story:b', [w]);
    const a = await graphFor(db, 'story:a');
    const b = await graphFor(db, 'story:b');
    await a.upsert({ id: 'char:k', type: 'Character', name: 'K', salience: 0.8 }, 'canon');

    // Bumping copy-on-writes a chronicle row; decay then cools only that.
    await a.bumpSalience(['char:k'], 0.1);
    await a.decaySalience(0.5, 0);
    assert.ok((await a.get('char:k'))!.salience < 0.5, 'A cooled');
    assert.equal((await b.get('char:k'))!.salience, 0.8, 'B reads the canon baseline, uncooled');
    const canon = await db.one<{ salience: number }>(`SELECT salience FROM canon_entities WHERE world_id = $1`, [w]);
    assert.equal(canon?.salience, 0.8, 'canon salience is never decayed');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('resolveName is exact or normalised, never a similarity guess', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:anselm', type: 'Character', name: 'Brother Anselm' }, 'canon');
    // A synthetic Pass B event node: name is a sentence fragment, summary is the
    // whole sentence. This is the node that used to hijack ~14,205 MENTIONS
    // edges when resolveName fell back to `search`, which also matches summary.
    await g.upsert(
      {
        id: 'event:abc',
        type: 'Event',
        name: 'Brother Anselm walked to the scriptorium and',
        summary: 'Brother Anselm walked to the scriptorium and set down his quill.',
        salience: 1,
      },
      'canon',
    );

    assert.equal((await g.resolveName('Brother Anselm'))?.id, 'char:anselm');
    assert.equal((await g.resolveName('brother anselm'))?.id, 'char:anselm', 'case-insensitive');
    assert.equal((await g.resolveName('The Brother Anselm'))?.id, 'char:anselm', 'leading article');
    // Nothing resembling it resolves at all — a missing edge is visible, a
    // wrong one is not.
    assert.equal(await g.resolveName('Anselm the Younger'), undefined);
    assert.equal(await g.resolveName(''), undefined);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an edge asserted later is not visible at an earlier scene', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    // "Live at scene N" is two conditions: already asserted, and not yet
    // expired. An early port of the overlay checked only the second, so an
    // alliance formed at scene 9 read as live when asked about scene 2 —
    // history that had not happened yet.
    await g.assertEdge({ subject: 'char:a', predicate: 'ALLIED_WITH', object: 'char:b' }, 9);
    assert.equal((await g.edgesFrom('char:a', 2)).length, 0, 'not yet asserted at scene 2');
    assert.equal((await g.edgesFrom('char:a', 9)).length, 1, 'live from scene 9');
    assert.equal((await g.edgesFrom('char:a', 12)).length, 1, 'still live later');
    assert.equal((await g.edgesTo('char:b', 2)).length, 0, 'same for the inbound direction');
    assert.equal((await g.edgesTo('char:b', 9)).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an overlay read reports which layer answered', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    await g.assertEdge({ subject: 'char:a', predicate: 'KNOWS', object: 'char:b' }, 1, 'canon');
    // `layer` is a real field on the domain type and callers branch on it (the
    // graph view rings emergent nodes with it), so losing it in a projection is
    // a behaviour change, not a cosmetic one.
    assert.equal((await g.get('char:a'))?.layer, 'canon');
    assert.equal((await g.edgesFrom('char:a'))[0]?.layer, 'canon');

    await g.upsert({ id: 'char:a', type: 'Character', name: 'A', summary: 'diverged' }, 'chronicle');
    await g.assertEdge({ subject: 'char:a', predicate: 'DISTRUSTS', object: 'char:c' }, 2);
    assert.equal((await g.get('char:a'))?.layer, 'chronicle');
    const own = (await g.edgesFrom('char:a')).find((e) => e.predicate === 'DISTRUSTS');
    assert.equal(own?.layer, 'chronicle');
    assert.deepEqual(
      (await g.list({ limit: 10 })).map((e) => [e.id, e.layer]),
      [['char:a', 'chronicle']],
      'the list path must report the winning layer too',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('counts report distinct overlay ids, not the sum of both layers', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    await g.upsert({ id: 'char:b', type: 'Character', name: 'B' }, 'canon');
    // Diverging A must not make it count twice.
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A', summary: 'diverged' }, 'chronicle');
    await g.upsert({ id: 'char:c', type: 'Character', name: 'C' }, 'chronicle');

    const c = await g.counts();
    assert.equal(c.canon, 2);
    assert.equal(c.chronicle, 2);
    assert.equal(c.entities, 3, 'a, b, c — a diverged entity is one entity');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('isEmpty answers the setup gate\u2019s question without counting', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    assert.equal(await g.isEmpty(), true);
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    assert.equal(await g.isEmpty(), false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('list filters by layer, type and salience', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A', salience: 0.9 }, 'canon');
    await g.upsert({ id: 'loc:b', type: 'Location', name: 'B', salience: 0.2 }, 'canon');
    await g.upsert({ id: 'char:c', type: 'Character', name: 'C', salience: 0.5 }, 'chronicle');

    assert.deepEqual((await g.list({ layer: 'canon' })).map((e) => e.id).sort(), ['char:a', 'loc:b']);
    assert.deepEqual((await g.list({ layer: 'chronicle' })).map((e) => e.id), ['char:c']);
    assert.deepEqual((await g.list({ type: 'Character' })).map((e) => e.id).sort(), ['char:a', 'char:c']);
    assert.deepEqual((await g.list({ minSalience: 0.4 })).map((e) => e.id).sort(), ['char:a', 'char:c']);
    // Ordered by salience descending, which is what the frame builder relies on.
    assert.deepEqual((await g.list({ limit: 2 })).map((e) => e.id), ['char:a', 'char:c']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('setDepth targets canon, and falls back to chronicle for an emergent entity', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:canon', type: 'Character', name: 'Canon', depthLevel: 1 }, 'canon');
    await g.upsert({ id: 'char:emergent', type: 'Character', name: 'Emergent', depthLevel: 0 }, 'chronicle');

    await g.setDepth('char:canon', 3);
    await g.setDepth('char:emergent', 2);

    assert.equal((await g.getCanon('char:canon'))?.depthLevel, 3);
    // Would silently match zero rows if setDepth assumed canon only.
    assert.equal((await g.get('char:emergent'))?.depthLevel, 2);
    // Never lowers: MAX/GREATEST semantics, so a shallower pass cannot undo a
    // deeper read.
    await g.setDepth('char:canon', 1);
    assert.equal((await g.getCanon('char:canon'))?.depthLevel, 3);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('belowDepth finds canon entities needing a deeper read', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:shallow', type: 'Character', name: 'Shallow', depthLevel: 1, salience: 0.9 }, 'canon');
    await g.upsert({ id: 'char:deep', type: 'Character', name: 'Deep', depthLevel: 3, salience: 0.9 }, 'canon');
    const below = await g.belowDepth(3);
    assert.deepEqual(below.map((e) => e.id), ['char:shallow']);
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------------ crossover

test('a crossover store reads both worlds, with ordinal precedence', async (t) => {
  const ran = await withPg(async (db) => {
    const hp = await makeWorld(db, 'potter');
    const lotr = await makeWorld(db, 'middle-earth');
    await makeStory(db, 'story:x', [hp, lotr]);
    const g = await graphFor(db, 'story:x');

    // Written per world, because a canon write needs a target.
    const hpStore = new GraphStore({ db, storyId: 'story:x', sources: g.sources, canonWorldId: hp });
    const lotrStore = new GraphStore({ db, storyId: 'story:x', sources: g.sources, canonWorldId: lotr });
    await hpStore.upsert({ id: 'char:luna', type: 'Character', name: 'Luna Lovegood' }, 'canon');
    await lotrStore.upsert({ id: 'char:luna', type: 'Character', name: 'Luna the Moon' }, 'canon');
    await lotrStore.upsert({ id: 'char:frodo', type: 'Character', name: 'Frodo' }, 'canon');

    assert.equal((await g.get('char:luna'))?.name, 'Luna Lovegood', 'ordinal 1 wins a collision');
    assert.equal((await g.get('char:frodo'))?.name, 'Frodo', 'ordinal 2 is still reachable');

    const ids = (await g.list({ limit: 50 })).map((e) => e.id);
    assert.equal(ids.filter((i) => i === 'char:luna').length, 1, 'a collision appears once');
    assert.ok(ids.includes('char:frodo'));

    // Edges from both worlds are walked in one traversal — the thing the SQLite
    // ATTACH ceiling (max 10 databases) would eventually have prevented.
    await hpStore.assertEdge({ subject: 'char:luna', predicate: 'ATTENDS', object: 'loc:hogwarts' }, 1, 'canon');
    await lotrStore.assertEdge({ subject: 'char:frodo', predicate: 'CARRIES', object: 'item:ring' }, 1, 'canon');
    assert.equal((await g.edgesFrom('char:luna')).length, 1);
    assert.equal((await g.edgesFrom('char:frodo')).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a canon write with no target world fails loudly rather than guessing', async (t) => {
  const ran = await withPg(async (db) => {
    // A story with no sources: pathological, but the failure must be a clear
    // error rather than rows landing in whichever world happened to be first.
    await db.query(`INSERT INTO stories (id, title) VALUES ('story:orphan','Orphan')`);
    const g = new GraphStore({ db, storyId: 'story:orphan', sources: [] });
    await assert.rejects(
      () => g.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon'),
      /no canon world/,
    );
    // Chronicle writes still work: they need no world.
    await g.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'chronicle');
    assert.equal((await g.get('char:a'))?.name, 'A');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a retired canon entity vanishes from every read path', async (t) => {
  const ran = await withPg(async (db) => {
    const g = await oneWorldStory(db);
    await g.upsert({ id: 'char:gone', type: 'Character', name: 'Gone', salience: 0.9 }, 'canon');
    await db.query(`UPDATE canon_entities SET retired_at_revision = 'r42' WHERE id = 'char:gone'`);

    assert.equal(await g.get('char:gone'), undefined);
    assert.equal(await g.getCanon('char:gone'), undefined);
    assert.equal(await g.has('char:gone'), false);
    assert.equal((await g.list({})).length, 0);
    assert.equal((await g.list({ layer: 'canon' })).length, 0);
    assert.equal((await g.belowDepth(3)).length, 0);
    assert.equal((await g.search('Gone')).length, 0);
    // But the row is still there: a refresh must not delete what a story may
    // reference, and no foreign key can span the overlay.
    assert.ok(await db.one(`SELECT id FROM canon_entities WHERE id = 'char:gone'`));
  });
  if (!ran) t.skip('no Postgres configured');
});
