import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkOS } from '@workos-inc/node';
import { CurrentStory, CurrentWorld, World } from '../src/store/index.ts';
import { createWorldFile } from '../src/store/worlds.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';
import type { AuthConfig } from '../src/auth/config.ts';
import { SESSION_COOKIE } from '../src/auth/config.ts';

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

/**
 * Same shape, but with a real `CurrentStory` behind the server, so the
 * story-management routes (switch, in particular) can actually be exercised
 * end to end rather than against a server that always resolves the one
 * `World` it was constructed with.
 */
async function withMultiStoryServer(fn: (base: string, world: World, currentStory: CurrentStory) => Promise<void>) {
  const world = World.open(':memory:');
  seedWorld(world);
  const currentStory = new CurrentStory(world.db, world.storyId);
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({ world: () => currentStory.world(), engine, currentStory });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world, currentStory);
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

test('the regenerate endpoint rewrites prose without touching the committed delta', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i keep copying' });
    const turn = world.chronicle.turns()[0]!;
    const eventsBefore = world.chronicle.events().length;

    const res = await send(base, 'POST', `/api/turn/${encodeURIComponent(turn.id)}/regenerate`, {});
    assert.equal(res.status, 200);
    assert.ok((res.body as { bookProse: string }).bookProse.length > 0);
    assert.equal(world.chronicle.events().length, eventsBefore, 'no new event from a reroll');
    assert.deepEqual(world.chronicle.getTurn(turn.id)!.delta, turn.delta, 'what happened did not change');
  });
});

test('the regenerate endpoint refuses a pinned turn with 409, not a silent no-op', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i keep copying' });
    const turn = world.chronicle.turns()[0]!;
    await send(base, 'POST', `/api/turn/${encodeURIComponent(turn.id)}/pin`, { pinned: true });

    const res = await send(base, 'POST', `/api/turn/${encodeURIComponent(turn.id)}/regenerate`, {});
    assert.equal(res.status, 409);
    assert.equal(world.chronicle.getTurn(turn.id)?.bookProse, turn.bookProse, 'prose unchanged');
  });
});

test('the regenerate endpoint 404s on an unknown turn id', async () => {
  await withServer(async (base) => {
    const res = await send(base, 'POST', '/api/turn/turn%3Adoes-not-exist/regenerate', {});
    assert.equal(res.status, 404);
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

// ------------------------------------------------------------------ stories

test('GET /api/stories lists every story in the file, most recently played first', async () => {
  await withServer(async (base, world) => {
    const { status, body } = await get(base, '/api/stories');
    assert.equal(status, 200);
    const list = body as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, world.storyId);
  });
});

test('POST /api/stories creates a fresh story sharing canon, without switching to it', async () => {
  await withServer(async (base, world) => {
    const { status, body } = await send(base, 'POST', '/api/stories', { title: 'A second playthrough' });
    assert.equal(status, 201);
    const created = body as { id: string; title: string; forkedFrom: string | null };
    assert.equal(created.title, 'A second playthrough');
    assert.equal(created.forkedFrom, null);

    const list = (await get(base, '/api/stories')).body as Array<{ id: string }>;
    assert.equal(list.length, 2);

    // The server is still looking at the original story: creating another
    // one does not implicitly switch to it.
    const state = (await get(base, '/api/state')).body as { session: { scene: number } };
    assert.equal(state.session.scene, world.session.get().scene);
  });
});

test('POST /api/stories/fork with no atScene forks the current story fresh; with atScene, continues it', async () => {
  await withServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });

    const fresh = await send(base, 'POST', '/api/stories/fork', { title: 'fresh fork' });
    assert.equal(fresh.status, 201);
    const freshBody = fresh.body as { story: { id: string }; copiedFrom: string | null };
    assert.equal(freshBody.copiedFrom, null);
    assert.equal(world.withStory(freshBody.story.id).chronicle.turns().length, 0);

    const continued = await send(base, 'POST', '/api/stories/fork', { title: 'continued', atScene: 1 });
    assert.equal(continued.status, 201);
    const continuedBody = continued.body as { story: { id: string }; copiedFrom: string; copiedUpToScene: number };
    assert.equal(continuedBody.copiedFrom, world.storyId);
    assert.equal(continuedBody.copiedUpToScene, 1);

    // The original story is unaffected by either fork.
    assert.equal(world.chronicle.turns().length, 1);
  });
});

