/**
 * Crossover: collision detection, aliasing, and the frame budget split.
 *
 * The behaviour under test is what makes "Harry Potter x LotR" a usable feature
 * rather than a technically-working one. The overlay already reads N worlds; the
 * question these tests answer is what happens at the seams — when both worlds
 * claim `loc:luna`, and when one world is 1,500x larger than the other.
 *
 * The collision count in the real corpora (6 ids across 45,012 entities) is why
 * aliasing is per-collision. A test asserts the bare id survives for the primary
 * world, because namespacing everything would break the `char:`/`loc:` prefix
 * assumptions elsewhere in the codebase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { sourcesFor } from '../src/db/overlay.ts';
import {
  aliasCollisions,
  findCollisions,
  frameBudgetPerSource,
  listAliases,
  resolveAlias,
} from '../src/store/crossover.ts';
import { GraphStore } from '../src/store/graph-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { setStorySources } from '../src/store/index-pg.ts';
import type { Db } from '../src/db/pg.ts';

/** Two worlds and a story reading both, in the given order. */
async function crossover(db: Db): Promise<{ hp: number; lotr: number; storyId: string }> {
  const hp = await makeWorld(db, 'potter', 'Harry Potter');
  const lotr = await makeWorld(db, 'middle-earth', 'Middle-earth');
  const story = await createStory(db, { title: 'A crossover', worldIds: [hp, lotr] });
  return { hp, lotr, storyId: story.id };
}

async function canon(db: Db, storyId: string, worldId: number, id: string, name: string, type = 'Character') {
  const g = new GraphStore({ db, storyId, sources: await sourcesFor(db, storyId), canonWorldId: worldId });
  await g.upsert({ id, type: type as 'Character', name }, 'canon');
}

