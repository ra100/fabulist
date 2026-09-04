import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';

async function withServer(fn: (base: string, world: World) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

const get = async (base: string, path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};
const send = async (base: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
};

test('state endpoint reports the world at a glance', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/state');
    assert.equal(status, 200);
    const s = body as Record<string, unknown>;
    assert.equal((s.session as { scene: number }).scene, 1);
    assert.ok((s.counts as { entities: number }).entities > 15);
    assert.ok((s.threads as unknown[]).length >= 3);
  });
});

test('graph endpoint filters by layer so canon is distinguishable', async () => {
  await withServer(async (base) => {
    const all = await get(base, '/api/graph');
    const canon = await get(base, '/api/graph?layer=canon');
    assert.ok((all.body as { entities: unknown[] }).entities.length > 0);
    assert.ok((canon.body as { entities: unknown[] }).entities.length > 0);
    const edges = (all.body as { edges: Array<{ subject: string; object: string }> }).edges;
    const ids = new Set((all.body as { entities: Array<{ id: string }> }).entities.map((e) => e.id));
    assert.ok(edges.every((e) => ids.has(e.subject) && ids.has(e.object)), 'no dangling edges in the view');
  });
});

test('entity endpoint returns the sheet, both edge directions, and knowledge', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/entity/char:brother-anselm');
    assert.equal(status, 200);
    const b = body as Record<string, unknown>;
    assert.ok(b.sheet, 'sheet included');
    assert.ok((b.edgesOut as unknown[]).length > 0);
    assert.ok((b.edgesIn as unknown[]).length > 0);
    assert.ok((b.knowledge as unknown[]).length > 0, 'epistemic state is inspectable');
    assert.ok((b.relationshipsToward as unknown[]).length > 0, 'asymmetry is visible');
  });
});

test('unknown entity is a 404, not a silent empty object', async () => {
  await withServer(async (base) => {
    const { status } = await get(base, '/api/entity/char:nobody');
    assert.equal(status, 404);
  });
});

test('playing a turn through the api commits and reports what it set in motion', async () => {
  await withServer(async (base, world) => {
    const { status, body } = await send(base, 'POST', '/api/play', { input: 'i hide the psalter under the loose flag' });
    assert.equal(status, 200);
    const b = body as { outcome: { kind: string }; seeded: number; tick: unknown };
    assert.equal(b.outcome.kind, 'narrated');
    assert.equal(world.chronicle.turns().length, 1);
    assert.ok(typeof b.seeded === 'number', 'reports how many consequences were seeded');
    assert.ok(b.tick !== null, 'and what the queue did');
  });
});

test('a vow breach returns the interrupt without committing', async () => {
  await withServer(async (base, world) => {
    const { body } = await send(base, 'POST', '/api/play', { input: 'i stab the captain' });
    const b = body as { outcome: { kind: string; interrupt?: { options: unknown[] } } };
    assert.equal(b.outcome.kind, 'interrupted');
    assert.ok((b.outcome.interrupt?.options.length ?? 0) >= 4, 'the player is offered routes');
    assert.equal(world.chronicle.turns().length, 0, 'nothing was written');
  });
});

test('the same input with an override goes through', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i stab the captain' });
    const { body } = await send(base, 'POST', '/api/play', { input: 'i stab the captain', overrideIntegrity: true });
    assert.equal((body as { outcome: { kind: string } }).outcome.kind, 'narrated');
    assert.equal(world.cast.get('char:brother-anselm')?.contract.vows[0]?.broken, true);
  });
});

test('empty input is rejected', async () => {
  await withServer(async (base) => {
    const { status } = await send(base, 'POST', '/api/play', { input: '   ' });
    assert.equal(status, 400);
  });
});

test('a directive returns the recalculation diff rather than moving things silently', async () => {
  await withServer(async (base) => {
    const { status, body } = await send(base, 'POST', '/api/directive', {
      text: 'turn this toward the captain searching the lower cells',
      strength: 'push',
    });
    assert.equal(status, 200);
    const b = body as { diff: { raisedThreads: string[]; raisedThreadTitles: string[] } };
    assert.ok(b.diff.raisedThreads.length > 0, 'something actually moved');
    assert.ok(b.diff.raisedThreadTitles.every((t) => typeof t === 'string' && t.length > 0), 'named, not just ids');
  });
});

test('locking a sheet field makes it survive an AI update', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/sheet/char:brother-anselm/lock', { path: 'condition.mood' });
    const sheet = world.cast.get('char:brother-anselm')!;
    assert.ok(sheet.locks.includes('condition.mood'));
    world.cast.updateCondition('char:brother-anselm', { mood: 'euphoric' });
    assert.equal(world.cast.get('char:brother-anselm')?.condition.mood, sheet.condition.mood);

    await send(base, 'POST', '/api/sheet/char:brother-anselm/lock', { path: 'condition.mood', locked: false });
    assert.ok(!world.cast.get('char:brother-anselm')!.locks.includes('condition.mood'));
  });
});

test('style and knobs round-trip through the api', async () => {
  await withServer(async (base, world) => {
    const style = await send(base, 'PUT', '/api/style', { genreLens: 'noir', pov: 'first', sceneTarget: 500 });
    assert.equal((style.body as { genreLens: string }).genreLens, 'noir');
    assert.equal(world.session.get().style.pov, 'first');
    assert.equal(world.session.get().style.register, 'plain', 'untouched fields are preserved');

    const knobs = await send(base, 'PUT', '/api/knobs', { characterStrictness: 'iron', danger: 0.9 });
    assert.equal((knobs.body as { characterStrictness: string }).characterStrictness, 'iron');
    assert.equal(world.session.get().knobs.propagationDepth, 3, 'other knobs unchanged');
  });
});

