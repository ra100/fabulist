import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import {
  applyDirectiveRecalc,
  defaultSeedOptions,
  seedConsequences,
  tickConsequences,
  transmitRumours,
  worldTick,
} from '../src/consequence/propagate.ts';
import type { StoryEvent } from '../src/domain/types.ts';

function setup() {
  const world = World.open(':memory:');
  seedWorld(world);
  return world;
}

function harm(world: World, target: string, significance = 0.9): StoryEvent {
  return world.chronicle.addEvent({
    scene: world.session.get().scene,
    turn: 1,
    text: `something serious happened to ${target}`,
    participants: [target],
    locationId: 'loc:the-scriptorium',
    significance,
    visibility: 'onscreen',
    fromConsequenceId: null,
  });
}

test('acting on a character seeds consequences among those who care', () => {
  const world = setup();
  const event = harm(world, 'char:novice-tem');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);

  assert.ok(seeded.length > 0, 'harm to a well-connected character ripples');
  // Tem's fellow Order members react on the faction's behalf.
  assert.ok(
    seeded.some((c) => c.actorId === 'char:sister-oria' || c.actorId === 'char:prior-galt'),
    'the Order responds to one of its own being harmed',
  );
  assert.ok(seeded.every((c) => c.depth === 1), 'first ring is depth 1');
  assert.ok(seeded.every((c) => c.causeEventId === event.id), 'traceable to the cause');
  world.close();
});

test('the player character is never a consequence actor', () => {
  const world = setup();
  // The queue drives NPCs and the world. Queueing an act the protagonist
  // performs offscreen would take the author's agency away.
  const events = ['char:novice-tem', 'char:sister-oria', 'char:hela-vask'].map((t) => harm(world, t));
  const seeded = seedConsequences(world, { events: [] } as never, events);
  const player = world.session.get().playerCharacterId;
  assert.ok(seeded.length > 0, 'consequences were seeded at all');
  assert.ok(seeded.every((c) => c.actorId !== player), 'the player acts through their own turns');
  world.close();
});

test('trivial acts ripple nowhere', () => {
  const world = setup();
  const event = harm(world, 'char:novice-tem', 0.05);
  const seeded = seedConsequences(world, { events: [] } as never, [event]);
  assert.equal(seeded.length, 0, '"nothing happened" is a valid and common outcome');
  world.close();
});

test('a hostile reactor moves against, a loyal one protects', () => {
  const world = setup();
  const event = harm(world, 'char:brother-anselm');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);

  const doff = seeded.find((c) => c.actorId === 'char:sergeant-doff');
  const tem = seeded.find((c) => c.actorId === 'char:novice-tem');
  if (doff) assert.match(doff.action, /against|advantage/, 'hostility shapes the reaction');
  if (tem) assert.match(tem.action, /protect|help|truth/, 'loyalty shapes the reaction');
  world.close();
});

test('consequence count is capped so the story does not drown in reaction', () => {
  const world = setup();
  const events = ['char:brother-anselm', 'char:captain-sered', 'char:novice-tem'].map((t) => harm(world, t));
  const seeded = seedConsequences(world, { events: [] } as never, events);
  assert.ok(seeded.length <= 12, `capped, got ${seeded.length}`);
  world.close();
});

test('propagation depth respects the knob', () => {
  const world = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, propagationDepth: 1 } });
  const event = harm(world, 'char:novice-tem');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);
  assert.ok(seeded.every((c) => c.depth <= 1));
  world.close();
});

test('a same-room reactor is onscreen and immediate', () => {
  const world = setup();
  // Oria shares the scriptorium with the player in seed state, so her reaction
  // to Tem being harmed happens where the player can see it.
  const event = harm(world, 'char:novice-tem');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);
  const oria = seeded.find((c) => c.actorId === 'char:sister-oria');
  assert.ok(oria, 'expected the herbalist in the room to react');
  assert.equal(oria!.visibility, 'onscreen', 'the player is in the room for it');
  assert.equal(oria!.trigger.kind, 'immediate');
  world.close();
});

test('a distant reactor is offscreen with latency', () => {
  const world = setup();
  const event = harm(world, 'char:brother-anselm');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);
  const distant = seeded.find((c) => c.actorId === 'char:sergeant-doff');
  assert.ok(distant, 'the garrison hears eventually');
  assert.notEqual(distant!.visibility, 'onscreen');
  assert.equal(distant!.trigger.kind, 'after-scenes');
  world.close();
});

test('pending consequences ripen then fire, in that order', () => {
  const world = setup();
  const event = harm(world, 'char:brother-anselm');
  seedConsequences(world, { events: [] } as never, [event]);

  const first = tickConsequences(world);
  assert.ok(first.fired.length + first.ripened.length > 0, 'the queue advances');

  // Advance story time so the delayed ones become ready.
  for (let s = 2; s <= 8; s++) {
    world.session.set({ scene: s });
    tickConsequences(world);
  }
  const fired = world.consequences.all().filter((c) => c.maturity === 'fired');
  assert.ok(fired.length > 0, 'delayed consequences eventually arrive');
  assert.ok(fired.every((c) => c.firedScene !== null), 'the firing scene is recorded');
  world.close();
});

