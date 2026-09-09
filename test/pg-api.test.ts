/**
 * The HTTP layer on Postgres, over a real listening server.
 *
 * These matter more than their line count suggests, because `api-pg.ts` is where
 * the *shape* of the app changed rather than just its await keywords. Three
 * properties are worth an automated test rather than a manual check:
 *
 *   - **Per-request story resolution.** `CurrentStory`/`CurrentWorld` were
 *     process-level mutable singletons, so one client's switch changed what every
 *     other request read. Two concurrent "users" here must see their own stories,
 *     which is the thing that was unrepresentable before and is now structural.
 *   - **The reset split.** `POST /api/setup/reset` and `POST /api/canon/rebuild`
 *     must each do exactly half of what the old single `reset()` did — that split
 *     is the reason for the migration, so it is tested through the routes a client
 *     actually calls.
 *   - **Crossover over HTTP.** `PUT /api/story/sources` replaced a world *switch*
 *     with a per-story *list*, and a story pointed at two worlds must read both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeWorld, withPg } from './pg-harness.ts';
import { World, createWorld, worldFor } from '../src/store/index-pg.ts';
import { claimUnownedStories, createStory, listStories } from '../src/store/world-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import type { Db } from '../src/db/pg.ts';
import type { SessionUser } from '../src/auth/config.ts';

/**
 * A server over the test schema, with a fixed boot world.
 *
 * `user` is injected rather than authenticated: the session gate is orthogonal to
 * everything being tested here, and `test/api.test.ts` already covers it on the
 * SQLite side. What matters is that the *dispatcher* resolves a world from
 * whichever user it is handed.
 */
async function withServer(
  db: Db,
  fn: (base: string, world: World, setup: SetupService) => Promise<void>,
  opts: { seed?: boolean } = {},
): Promise<void> {
  const worldId = await makeWorld(db, 'verrow', 'Saint Verrow');
  const story = await createStory(db, { title: 'A story', worldIds: [worldId] });
  const world = await World.forStory(db, story.id);
  if (opts.seed !== false) await seedWorld(world);

  const providers = new ProviderRegistry(new MockProvider());
  const engine = new Engine({ world: () => world, db, providers });
  const setup = new SetupService({ world: () => world, db, providers });
  const server = createApiServer({ world: () => world, db, engine, setup });
  await listen(server);
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, world, setup);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
}

/**
 * A parsed JSON response.
 *
 * `body` is deliberately untyped. These tests assert against real route payloads
 * whose shapes vary per route, and restating each one here would duplicate the API
 * surface without catching anything the assertions do not already check — the
 * assertions *are* the shape check, and they run against the real server.
 */
// biome-ignore lint/suspicious/noExplicitAny: a test-local reader over heterogeneous route payloads
type Res = { status: number; body: any };

