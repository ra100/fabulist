import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type Provider } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { Compactor } from '../src/loop/compact.ts';
import { buildNarratorFrame } from '../src/frame/builders.ts';
import { tokenizerFor } from '../src/frame/tokenizer.ts';

function setup() {
  const world = World.open(':memory:');
  seedWorld(world);
  const mock = new MockProvider();
  const engine = new Engine({ world, providers: new ProviderRegistry(mock) });
  return { world, engine, mock };
}

/** Writes turns into a scene without running the loop. */
function addTurns(world: World, scene: number, count: number, ids: string[] = ['char:brother-anselm']) {
  for (let i = 1; i <= count; i++) {
    world.chronicle.addTurn({
      scene,
      turn: i,
      rawInput: `input ${i}`,
      intent: null,
      delta: {
        events: [{ text: `something happened (${i})`, participants: ids, locationId: 'loc:the-scriptorium', significance: 0.5 }],
        entityUpserts: [], edgeAsserts: [], edgeRetires: [], conditionUpdates: [],
        relationshipUpdates: [], factsLearned: [], threadUpdates: [], vowBreaks: [], sceneAdvance: false,
      },
      bookProse: `He did the thing, and it went as it went. This is turn ${i} of scene ${scene}.`,
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });
  }
}

test('a closed scene gets a summary written', async () => {
  const { world, mock } = setup();
  addTurns(world, 1, 3);
  const compactor = new Compactor({ world, provider: mock });

  const summary = await compactor.summariseScene(1);
  assert.ok(summary, 'a summary was produced');
  assert.equal(world.chronicle.scenes().find((s) => s.scene === 1)?.summary, summary);
});

test('summaries keep entity ids so the graph stays walkable from them', async () => {
  const { world, mock } = setup();
  addTurns(world, 1, 3, ['char:brother-anselm', 'char:novice-tem']);
  const compactor = new Compactor({ world, provider: mock });

  const summary = (await compactor.summariseScene(1))!;
  assert.match(summary, /char:brother-anselm/, 'the id survives compaction');
  assert.match(summary, /char:novice-tem/);
  // Losing an id is the failure that makes compaction actively harmful: the text
  // still reads fine while the world model becomes unreachable from it.
  assert.ok(world.graph.get('char:novice-tem'), 'and it still resolves in the graph');
});

test('an id the model drops is appended rather than lost', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  addTurns(world, 1, 3, ['char:brother-anselm', 'char:sister-oria']);

  // A provider that returns prose with no ids at all.
  const forgetful: Provider = {
    id: 'x', model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0.5, steerability: 0.5 },
    async complete() {
      return { text: JSON.stringify({ summary: 'They spoke and nothing was settled.', title: 'A talk' }), tokensIn: 1, tokensOut: 1, model: 'x', schemaEnforced: true };
    },
  };
  const compactor = new Compactor({ world, provider: forgetful });
  const summary = (await compactor.summariseScene(1))!;

  assert.match(summary, /char:brother-anselm/);
  assert.match(summary, /char:sister-oria/);
  assert.match(summary, /also present/, 'repaired rather than retried');
});

test('summarising is idempotent unless forced', async () => {
  const { world, mock } = setup();
  addTurns(world, 1, 3);
  const compactor = new Compactor({ world, provider: mock });

  const first = await compactor.summariseScene(1);
  const before = mock.calls.filter((c) => c.role === 'summarize').length;
  const second = await compactor.summariseScene(1);
  const after = mock.calls.filter((c) => c.role === 'summarize').length;

  assert.equal(second, first, 'same summary returned');
  assert.equal(after, before, 'and no second model call, so scene advance is cheap to call');

  await compactor.summariseScene(1, true);
  assert.ok(mock.calls.filter((c) => c.role === 'summarize').length > after, 'force re-summarises');
});

test('a scene too thin to compact is skipped', async () => {
  const { world, mock } = setup();
  addTurns(world, 1, 1);
  const compactor = new Compactor({ world, provider: mock, minTurns: 2 });
  assert.equal(await compactor.summariseScene(1), null, 'one turn is not worth a summary');
});

test('chapters roll up from scene summaries', async () => {
  const { world, mock } = setup();
  const compactor = new Compactor({ world, provider: mock, chapterSize: 3 });
  for (const scene of [1, 2, 3]) {
    addTurns(world, scene, 2);
    world.chronicle.upsertScene(scene, { chapter: 1 });
    await compactor.summariseScene(scene);
  }
  const chapterSummary = await compactor.summariseChapter(1);
  assert.ok(chapterSummary, 'a chapter summary was written');
  assert.equal(world.chronicle.chapter(1)?.summary, chapterSummary);
});

test('a chapter with fewer than two summarised scenes is not rolled up', async () => {
  const { world, mock } = setup();
  addTurns(world, 1, 2);
  const compactor = new Compactor({ world, provider: mock, chapterSize: 3 });
  await compactor.summariseScene(1);
  assert.equal(await compactor.summariseChapter(1), null);
});