test('POST /api/stories/fork can branch a story other than the one currently open, via an explicit fromStoryId', async () => {
  await withMultiStoryServer(async (base, world, currentStory) => {
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    const originalStoryId = world.storyId;

    const created = (await send(base, 'POST', '/api/stories', { title: 'other' })).body as { id: string };
    // Switch away, so `originalStoryId` is no longer the server's current story.
    await send(base, 'POST', `/api/stories/${encodeURIComponent(created.id)}/switch`, {});
    assert.equal(currentStory.id(), created.id, 'current story really did move');

    const forked = await send(base, 'POST', '/api/stories/fork', {
      fromStoryId: originalStoryId,
      atScene: 2,
      title: 'branched without switching back',
    });
    assert.equal(forked.status, 201);
    const forkedBody = forked.body as { story: { id: string }; copiedFrom: string };
    assert.equal(forkedBody.copiedFrom, originalStoryId);

    // The server's current story never moved during the fork — still `created`.
    assert.equal(currentStory.id(), created.id, 'forking a non-current story does not switch to it');
    assert.equal(world.withStory(forkedBody.story.id).chronicle.turns().length, 1, "the fork copied the original story's turn");
  });
});

test('story management routes 503 when the server has no CurrentStory configured', async () => {
  await withServer(async (base) => {
    const { status, body } = await send(base, 'POST', '/api/stories/some-id/switch', {});
    assert.equal(status, 503);
    assert.match((body as { error: string }).error, /not enabled/);
  });
});

test('switching stories takes effect on the very next request, no restart', async () => {
  await withMultiStoryServer(async (base, world) => {
    await send(base, 'POST', '/api/play', { input: 'i warm the ink' });
    assert.equal(world.chronicle.turns().length, 1);

    const created = (await send(base, 'POST', '/api/stories', { title: 'second' })).body as { id: string };

    const switched = await send(base, 'POST', `/api/stories/${encodeURIComponent(created.id)}/switch`, {});
    assert.equal(switched.status, 200);
    assert.equal((switched.body as { current: string }).current, created.id);

    // The server now resolves the second story on every route, immediately.
    const state = (await get(base, '/api/state')).body as { session: { scene: number } };
    assert.equal(state.session.scene, 1, 'the fresh story starts at scene 1');

    await send(base, 'POST', '/api/play', { input: 'i check the door' });
    assert.equal(world.withStory(created.id).chronicle.turns().length, 1, 'the turn landed on the switched-to story');
    assert.equal(world.chronicle.turns().length, 1, 'the original story is untouched by anything played after the switch');
  });
});

test('switching to a story that does not exist is refused with a 404, not a silent no-op', async () => {
  await withMultiStoryServer(async (base) => {
    const { status, body } = await send(base, 'POST', '/api/stories/story%3Adoes-not-exist/switch', {});
    assert.equal(status, 404);
    assert.match((body as { error: string }).error, /no story/);
  });
});

test('PUT /api/stories/:id/title renames a story without switching to it', async () => {
  await withServer(async (base, world) => {
    const created = (await send(base, 'POST', '/api/stories', { title: 'old name' })).body as { id: string };
    const { status } = await send(base, 'PUT', `/api/stories/${encodeURIComponent(created.id)}/title`, { title: 'new name' });
    assert.equal(status, 200);
    const list = (await get(base, '/api/stories')).body as Array<{ id: string; title: string }>;
    assert.equal(list.find((s) => s.id === created.id)?.title, 'new name');
    // The current story's own title is untouched.
    assert.equal(list.find((s) => s.id === world.storyId)?.title, world.session.info().title);
  });
});

