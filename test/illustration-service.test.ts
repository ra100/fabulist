/**
 * Illustration store and service integration tests. Exercises the full
 * pipeline — compose, generate against the mock, persist, update appearance
 * — with no network and no real image provider, mirroring how
 * `test/providers.test.ts` exercises text providers against injected fetchers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../src/store/index.ts';
import { IllustrationService } from '../src/illustration/service.ts';
import { MockImageProvider } from '../src/providers/mockImage.ts';
import type { ImageProvider } from '../src/providers/image.ts';

const TMP_IMAGES = join('data', '.test-images-illustration');

function fresh() {
  rmSync(TMP_IMAGES, { recursive: true, force: true });
  const world = World.open(':memory:', undefined, TMP_IMAGES);
  world.graph.upsert({ id: 'char:anselm', type: 'Character', name: 'Brother Anselm', summary: 'A monk.' }, 'canon');
  world.graph.upsert({ id: 'loc:scriptorium', type: 'Location', name: 'The Scriptorium', summary: 'Long room, north light.' }, 'canon');
  world.cast.put({
    entityId: 'char:anselm',
    identity: { goals: [], wounds: [], fears: [], allegiances: [], competencies: [], secrets: [], arc: '' },
    contract: { vows: [], drives: [], breakingPoint: '', costOfBreak: '' },
    voice: { diction: '', tics: [], samples: [], never: [] },
    condition: { locationId: 'loc:scriptorium', mood: '', injuries: [], inventory: [], intent: '', presentWith: [] },
    appearance: { description: 'Lean, grey-haired, ink-stained hands.', attire: 'undyed wool habit', markers: [], referenceImagePath: null, seed: null },
    locks: [],
    isPlayer: true,
  }, 'canon');
  return world;
}

function serviceWith(provider: ImageProvider | null, world: World) {
  return new IllustrationService({ world, providers: { get: () => provider } });
}

test.after(() => rmSync(TMP_IMAGES, { recursive: true, force: true }));

test('illustrating a portrait writes a real file and sets the appearance reference', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);

  const illus = await svc.illustratePortrait('char:anselm');
  assert.equal(illus.status, 'done');
  assert.ok(illus.path);

  const abs = world.illustrations.absolutePath(illus)!;
  assert.ok(existsSync(abs), 'the image file actually exists on disk');

  const sheet = world.cast.get('char:anselm')!;
  assert.equal(sheet.appearance.referenceImagePath, abs, 'the sheet now points at the generated image');
  assert.equal(sheet.appearance.seed, illus.seed, 'the seed used is recorded for reuse');
  world.close();
});

test('regenerating a portrait reuses the previous seed when the provider supports seed control', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);

  const first = await svc.illustratePortrait('char:anselm');
  const second = await svc.illustratePortrait('char:anselm');

  assert.equal(mock.calls[1]?.seed, first.seed, 'the second call was asked to reuse the first seed');
  assert.equal(second.seed, first.seed, 'the mock honoured the seed it was given');
  world.close();
});

test('the composed prompt for a portrait reaches the provider intact', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);

  await svc.illustratePortrait('char:anselm');
  assert.match(mock.calls[0]!.prompt, /Brother Anselm/);
  assert.match(mock.calls[0]!.prompt, /Lean, grey-haired/);
  world.close();
});

test('illustrating with no image provider configured throws a distinguishable error', async () => {
  const world = fresh();
  const svc = serviceWith(null, world);
  await assert.rejects(() => svc.illustratePortrait('char:anselm'), /no image provider/);
  world.close();
});

test('illustrating an unknown entity fails cleanly, before any provider call', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);
  await assert.rejects(() => svc.illustratePortrait('char:nobody'), /no such entity/);
  assert.equal(mock.calls.length, 0, 'the provider was never called');
  world.close();
});

test('a provider failure is recorded on the illustration row rather than thrown past the caller unrecorded', async () => {
  const world = fresh();
  const failing: ImageProvider = {
    id: 'failing', model: 'x',
    capabilities: { imageConditioning: false, seedControl: false, costTier: 'free', qualityTier: 0 },
    generate: async () => { throw new Error('the model server is down'); },
  };
  const svc = serviceWith(failing, world);
  const illus = await svc.illustratePortrait('char:anselm');
  assert.equal(illus.status, 'failed');
  assert.match(illus.error ?? '', /model server is down/);
  world.close();
});

test('a scene illustration is conditioned on every present character, restated the same way a portrait would be', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);

  const turn = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'i copy the page', intent: null,
    delta: { events: [{ text: 'He copies the page.', participants: ['char:anselm'], locationId: 'loc:scriptorium', significance: 0.3 }], entityUpserts: [], edgeAsserts: [], edgeRetires: [], conditionUpdates: [], relationshipUpdates: [], factsLearned: [], threadUpdates: [], vowBreaks: [], sceneAdvance: false },
    bookProse: 'He copies the page in silence.', pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });

  const illus = await svc.illustrateScene(turn.id, 'loc:scriptorium', ['char:anselm'], 'He copies the page.');
  assert.equal(illus.status, 'done');
  assert.match(mock.calls[0]!.prompt, /The Scriptorium/);
  assert.match(mock.calls[0]!.prompt, /Brother Anselm/);
  assert.match(mock.calls[0]!.prompt, /Lean, grey-haired/, 'the same durable appearance a portrait would use');

  const forTurn = world.illustrations.forTurn(turn.id);
  assert.equal(forTurn.length, 1);
  assert.equal(forTurn[0]!.id, illus.id);
  world.close();
});

test('a scene at a location with a prior illustration is offered that image as a reference, when the provider can condition on one', async () => {
  const world = fresh();
  const mock = new MockImageProvider(); // imageConditioning: true by default
  const svc = serviceWith(mock, world);

  const turn1 = world.chronicle.addTurn({
    scene: 1, turn: 1, rawInput: 'a', intent: null, delta: null, bookProse: '', pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  await svc.illustrateScene(turn1.id, 'loc:scriptorium', [], 'first pass');

  const turn2 = world.chronicle.addTurn({
    scene: 1, turn: 2, rawInput: 'b', intent: null, delta: null, bookProse: '', pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  });
  await svc.illustrateScene(turn2.id, 'loc:scriptorium', [], 'second pass, same room');

  assert.equal(mock.calls[0]!.referenceImagePath, null, 'no prior image existed yet for the first scene here');
  assert.ok(mock.calls[1]!.referenceImagePath, 'the second scene at the same location was given the first as a reference');
  world.close();
});

test('deleting an illustration removes its file from disk, not just the row', async () => {
  const world = fresh();
  const mock = new MockImageProvider();
  const svc = serviceWith(mock, world);
  const illus = await svc.illustratePortrait('char:anselm');
  const abs = world.illustrations.absolutePath(illus)!;
  assert.ok(existsSync(abs));

  world.illustrations.delete(illus.id);
  assert.ok(!existsSync(abs), 'the file is gone');
  assert.equal(world.illustrations.get(illus.id), undefined, 'the row is gone');
  world.close();
});