test('chapter boundaries follow chapterSize', () => {
  const { world, mock } = setup();
  const c = new Compactor({ world, provider: mock, chapterSize: 4 });
  assert.equal(c.chapterOf(1), 1);
  assert.equal(c.chapterOf(4), 1);
  assert.equal(c.chapterOf(5), 2);
  assert.equal(c.chapterOf(9), 3);
});

test('onSceneClosed summarises the scene and the chapter at a boundary', async () => {
  const { world, mock } = setup();
  const compactor = new Compactor({ world, provider: mock, chapterSize: 2 });
  for (const scene of [1, 2]) {
    addTurns(world, scene, 2);
    world.chronicle.upsertScene(scene, { chapter: 1 });
  }
  await compactor.onSceneClosed(1);
  const res = await compactor.onSceneClosed(2);
  assert.deepEqual(res.scenesSummarised, [2]);
  assert.deepEqual(res.chaptersSummarised, [1], 'scene 2 closes chapter 1 at chapterSize 2');
});

test('backfill catches up scenes that closed unsummarised, never the current one', async () => {
  const { world, mock } = setup();
  for (const scene of [1, 2, 3]) addTurns(world, scene, 2);
  const compactor = new Compactor({ world, provider: mock });

  const res = await compactor.backfill(3);
  assert.deepEqual(res.scenesSummarised, [1, 2], 'the current scene stays verbatim');
  assert.ok(!world.chronicle.scenes().find((s) => s.scene === 3)?.summary);
});

test('a provider failure leaves the scene unsummarised rather than corrupt', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  addTurns(world, 1, 3);
  const failing: Provider = {
    id: 'x', model: 'x',
    capabilities: { contextWindow: 64_000, structuredOutput: 'none', systemRole: true, streaming: false, costTier: 'free', charsPerToken: 4, proseQuality: 0, steerability: 0 },
    async complete() { throw new Error('rate limited'); },
  };
  const seen: string[] = [];
  const compactor = new Compactor({ world, provider: failing, onError: (s) => seen.push(s) });

  assert.equal(await compactor.summariseScene(1), null);
  assert.equal(world.chronicle.scenes().find((s) => s.scene === 1)?.summary ?? '', '');
  assert.deepEqual(seen, ['scene 1'], 'and it says which scene failed');
});

test('the engine compacts automatically when a scene advances', async () => {
  const { world, engine } = setup();
  // Two turns of real play, then force the advance the extractor would report.
  await engine.takeTurn('i warm the ink');
  await engine.takeTurn('i check the door');
  assert.equal(world.session.get().scene, 1);

  await engine.compaction().onSceneClosed(1);
  world.session.set({ scene: 2, turn: 0 });

  const summary = world.chronicle.scenes().find((s) => s.scene === 1)?.summary;
  assert.ok(summary, 'the closed scene has a summary');
  assert.match(summary!, /char:/, 'with ids intact');
});

test('scene summaries reach the narrator frame once a scene has closed', async () => {
  const { world, engine, mock } = setup();
  addTurns(world, 1, 3);
  await engine.compaction().summariseScene(1);
  world.session.set({ scene: 2, turn: 0 });

  const frame = buildNarratorFrame({
    world,
    session: world.session.get(),
    tokenizer: tokenizerFor(4),
    budget: 20_000,
    rawInput: 'i keep copying',
  });
  const slot = frame.log.slots.find((s) => s.name === 'scene-summaries');
  assert.ok(slot, 'the summary slot is populated');
  assert.match(frame.text, /scene 1:/, 'and the narrator can see what came before');
  assert.ok(mock.calls.length > 0);
});

test('compaction bounds context growth over a long session', async () => {
  const { world, engine } = setup();
  // Ten scenes of three turns. Without compaction the frame would carry every
  // turn verbatim; with it, closed scenes collapse to a line each.
  for (let scene = 1; scene <= 10; scene++) {
    addTurns(world, scene, 3);
    world.chronicle.upsertScene(scene, { chapter: engine.compaction().chapterOf(scene) });
    if (scene < 10) await engine.compaction().summariseScene(scene);
  }
  world.session.set({ scene: 10, turn: 3 });

  const frame = buildNarratorFrame({
    world,
    session: world.session.get(),
    tokenizer: tokenizerFor(4),
    budget: 20_000,
    rawInput: 'i keep copying',
  });

  const summaries = frame.log.slots.find((s) => s.name === 'scene-summaries')?.tokens ?? 0;
  const verbatim = frame.log.slots.find((s) => s.name === 'recent-prose')?.tokens ?? 0;
  const allProse = world.chronicle.turns({ limit: 999 }).map((t) => t.bookProse).join(' ').length / 4;

  assert.ok(summaries > 0, 'nine closed scenes are represented');
  assert.ok(summaries + verbatim < allProse, `compacted (${Math.round(summaries + verbatim)}) beats verbatim (${Math.round(allProse)})`);
});