test('DELETE /api/stories/:id removes a story and everything scoped to it, but refuses the currently open one', async () => {
  await withServer(async (base, world) => {
    const created = (await send(base, 'POST', '/api/stories', { title: 'to delete' })).body as { id: string };

    const selfDelete = await send(base, 'DELETE', `/api/stories/${encodeURIComponent(world.storyId)}`);
    assert.equal(selfDelete.status, 409, 'refuses to delete the story currently open');

    const del = await send(base, 'DELETE', `/api/stories/${encodeURIComponent(created.id)}`);
    assert.equal(del.status, 200);
    const list = (await get(base, '/api/stories')).body as Array<{ id: string }>;
    assert.ok(!list.some((s) => s.id === created.id));
  });
});

test('DELETE /api/stories/:id refuses to delete the last story in a world', async () => {
  await withServer(async (base, world) => {
    const created = (await send(base, 'POST', '/api/stories', { title: 'second' })).body as { id: string };
    // Remove the original directly at the store level, so `created` becomes
    // the sole remaining story — the route itself refuses to delete
    // whichever story `world` (the server's fixed, non-switching handle in
    // this test) currently points at, so this is the only way to reach
    // "exactly one story left" without a CurrentStory-backed server.
    const { deleteStory } = await import('../src/store/world.ts');
    deleteStory(world.db, world.storyId);

    const del = await send(base, 'DELETE', `/api/stories/${encodeURIComponent(created.id)}`);
    assert.equal(del.status, 400);
    assert.match((del.body as { error: string }).error, /last story/);
  });
});

// ------------------------------------------------------ per-user stories

/**
 * A minimal fake shaped exactly like the one seam `verifySession`
 * (`src/auth/config.ts`) calls through — `workos.userManagement
 * .loadSealedSession(...).authenticate()` — mapping a request's raw
 * session-cookie *value* directly to a `SessionUser`, keyed by a plain
 * lookup table rather than any real cryptography. This tests the ownership
 * branching these routes now do, not WorkOS's own cookie-sealing (already
 * verified against a real account and a real browser login in the session
 * that added `src/auth/`) — a real `sealData`/`unsealData` round trip would
 * only re-prove code this codebase doesn't own and already trusts.
 */
function fakeAuthConfig(usersByCookie: Record<string, { id: string; email: string }>): AuthConfig {
  return {
    requireLogin: true,
    clientId: 'client_test',
    cookiePassword: 'x'.repeat(32),
    workos: {
      userManagement: {
        loadSealedSession: ({ sessionData }: { sessionData: string }) => ({
          authenticate: async () => {
            const found = usersByCookie[sessionData];
            if (!found) return { authenticated: false as const, reason: 'invalid_session_cookie' as const };
            return { authenticated: true as const, user: { ...found, firstName: null, lastName: null } };
          },
        }),
      },
    } as unknown as WorkOS,
  };
}

