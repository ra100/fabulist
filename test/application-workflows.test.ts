import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDirective, type DirectiveRepository } from '../src/application/directives.ts';
import { sqliteDirectiveRepository } from '../src/application/directives-sqlite.ts';
import { runPlayTurn } from '../src/application/play-workflow.ts';
import { recordAuthoringCheckpointTx } from '../src/loop/history.ts';
import { World } from '../src/store/index.ts';

test('play workflow runs post-commit effects only for narrated outcomes', async () => {
  const calls: string[] = [];
  const adapter = {
    takeTurn: async () => ({ kind: 'narrated', delta: { events: [] }, commit: { events: ['event'] } }),
    seedConsequences: async () => {
      calls.push('seed');
      return 2;
    },
    tickConsequences: async () => {
      calls.push('tick');
      return { fired: 1 };
    },
    worldTick: async () => {
      calls.push('world');
    },
  };

  const result = await runPlayTurn(adapter, { storyId: 'story:a' }, 'act');
  assert.deepEqual(calls, ['seed', 'tick', 'world']);
  assert.equal(result.seeded, 2);
  assert.deepEqual(result.tick, { fired: 1 });

  calls.length = 0;
  const interrupted = await runPlayTurn(
    { ...adapter, takeTurn: async () => ({ kind: 'interrupted' }) },
    { storyId: 'story:a' },
    'act',
  );
  assert.deepEqual(calls, []);
  assert.equal(interrupted.seeded, 0);
  assert.equal(interrupted.tick, null);
});

test('directive workflow applies defaults and resolves affected thread titles', async () => {
  const repository: DirectiveRepository = {
    currentScene: () => 7,
    create: (directive) => ({ id: 'directive:1', ...directive }),
    recalculate: () => ({ raisedThreads: ['thread:a'], loweredThreads: ['thread:missing'] }),
    threadTitles: () => new Map([['thread:a', 'The debt comes due']]),
  };

  const result = await createDirective(repository, { text: 'Bring back the debt' });
  assert.equal(result.directive.createdScene, 7);
  assert.equal(result.directive.scope, 'chapter');
  assert.equal(result.directive.strength, 'push');
  assert.deepEqual(result.diff.raisedThreadTitles, ['The debt comes due']);
  assert.deepEqual(result.diff.loweredThreadTitles, ['thread:missing']);
});

test('directive workflow rolls back its write when title lookup fails', async () => {
  const world = World.open(':memory:');
  const repository = sqliteDirectiveRepository(world);
  const failingRepository: DirectiveRepository = {
    ...repository,
    recalculate: () => ({ raisedThreads: [], loweredThreads: [] }),
    threadTitles: () => {
      throw new Error('title lookup failed');
    },
  };

  await assert.rejects(
    recordAuthoringCheckpointTx(world, () => createDirective(failingRepository, { text: 'A directive' })),
    /title lookup failed/,
  );
  assert.deepEqual(world.directives.active(), []);
  world.close();
});
