import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { exportMarkdown, exportPlainText } from '../src/loop/export.ts';

async function playHistory(world: World) {
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()), autoCompact: false });
  await engine.takeTurn('i warm the ink');
  world.session.set({ scene: 2, turn: 0 });
  await engine.takeTurn('i hide the psalter under the loose flag');
}

test('exportMarkdown renders a title, one heading per scene, and each turn\u2019s prose', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);

  const md = exportMarkdown(world);
  assert.match(md, /^# Saint Verrow/);
  assert.match(md, /### Scene 1/);
  assert.match(md, /### Scene 2/);
  // The mock provider's prose for the first turn should appear verbatim.
  const turn = world.chronicle.turns()[0]!;
  assert.ok(md.includes(turn.bookProse.trim()), 'the actual prose is in the export, not a placeholder');
  world.close();
});

test('exportMarkdown groups scenes under a chapter heading once one is recorded', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.chronicle.upsertScene(1, { chapter: 1 });
  world.chronicle.upsertScene(2, { chapter: 1 });
  world.chronicle.upsertChapter(1, { title: 'Opening' });

  const md = exportMarkdown(world);
  assert.match(md, /## Chapter 1: Opening/);
  // Both scenes fall under the same chapter heading, appearing once, not twice.
  assert.equal(md.match(/## Chapter 1/g)?.length, 1);
  world.close();
});

test('exportMarkdown includes a scene summary when one exists, and can be told not to', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.chronicle.upsertScene(1, { summary: 'Anselm begins his day at the desk.' });

  const withSummary = exportMarkdown(world);
  assert.match(withSummary, /Anselm begins his day at the desk\./);

  const withoutSummary = exportMarkdown(world, { includeSceneSummaries: false });
  assert.doesNotMatch(withoutSummary, /Anselm begins his day at the desk\./);
  world.close();
});

test('exportMarkdown accepts an explicit title, overriding the world\u2019s own', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  const md = exportMarkdown(world, { title: 'A Different Title' });
  assert.match(md, /^# A Different Title/);
  world.close();
});

test('exportMarkdown on an empty book still produces a valid title page, no turns', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const md = exportMarkdown(world);
  assert.match(md, /^# Saint Verrow/);
  world.close();
});

test('exportPlainText strips markdown syntax to a reader-friendly heading style', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  world.chronicle.upsertScene(1, { summary: 'Anselm begins his day.' });

  const text = exportPlainText(world);
  assert.ok(!text.includes('#'), 'no literal hash marks survive');
  assert.ok(!/^\*.*\*$/m.test(text), 'no literal asterisk-italic survives');
  assert.match(text, /^Saint Verrow\n=+/, 'the title becomes an underlined heading');
  assert.match(text, /Anselm begins his day\./, 'the summary text itself survives, just unwrapped');
  world.close();
});

test('a pinned or regenerated turn\u2019s current bookProse is what gets exported, not the original', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  await playHistory(world);
  const turn = world.chronicle.turns()[0]!;
  world.chronicle.setProse(turn.id, 'A hand-edited line that should appear in the export.');

  const md = exportMarkdown(world);
  assert.match(md, /A hand-edited line that should appear in the export\./);
  world.close();
});