test('a story reading one world has no collisions to report', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'solo');
    const story = await createStory(db, { worldIds: [worldId] });
    await canon(db, story.id, worldId, 'char:a', 'A');
    assert.deepEqual(await findCollisions(db, story.id), []);
    // And the whole budget goes to the only source, not a fraction of it.
    assert.deepEqual(await frameBudgetPerSource(db, story.id, 40), [{ worldId, ordinal: 1, cap: 40 }]);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('collisions are found and reported in precedence order', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    // The real Star Trek x Mass Effect collision set is exactly this shape: a
    // handful of common nouns and given names that two unrelated wikis both use
    // as page titles, because ids are deterministic slugs of (type, title).
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    await canon(db, storyId, hp, 'concept:invasion', 'Invasion of Hogwarts', 'Concept');
    await canon(db, storyId, lotr, 'concept:invasion', 'Invasion of Rohan', 'Concept');
    // Unique to each: must not be reported.
    await canon(db, storyId, hp, 'char:harry', 'Harry');
    await canon(db, storyId, lotr, 'char:frodo', 'Frodo');

    const collisions = await findCollisions(db, storyId);
    assert.deepEqual(collisions.map((c) => c.id).sort(), ['concept:invasion', 'loc:luna']);
    const luna = collisions.find((c) => c.id === 'loc:luna')!;
    assert.equal(luna.claimants.length, 2);
    assert.equal(luna.claimants[0]!.ordinal, 1);
    assert.equal(luna.claimants[0]!.name, 'Luna Lovegood', 'the winner is listed first');
    assert.equal(luna.claimants[1]!.name, 'Luna the Moon');
    assert.equal(luna.claimants[1]!.slug, 'middle-earth', 'the report names which world is shadowed');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a retired entity does not count as a collision', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    assert.equal((await findCollisions(db, storyId)).length, 1);

    // A refresh that retires one side resolves the collision. Reporting it
    // afterwards would send the player looking for a conflict that is gone.
    await db.query(`UPDATE canon_entities SET retired_at_revision = 'r2' WHERE world_id = $1 AND id = 'loc:luna'`, [
      lotr,
    ]);
    assert.deepEqual(await findCollisions(db, storyId), []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('aliasing renames only the shadowed claimants, never the primary', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    await canon(db, storyId, hp, 'char:harry', 'Harry');

    const result = await aliasCollisions(db, storyId);
    assert.equal(result.collisions, 1);
    assert.equal(result.aliased.length, 1, 'one side of one collision');
    assert.equal(result.aliased[0]!.composedId, 'middle-earth:loc:luna');
    assert.equal(result.aliased[0]!.localId, 'loc:luna');

    // The primary world reads exactly as it would alone. A crossover must not
    // change how the world you started from behaves.
    const g = new GraphStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    assert.equal((await g.get('loc:luna'))?.name, 'Luna Lovegood');
    assert.equal((await g.get('char:harry'))?.name, 'Harry', 'a non-colliding id is untouched');

    // And the shadowed one is now reachable by its composed name.
    const resolved = await resolveAlias(db, storyId, 'middle-earth:loc:luna');
    assert.equal(resolved?.worldId, lotr);
    assert.equal(resolved?.localId, 'loc:luna');
    assert.equal(await resolveAlias(db, storyId, 'char:harry'), undefined, 'unaliased ids resolve to nothing here');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('canon is never rewritten, so each world stays independently refreshable', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    await aliasCollisions(db, storyId);

    // This is the property that makes Phase 3 and Phase 4 compatible: the alias
    // lives in the story's namespace, so refreshing Middle-earth does not have to
    // know that some story somewhere composed it with Harry Potter.
    const rows = await db.many<{ world_id: string; id: string }>(
      `SELECT world_id, id FROM canon_entities WHERE id LIKE '%luna%' ORDER BY world_id`,
    );
    assert.deepEqual(rows.map((r) => r.id), ['loc:luna', 'loc:luna'], 'both canon rows keep their bare ids');
    // The alias table is where the namespacing lives, and it is per story.
    assert.equal((await listAliases(db, storyId)).length, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('re-aliasing is idempotent and drops aliases a refresh resolved', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    await canon(db, storyId, hp, 'char:april', 'April');
    await canon(db, storyId, lotr, 'char:april', 'April the Month');

    await aliasCollisions(db, storyId);
    assert.equal((await listAliases(db, storyId)).length, 2);
    // Running twice must not duplicate.
    await aliasCollisions(db, storyId);
    assert.equal((await listAliases(db, storyId)).length, 2);

    // A refresh retires one collision; re-aliasing must forget that alias rather
    // than leaving it pointing at an id that no longer collides.
    await db.query(`UPDATE canon_entities SET retired_at_revision = 'r2' WHERE world_id = $1 AND id = 'char:april'`, [
      lotr,
    ]);
    await aliasCollisions(db, storyId);
    const remaining = await listAliases(db, storyId);
    assert.deepEqual(remaining.map((a) => a.composedId), ['middle-earth:loc:luna']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('changing the source order changes which side is aliased', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    await canon(db, storyId, hp, 'loc:luna', 'Luna Lovegood');
    await canon(db, storyId, lotr, 'loc:luna', 'Luna the Moon');
    await aliasCollisions(db, storyId);
    assert.equal((await listAliases(db, storyId))[0]?.worldId, lotr);

    // Reordering is the player saying "this is a Middle-earth story with Hogwarts
    // in it, not the other way round".
    await setStorySources(db, storyId, [lotr, hp]);
    await aliasCollisions(db, storyId);
    const aliases = await listAliases(db, storyId);
    assert.equal(aliases[0]?.worldId, hp, 'now Harry Potter is the shadowed one');
    assert.equal(aliases[0]?.composedId, 'potter:loc:luna');

    const g = new GraphStore({ db, storyId, sources: await sourcesFor(db, storyId) });
    assert.equal((await g.get('loc:luna'))?.name, 'Luna the Moon', 'the new primary wins the bare id');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the frame budget splits by size but never starves the smaller world', async (t) => {
  const ran = await withPg(async (db) => {
    const big = await makeWorld(db, 'big');
    const small = await makeWorld(db, 'small');
    const story = await createStory(db, { worldIds: [big, small] });
    // The real asymmetry: saint-verrow has 22 canon entities, star-trek has
    // 33,332. Splitting the frame purely by salience would let the large world
    // win every slot, turning a crossover into one world with scenery.
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name)
       SELECT $1, 'char:b' || g, 'Character', 'B' || g FROM generate_series(1, 1000) g`,
      [big],
    );
    await db.query(
      `INSERT INTO canon_entities (world_id, id, type, name)
       SELECT $1, 'char:s' || g, 'Character', 'S' || g FROM generate_series(1, 10) g`,
      [small],
    );

    const caps = await frameBudgetPerSource(db, story.id, 40);
    const bigCap = caps.find((c) => c.worldId === big)!.cap;
    const smallCap = caps.find((c) => c.worldId === small)!.cap;
    assert.ok(bigCap > smallCap, 'the larger world gets more');
    assert.ok(smallCap >= 5, `the smaller world must still appear, got ${smallCap}`);
    assert.ok(bigCap <= 40);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a crossover with no sources yields no budget rather than dividing by zero', async (t) => {
  const ran = await withPg(async (db) => {
    const story = await createStory(db, { title: 'no world yet' });
    assert.deepEqual(await frameBudgetPerSource(db, story.id, 40), []);
    assert.deepEqual(await findCollisions(db, story.id), []);
    assert.deepEqual((await aliasCollisions(db, story.id)).aliased, []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a crossover walks edges from both worlds in one traversal', async (t) => {
  const ran = await withPg(async (db) => {
    const { hp, lotr, storyId } = await crossover(db);
    const sources = await sourcesFor(db, storyId);
    const hpG = new GraphStore({ db, storyId, sources, canonWorldId: hp });
    const lotrG = new GraphStore({ db, storyId, sources, canonWorldId: lotr });
    await hpG.assertEdge({ subject: 'char:harry', predicate: 'ATTENDS', object: 'loc:hogwarts' }, 1, 'canon');
    await lotrG.assertEdge({ subject: 'char:frodo', predicate: 'CARRIES', object: 'item:ring' }, 1, 'canon');

    const g = new GraphStore({ db, storyId, sources });
    assert.equal((await g.edgesFrom('char:harry')).length, 1);
    assert.equal((await g.edgesFrom('char:frodo')).length, 1);

    // The bridge between the two worlds is chronicle, not canon: "how does
    // Hogwarts touch Middle-earth" is the player's story, not either franchise's
    // source material. This falls out of the design rather than needing new
    // machinery, and it is why canon stays refreshable.
    await g.assertEdge({ subject: 'char:harry', predicate: 'ALLIED_WITH', object: 'char:frodo' }, 2);
    const bridge = (await g.edgesFrom('char:harry')).find((e) => e.object === 'char:frodo');
    assert.equal(bridge?.layer, 'chronicle');
    assert.equal((await g.allEdges()).length, 3);
  });
  if (!ran) t.skip('no Postgres configured');
});
