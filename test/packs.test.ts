/**
 * Pack guardrails.
 *
 * These tests exist because four large hand-authored worlds are exactly the kind
 * of asset that rots silently. A pack has no compiler to tell it that a focus
 * map points at an entity somebody renamed, or that a thread lost its second
 * resolution in an edit, or that every entity ended up at the same salience and
 * the Narrator is therefore reading an alphabetical slice of the world. Every
 * assertion below is a mistake that was cheap to make and expensive to notice
 * while playing.
 *
 * The parameterised block runs against every registered pack, so a fifth world
 * inherits the whole suite by being added to `PACKS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { CurrentStory, World } from '../src/store/index.ts';
import { PACKS, danglingIds, installPack, lintPack, packSummaries } from '../src/packs/index.ts';
import { SALIENCE } from '../src/packs/types.ts';
import { isKnownPredicate, PREDICATES, stanceForPredicate } from '../src/packs/predicates.ts';
import { buildNarratorFrame } from '../src/frame/builders.ts';
import { HeuristicTokenizer } from '../src/frame/tokenizer.ts';
import { SetupService } from '../src/setup/service.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';

test('there is at least one pack registered', () => {
  assert.ok(PACKS.length >= 1);
});

for (const pack of PACKS) {
  test(`${pack.id}: lints clean`, () => {
    const problems = lintPack(pack);
    assert.deepEqual(problems, [], `\n  - ${problems.join('\n  - ')}`);
  });

  test(`${pack.id}: no dangling entity references`, () => {
    assert.deepEqual(danglingIds(pack), []);
  });

  test(`${pack.id}: installs without warnings`, () => {
    const world = World.open(':memory:');
    const result = installPack(world, pack);
    assert.deepEqual(result.warnings, [], `\n  - ${result.warnings.join('\n  - ')}`);
    assert.equal(result.entities, pack.entities.length);
    assert.equal(result.scenarios.length, pack.scenarios.length);
  });

  test(`${pack.id}: salience is tiered, not flat`, () => {
    // A cheap smoke test for authored intent. The real invariant is asserted per
    // scenario below — this only catches a pack that forgot tiers entirely.
    const tiers = new Set(pack.entities.map((e) => e.tier ?? 'supporting'));
    assert.ok(tiers.size >= 2, `only ${tiers.size} distinct tier(s) across ${pack.entities.length} entities`);
  });

  test(`${pack.id}: every edge predicate is in the vocabulary`, () => {
    const unknown = [...new Set(pack.edges.map((e) => e.predicate.toUpperCase()))].filter((p) => !isKnownPredicate(p));
    assert.deepEqual(unknown, [], `unknown predicates carry no consequences: ${unknown.join(', ')}`);
  });

  test(`${pack.id}: the social graph can actually propagate`, () => {
    // An edge whose predicate has no stance is invisible to
    // `consequence/propagate.ts`. A pack made entirely of structural edges would
    // pass every other check here and produce a world where nothing reacts.
    const live = pack.edges.filter((e) => stanceForPredicate(e.predicate) !== null);
    assert.ok(
      live.length >= pack.edges.length * 0.4,
      `only ${live.length} of ${pack.edges.length} edges carry a propagation stance`,
    );
  });

  for (const scenario of pack.scenarios) {
    test(`${pack.id}/${scenario.id}: opens playable`, () => {
      const world = World.open(':memory:');
      const result = installPack(world, pack);
      const installed = result.scenarios.find((s) => s.id === scenario.id);
      assert.ok(installed, 'scenario was not installed');

      const w = world.withStory(installed.storyId);
      const session = w.session.get();
      assert.equal(session.playerCharacterId, scenario.playerCharacterId);
      assert.equal(session.currentLocationId, scenario.openingLocationId);
      assert.equal(session.scene, 1);

      // The integrity gate is the engine's most distinctive feature and it reads
      // the player's contract. A scenario whose player has no vows disables it.
      const player = w.cast.player();
      assert.ok(player, 'no sheet is flagged isPlayer');
      assert.equal(player.entityId, scenario.playerCharacterId);
      assert.ok(player.contract.vows.length >= 1, 'player has no vows');

      // Slow half from canon, fast half from the scenario: the whole point of
      // the split. A player with a voice but no location proves canon was
      // inherited; a location proves the overlay was applied.
      assert.ok(player.voice.diction.length > 0, 'player inherited no voice from canon');
      assert.equal(player.condition.locationId, scenario.openingLocationId);

      assert.ok(w.threads.open().length >= 2, 'fewer than two open threads');
      assert.ok(w.chronicle.facts().length >= 1, 'no facts');
    });

    test(`${pack.id}/${scenario.id}: the top salience band is chosen, not alphabetical`, () => {
      // This is the real guard, and it replaces counting tier names.
      //
      // `frame/builders.ts` takes `list({ limit: 40, minSalience: 0.2 })` and
      // slices to twelve, and `graph.list` orders by `salience DESC, name ASC`.
      // So if more than twelve entities share the top salience, the tie-break
      // decides which the Narrator sees — alphabetically, by first letter of the
      // name. That is exactly the defect in the ingested wiki save in this repo,
      // where 3,636 of 3,643 entities sat at one value and the window read
      // "2175 Aeia, 2181 Arion, A Batarian Army".
      //
      // Two claims: the top band fits inside the window, and most of the window
      // is what this scenario actually asked for rather than baseline spill.
      const world = World.open(':memory:');
      const result = installPack(world, pack);
      const installed = result.scenarios.find((s) => s.id === scenario.id);
      assert.ok(installed);
      const w = world.withStory(installed.storyId);

      const ranked = w.graph.list({ limit: 40, minSalience: 0.2 });
      assert.ok(ranked.length > 0, 'nothing clears the frame floor');

      const topSalience = ranked[0]?.salience;
      const atTop = ranked.filter((e) => e.salience === topSalience);
      assert.ok(
        atTop.length <= 12,
        `${atTop.length} entities tie at the top salience, so the frame picks between them by name`,
      );

      const focused = new Set(Object.keys(scenario.focus ?? {}));
      const chosen = ranked.slice(0, 12).filter((e) => focused.has(e.id)).length;
      assert.ok(
        chosen >= 6,
        `only ${chosen} of the Narrator's twelve entities were chosen by this scenario; the rest are baseline spill`,
      );
      world.close();
    });

    test(`${pack.id}/${scenario.id}: the frame shows people, not an alphabetical slice`, () => {
      // The end-to-end version of the salience test: build the real Narrator
      // frame and assert the cast actually reaches it. This is the check that
      // would have caught the ingested save whose window was "2175 Aeia,
      // 2181 Arion, A Batarian Army".
      const world = World.open(':memory:');
      const result = installPack(world, pack);
      const installed = result.scenarios.find((s) => s.id === scenario.id);
      assert.ok(installed);
      const w = world.withStory(installed.storyId);

      const frame = buildNarratorFrame({
        world: w,
        session: w.session.get(),
        budget: 28_000,
        tokenizer: new HeuristicTokenizer(),
        rawInput: 'i look around',
      });

      const present = frame.slots.find((s) => s.name === 'present-cast');
      assert.ok(present && present.content.trim().length > 0, 'present-cast slot is empty');

      // The player is present by construction; the interesting claim is that
      // somebody else is too, because an ensemble is what co-located conditions
      // are for.
      const playerName = pack.entities.find((e) => e.id === scenario.playerCharacterId)?.name ?? '';
      assert.ok(present.content.includes(playerName), 'player missing from present-cast');

      const others = (scenario.conditions ?? []).filter(
        (c) => c.entityId !== scenario.playerCharacterId && c.locationId === scenario.openingLocationId,
      );
      for (const other of others) {
        const name = pack.entities.find((e) => e.id === other.entityId)?.name ?? '';
        assert.ok(present.content.includes(name), `${name} shares the opening location but is not on stage`);
      }
    });
  }
}

test('pack summaries name the player character rather than leaking an id', () => {
  for (const summary of packSummaries()) {
    for (const scenario of summary.scenarios) {
      assert.ok(!scenario.playerName.includes(':'), `${summary.id}/${scenario.id} exposes a raw id`);
      assert.ok(scenario.playerName.length > 0);
    }
  }
});

test('the predicate vocabulary has no duplicates and every stance is valid', () => {
  const seen = new Set<string>();
  for (const p of PREDICATES) {
    assert.ok(!seen.has(p.predicate), `duplicate predicate ${p.predicate}`);
    seen.add(p.predicate);
    assert.equal(p.predicate, p.predicate.toUpperCase(), 'predicates are upper snake case');
    assert.ok(p.note.trim().length > 0, `${p.predicate} has no note`);
  }
});

test('stanceForPredicate still resolves ingest-invented predicates by pattern', () => {
  // Wiki ingest derives predicates from arbitrary infobox field names, so the
  // regex fallback has to survive the introduction of the table. These are not
  // in `PREDICATES` and must still resolve exactly as they did before.
  assert.equal(stanceForPredicate('IS_KIN_TO_SOMEONE'), 'kin');
  assert.equal(stanceForPredicate('deals_with_partner'), 'factional');
  assert.equal(stanceForPredicate('TOTALLY_UNKNOWN_THING'), null);
});

test('background tier sits below the frame floor, focal above it', () => {
  // `frame/builders.ts` filters on `minSalience: 0.2`. Background entities are
  // meant to exist for the Referee and cost no frame budget; if this inverts,
  // packs silently start paying for their own scenery.
  assert.ok(SALIENCE.background < 0.2);
  assert.ok(SALIENCE.supporting > 0.2);
  assert.ok(SALIENCE.focal > SALIENCE.principal);
  assert.ok(SALIENCE.principal > SALIENCE.supporting);
});

// ------------------------------------------------------------------- service

/**
 * The first registered pack, narrowed. `PACKS` is an array, and the project
 * compiles with checked indexed access, so every test that reaches for a
 * specific pack or scenario needs this rather than a non-null assertion.
 */