function cookieHeader(value: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(value)}` };
}

async function withLoginServer(
  usersByCookie: Record<string, { id: string; email: string }>,
  fn: (base: string, world: World, currentStory: CurrentStory) => Promise<void>,
) {
  const world = World.open(':memory:');
  seedWorld(world);
  const currentStory = new CurrentStory(world.db, world.storyId);
  const engine = new Engine({ world: () => currentStory.world(), providers: new ProviderRegistry(new MockProvider()) });
  const authConfig = fakeAuthConfig(usersByCookie);
  const server = createApiServer({ world: () => currentStory.world(), engine, currentStory, authConfig });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world, currentStory);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    world.close();
  }
}

test('GET /api/stories with login on returns only the calling user\u2019s own stories, never another\u2019s', async () => {
  await withLoginServer(
    { 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' }, 'bob-cookie': { id: 'user_bob', email: 'bob@x.com' } },
    async (base) => {
      // Each user's first request auto-creates their own story (worldFor -> resolveOrCreateStoryForUser).
      const aliceHeaders = cookieHeader('alice-cookie');
      const bobHeaders = cookieHeader('bob-cookie');
      await fetch(`${base}/api/state`, { headers: aliceHeaders }); // touches/creates alice's story
      await fetch(`${base}/api/state`, { headers: bobHeaders }); // touches/creates bob's story

      const aliceList = await fetch(`${base}/api/stories`, { headers: aliceHeaders });
      const aliceStories = (await aliceList.json()) as Array<{ ownerUserId: string | null }>;
      assert.equal(aliceStories.length, 1);
      assert.equal(aliceStories[0]?.ownerUserId, 'user_alice');

      const bobList = await fetch(`${base}/api/stories`, { headers: bobHeaders });
      const bobStories = (await bobList.json()) as Array<{ ownerUserId: string | null }>;
      assert.equal(bobStories.length, 1);
      assert.equal(bobStories[0]?.ownerUserId, 'user_bob');
    },
  );
});

test('a request with no session gets 401 on an API route when login is required', async () => {
  await withLoginServer({ 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' } }, async (base) => {
    const res = await fetch(`${base}/api/stories`);
    assert.equal(res.status, 401);
  });
});

test('POST /api/stories with login on attributes the new story to the calling user', async () => {
  await withLoginServer({ 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' } }, async (base) => {
    const res = await fetch(`${base}/api/stories`, {
      method: 'POST',
      headers: { ...cookieHeader('alice-cookie'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'alice\u2019s new story' }),
    });
    const body = (await res.json()) as { ownerUserId: string | null };
    assert.equal(body.ownerUserId, 'user_alice');
  });
});

test('renaming, deleting, or switching to another user\u2019s story is refused with 403', async () => {
  await withLoginServer(
    { 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' }, 'bob-cookie': { id: 'user_bob', email: 'bob@x.com' } },
    async (base) => {
      const aliceHeaders = { ...cookieHeader('alice-cookie'), 'content-type': 'application/json' };
      const bobHeaders = { ...cookieHeader('bob-cookie'), 'content-type': 'application/json' };
      const bobHeadersNoContentType = cookieHeader('bob-cookie');

      const created = await fetch(`${base}/api/stories`, { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ title: 'alice only' }) });
      const alicesStory = (await created.json()) as { id: string };

      const renameAttempt = await fetch(`${base}/api/stories/${encodeURIComponent(alicesStory.id)}/title`, {
        method: 'PUT',
        headers: bobHeaders,
        body: JSON.stringify({ title: 'hijacked' }),
      });
      assert.equal(renameAttempt.status, 403);

      const deleteAttempt = await fetch(`${base}/api/stories/${encodeURIComponent(alicesStory.id)}`, {
        method: 'DELETE',
        headers: bobHeadersNoContentType,
      });
      assert.equal(deleteAttempt.status, 403);

      const switchAttempt = await fetch(`${base}/api/stories/${encodeURIComponent(alicesStory.id)}/switch`, {
        method: 'POST',
        headers: bobHeadersNoContentType,
      });
      assert.equal(switchAttempt.status, 403);

      // Alice herself, meanwhile, may do all three.
      const aliceRename = await fetch(`${base}/api/stories/${encodeURIComponent(alicesStory.id)}/title`, {
        method: 'PUT',
        headers: aliceHeaders,
        body: JSON.stringify({ title: 'still alice\u2019s' }),
      });
      assert.equal(aliceRename.status, 200);
    },
  );
});

test('forking another user\u2019s story is refused with 403, forking one\u2019s own succeeds and is owned by the forker', async () => {
  await withLoginServer(
    { 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' }, 'bob-cookie': { id: 'user_bob', email: 'bob@x.com' } },
    async (base) => {
      const aliceHeaders = { ...cookieHeader('alice-cookie'), 'content-type': 'application/json' };
      const bobHeaders = { ...cookieHeader('bob-cookie'), 'content-type': 'application/json' };

      const created = await fetch(`${base}/api/stories`, { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ title: 'alice source' }) });
      const alicesStory = (await created.json()) as { id: string };

      const bobForkAttempt = await fetch(`${base}/api/stories/fork`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ fromStoryId: alicesStory.id }),
      });
      assert.equal(bobForkAttempt.status, 403);

      const aliceForkOwn = await fetch(`${base}/api/stories/fork`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ fromStoryId: alicesStory.id, title: 'alice\u2019s fork' }),
      });
      assert.equal(aliceForkOwn.status, 201);
      const forkBody = (await aliceForkOwn.json()) as { story: { ownerUserId: string | null } };
      assert.equal(forkBody.story.ownerUserId, 'user_alice');
    },
  );
});

test('an unowned story (created before login existed) is invisible to a logged-in user\u2019s list, but ownsStoryOrRespond still allows acting on it', async () => {
  await withLoginServer({ 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' } }, async (base, world) => {
    const { createStory } = await import('../src/store/world.ts');
    const unowned = createStory(world.db, { title: 'pre-login save' }); // no ownerUserId

    const list = await fetch(`${base}/api/stories`, { headers: cookieHeader('alice-cookie') });
    const stories = (await list.json()) as Array<{ id: string }>;
    assert.ok(!stories.some((s) => s.id === unowned.id), 'an unowned story never appears in a logged-in user\u2019s own list');

    // Not exclusively anyone's, so not yet a 403 either — see ownsStoryOrRespond's own doc comment.
    const rename = await fetch(`${base}/api/stories/${encodeURIComponent(unowned.id)}/title`, {
      method: 'PUT',
      headers: { ...cookieHeader('alice-cookie'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    });
    assert.equal(rename.status, 200);
  });
});

/**
 * The actual claim this whole feature makes, proven directly: two logged-in
 * users each play a turn through the real turn-taking route — not the
 * story-management routes above — and end up with completely separate
 * chronicles, on separate auto-created stories, sharing only canon. This is
 * what `engine.takeTurn`'s `world` override (`TakeTurnOptions.world`,
 * wired in `/api/play`) actually exists for: without it, both of these
 * calls would have landed on whichever story `CurrentStory`'s legacy shared
 * pointer happened to resolve to, and alice's turn could have been written
 * into bob's story or vice versa depending on request order.
 */
test('two logged-in users playing a turn each land on their own separate story, never each other\u2019s', async () => {
  await withLoginServer(
    { 'alice-cookie': { id: 'user_alice', email: 'alice@x.com' }, 'bob-cookie': { id: 'user_bob', email: 'bob@x.com' } },
    async (base, world) => {
      const aliceHeaders = { ...cookieHeader('alice-cookie'), 'content-type': 'application/json' };
      const bobHeaders = { ...cookieHeader('bob-cookie'), 'content-type': 'application/json' };

      const aliceTurn = await fetch(`${base}/api/play`, { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ input: 'i warm the ink and keep copying' }) });
      assert.equal(aliceTurn.status, 200);
      const bobTurn = await fetch(`${base}/api/play`, { method: 'POST', headers: bobHeaders, body: JSON.stringify({ input: 'i wait for the captain' }) });
      assert.equal(bobTurn.status, 200);

      const aliceStories = (await (await fetch(`${base}/api/stories`, { headers: cookieHeader('alice-cookie') })).json()) as Array<{ id: string }>;
      const bobStories = (await (await fetch(`${base}/api/stories`, { headers: cookieHeader('bob-cookie') })).json()) as Array<{ id: string }>;
      assert.equal(aliceStories.length, 1);
      assert.equal(bobStories.length, 1);
      assert.notEqual(aliceStories[0]?.id, bobStories[0]?.id, 'each landed on their own auto-created story');

      // Read the chronicle directly, at the store level, for both stories —
      // the one place that can prove no cross-contamination happened, since
      // the API's own per-request resolution is exactly the mechanism under test.
      const aliceWorld = world.withStory(aliceStories[0]!.id);
      const bobWorld = world.withStory(bobStories[0]!.id);
      assert.equal(aliceWorld.chronicle.turns().length, 1);
      assert.equal(bobWorld.chronicle.turns().length, 1);
      assert.equal(aliceWorld.chronicle.turns()[0]?.rawInput, 'i warm the ink and keep copying');
      assert.equal(bobWorld.chronicle.turns()[0]?.rawInput, 'i wait for the captain');
    },
  );
});

/**
 * `/api/meta` exists so a stale server is diagnosable. The web client is a
 * static bundle, so rebuilding `dist/` while an old server keeps running
 * produces a UI whose newer controls 404 — which is how
 * `no route for POST /api/stories` was first seen, from a Stories tab that
 * rendered perfectly.
 */
test('the meta endpoint reports the route inventory this build serves', async () => {
  await withServer(async (base) => {
    const { status, body } = await get(base, '/api/meta');
    assert.equal(status, 200);
    const routes = body.routes as string[];

    assert.ok(routes.length > 40, `expected a real inventory, got ${routes.length}`);
    assert.ok(routes.includes('GET /api/meta'), 'it reports itself');
    // The routes whose absence produced the original confusing 404.
    for (const r of ['GET /api/stories', 'POST /api/stories', 'DELETE /api/stories/:id']) {
      assert.ok(routes.includes(r), `${r} missing from the inventory`);
    }
    // Parameterised paths are reported in their literal `:param` form, not as a
    // compiled regex, so a client can compare them by string equality.
    assert.ok(routes.includes('POST /api/stories/:id/switch'));
    assert.deepEqual([...routes].sort(), routes, 'sorted, so two servers can be diffed by eye');
    assert.match(String(body.startedAt), /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('every route the inventory advertises is actually dispatchable', async () => {
  await withServer(async (base) => {
    const { body } = await get(base, '/api/meta');
    // A GET with no parameters must not 404. This catches an inventory that
    // drifts from the table it is generated from — the failure the endpoint
    // exists to prevent, turned back on itself.
    const simpleGets = (body.routes as string[])
      .filter((r) => r.startsWith('GET /') && !r.includes(':'))
      .map((r) => r.slice('GET '.length));
    assert.ok(simpleGets.length > 10);
    for (const path of simpleGets) {
      const res = await fetch(`${base}${path}`);
      assert.notEqual(res.status, 404, `${path} is advertised but not dispatchable`);
    }
  });
});

/**
 * The freshness check is only useful if its own list is right. A typo or a
 * renamed route in `REQUIRED_ROUTES` would fire the "this page is newer than the
 * server" banner permanently against a perfectly healthy server — a false alarm
 * in the mechanism whose entire job is telling the truth about staleness.
 */
test('every route the web client demands is actually served', async () => {
  const { REQUIRED_ROUTES } = await import('../web/src/api.ts');
  await withServer(async (base) => {
    const { body } = await get(base, '/api/meta');
    const served = new Set(body.routes as string[]);
    const missing = REQUIRED_ROUTES.filter((r) => !served.has(r));
    assert.deepEqual(missing, [], `the client would warn about routes that do exist: ${missing.join(', ')}`);
  });
});

// ------------------------------------------------------------------- worlds
//
// The file-level layer. Unlike the story routes, these need a real directory on
// disk, because a world *is* a directory — so this harness uses a temp root
// rather than `:memory:`.

async function withWorldServer(
  fn: (base: string, cw: CurrentWorld, root: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-api-worlds-'));
  createWorldFile('First World', root);
  const cw = CurrentWorld.open('first-world', root);
  const engine = new Engine({ world: cw.world, providers: new ProviderRegistry(new MockProvider()) });
  const server = createApiServer({
    world: cw.world,
    engine,
    currentStory: cw.stories(),
    currentWorld: cw,
    dataRoot: root,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, cw, root);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cw.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('the worlds list flags which one is open', async () => {
  await withWorldServer(async (base) => {
    await send(base, 'POST', '/api/worlds', { title: 'Second World' });
    const { status, body } = await get(base, '/api/worlds');
    assert.equal(status, 200);
    const { current, worlds } = body as { current: string; worlds: Array<{ slug: string; current: boolean }> };
    assert.equal(current, 'first-world');
    // The whole point: without a per-row flag the UI cannot tell the open world
    // from the others, which is what made switching look like it did not exist.
    assert.deepEqual(
      worlds.filter((w) => w.current).map((w) => w.slug),
      ['first-world'],
    );
    assert.equal(worlds.length, 2);
  });
});

test('creating a world does not switch to it', async () => {
  await withWorldServer(async (base, cw) => {
    const { status } = await send(base, 'POST', '/api/worlds', { title: 'Elsewhere' });
    assert.equal(status, 201);
    // An accidental click must not navigate away from an in-progress scene.
    assert.equal(cw.slug(), 'first-world', 'still in the world we were reading');
  });
});

test('switching worlds takes effect on the very next request', async () => {
  await withWorldServer(async (base, cw, root) => {
    // Give the second world distinct canon, so a leak would be visible.
    const other = createWorldFile('Other', root);
    const w = World.open(other.dbPath, undefined, other.imagesDir);
    w.graph.upsert({ id: 'char:zed', type: 'Character', name: 'Zed' }, 'canon');
    w.chronicle.setMeta('worldTitle', 'Other');
    w.close();

    const before = await get(base, '/api/state');
    assert.notEqual((before.body as { worldTitle: string }).worldTitle, 'Other');

    const sw = await send(base, 'POST', '/api/worlds/other/switch');
    assert.equal(sw.status, 200);
    assert.equal(cw.slug(), 'other');

    // Through the plain `world` getter every route holds — not via cw directly.
    const after = await get(base, '/api/state');
    assert.equal((after.body as { worldTitle: string }).worldTitle, 'Other', 'no restart needed');
  });
});

test('switching to a world that does not exist 404s and changes nothing', async () => {
  await withWorldServer(async (base, cw) => {
    const { status } = await send(base, 'POST', '/api/worlds/ghost/switch');
    assert.equal(status, 404);
    assert.equal(cw.slug(), 'first-world');
    // The server must still be serving: a close-then-fail-to-open would leave
    // every later request broken until a restart.
    const state = await get(base, '/api/state');
    assert.equal(state.status, 200, 'the open world still answers');
  });
});

test('a world cannot be deleted while it is open', async () => {
  await withWorldServer(async (base) => {
    await send(base, 'POST', '/api/worlds', { title: 'Spare' });
    const { status, body } = await send(base, 'DELETE', '/api/worlds/first-world');
    assert.equal(status, 409);
    assert.match((body as { error: string }).error, /currently open/);
  });
});

test('the only world cannot be deleted, so there is always somewhere to land', async () => {
  await withWorldServer(async (base) => {
    const { status, body } = await send(base, 'DELETE', '/api/worlds/first-world');
    assert.equal(status, 409);
    assert.match((body as { error: string }).error, /only world/);
  });
});

test('deleting another world removes it from the list', async () => {
  await withWorldServer(async (base) => {
    await send(base, 'POST', '/api/worlds', { title: 'Doomed' });
    const del = await send(base, 'DELETE', '/api/worlds/doomed');
    assert.equal(del.status, 200);
    const { body } = await get(base, '/api/worlds');
    assert.deepEqual((body as { worlds: Array<{ slug: string }> }).worlds.map((w) => w.slug), ['first-world']);
  });
});

test('renaming a world updates the title reported by state', async () => {
  await withWorldServer(async (base) => {
    const { status } = await send(base, 'PUT', '/api/worlds/first-world/title', { title: 'Renamed' });
    assert.equal(status, 200);
    const { body } = await get(base, '/api/state');
    assert.equal((body as { worldTitle: string }).worldTitle, 'Renamed');
  });
});

test('world routes 503 when the server has no CurrentWorld configured', async () => {
  await withServer(async (base) => {
    // Same contract as the story routes: a server built without world
    // management says so plainly rather than 404ing or half-working.
    for (const [method, path] of [
      ['POST', '/api/worlds'],
      ['POST', '/api/worlds/x/switch'],
      ['DELETE', '/api/worlds/x'],
    ] as const) {
      const { status } = await send(base, method, path, {});
      assert.equal(status, 503, `${method} ${path}`);
    }
  });
});

test('the stories list flags the one being read', async () => {
  await withMultiStoryServer(async (base, world) => {
    const created = await send(base, 'POST', '/api/stories', { title: 'another' });
    const { body } = await get(base, '/api/stories');
    const rows = body as Array<{ id: string; current: boolean }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.filter((r) => r.current).map((r) => r.id),
      [world.storyId],
      'exactly the open story is flagged, so the UI can stop showing identical rows',
    );
    assert.ok(rows.some((r) => r.id === (created.body as { id: string }).id));
  });
});
