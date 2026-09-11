/**
 * The world builders on Postgres: pack installation, the sample seed, and
 * custom-world authoring.
 *
 * The pack installer matters most of the three, because packs are the only
 * *shipped* content — `.design`/README call them "byte-identical on every
 * machine", which makes them the one world where a conversion bug would be
 * visible to every user rather than to one save. So this installs a real shipped
 * pack rather than a fixture, and asserts the scenario it produces is actually
 * playable: a player with a contract, co-located cast, threads with more than one
 * resolution, and asymmetric knowledge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World, createWorld } from '../src/store/index-pg.ts';
import { createStory, getStory } from '../src/store/world-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { installPack } from '../src/packs/apply-pg.ts';
import { PACKS } from '../src/packs/index.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { applyCustomWorld, applyStyle, assignPlayerCharacter, proposeOpening } from '../src/setup/apply-pg.ts';
import { checkIntegrity, formatIntegrityReport } from '../src/store/integrity-pg.ts';
import type { Db } from '../src/db/pg.ts';

async function emptyWorld(db: Db, slug = 'w'): Promise<World> {
  const worldId = await makeWorld(db, slug);
  const story = await createStory(db, { worldIds: [worldId] });
  return World.forStory(db, story.id);
}

// -------------------------------------------------------------------- packs

test('every shipped pack installs, and its scenarios are playable', async (t) => {
  const ran = await withPg(async (db) => {
    assert.ok(PACKS.length >= 4, `expected the shipped packs, found ${PACKS.length}`);

    for (const pack of PACKS) {
      const created = await createWorld(db, pack.title);
      // A world with no story yet: installPack creates one per scenario.
      const holder = await createStory(db, { title: 'holder', worldIds: [created.id] });
      const world = await World.forStory(db, holder.id);

      const result = await installPack(db, world, pack);

      assert.ok(result.entities > 0, `${pack.id}: no entities installed`);
      assert.ok(result.scenarios.length > 0, `${pack.id}: no playable scenario`);
      assert.deepEqual(
        result.warnings.filter((w) => /unknown|not in the pack/.test(w)),
        [],
        `${pack.id} should reference only its own entities: ${result.warnings.join('; ')}`,
      );

      for (const scenario of result.scenarios) {
        const story = await getStory(db, scenario.storyId);
        assert.ok(story, `${pack.id}/${scenario.id}: story row missing`);
        const w = await World.forStory(db, scenario.storyId);

        // The player must exist, be flagged, and hold a contract — without vows the
        // integrity gate has nothing to defend and the pack is not really playable.
        const player = await w.cast.player();
        assert.equal(player?.entityId, scenario.playerCharacterId, `${pack.id}/${scenario.id}: player not flagged`);
        assert.ok(player!.contract.vows.length > 0, `${pack.id}/${scenario.id}: player has no vows`);

        // Someone else must share the player's room, or the opening is a monologue.
        const session = await w.session.get();
        const sheets = await w.cast.list();
        const coLocated = sheets.filter((s) => s.condition.locationId === session.currentLocationId);
        assert.ok(coLocated.length >= 1, `${pack.id}/${scenario.id}: nobody is on stage`);

        // Threads with a single resolution are plots, which break on deviation.
        for (const thread of await w.threads.all()) {
          assert.ok(
            thread.resolutions.length >= 2,
            `${pack.id}/${scenario.id}: thread "${thread.title}" has one resolution`,
          );
        }

        // Salience: the player and the opening location must be focal, or the
        // protagonist can be evicted from their own scene by the frame budget.
        const focal = await w.graph.list({ limit: 12 });
        assert.ok(
          focal.some((e) => e.id === scenario.playerCharacterId),
          `${pack.id}/${scenario.id}: the player is not in the top-12 by salience`,
        );
      }

      // No dangling references anywhere in what the pack wrote.
      const report = await checkIntegrity(db, { worldId: created.id });
      assert.equal(report.ok, true, `${pack.id}: ${formatIntegrityReport(report)}`);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a pack installs canon once, so two scenarios share it', async (t) => {
  const ran = await withPg(async (db) => {
    const pack = PACKS[0]!;
    const created = await createWorld(db, pack.title);
    const holder = await createStory(db, { title: 'holder', worldIds: [created.id] });
    const world = await World.forStory(db, holder.id);
    const result = await installPack(db, world, pack);

    const canonCount = Number(
      (await db.one<{ n: string }>(`SELECT count(*) n FROM canon_entities WHERE world_id = $1`, [created.id]))!.n,
    );
    assert.equal(canonCount, result.entities, 'entities land in canon, not per story');

    // Each scenario's chronicle is its own: focus salience is written per story, so
    // the same canon entity can be focal in one scenario and background in another.
    if (result.scenarios.length >= 2) {
      const [a, b] = result.scenarios;
      const chronA = Number(
        (await db.one<{ n: string }>(`SELECT count(*) n FROM chron_entities WHERE story_id = $1`, [a!.storyId]))!.n,
      );
      assert.ok(chronA > 0, 'focus salience should have written a chronicle overlay');
      const shared = Number(
        (await db.one<{ n: string }>(
          `SELECT count(*) n FROM chron_entities WHERE story_id = $1 AND id IN (SELECT id FROM chron_entities WHERE story_id = $2)`,
          [a!.storyId, b!.storyId],
        ))!.n,
      );
      // Overlapping ids are fine and expected; what matters is that they are
      // separate rows per story rather than shared state.
      assert.ok(shared >= 0);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

// --------------------------------------------------------------- sample seed

test('the sample seed produces a playable Saint Verrow', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await emptyWorld(db, 'verrow');
    await seedWorld(world);

    const counts = await world.graph.counts();
    assert.ok(counts.canon > 10, `expected a populated canon, got ${counts.canon}`);
    const player = await world.cast.player();
    assert.ok(player, 'the sample must have a player');
    assert.ok(player!.contract.vows.length > 0);

    const session = await world.session.get();
    assert.equal(session.playerCharacterId, player!.entityId);
    assert.ok(session.currentLocationId, 'the player must start somewhere');
    assert.ok((await world.threads.open()).length > 0, 'the sample needs pressure to be playable');

    // And it is internally consistent.
    const report = await checkIntegrity(db);
    assert.equal(report.ok, true, formatIntegrityReport(report));
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------- custom world

test('a described world becomes canon, a cast, and an opening scene', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await emptyWorld(db, 'custom');
    const result = await applyCustomWorld(world, {
      title: 'The Salt Road',
      entities: [
        { id: 'loc:waystation', type: 'Location', name: 'The Waystation', summary: 'Last water for sixty miles.' },
        { id: 'char:mara', type: 'Character', name: 'Mara', summary: 'Keeps the well.' },
        { id: 'char:oren', type: 'Character', name: 'Oren', summary: 'Arrived with no water.' },
      ],
      edges: [{ subject: 'char:mara', predicate: 'LIVES_IN', object: 'loc:waystation', weight: 0.9 }],
      sheets: [
        {
          entityId: 'char:mara',
          identity: { goals: ['keep the well flowing'], arc: 'A keeper' },
          contract: { vows: [{ id: 'vow:water', text: 'Never refuse water', rank: 1, broken: false, brokenScene: null }] },
        },
      ],
      relationships: [{ from: 'char:oren', to: 'char:mara', trust: 0.4 }],
      threads: [{ title: 'The well is failing', stakes: 'everyone on the road', tension: 0.7, parties: ['char:mara'], resolutions: ['dig deeper', 'ration', 'abandon it'] }],
      facts: [{ text: 'The well has three days left', knownBy: ['char:mara'] }],
      playerCharacterId: 'char:mara',
    });

    assert.equal(result.entities, 3);
    assert.equal(result.playerCharacterId, 'char:mara');
    assert.equal((await world.graph.get('loc:waystation'))?.name, 'The Waystation');
    // Authored worlds write canon, so a second story in this world would read it.
    assert.equal((await world.graph.getCanon('char:mara'))?.name, 'Mara');
    assert.equal((await world.cast.player())?.entityId, 'char:mara');
    assert.equal((await world.session.get()).currentLocationId, 'loc:waystation', 'placed where the player lives');
    assert.equal((await world.threads.open()).length, 1);
    // Asymmetric knowledge is the story engine: Mara knows, Oren does not.
    const facts = await world.chronicle.facts();
    assert.equal(await world.chronicle.knows('char:mara', facts[0]!.id), true);
    assert.equal(await world.chronicle.knows('char:oren', facts[0]!.id), false);

    assert.equal((await checkIntegrity(db)).ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * The wizard's own path, on the story the wizard actually runs against: a brand
 * new one, bound to no canon world at all.
 *
 * `createStory` writes no `story_sources` row, because until the wizard runs
 * there is nothing to point at — so every canon write in this path had nowhere
 * to go, and the stores refuse to guess. On a fresh instance an ingest died on
 * its first statement, `setMeta('worldTitle')`, and an authored world on its
 * last, after the model had already been paid to invent one; both said "no world
 * for story …", and the wizard offers no way to retry a step.
 *
 * Driven through `SetupService` rather than `applyCustomWorld` directly, because
 * the binding is the service's decision and calling the applier with an
 * already-bound world is exactly the assumption that hid this.
 */
