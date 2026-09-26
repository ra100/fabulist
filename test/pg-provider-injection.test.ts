import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { World, createWorld } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { regenerateProseWithCheckpoint } from '../src/loop/history-pg.ts';

const roles = (p: MockProvider) => new Set(p.calls.map((c) => c.role));

test('turns, rerolls and compaction run on the registry passed for the call, not the engine default', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
    const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
    const world = await World.forStory(db, story.id);
    await seedWorld(world);
    const fallback = new MockProvider();
    const perCall = new MockProvider({ id: 'per-call' });
    const providers = new ProviderRegistry(perCall);
    const engine = new Engine({ world, db, providers: new ProviderRegistry(fallback) });

    const first = await engine.takeTurn('i warm the ink and keep copying', { world, providers });
    assert.equal(first.kind, 'narrated', JSON.stringify(first).slice(0, 300));
    await engine.takeTurn('i check the door', { world, providers });
    assert.ok(roles(perCall).has('classify') && roles(perCall).has('referee') && roles(perCall).has('extract'));

    const proposed = await engine.takeTurn('i hide the psalter', { world, providers, narrateExternally: true });
    assert.equal(proposed.kind, 'awaiting-narration');
    if (proposed.kind !== 'awaiting-narration') return;
    const extractsBefore = perCall.calls.filter((c) => c.role === 'extract').length;
    await engine.commitExternalNarration(proposed.resumeToken, 'Brother Anselm hides the psalter.', world, undefined, providers);
    assert.ok(perCall.calls.filter((c) => c.role === 'extract').length > extractsBefore);

    if (first.kind === 'narrated') {
      await regenerateProseWithCheckpoint(db, world, engine, first.turn.id, { providers });
    }
    await engine.compaction(providers).summariseScene(world, (await world.session.get()).scene, true);
    assert.ok(roles(perCall).has('summarize'));
    assert.equal(fallback.calls.length, 0, 'the engine default saw no call');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a custom world is invented on the registry in its authoring target', async (t) => {
  const ran = await withPg(async (db) => {
    await createWorld(db, '');
    const story = await createStory(db, { title: '' });
    const fallback = new MockProvider();
    const perCall = new MockProvider({ id: 'per-call' });
    const service = new SetupService({ world: () => World.forStory(db, story.id), db, providers: new ProviderRegistry(fallback) });
    const job = service.startCustomWorld('A city of bell-ringers.', undefined, {
      world: await World.forStory(db, story.id),
      user: null,
      providers: new ProviderRegistry(perCall),
    });
    for (let i = 0; i < 400 && service.jobs.get(job.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(service.jobs.get(job.id)?.status, 'done', service.jobs.get(job.id)?.error ?? '');
    assert.ok(roles(perCall).has('setup'));
    assert.equal(fallback.calls.length, 0);
  });
  if (!ran) t.skip('no Postgres configured');
});
