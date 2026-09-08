/**
 * The in-place event-graph repair (`src/ingest/repair.ts`).
 *
 * Every fixture here is built to match what a real pre-fix ingest produced —
 * `event:<subjectId>:<counter>` ids, sentence-length names, one `INVOLVED_IN`
 * edge back to the single page that reported it — because the whole value of
 * this module is that it fixes *those* rows without a re-ingest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { eventIdFor } from '../src/ingest/depth.ts';
import { repairEvents, isLegacyEventId } from '../src/ingest/repair.ts';

/** A world with three characters, ready to be given legacy event nodes. */
function seeded() {
  const world = World.open(':memory:');
  for (const [id, name] of [
    ['char:shepard', 'Shepard'],
    ['char:saren', 'Saren'],
    ['char:liara', 'Liara'],
  ] as const) {
    world.graph.upsert({ id, type: 'Character', name }, 'canon');
  }
  return world;
}

/** Exactly the shape `applyPassB` used to write: counter id, sentence name, one edge. */
function legacyEvent(world: World, subject: string, seq: number, text: string, date?: string) {
  const id = `event:${subject}:${seq}`;
  world.graph.upsert(
    {
      id,
      type: 'Event',
      name: text.slice(0, 70),
      summary: text,
      provenance: `passB:${subject}`,
      props: date ? { inWorldDate: date } : {},
    },
    'canon',
  );
  world.graph.assertEdge({ subject, predicate: 'INVOLVED_IN', object: id, weight: 0.6 }, 0, 'canon');
  return id;
}

test('isLegacyEventId recognises the counter scheme and nothing else', () => {
  assert.equal(isLegacyEventId('event:char:shepard:3'), true);
  assert.equal(isLegacyEventId('event:battle-of-the-citadel'), false, 'a page-derived event is not legacy');
  assert.equal(isLegacyEventId(eventIdFor('x', 'y')), false, 'nor is a content-keyed one');
  assert.equal(isLegacyEventId('char:shepard'), false);
});

test('three copies of one event become a single node with three participants', () => {
  const world = seeded();
  const text = 'The Citadel was attacked.';
  // The same event, read off three different pages — the 26-duplicate-group
  // population in the real world that prompted this.
  legacyEvent(world, 'char:shepard', 0, text, '2183');
  legacyEvent(world, 'char:saren', 0, text, '2183');
  legacyEvent(world, 'char:liara', 1, text, '2183');

  const res = repairEvents(world, {});
  assert.equal(res.examined, 3);
  assert.equal(res.merged, 2, 'two folded into one');

  const events = world.db.prepare(`SELECT id, name FROM entities WHERE type = 'Event'`).all() as Array<{ id: string; name: string }>;
  assert.equal(events.length, 1, 'one node for one event');
  assert.equal(events[0]!.id, eventIdFor(text, '2183'), 'keyed by what happened, not by who reported it');

  const participants = world.db
    .prepare(`SELECT subject FROM edges WHERE object = ? AND predicate = 'INVOLVED_IN'`)
    .all(events[0]!.id) as Array<{ subject: string }>;
  assert.deepEqual(
    participants.map((p) => p.subject).sort(),
    ['char:liara', 'char:saren', 'char:shepard'],
    'the merge is what gives the event the participants it always had',
  );
  assert.ok(res.participantsGained >= 0);
  world.close();
});

test('a sentence-length event name is shortened, so it stops being a name magnet', () => {
  const world = seeded();
  const text = 'The garrison marched out at dawn, crossed the gorge, and burned the mill.';
  legacyEvent(world, 'char:shepard', 0, text, '2183');

  const res = repairEvents(world, {});
  assert.equal(res.relabelled, 1);
  const ev = world.db.prepare(`SELECT name, summary FROM entities WHERE type = 'Event'`).get() as { name: string; summary: string };
  assert.ok(ev.name.length < text.length, 'the label is a label');
  assert.equal(ev.summary, text, 'and the full text is still there');
  // The reason this matters: a prose-length name was matching almost any proper
  // noun through the old fuzzy resolution.
  assert.equal(world.graph.resolveName('the gorge'), undefined);
  world.close();
});