test('firing a consequence writes a real event to the chronicle', () => {
  const world = setup();
  const event = harm(world, 'char:novice-tem');
  seedConsequences(world, { events: [] } as never, [event]);
  const before = world.chronicle.events().length;

  tickConsequences(world);
  tickConsequences(world);

  const after = world.chronicle.events();
  assert.ok(after.length > before, 'offscreen events are committed, not hypothetical');
  const derived = after.find((e) => e.fromConsequenceId !== null);
  assert.ok(derived, 'the event knows which consequence produced it');
  world.close();
});

test('hidden consequences are still committed as true', () => {
  const world = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, ignoranceBudget: 99 } });
  const event = harm(world, 'char:hela-vask');
  seedConsequences(world, { events: [] } as never, [event]);

  for (let s = 1; s <= 8; s++) {
    world.session.set({ scene: s });
    tickConsequences(world);
  }
  const offscreen = world.chronicle.events({ visibility: ['offscreen-hidden', 'offscreen-discoverable'] });
  assert.ok(offscreen.length > 0, 'things happened that the player did not see');
  world.close();
});

test('chains continue at increasing depth and then terminate', () => {
  const world = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, propagationDepth: 3 } });
  const event = harm(world, 'char:brother-anselm', 1.0);
  seedConsequences(world, { events: [] } as never, [event]);

  for (let s = 1; s <= 14; s++) {
    world.session.set({ scene: s });
    tickConsequences(world);
  }
  const depths = world.consequences.all().map((c) => c.depth);
  assert.ok(Math.max(...depths) > 1, 'a real chain, not one-step reactions');
  assert.ok(Math.max(...depths) <= 3, 'and it stays inside the depth cap');
  world.close();
});

test('the ignorance budget forces traces toward the player once exceeded', () => {
  const world = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, ignoranceBudget: 0 } });
  const event = harm(world, 'char:hela-vask');
  const seeded = seedConsequences(world, { events: [] } as never, [event]);
  const offscreen = seeded.filter((c) => c.visibility !== 'onscreen');
  assert.ok(offscreen.length > 0);
  assert.ok(
    offscreen.every((c) => c.visibility === 'offscreen-discoverable'),
    'invisible coherence is the real failure mode, so stop hiding things',
  );
  world.close();
});

test('low-significance consequences expire rather than lingering', () => {
  const world = setup();
  world.consequences.enqueue({
    causeEventId: 'ev:x',
    trigger: { kind: 'after-scenes', scenes: 40 },
    actorId: 'char:hela-vask',
    action: 'spreads word of it',
    visibility: 'offscreen-hidden',
    maturity: 'pending',
    depth: 1,
    significance: 0.2,
    createdScene: 1,
  });
  world.session.set({ scene: 20 });
  const res = tickConsequences(world);
  assert.ok(res.expired.length > 0, 'most consequences should die');
  world.close();
});

// --------------------------------------------------------------- rumours

test('rumours travel along social edges and arrive distorted', () => {
  const world = setup();
  const fact = world.chronicle.addFact('the psalter was moved to the mill', 1);
  world.chronicle.setKnowledge(fact.id, 'char:brother-anselm', 'knows', 1);

  const moved = transmitRumours(world, 6);
  assert.ok(moved.length > 0, 'news spreads');
  assert.ok(moved.every((m) => m.distortion > 0), 'and it degrades in the telling');

  const knowers = world.chronicle.knowersOf(fact.id);
  assert.ok(knowers.length > 1, 'more people hold a version of it now');
  assert.ok(
    knowers.some((k) => k.entityId !== 'char:brother-anselm' && k.level !== 'knows'),
    'second-hand is suspicion, not knowledge',
  );
  world.close();
});

test('distortion compounds until people believe something simply wrong', () => {
  const world = setup();
  const fact = world.chronicle.addFact('a thing happened', 1);
  world.chronicle.setKnowledge(fact.id, 'char:brother-anselm', 'knows', 1, 0.5);
  transmitRumours(world, 8);
  const wrong = world.chronicle.knowersOf(fact.id).filter((k) => k.level === 'wrong');
  assert.ok(wrong.length > 0, 'by the third hop the story is wrong, and that is the drama');
  world.close();
});

test('a rumour never travels to someone who already holds it', () => {
  const world = setup();
  const fact = world.chronicle.addFact('a shared secret', 1);
  world.chronicle.setKnowledge(fact.id, 'char:brother-anselm', 'knows', 1);
  world.chronicle.setKnowledge(fact.id, 'char:sister-oria', 'knows', 1);
  transmitRumours(world, 8);
  const oria = world.chronicle.knowersOf(fact.id).filter((k) => k.entityId === 'char:sister-oria');
  assert.equal(oria.length, 1);
  assert.equal(oria[0]?.level, 'knows', 'existing knowledge is not downgraded by hearsay');
  world.close();
});