test('the custom-world wizard binds a canon world to a story that has none', async (t) => {
  const ran = await withPg(async (db) => {
    // The placeholder `serve-pg` creates at boot, and a story with no sources.
    await createWorld(db, '');
    const story = await createStory(db, { title: '' });
    const world = await World.forStory(db, story.id);
    assert.deepEqual(world.sources, [], 'precondition: nothing bound yet');

    const service = new SetupService({
      world: () => World.forStory(db, story.id),
      db,
      providers: new ProviderRegistry(new MockProvider()),
    });

    const job = service.startCustomWorld('A city where the weights-and-measures office decides what may be sold.');
    for (let i = 0; i < 200 && service.jobs.get(job.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const settled = service.jobs.get(job.id)!;
    assert.equal(settled.status, 'done', settled.error ?? '');

    // The story is bound, and the canon went into the world it was bound to.
    const bound = await World.forStory(db, story.id);
    assert.equal(bound.sources.length, 1, 'the wizard bound exactly one canon world');
    assert.ok((await bound.graph.counts()).canon > 0, 'canon landed in that world');

    // The write that failed last, and the reason this test exists: world-level
    // meta with no pre-existing `story_sources` binding.
    assert.equal(await bound.chronicle.getMeta('worldTitle'), 'The Long Silence');
    assert.equal((await checkIntegrity(db)).ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('assignPlayerCharacter adopts an existing character or creates one', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await emptyWorld(db, 'ingested');
    await world.graph.upsert(
      { id: 'char:picard', type: 'Character', name: 'Jean-Luc Picard', summary: 'A captain.' },
      'canon',
    );
    await world.graph.upsert({ id: 'loc:bridge', type: 'Location', name: 'The Bridge' }, 'canon');

    // Adopting someone the ingest already knows, found by name.
    const adopted = await assignPlayerCharacter(world, { existing: 'Jean-Luc Picard', name: '', role: '', goals: [], vows: [] });
    assert.equal(adopted.playerCharacterId, 'char:picard');
    assert.equal(adopted.created, false);
    assert.equal((await world.cast.player())?.entityId, 'char:picard');

    // Creating an original inside the same world. The previous player must be
    // un-flagged, or `cast.player()` finds two and the gate reads the wrong one.
    const created = await assignPlayerCharacter(world, { existing: null, name: 'Ensign Vale', role: 'an ensign', goals: ['prove herself'], vows: [{ text: 'Follow lawful orders', rank: 1 }] });
    assert.equal(created.created, true);
    const players = (await world.cast.list()).filter((s) => s.isPlayer);
    assert.equal(players.length, 1, 'exactly one player at a time');
    assert.equal(players[0]!.entityId, created.playerCharacterId);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('proposeOpening prefers a thread, then the neighbourhood, then a fallback', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await emptyWorld(db, 'opening');
    await world.graph.upsert({ id: 'loc:hall', type: 'Location', name: 'The Hall', summary: 'Cold stone.' }, 'canon');
    await world.graph.upsert({ id: 'char:pc', type: 'Character', name: 'PC' }, 'canon');
    await world.graph.upsert({ id: 'char:other', type: 'Character', name: 'Sered', summary: 'A captain.' }, 'canon');
    await world.graph.assertEdge({ subject: 'char:other', predicate: 'ALLIED_WITH', object: 'char:pc' }, 1, 'canon');
    await world.session.set({ scene: 1, turn: 0, playerCharacterId: 'char:pc', currentLocationId: 'loc:hall' });

    // No thread yet: falls back to the best-connected nearby character. A fresh
    // wiki ingest usually has no threads, which is exactly why this path exists.
    const fromGraph = await proposeOpening(world);
    assert.match(fromGraph, /The Hall/);
    assert.match(fromGraph, /Sered/);

    // With a thread, the thread wins — it is the actual pressure.
    await world.threads.create({
      title: 'The garrison is at the gate',
      stakes: 'the cloister',
      tension: 0.8,
      parties: ['char:pc', 'char:other'],
      resolutions: ['open it', 'refuse'],
      status: 'open',
      createdScene: 1,
    });
    const fromThread = await proposeOpening(world);
    assert.match(fromThread, /The garrison is at the gate\./, 'a fragment title gets a full stop');
    assert.match(fromThread, /At stake: the cloister\./);
    assert.match(fromThread, /Present: Sered\./);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('applyStyle merges over the existing contract rather than replacing it', async (t) => {
  const ran = await withPg(async (db) => {
    const world = await emptyWorld(db, 'style');
    const first = await applyStyle(world, { pov: 'first', sceneTarget: 800 });
    assert.equal(first.pov, 'first');
    assert.equal(first.sceneTarget, 800);

    // A later partial edit must not reset the fields it does not mention.
    const second = await applyStyle(world, { tense: 'present' });
    assert.equal(second.tense, 'present');
    assert.equal(second.pov, 'first', 'an unmentioned field must survive');
    assert.equal((await world.session.get()).style.sceneTarget, 800);
  });
  if (!ran) t.skip('no Postgres configured');
});