function firstPack() {
  const pack = PACKS[0];
  assert.ok(pack, 'no packs registered');
  const first = pack.scenarios[0];
  const last = pack.scenarios[pack.scenarios.length - 1];
  assert.ok(first && last, `${pack.id} has no scenarios`);
  return { pack, first, last };
}

test('usePack installs a pack and returns the chosen scenario’s story', () => {
  const world = World.open(':memory:');
  const setup = new SetupService({ world, providers: new ProviderRegistry(new MockProvider()) });
  const { pack, last: wanted } = firstPack();

  const result = setup.usePack(pack.id, wanted.id);

  assert.equal(result.scenarioId, wanted.id);
  assert.equal(result.playerCharacterId, wanted.playerCharacterId);
  assert.equal(result.scenarios.length, pack.scenarios.length);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.opening.length > 0, 'no opening was proposed');

  // The returned id must actually resolve to a story configured for that
  // scenario — the whole reason this method returns one instead of assuming the
  // caller is already bound to the right place.
  const w = world.withStory(result.storyId);
  assert.equal(w.session.get().playerCharacterId, wanted.playerCharacterId);
  assert.equal(w.session.get().currentLocationId, wanted.openingLocationId);
  world.close();
});

test('usePack defaults to the first scenario and rejects unknown ids', () => {
  const world = World.open(':memory:');
  const setup = new SetupService({ world, providers: new ProviderRegistry(new MockProvider()) });
  const { pack, first } = firstPack();

  assert.equal(setup.usePack(pack.id).scenarioId, first.id);
  assert.throws(() => setup.usePack('no-such-pack'), /no such world pack/);
  assert.throws(() => setup.usePack(pack.id, 'no-such-scenario'), /no scenario/);
  world.close();
});