test('pinned prose survives a re-render attempt', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    const turn = world.chronicle.turns()[0]!;
    await send(base, 'POST', `/api/turn/${encodeURIComponent(turn.id)}/pin`, { pinned: true });
    world.chronicle.setProse(turn.id, 'something worse');
    assert.equal(world.chronicle.getTurn(turn.id)?.bookProse, turn.bookProse);
  });
});

test('the book endpoint returns both registers per turn', async () => {
  await withServer(async (base) => {
    await send(base, 'POST', '/api/play', { input: 'i tell tem to fetch water' });
    const { body } = await get(base, '/api/book');
    const turns = (body as { turns: Array<{ rawInput: string; bookProse: string }> }).turns;
    assert.equal(turns.length, 1);
    assert.match(turns[0]!.rawInput, /fetch water/, 'the note survives');
    assert.ok(turns[0]!.bookProse.length > 0, 'and the prose exists alongside it');
  });
});

test('causality endpoint links acts to what they seeded', async () => {
  await withServer(async (base) => {
    await send(base, 'POST', '/api/play', { input: 'i hide the psalter and lie to the prior about it' });
    await send(base, 'POST', '/api/tick');
    const { body } = await get(base, '/api/causality');
    const b = body as { nodes: unknown[]; links: Array<{ kind: string }> };
    assert.ok(b.nodes.length > 0);
    if (b.links.length) assert.ok(b.links.some((l) => l.kind === 'seeds'), 'the chain is drawable');
  });
});

test('facts endpoint exposes who knows what, including partial knowledge', async () => {
  await withServer(async (base) => {
    const { body } = await get(base, '/api/facts');
    const facts = body as Array<{ text: string; knowers: Array<{ level: string; name: string }> }>;
    assert.ok(facts.length >= 3);
    const route = facts.find((f) => /over the pass/.test(f.text))!;
    assert.ok(route.knowers.some((k) => k.level === 'knows'));
    assert.ok(route.knowers.some((k) => k.level === 'suspects'), 'suspicion is distinct from knowledge');
  });
});

test('search finds entities by loose name', async () => {
  await withServer(async (base) => {
    const { body } = await get(base, '/api/search?q=sered');
    assert.ok((body as unknown[]).length > 0);
  });
});

test('compaction can be triggered and reports what it summarised', async () => {
  await withServer(async (base, world) => {
    // Two turns in scene 1, then move on so scene 1 counts as closed.
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    await send(base, 'POST', '/api/play', { input: 'i check the door' });
    world.session.set({ scene: 2, turn: 0 });

    const { status, body } = await send(base, 'POST', '/api/compact', {});
    assert.equal(status, 200);
    assert.deepEqual((body as { scenesSummarised: number[] }).scenesSummarised, [1]);
    const summary = world.chronicle.scenes().find((s) => s.scene === 1)?.summary;
    assert.ok(summary && /char:/.test(summary), 'the summary keeps ids so the graph stays walkable');
  });
});

test('branching an in-memory save is refused rather than silently doing nothing', async () => {
  await withServer(async (base) => {
    const { status, body } = await send(base, 'POST', '/api/branch', { atScene: 2, toPath: '/tmp/nope.db' });
    assert.equal(status, 400);
    assert.match((body as { error: string }).error, /in-memory/);
  });
});

test('branch requires both a scene and a destination', async () => {
  await withServer(async (base) => {
    const { status } = await send(base, 'POST', '/api/branch', { atScene: 2 });
    assert.equal(status, 400);
  });
});

test('chapters endpoint exposes the compaction hierarchy', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/chapters');
    assert.equal(status, 200);
    const b = body as { chapters: unknown[]; scenes: unknown[] };
    assert.ok(Array.isArray(b.chapters));
    assert.ok((b.scenes as unknown[]).length > 0);
  });
});

test('scene close advances the scene and summarises what closed, the UI equivalent of /scene', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    await send(base, 'POST', '/api/play', { input: 'i check the door' });
    assert.equal(world.session.get().scene, 1);

    const { status, body } = await send(base, 'POST', '/api/scene/close');
    assert.equal(status, 200);
    const b = body as { closedScene: number; nowScene: number; summary: string | null; scenesSummarised: number[] };
    assert.equal(b.closedScene, 1);
    assert.equal(b.nowScene, 2);
    assert.deepEqual(b.scenesSummarised, [1]);
    assert.ok(b.summary && /char:/.test(b.summary));
    assert.equal(world.session.get().scene, 2);
    assert.equal(world.session.get().turn, 0);
  });
});

test('state endpoint accumulates provider usage across turns', async () => {
  await withServer(async (base) => {
    const before = await get(base, '/api/state');
    assert.equal((before.body as { usage: { calls: number } }).usage.calls, 0);

    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    await send(base, 'POST', '/api/play', { input: 'i check the door' });

    const { body } = await get(base, '/api/state');
    const usage = (body as { usage: { tokensIn: number; tokensOut: number; calls: number; byRole: Record<string, unknown> } }).usage;
    assert.ok(usage.calls > 0, 'two turns make more than zero provider calls');
    assert.ok(usage.tokensIn > 0);
    assert.ok(usage.tokensOut > 0);
    assert.ok(Object.keys(usage.byRole).length > 0);
  });
});

test('an unknown api route is a clear 404', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/nope');
    assert.equal(status, 404);
    assert.match((body as { error: string }).error, /no route/);
  });
});

test('a path traversal attempt cannot escape the web root', async () => {
  const world = World.open(':memory:');
  seedWorld(world);
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world, engine, webRoot: 'web/dist' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/../../package.json`);
  const text = await res.text();
  assert.ok(!text.includes('"name": "fabulist"'), 'must not serve files outside the root');
  await new Promise<void>((r) => server.close(() => r()));
  world.close();
});