async function get(base: string, path: string): Promise<Res> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function send(
  base: string,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

test('state, cast, threads and the book all serve from Postgres', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base) => {
      const state = await get(base, '/api/state');
      assert.equal(state.status, 200);
      assert.ok(state.body.session.playerCharacterId, 'the seeded player should be in the session');
      assert.ok(state.body.counts.canon > 10, `expected populated canon, got ${JSON.stringify(state.body.counts)}`);

      const cast = await get(base, '/api/cast');
      assert.equal(cast.status, 200);
      assert.ok(cast.body.length > 0);
      // The entity is joined onto each sheet — the read that used to be one query
      // per sheet and is now one batch.
      assert.ok(cast.body[0].entity?.name, 'each sheet should carry its entity');

      const threads = await get(base, '/api/threads');
      assert.equal(threads.status, 200);
      assert.ok(threads.body.length > 0, 'the sample has open threads');

      assert.equal((await get(base, '/api/facts')).status, 200);
      assert.equal((await get(base, '/api/consequences')).status, 200);
      assert.equal((await get(base, '/api/causality')).status, 200);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a turn plays over HTTP and persists', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base, world) => {
      const played = await send(base, 'POST', '/api/play', { input: 'i warm the ink and keep copying' });
      assert.equal(played.status, 200);
      assert.equal(played.body.outcome.kind, 'narrated', JSON.stringify(played.body).slice(0, 300));
      assert.ok(played.body.outcome.prose.length > 0);

      // Persisted, not merely returned.
      const turns = await world.chronicle.turns();
      assert.equal(turns.length, 1);
      const book = await get(base, '/api/book?limit=5');
      assert.equal(book.body.turns.length, 1);
      assert.equal(book.body.turns[0].bookProse, played.body.outcome.prose);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('two users get their own stories from the same server, concurrently', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'shared', 'Shared World');
    const alice: SessionUser = { id: 'user:alice', email: 'alice@example.com', firstName: 'Alice', lastName: null, isAdmin: false };
    const bob: SessionUser = { id: 'user:bob', email: 'bob@example.com', firstName: 'Bob', lastName: null, isAdmin: false };
    const aliceStory = await createStory(db, { title: "Alice's book", worldIds: [worldId], ownerUserId: alice.id });
    const bobStory = await createStory(db, { title: "Bob's book", worldIds: [worldId], ownerUserId: bob.id });

    // The property the singletons made impossible: resolution is a pure function of
    // who is asking, so two requests interleaved in any order still land on their
    // own story. Exercised through `worldFor` directly, which is exactly what the
    // dispatcher calls per request.
    const [a, b, a2] = await Promise.all([
      worldFor(db, alice),
      worldFor(db, bob),
      worldFor(db, alice),
    ]);
    assert.equal(a.storyId, aliceStory.id);
    assert.equal(b.storyId, bobStory.id);
    assert.equal(a2.storyId, aliceStory.id, 'resolution must not depend on interleaving');

    // And a story that is not yours is not reachable by asking for it. It throws
    // rather than silently falling back to your own — a fallback would turn an
    // attempt to read someone else's book into a successful-looking request, which
    // is exactly the kind of failure that never gets noticed.
    await assert.rejects(
      () => worldFor(db, bob, { storyIdOverride: aliceStory.id }),
      /does not belong to this user/,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PUT /api/story/sources assembles a crossover that reads both worlds', async (t) => {
  const ran = await withPg(async (db) => {
    // Two canon worlds with a character each, plus one colliding id so precedence
    // is actually exercised rather than assumed.
    const hp = await createWorld(db, 'Potter');
    const me = await createWorld(db, 'Middle-earth');
    for (const [id, name, worldId] of [
      ['char:harry', 'Harry Potter', hp.id],
      ['loc:shared', 'Hogwarts', hp.id],
      ['char:frodo', 'Frodo Baggins', me.id],
      ['loc:shared', 'The Shire', me.id],
    ] as const) {
      await db.query(
        `INSERT INTO canon_entities (world_id, id, type, name, summary, provenance, salience)
         VALUES ($1,$2,$3,$4,'','authored',1)`,
        [worldId, id, id.startsWith('char') ? 'Character' : 'Location', name],
      );
    }
    const story = await createStory(db, { title: 'Crossover', worldIds: [hp.id] });
    const world = await World.forStory(db, story.id);
    const providers = new ProviderRegistry(new MockProvider());
    const engine = new Engine({ world: () => world, db, providers });
    const server = createApiServer({ world: () => world, db, engine });
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Only Potter to begin with.
      assert.equal((await get(base, '/api/search?q=Frodo')).body.length, 0);

      const set = await send(base, 'PUT', '/api/story/sources', { slugs: ['potter', 'middle-earth'] });
      assert.equal(set.status, 200);
      assert.deepEqual(set.body.sources.map((s: { ordinal: number }) => s.ordinal), [1, 2]);

      // A fresh World for the same story now composes both.
      const crossover = await World.forStory(db, story.id);
      assert.equal((await crossover.graph.get('char:harry'))?.name, 'Harry Potter');
      assert.equal((await crossover.graph.get('char:frodo'))?.name, 'Frodo Baggins');
      // The colliding id resolves to the primary source, which is what ordinal
      // means: the first world listed wins.
      assert.equal((await crossover.graph.get('loc:shared'))?.name, 'Hogwarts');

      // Reversing precedence flips exactly that, and nothing else.
      await send(base, 'PUT', '/api/story/sources', { slugs: ['middle-earth', 'potter'] });
      const reversed = await World.forStory(db, story.id);
      assert.equal((await reversed.graph.get('loc:shared'))?.name, 'The Shire');
      assert.equal((await reversed.graph.get('char:harry'))?.name, 'Harry Potter', 'both worlds still readable');

      assert.equal((await send(base, 'PUT', '/api/story/sources', { slugs: ['nope'] })).status, 404);
      assert.equal((await send(base, 'PUT', '/api/story/sources', { slugs: [] })).status, 400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the reset split: /api/setup/reset keeps canon, /api/canon/rebuild keeps prose', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base, world) => {
      await send(base, 'POST', '/api/play', { input: 'i trim the wick' });
      const canonBefore = (await world.graph.counts()).canon;
      assert.ok(canonBefore > 10);
      assert.equal((await world.chronicle.turns()).length, 1);

      // Half one: my story goes, canon stays.
      const reset = await send(base, 'POST', '/api/setup/reset');
      assert.equal(reset.status, 200);
      assert.ok(reset.body.storyId, 'a replacement story is returned to land on');
      const fresh = await World.forStory(db, reset.body.storyId);
      assert.equal((await fresh.graph.counts()).canon, canonBefore, 'canon survives a story reset');
      assert.equal((await fresh.chronicle.turns()).length, 0, 'the new story is empty');

      // Half two: canon goes, stories stay. Written against the *new* story so
      // there is prose to preserve.
      await send(base, 'POST', '/api/play', { input: 'i look up' });
      const storiesBefore = (await listStories(db)).length;
      const rebuild = await send(base, 'POST', '/api/canon/rebuild');
      assert.equal(rebuild.status, 200);
      assert.equal(rebuild.body.entities, canonBefore, 'reports what it removed');
      assert.equal((await listStories(db)).length, storiesBefore, 'every story survives a canon rebuild');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('POST /api/branch forks the story rather than copying a file', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base, world) => {
      await send(base, 'POST', '/api/play', { input: 'i light the lamp' });
      await send(base, 'POST', '/api/play', { input: 'i read the note' });

      const branched = await send(base, 'POST', '/api/branch', { atScene: 1, title: 'A branch' });
      assert.equal(branched.status, 200, JSON.stringify(branched.body));
      assert.ok(branched.body.storyId);
      assert.notEqual(branched.body.storyId, world.storyId, 'a branch is a different story');

      // The original is untouched — that is the whole point of branching over
      // retconning.
      assert.equal((await world.chronicle.turns()).length, 2);
      // `atScene: 1` copies everything *before* scene 1, so the branch starts clean
      // and resumes at 1.
      const branch = await World.forStory(db, branched.body.storyId);
      assert.equal((await branch.session.get()).scene, 1);
      // And it reads the same canon rather than a copy of it.
      assert.deepEqual(branch.sources.map((s) => s.worldId), world.sources.map((s) => s.worldId));

      assert.equal((await send(base, 'POST', '/api/branch', {})).status, 400, 'atScene is required');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('story routes list, rename, and refuse to delete the open story', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base, world) => {
      const listed = await get(base, '/api/stories');
      assert.equal(listed.status, 200);
      assert.ok(listed.body.some((s: { id: string; current: boolean }) => s.id === world.storyId && s.current));

      const renamed = await send(base, 'PUT', `/api/stories/${world.storyId}/title`, { title: 'Renamed' });
      assert.equal(renamed.status, 200);
      assert.equal((await get(base, '/api/stories')).body.find((s: { id: string }) => s.id === world.storyId).title, 'Renamed');

      // Deleting the story you are reading would leave the request with nothing to
      // resolve, so it is refused rather than handled.
      const deleted = await send(base, 'DELETE', `/api/stories/${world.storyId}`);
      assert.equal(deleted.status, 409);

      const other = await send(base, 'POST', '/api/stories', { title: 'Another' });
      assert.equal(other.status, 201);
      const delOther = await send(base, 'DELETE', `/api/stories/${other.body.id}`);
      assert.equal(delOther.status, 200, `${other.body.id} vs open ${world.storyId}: ${JSON.stringify(delOther.body)}`);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('GET /api/worlds reports which worlds this story reads', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base, world) => {
      await createWorld(db, 'Unread World');
      const worlds = await get(base, '/api/worlds');
      assert.equal(worlds.status, 200);
      assert.ok(worlds.body.worlds.length >= 2);

      // "Is this story reading it", not "is the server holding it open" — the
      // distinction the file-based version could not draw.
      const mine = world.sources.map((s) => s.worldId);
      for (const w of worlds.body.worlds) {
        assert.equal(w.reading, mine.includes(w.id), `${w.slug}: reading flag should follow story_sources`);
      }
      assert.ok(worlds.body.worlds.some((w: { entityCount: number }) => w.entityCount > 10));
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a 404 and a bad body are answered, not crashed', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base) => {
      assert.equal((await get(base, '/api/nonsense')).status, 404);
      // A malformed body reaches the handler as undefined rather than throwing in
      // the reader, so the route's own validation answers.
      const res = await fetch(`${base}/api/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.ok(res.status === 400 || res.status === 500, `expected a handled error, got ${res.status}`);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * The staleness check is only useful if its own list is right.
 *
 * `web/src/api.ts` warns "this page is newer than the server" when a route it needs
 * is missing from `/api/meta`. A typo or a renamed route in `REQUIRED_ROUTES` fires
 * that banner permanently against a perfectly healthy server — a false alarm in the
 * mechanism whose entire job is telling the truth about staleness.
 *
 * Moved here from `test/api.test.ts` when the UI moved to this server: the list now
 * contains `PUT /api/story/sources`, which the SQLite server does not serve and
 * should not, since a world is a file there and a story composes nothing. This is
 * the server the shipped UI talks to, so this is where the list has to match.
 */
test('every route the web client demands is actually served', async (t) => {
  const ran = await withPg(async (db) => {
    const { REQUIRED_ROUTES } = await import('../web/src/api.ts');
    await withServer(db, async (base) => {
      const meta = await get(base, '/api/meta');
      const served = new Set(meta.body.routes as string[]);
      const missing = REQUIRED_ROUTES.filter((r) => !served.has(r));
      assert.deepEqual(missing, [], `the client would warn about routes that do exist: ${missing.join(', ')}`);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * Every advertised parameterless GET is actually dispatchable.
 *
 * `/api/meta` is generated from the route table, so a route can be advertised and
 * still 404 if its handler throws on the way in — which is exactly what an
 * unawaited promise or a missing store method looks like. Cheap to check, and it
 * covers the routes no other test in this file touches.
 */
test('every advertised parameterless GET responds', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base) => {
      const meta = await get(base, '/api/meta');
      const simpleGets = (meta.body.routes as string[])
        .filter((r) => r.startsWith('GET /') && !r.includes(':'))
        .map((r) => r.slice('GET '.length));
      assert.ok(simpleGets.length > 10, `expected a real route table, got ${simpleGets.length}`);
      for (const path of simpleGets) {
        const res = await fetch(`${base}${path}`);
        assert.notEqual(res.status, 404, `${path} is advertised but not dispatchable`);
        // A 500 here is the shape an unawaited promise or a missing method takes.
        assert.notEqual(res.status, 500, `${path} threw: ${JSON.stringify(await res.json().catch(() => null))}`);
      }
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * `/api/health` reports the database, not just the process.
 *
 * Written after a production restart loop that container healthchecks reported as
 * `healthy` throughout: they probed `/api/meta`, which renders the route table from
 * memory and never touches Postgres. A health signal that cannot see the database is
 * close to useless on a database-backed service, and the endpoint that replaced it is
 * worth pinning — including that it answers *before* the session gate, since a probe
 * has no cookie and one that must treat 401 as success cannot tell "up" from
 * "unauthorised".
 */
test('/api/health proves the database is reachable, and needs no session', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base) => {
      const res = await get(base, '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.database, 'reachable');
      // A number, so a slow database is visible rather than merely "healthy".
      assert.equal(typeof res.body.ms, 'number');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('/api/health answers 503 when the database is gone', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'health');
    const story = await createStory(db, { worldIds: [worldId] });
    const world = await World.forStory(db, story.id);

    // A pool pointed at a port nothing listens on: the same shape as a database that
    // has stopped, without stopping the one the rest of the suite is using.
    const { Db } = await import('../src/db/pg.ts');
    const dead = new Db({ connectionString: 'postgres://nobody@127.0.0.1:1/none', kind: 'play', max: 1 });
    const providers = new ProviderRegistry(new MockProvider());
    const server = createApiServer({
      world: () => world,
      db: dead,
      engine: new Engine({ world: () => world, db, providers }),
    });
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await get(base, '/api/health');
      // 503, not 200 — this is the bit the old `/api/meta` check could not express.
      assert.equal(res.status, 503);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.database, 'unreachable');
      assert.ok(res.body.error.length > 0, 'the reason belongs in the response');
      // And `/api/meta` still answers, which is exactly why it was the wrong probe.
      assert.equal((await get(base, '/api/meta')).status, 200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await dead.close().catch(() => {});
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * Imported books must be findable and claimable, not silently invisible.
 *
 * Imported SQLite saves arrive with `owner_user_id` NULL, deliberately: attributing
 * them automatically would hand one person's writing to whoever signs in first. But
 * `WHERE owner_user_id = $1` never matches NULL, so on a logged-in instance they
 * vanished from the library — 13 imported books present in the database and absent from
 * the UI. Reported by the operator as "I only see our generated worlds".
 */
test('unowned stories are listed separately and can be claimed', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, async (base) => {
      // `withServer` already made a story; make it unowned, as an import would, plus
      // one owned by somebody else that must never appear.
      const all = await listStories(db);
      const orphanId = all[0]!.id;
      await db.query(`UPDATE stories SET owner_user_id = NULL WHERE id = $1`, [orphanId]);
      const worldId = await makeWorld(db, 'other-world');
      const theirs = await createStory(db, { worldIds: [worldId], title: 'Someone else' });
      await db.query(`UPDATE stories SET owner_user_id = 'user-other' WHERE id = $1`, [theirs.id]);

      const unowned = await get(base, '/api/stories/unowned');
      assert.equal(unowned.status, 200);
      const ids = (unowned.body as { id: string }[]).map((st) => st.id);
      assert.deepEqual(ids, [orphanId], "only the unowned one, never another user's");

      // Without a signed-in user there is nobody to claim for, and saying so beats
      // silently doing nothing.
      const claim = await send(base, 'POST', '/api/stories/claim');
      assert.equal(claim.status, 400);
      assert.match(claim.body.error as string, /sign in/i);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('claiming only ever takes stories nobody owns', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'claimsafe');
    const orphan = await createStory(db, { worldIds: [worldId], title: 'Unowned' });
    const theirs = await createStory(db, { worldIds: [worldId], title: 'Theirs' });
    await db.query(`UPDATE stories SET owner_user_id = NULL WHERE id = $1`, [orphan.id]);
    await db.query(`UPDATE stories SET owner_user_id = 'user-other' WHERE id = $1`, [theirs.id]);

    const claimed = await claimUnownedStories(db, 'user-me');
    assert.equal(claimed, 1, 'exactly the one unowned story');

    const mine = await db.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM stories WHERE id = $1`, [
      orphan.id,
    ]);
    assert.equal(mine.rows[0]!.owner_user_id, 'user-me');

    // The other user's story is untouched — the NULL guard in the UPDATE is what
    // makes this a claim rather than a transfer.
    const other = await db.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM stories WHERE id = $1`, [
      theirs.id,
    ]);
    assert.equal(other.rows[0]!.owner_user_id, 'user-other', 'never reassigns an owned story');

    // And a second claim finds nothing left to do.
    assert.equal(await claimUnownedStories(db, 'user-me'), 0);
  });
  if (!ran) t.skip('no Postgres configured');
});