// ------------------------------------------------------------- world tick

test('the world advances its own agendas without the player', () => {
  const world = setup();
  const before = world.threads.open().map((t) => ({ id: t.id, tension: t.tension }));
  const notes = worldTick(world);
  assert.ok(notes.length > 0, 'something moved');
  const after = world.threads.open();
  const changed = after.some((t) => {
    const prev = before.find((b) => b.id === t.id);
    return prev && Math.abs(prev.tension - t.tension) > 1e-9;
  });
  assert.ok(changed, 'a place, not a backdrop');
  world.close();
});

test('npc agency at zero freezes the world tick', () => {
  const world = setup();
  world.session.set({ knobs: { ...world.session.get().knobs, npcAgency: 0 } });
  assert.equal(worldTick(world).length, 0);
  world.close();
});

// -------------------------------------------------------------- directives

test('a directive raises matching threads and lowers competing ones', () => {
  const world = setup();
  const dir = world.directives.create({
    text: 'turn this toward the captain searching the lower cells',
    scope: 'chapter',
    strength: 'push',
    lifetimeScenes: 5,
    status: 'active',
    createdScene: 1,
  });
  const before = new Map(world.threads.open(20).map((t) => [t.id, t.tension]));
  const diff = applyDirectiveRecalc(world, dir.id, dir.text);

  assert.ok(diff.raisedThreads.length > 0, 'the aligned thread gains pressure');
  const raisedId = diff.raisedThreads[0]!;
  assert.ok((world.threads.get(raisedId)?.tension ?? 0) > (before.get(raisedId) ?? 0));
  world.close();
});

test('a directive supersedes unaligned low-value pending consequences', () => {
  const world = setup();
  world.consequences.enqueue({
    causeEventId: 'ev:x',
    trigger: { kind: 'after-scenes', scenes: 5 },
    actorId: 'char:hela-vask',
    action: 'spreads word of it',
    visibility: 'offscreen-hidden',
    maturity: 'pending',
    depth: 1,
    significance: 0.2,
    createdScene: 1,
  });
  const dir = world.directives.create({
    text: 'focus entirely on the inspection of the cells',
    scope: 'chapter', strength: 'push', lifetimeScenes: null, status: 'active', createdScene: 1,
  });
  const diff = applyDirectiveRecalc(world, dir.id, dir.text);
  assert.ok(diff.supersededConsequences.length > 0, 'recalculation is real, not cosmetic');
  const sup = world.consequences.all().find((c) => c.maturity === 'superseded');
  assert.equal(sup?.supersededBy, dir.id, 'and it records what superseded it');
  world.close();
});

test('a directive never rewrites committed history', () => {
  const world = setup();
  const event = harm(world, 'char:novice-tem');
  const eventsBefore = world.chronicle.events().length;
  const dir = world.directives.create({
    text: 'steer toward the northern passes instead',
    scope: 'campaign', strength: 'mandate', lifetimeScenes: null, status: 'active', createdScene: 1,
  });
  applyDirectiveRecalc(world, dir.id, dir.text);
  assert.equal(world.chronicle.events().length, eventsBefore, 'directives change the future only');
  assert.ok(world.chronicle.events().some((e) => e.id === event.id), 'the past is intact');
  world.close();
});

test('directives expire once their lifetime runs out', () => {
  const world = setup();
  world.directives.create({
    text: 'temporary steering', scope: 'scene', strength: 'hint',
    lifetimeScenes: 2, status: 'active', createdScene: 1,
  });
  assert.equal(world.directives.active().length, 1);
  const expired = world.directives.expire(4);
  assert.equal(expired.length, 1, 'stale steering decays rather than accumulating');
  assert.equal(world.directives.active().length, 0);
  world.close();
});

test('a scene-3 act still has traceable descendants many scenes later', () => {
  const world = setup();
  world.session.set({ scene: 3 });
  const event = harm(world, 'char:brother-anselm', 1.0);
  seedConsequences(world, { events: [] } as never, [event]);

  for (let s = 4; s <= 20; s++) {
    world.session.set({ scene: s });
    tickConsequences(world);
  }

  // Walk the causal chain forward from the original act.
  let frontier = [event.id];
  const reached: string[] = [];
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of world.consequences.byCause(id)) {
        reached.push(c.id);
        if (c.maturity === 'fired') {
          const derived = world.chronicle.events().filter((e) => e.fromConsequenceId === c.id);
          next.push(...derived.map((e) => e.id));
        }
      }
    }
    frontier = next;
  }
  assert.ok(reached.length > 0, 'the causality map has something to draw');
  const late = world.chronicle.events().filter((e) => e.fromConsequenceId !== null && e.scene > 5);
  assert.ok(late.length > 0, 'scene-3 kindness is why scene-19 went the way it did');
  world.close();
});