test('every scenario of every pack installs into a distinct story', () => {
  // Canon is shared and scenarios are chronicle overlays, so the failure mode to
  // rule out is two scenarios landing on the same story row and overwriting each
  // other's threads, facts and salience.
  for (const pack of PACKS) {
    const world = World.open(':memory:');
    const result = installPack(world, pack);
    const storyIds = new Set(result.scenarios.map((s) => s.storyId));
    assert.equal(storyIds.size, result.scenarios.length, `${pack.id}: scenarios share a story`);

    // And each overlay must be independent: the same canon entity may be focal
    // in one scenario and background in another.
    for (const s of result.scenarios) {
      const w = world.withStory(s.storyId);
      assert.equal(w.session.get().playerCharacterId, s.playerCharacterId);
    }
    world.close();
  }
});

test('POST /api/setup/pack rebinds the server to the scenario’s story', async () => {
  // The bug this guards against is the one `POST /api/setup/reset` documents: a
  // pack install creates several stories, so a server left bound to the story
  // the file opened with would answer the next request from the wrong overlay.
  const world = World.open(':memory:');
  const currentStory = new CurrentStory(world.db, world.storyId);
  const setup = new SetupService({
    world: () => currentStory.world(),
    providers: new ProviderRegistry(new MockProvider()),
  });
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world: () => currentStory.world(), engine, setup, currentStory });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const listed = await fetch(`${base}/api/setup/packs`).then((r) => r.json() as Promise<{ packs: unknown[] }>);
    assert.ok(listed.packs.length >= 1);

    const pack = PACKS[0];
    const wanted = pack?.scenarios[pack.scenarios.length - 1];
    assert.ok(pack && wanted);
    const res = await fetch(`${base}/api/setup/pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packId: pack.id, scenarioId: wanted.id }),
    });
    assert.equal(res.status, 200);
    const installed = (await res.json()) as { storyId: string; playerCharacterId: string };

    assert.equal(currentStory.world().storyId, installed.storyId, 'server was not rebound');
    assert.equal(currentStory.world().session.get().playerCharacterId, wanted.playerCharacterId);

    const bad = await fetch(`${base}/api/setup/pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
});

