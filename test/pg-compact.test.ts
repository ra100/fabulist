import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDelta, type Turn } from '../src/domain/types.ts';
import { Compactor } from '../src/loop/compact-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { World } from '../src/store/index-pg.ts';
import { makeStory, makeWorld, withPg } from './pg-harness.ts';

function turnInput(scene: number, turn: number): Omit<Turn, 'id' | 'createdAt'> {
  return {
    scene,
    turn,
    rawInput: `action ${scene}.${turn}`,
    intent: null,
    delta: emptyDelta(),
    bookProse: `Prose for scene ${scene}, turn ${turn}.`,
    pinned: false,
    meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
  };
}

test('PostgreSQL backfill reads events once and partitions them by scene layout', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'compact-backfill');
    const storyId = await makeStory(db, 'compact-backfill-story', [worldId]);
    const world = await World.forStory(db, storyId);
    for (const scene of [1, 2, 3]) {
      for (const turn of [1, 2]) await world.chronicle.addTurn(turnInput(scene, turn));
      await world.chronicle.addEvent({
        scene, turn: 1, text: `event for scene ${scene}`, participants: [], locationId: null,
        significance: 0.5, visibility: 'onscreen', fromConsequenceId: null,
      });
    }
    await world.session.set({ scene: 3, turn: 2 });
    const originalEvents = world.chronicle.events.bind(world.chronicle);
    let eventReads = 0;
    world.chronicle.events = (async (opts) => {
      eventReads += 1;
      return originalEvents(opts);
    }) as typeof world.chronicle.events;
    const mock = new MockProvider();
    const requests: string[] = [];
    const originalComplete = mock.complete.bind(mock);
    mock.complete = async (request) => {
      requests.push(String(request.messages[1]?.content));
      return originalComplete(request);
    };

    const result = await new Compactor({ provider: mock, minTurns: 1 }).backfill(world, 3);

    assert.deepEqual(result.scenesSummarised, [1, 2]);
    assert.equal(eventReads, 1);
    assert.match(requests[0]!, /event for scene 1/);
    assert.doesNotMatch(requests[0]!, /event for scene 2/);
    assert.match(requests[1]!, /event for scene 2/);
    assert.doesNotMatch(requests[1]!, /event for scene 1/);
  });
  if (!ran) t.skip('no Postgres configured');
});
