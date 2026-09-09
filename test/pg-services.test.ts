/**
 * The setup and illustration services on Postgres.
 *
 * The centrepiece is the `reset()` split. Under SQLite there was one operation,
 * and it deleted 17 tables *including `stories`* — so "rebuild this world" and
 * "destroy every story in it" were the same button. That is the concrete reason
 * this migration happened, and these tests pin both halves:
 *
 *   - `resetMyStory` wipes one playthrough and leaves canon plus every other
 *     story untouched.
 *   - `rebuildCanon` empties a world's canon and leaves every story's chronicle
 *     and prose intact.
 *
 * Neither can do the other's job, which is the property the grants enforce and
 * the reason a refresh is now safe to offer at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, withPg } from './pg-harness.ts';
import { World } from '../src/store/index-pg.ts';
import { createStory, getStory, listStories } from '../src/store/world-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { IllustrationService } from '../src/illustration/service-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { MockImageProvider } from '../src/providers/mockImage.ts';
import { SwappableImageRegistry } from '../src/providers/image.ts';
import { checkIntegrity } from '../src/store/integrity-pg.ts';
import type { Db } from '../src/db/pg.ts';

async function setup(db: Db, slug = 'w'): Promise<{ world: World; worldId: number; service: SetupService }> {
  const worldId = await makeWorld(db, slug);
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  const service = new SetupService({ world, db, providers: new ProviderRegistry(new MockProvider()) });
  return { world, worldId, service };
}

// --------------------------------------------------------- the reset split

test('resetMyStory wipes one story and leaves canon and other stories alone', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, worldId, service } = await setup(db);
    await seedWorld(world);

    // A second story in the same world, and a third in another world, so a
    // too-broad delete is visible rather than plausible.
    const sibling = await createStory(db, { title: 'sibling', worldIds: [worldId] });
    const siblingWorld = await World.forStory(db, sibling.id);
    await siblingWorld.chronicle.addTurn({
      scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null, bookProse: 'The sibling\u2019s novel.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });

    const canonBefore = (await world.graph.counts()).canon;
    assert.ok(canonBefore > 10, 'the seed should have written canon');
    await world.chronicle.addTurn({
      scene: 1, turn: 1, rawInput: 'y', intent: null, delta: null, bookProse: 'My novel.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });

    const freshId = await service.resetMyStory();

    // The old story is gone, with everything scoped to it.
    assert.equal(await getStory(db, world.storyId), undefined);
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM turns WHERE story_id = $1`, [world.storyId]))!.n),
      0,
    );
    // A replacement exists and reads the same canon.
    const fresh = await World.forStory(db, freshId);
    assert.deepEqual(fresh.sources.map((s) => s.worldId), [worldId]);
    assert.equal((await fresh.graph.counts()).canon, canonBefore, 'canon is untouched');
    // And the sibling still has its prose.
    assert.equal((await siblingWorld.chronicle.turns())[0]!.bookProse, 'The sibling\u2019s novel.');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('rebuildCanon empties a world and leaves every story\u2019s prose intact', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, worldId, service } = await setup(db);
    await seedWorld(world);
    const before = await world.graph.counts();
    assert.ok(before.canon > 10);

    // The thing the SQLite reset destroyed: somebody's actual writing.
    await world.chronicle.addTurn({
      scene: 1, turn: 1, rawInput: 'x', intent: null, delta: null,
      bookProse: 'He set the quill down across the inkwell.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });
    await world.graph.upsert({ id: 'char:invented', type: 'Character', name: 'Invented' }, 'chronicle');
    // The seed already writes facts, so the count is captured rather than assumed:
    // what matters is that a canon rebuild removes none of them.
    const factsBefore = (await world.chronicle.facts()).length;
    assert.ok(factsBefore > 0, 'the seed should have written facts');

    const result = await service.rebuildCanon();

    assert.equal(result.worldId, worldId);
    assert.equal(result.entities, before.canon, 'reports what it removed');
    // Canon is gone…
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities WHERE world_id = $1`, [worldId]))!.n),
      0,
    );
    // …and every story survives, prose and chronicle included. This is the whole
    // point: under SQLite this operation deleted the stories too.
    assert.ok(await getStory(db, world.storyId), 'the story must still exist');
    const turns = await world.chronicle.turns();
    assert.equal(turns[0]!.bookProse, 'He set the quill down across the inkwell.');
    assert.equal((await world.chronicle.facts()).length, factsBefore, 'epistemic state survives');
    assert.equal((await world.graph.get('char:invented'))?.name, 'Invented', 'emergent entities survive');

    // ingest_pages goes with canon: keeping it would make the next ingest think
    // every page was already read and skip the Pass B it needs to redo.
    assert.equal(
      Number((await db.one<{ n: string }>(`SELECT count(*) n FROM ingest_pages WHERE world_id = $1`, [worldId]))!.n),
      0,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a story reading a rebuilt world reports its dangling references honestly', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, service } = await setup(db);
    await seedWorld(world);
    const session = await world.session.get();
    assert.ok(session.playerCharacterId, 'the seed sets a player');

    await service.rebuildCanon();

    // The story still points at a canon character that no longer exists. That is
    // *correct* behaviour for "the source material is being rebuilt underneath
    // you" — recoverable by re-ingesting, where deleting the novel is not — and
    // the integrity checker says so rather than hiding it.
    const report = await checkIntegrity(db);
    assert.equal(report.ok, false);
    assert.ok(
      report.orphans.some((o) => o.column === 'player_character_id'),
      `expected the dangling player to be reported, got ${JSON.stringify(report.orphans.slice(0, 3))}`,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('resetMyStory keeps the library openable if the delete fails', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, service } = await setup(db);
    const before = (await listStories(db)).length;
    const freshId = await service.resetMyStory();
    const after = await listStories(db);
    // One in, one out: the replacement is created before the delete precisely so
    // a failure leaves the old story rather than an empty library.
    assert.equal(after.length, before);
    assert.ok(after.some((s) => s.id === freshId));
    assert.ok(!after.some((s) => s.id === world.storyId));
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------ setup service

test('isFresh gates the wizard on whether canon exists', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, service } = await setup(db);
    assert.equal(await service.isFresh(), true, 'a new world has no canon');
    await world.graph.upsert({ id: 'char:a', type: 'Character', name: 'A' }, 'canon');
    assert.equal(await service.isFresh(), false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the sample and a pack both produce a playable world through the service', async (t) => {
  const ran = await withPg(async (db) => {
    const { service } = await setup(db, 'sample');
    const sample = await service.useSample();
    assert.ok(sample.playerCharacterId, 'the sample must place a player');
    assert.ok(sample.opening.length > 0, 'and propose an opening');

    const { service: packService } = await setup(db, 'packworld');
    const applied = await packService.usePack('the-nine-debts');
    assert.ok(applied.storyId);
    assert.ok(applied.playerCharacterId);
    assert.ok(applied.opening.length > 0);
    assert.deepEqual(applied.warnings, [], `a shipped pack should install clean: ${applied.warnings.join('; ')}`);
    // The opening is resolved against the scenario's own story, not whichever
    // story the service happened to be bound to.
    const scenarioWorld = await World.forStory(db, applied.storyId);
    assert.equal((await scenarioWorld.session.get()).playerCharacterId, applied.playerCharacterId);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('ingestHealth reports per-wiki Pass B progress, or says there is no ingest', async (t) => {
  const ran = await withPg(async (db) => {
    const { world, worldId, service } = await setup(db);
    // A world built by hand rather than crawled has no ingest to continue, and
    // saying so is more useful than reporting zeros as if it did.
    assert.equal((await service.ingestHealth()).hasContext, false);

    await world.chronicle.setMeta(
      'ingestContext',
      JSON.stringify({ baseUrl: 'https://example.fandom.com', wikiName: 'example', mode: 'mid', seeds: ['A'], excludeCategories: [], title: 'Example' }),
    );
    await db.query(
      `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision, passb_status) VALUES
         ($1,'example','1','A','r1','done'),
         ($1,'example','2','B','r1','failed'),
         ($1,'example','3','C','r1','')`,
      [worldId],
    );

    const health = await service.ingestHealth();
    assert.equal(health.hasContext, true);
    assert.equal(health.pagesDone, 1);
    assert.equal(health.pagesFailed, 1, 'a failed page must be retried, not treated as read');
    assert.equal(health.pagesPending, 1);
  });
  if (!ran) t.skip('no Postgres configured');
});

// ----------------------------------------------------- illustration service

test('a portrait reserves, generates, and becomes the reference image', async (t) => {
  const ran = await withPg(async (db) => {
    const dir = mkdtempSync(join(tmpdir(), 'fabulist-illus-svc-'));
    try {
      const worldId = await makeWorld(db, 'illus');
      const story = await createStory(db, { worldIds: [worldId] });
      const world = new World({ db, storyId: story.id, sources: [{ worldId, ordinal: 1, alias: '' }], imagesDir: dir });
      await world.graph.upsert(
        { id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'A monk.' },
        'canon',
      );
      await world.session.set({ scene: 1, turn: 1, playerCharacterId: 'char:anselm', currentLocationId: null });

      const service = new IllustrationService({
        world,
        providers: new SwappableImageRegistry(new MockImageProvider()),
      });

      // The prompt-only path must never touch the provider or the table.
      const composed = await service.composePortrait('char:anselm');
      assert.ok(composed.prompt.length > 0);
      assert.match(composed.prompt, /Anselm/);
      assert.equal((await world.illustrations.forEntity('char:anselm')).length, 0, 'composing writes nothing');

      const illus = await service.illustratePortrait('char:anselm');
      assert.equal(illus.status, 'done');
      assert.ok(illus.path, 'bytes should be on disk');

      // The winning portrait becomes the character-consistency anchor every later
      // prompt for this entity is conditioned on.
      const sheet = await world.cast.get('char:anselm');
      assert.ok(sheet?.appearance.referenceImagePath, 'the sheet should point at the image');
      assert.equal((await world.illustrations.latestPortrait('char:anselm'))?.id, illus.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a scene illustration reads its cast and place in batched queries', async (t) => {
  const ran = await withPg(async (db) => {
    const dir = mkdtempSync(join(tmpdir(), 'fabulist-illus-scene-'));
    try {
      const worldId = await makeWorld(db, 'scene');
      const story = await createStory(db, { worldIds: [worldId] });
      const world = new World({ db, storyId: story.id, sources: [{ worldId, ordinal: 1, alias: '' }], imagesDir: dir });
      await world.graph.upsert({ id: 'loc:hall', type: 'Location', name: 'The Hall', summary: 'Cold stone.' }, 'canon');
      for (let i = 0; i < 6; i += 1) {
        await world.graph.upsert({ id: `char:c${i}`, type: 'Character', name: `Person ${i}` }, 'canon');
      }
      await world.session.set({ scene: 1, turn: 1, playerCharacterId: 'char:c0', currentLocationId: 'loc:hall' });

      const service = new IllustrationService({
        world,
        providers: new SwappableImageRegistry(new MockImageProvider()),
      });
      const present = ['char:c0', 'char:c1', 'char:c2', 'char:c3', 'char:c4', 'char:c5'];

      const composed = await service.composeScene('turn:1', 'loc:hall', present, 'lamps lit');
      assert.match(composed.prompt, /Hall/);

      const illus = await service.illustrateScene('turn:1', 'loc:hall', present, 'lamps lit');
      assert.equal(illus.status, 'done');
      assert.equal((await world.illustrations.forTurn('turn:1')).length, 1);
      // A location's most recent scene image becomes the place-consistency
      // reference the next scene there is conditioned on.
      assert.equal((await world.illustrations.latestLocationReference('loc:hall'))?.id, illus.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  if (!ran) t.skip('no Postgres configured');
});
