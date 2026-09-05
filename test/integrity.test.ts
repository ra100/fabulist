import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { createStory } from '../src/store/world.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { checkIntegrity, formatIntegrityReport } from '../src/store/integrity.ts';
import { forkStory, truncateToScene } from '../src/loop/branch.ts';
import { Engine } from '../src/loop/engine.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';

function seeded() {
  const world = World.open(':memory:');
  seedWorld(world);
  return world;
}

test('a seeded world has no dangling references', () => {
  const world = seeded();
  const report = checkIntegrity(world.db);
  assert.ok(report.ok, formatIntegrityReport(report));
  assert.ok(report.checked > 0, 'and actually checked something — "clean" must not mean "empty"');
  world.close();
});

test('deleting an entity out from under the graph is reported across every reference shape', () => {
  const world = seeded();
  world.db.prepare(`DELETE FROM entities WHERE id = 'char:brother-anselm'`).run();
  const report = checkIntegrity(world.db);

  assert.ok(!report.ok);
  const columns = new Set(report.orphans.map((o) => `${o.table}.${o.column}`));
  // Plain columns, a composite-key table, a JSON array, the story's own
  // pointer, and the table scoped through a join rather than a story_id column.
  for (const expected of [
    'edges.subject',
    'edges.object',
    'sheets.entity_id',
    'relationships.from_id',
    'threads.parties[]',
    'fact_knowledge.entity_id',
    'stories.player_character_id',
  ]) {
    assert.ok(columns.has(expected), `${expected} not reported; got ${[...columns].join(', ')}`);
  }
  assert.ok(
    report.orphans.every((o) => o.missingId === 'char:brother-anselm'),
    'every orphan names the id that vanished',
  );
  world.close();
});

/**
 * The failure a fork bug actually produces, and the reason this resolves through
 * the canon/chronicle overlay rather than asking `entities` flatly: an id that
 * exists only as another story's chronicle row is invisible to this story, even
 * though a bare `WHERE id = ?` finds it.
 */
test('a reference to another story\'s chronicle-only entity is dangling, though it exists in the table', () => {
  const world = seeded();
  const other = createStory(world.db, { title: 'other' }).id;
  world.graph.upsert({ id: 'char:ghost', type: 'Character', name: 'A Ghost' }, 'chronicle');

  const flat = world.db.prepare(`SELECT 1 AS x FROM entities WHERE id = 'char:ghost'`).get();
  assert.ok(flat, 'precondition: a naive existence check is satisfied');

  world.db
    .prepare(`INSERT INTO relationships (story_id, from_id, to_id, trust, affection, respect, note) VALUES (?,?,?,0,0,0,'')`)
    .run(other, 'char:ghost', 'char:ghost');

  const report = checkIntegrity(world.db);
  assert.ok(!report.ok, 'the overlay-aware check sees what the flat one cannot');
  assert.equal(report.orphans[0]?.storyId, other, 'and says which story owns the bad row');
  world.close();
});

test('an intra-story row reference is checked too, not only entity ids', () => {
  const world = seeded();
  const other = createStory(world.db, { title: 'other' }).id;
  const event = world.chronicle.addEvent({
    scene: 1, turn: 1, text: 'a thing', participants: [], locationId: null,
    significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
  });
  // A consequence in story B citing story A's event — what a bad copy leaves.
  world.db
    .prepare(
      `INSERT INTO consequences (id, story_id, cause_event_id, trigger, actor_id, action, visibility, maturity, depth, significance, created_scene)
       VALUES (?,?,?,'{}','','x','onscreen','pending',1,0.5,1)`,
    )
    .run('cons:x', other, event.id);

  const report = checkIntegrity(world.db);
  assert.ok(!report.ok);
  assert.equal(report.orphans[0]?.column, 'cause_event_id');
  world.close();
});

test('fork and truncate leave the file referentially intact', async () => {
  const world = seeded();
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()), autoCompact: false });
  await engine.takeTurn('i warm the ink');
  world.session.set({ scene: 2, turn: 0 });
  await engine.takeTurn('i climb to the gate');
  world.session.set({ scene: 3, turn: 0 });
  await engine.takeTurn('i wait');

  assert.ok(checkIntegrity(world.db).ok, 'after play');

  forkStory(world, { fromStoryId: world.storyId, atScene: 2, title: 'branch' });
  let report = checkIntegrity(world.db);
  assert.ok(report.ok, `after fork: ${formatIntegrityReport(report)}`);

  truncateToScene(world.withStory(world.storyId), 2);
  report = checkIntegrity(world.db);
  assert.ok(report.ok, `after truncate: ${formatIntegrityReport(report)}`);
  world.close();
});

test('the report reads usefully in both states', () => {
  const world = seeded();
  assert.match(formatIntegrityReport(checkIntegrity(world.db)), /^integrity ok: \d+ rows checked/);

  world.db.prepare(`DELETE FROM entities WHERE id = 'char:brother-anselm'`).run();
  const text = formatIntegrityReport(checkIntegrity(world.db));
  assert.match(text, /dangling reference\(s\) across \d+ column\(s\)/);
  assert.match(text, /missing char:brother-anselm/);
  // Long lists are summarised rather than dumped.
  assert.match(text, /… and \d+ more/);
  world.close();
});