// ------------------------------------------------------------- playability

test('every scenario can actually take a turn through the engine', async () => {
  // Installing and framing correctly is necessary but not sufficient: this is
  // the check that a pack world *plays*. It runs one real turn per scenario on
  // the deterministic mock provider, which exercises the whole loop — intent,
  // integrity gate, referee, narrator, delta validation, commit — against
  // authored canon rather than the one seed world the rest of the suite uses.
  for (const pack of PACKS) {
    for (const scenario of pack.scenarios) {
      const world = World.open(':memory:');
      const installed = installPack(world, pack).scenarios.find((s) => s.id === scenario.id);
      assert.ok(installed, `${pack.id}/${scenario.id} did not install`);

      const w = world.withStory(installed.storyId);
      const engine = new Engine({ world: w, providers: new ProviderRegistry(new MockProvider()) });
      const out = await engine.takeTurn('i look around and take stock of the room');

      assert.equal(out.kind, 'narrated', `${pack.id}/${scenario.id}: turn did not narrate`);
      if (out.kind !== 'narrated') {
        world.close();
        continue;
      }
      assert.ok(out.prose.length > 0, `${pack.id}/${scenario.id}: no prose`);
      // Prose without a delta is drift — the central invariant of the engine.
      assert.ok(out.delta.events.length > 0, `${pack.id}/${scenario.id}: prose with no delta`);
      assert.equal(w.chronicle.events().length, out.delta.events.length);
      world.close();
    }
  }
});

test('a pack scenario’s integrity gate fires on its own player vow', async () => {
  // The gate is the engine's signature feature and it reads the player's
  // contract, which packs author in canon. If a pack's vows were not reaching
  // the gate, every scenario would silently play as though the character had no
  // lines they would not cross — the failure would look like nothing at all.
  const { pack, first } = firstPack();
  const world = World.open(':memory:');
  const installed = installPack(world, pack).scenarios.find((s) => s.id === first.id);
  assert.ok(installed);

  const w = world.withStory(installed.storyId);
  const vow = w.cast.player()?.contract.vows[0];
  assert.ok(vow, 'player has no vow to test against');

  // Deliberately at odds with the player's ranked vows. What is asserted is that
  // the gate *ran against the authored contract* — the verdict is recorded on the
  // turn either way. Asserting a particular ruling would be asserting the mock
  // provider's judgement, not that packs are wired to the gate.
  const engine = new Engine({ world: w, providers: new ProviderRegistry(new MockProvider()) });
  const out = await engine.takeTurn('i draw a blade and kill the nearest person');

  if (out.kind === 'interrupted') {
    assert.ok(out.interrupt.options.length > 0, 'an interrupt with no options is a dead end');
    // The override must always exist: an author has to be able to break their own
    // character on purpose, and the gate exists to make it cost something.
    assert.ok(out.interrupt.options.some((o) => o.effect === 'override'));
  } else {
    assert.equal(out.kind, 'narrated');
    if (out.kind !== 'narrated') return;
    const verdict = out.turn.meta.integrity;
    assert.ok(verdict, 'the integrity gate left no verdict, so it never saw the contract');
    assert.ok(verdict.distance.length > 0);
  }
  world.close();
});