test('repair is idempotent — running it twice changes nothing the second time', () => {
  const world = seeded();
  legacyEvent(world, 'char:shepard', 0, 'The Citadel was attacked.', '2183');
  legacyEvent(world, 'char:saren', 0, 'The Citadel was attacked.', '2183');
  legacyEvent(world, 'char:liara', 0, 'A different thing happened.', '2184');

  repairEvents(world, {});
  const snapshot = () => ({
    entities: world.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number },
    edges: world.db.prepare(`SELECT COUNT(*) AS n FROM edges`).get() as { n: number },
  });
  const first = JSON.stringify(snapshot());

  const second = repairEvents(world, {});
  assert.equal(second.examined, 0, 'nothing left on the old scheme');
  assert.equal(JSON.stringify(snapshot()), first, 'and the graph is untouched');
  world.close();
});

test('an existing content-keyed node absorbs a legacy duplicate rather than colliding with it', () => {
  const world = seeded();
  const text = 'The Citadel was attacked.';
  // What a world ingested partly before and partly after the fix looks like.
  const canonical = eventIdFor(text, '2183');
  world.graph.upsert({ id: canonical, type: 'Event', name: 'The Citadel was attacked', summary: text, props: { inWorldDate: '2183' } }, 'canon');
  world.graph.assertEdge({ subject: 'char:shepard', predicate: 'INVOLVED_IN', object: canonical, weight: 0.6 }, 0, 'canon');
  legacyEvent(world, 'char:saren', 0, text, '2183');

  repairEvents(world, {});
  const events = world.db.prepare(`SELECT id FROM entities WHERE type = 'Event'`).all() as Array<{ id: string }>;
  assert.deepEqual(events.map((e) => e.id), [canonical], 'one node survives, the content-keyed one');
  const participants = world.db
    .prepare(`SELECT subject FROM edges WHERE object = ? AND predicate = 'INVOLVED_IN'`)
    .all(canonical) as Array<{ subject: string }>;
  assert.deepEqual(participants.map((p) => p.subject).sort(), ['char:saren', 'char:shepard']);
  world.close();
});

test('prune moves undated single-participant events onto their subject and deletes the node', () => {
  const world = seeded();
  legacyEvent(world, 'char:shepard', 0, 'She is respected by the crew.');
  legacyEvent(world, 'char:saren', 0, 'The Citadel was attacked.', '2183');

  const res = repairEvents(world, { prune: true });
  assert.equal(res.pruned, 1, 'the undated single-participant node goes');

  const events = world.db.prepare(`SELECT id, summary FROM entities WHERE type = 'Event'`).all() as Array<{ id: string; summary: string }>;
  assert.equal(events.length, 1, 'the dated one stays — a date makes it locatable even with one participant');
  assert.equal(events[0]!.summary, 'The Citadel was attacked.');

  // Nothing was lost: the sentence is on the entity whose page said it, which
  // is where `applyPassB` now puts statements like this in the first place.
  const shepard = world.graph.get('char:shepard')!;
  assert.deepEqual(shepard.props.pageEvents, ['She is respected by the crew.']);
  world.close();
});

test('without prune, nothing is deleted', () => {
  const world = seeded();
  legacyEvent(world, 'char:shepard', 0, 'She is respected by the crew.');
  const res = repairEvents(world, {});
  assert.equal(res.pruned, 0);
  const n = world.db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE type = 'Event'`).get() as { n: number };
  assert.equal(n.n, 1, 'the node is re-keyed and relabelled, but kept');
  world.close();
});

test('page-derived events are left completely alone', () => {
  const world = seeded();
  world.graph.upsert({ id: 'event:battle-of-the-citadel', type: 'Event', name: 'Battle of the Citadel', summary: 'A battle.' }, 'canon');
  world.graph.assertEdge({ subject: 'char:shepard', predicate: 'INVOLVED_IN', object: 'event:battle-of-the-citadel', weight: 0.6 }, 0, 'canon');

  const res = repairEvents(world, { prune: true });
  assert.equal(res.examined, 0, 'not a legacy id, so not this migration’s business');
  const ev = world.graph.get('event:battle-of-the-citadel');
  assert.ok(ev, 'still there');
  assert.equal(ev!.name, 'Battle of the Citadel', 'and still named as the wiki named it');
  world.close();
});
