/**
 * Per-world access control and the per-user prose blocklist.
 *
 * The question this makes answerable could not be asked before: a world was a file
 * on one laptop, so "may Alice see the Star Trek world" had no representation. Now
 * worlds are shared system data, and the tests that matter are the ones that prove
 * a private world does not leak — including through the indirect paths, which is
 * where this kind of check is usually missed.
 *
 * A note on what is *not* enforced here. `schema-pg-roles.sql` stops a play
 * connection writing canon at all, for every connection, in the database. That is a
 * different rule from "which humans may see which world", which changes per row and
 * would need a Postgres role per user. So this layer is application code, checked by
 * the routes — and therefore worth testing directly rather than trusting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeWorld, withPg } from './pg-harness.ts';
import { World, createWorld, getWorldBySlug, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import {
  assertWorldAccess,
  blockPhrase,
  blocklistFor,
  grantWorldAccess,
  revokeWorldAccess,
  setWorldVisibility,
  unblockPhrase,
  worldRoleFor,
  worldsVisibleTo,
} from '../src/store/access-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { commitDelta } from '../src/loop/commit-pg.ts';
import { type McpToolContext, listWorldsTool, setStorySourcesTool } from '../src/mcp/tools-pg.ts';
import { emptyDelta } from '../src/domain/types.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import type { Db } from '../src/db/pg.ts';
import type { SessionUser } from '../src/auth/config.ts';

function userOf(id: string, isAdmin = false): SessionUser {
  return { id, email: `${id}@example.com`, firstName: null, lastName: null, isAdmin };
}

const alice = userOf('user:alice');
const bob = userOf('user:bob');
const admin = userOf('user:admin', true);

// ------------------------------------------------------------ the access rule

test('a public world is readable by everyone; a private one only by its grants', async (t) => {
  const ran = await withPg(async (db) => {
    const open = await createWorld(db, 'Open World');
    const secret = await createWorld(db, 'Secret World');
    await setWorldVisibility(db, secret.id, 'private');

    // Public with no row grants reader — the right default for ingested canon,
    // which is not anybody's private writing.
    assert.equal(await worldRoleFor(db, alice, open.id), 'reader');
    // Private with no row grants nothing at all.
    assert.equal(await worldRoleFor(db, alice, secret.id), null);

    // A grant works whatever the visibility, and outranks the implicit default.
    await grantWorldAccess(db, secret.id, alice.id, 'ingest');
    assert.equal(await worldRoleFor(db, alice, secret.id), 'ingest');
    assert.equal(await worldRoleFor(db, bob, secret.id), null, 'a grant is per user');

    // Revoking returns a private world to invisible, and leaves a public one alone.
    await revokeWorldAccess(db, secret.id, alice.id);
    assert.equal(await worldRoleFor(db, alice, secret.id), null);
    await grantWorldAccess(db, open.id, alice.id, 'owner');
    await revokeWorldAccess(db, open.id, alice.id);
    assert.equal(await worldRoleFor(db, alice, open.id), 'reader', 'a public world stays readable');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('worldsVisibleTo hides private worlds and reports the effective role', async (t) => {
  const ran = await withPg(async (db) => {
    // Created for the fixture; referenced by slug below rather than by id.
    await createWorld(db, 'Open');
    const mine = await createWorld(db, 'Mine');
    const theirs = await createWorld(db, 'Theirs');
    await setWorldVisibility(db, mine.id, 'private');
    await setWorldVisibility(db, theirs.id, 'private');
    await grantWorldAccess(db, mine.id, alice.id, 'owner');
    await grantWorldAccess(db, theirs.id, bob.id, 'owner');

    const forAlice = await worldsVisibleTo(db, alice);
    const slugs = forAlice.map((w) => w.slug).sort();
    assert.deepEqual(slugs, ['mine', 'open'], "Bob's private world must not appear at all");
    assert.equal(forAlice.find((w) => w.slug === 'mine')!.role, 'owner');
    assert.equal(forAlice.find((w) => w.slug === 'open')!.role, 'reader');

    // An admin sees everything: they are the person who has to fix a world nobody
    // else can reach.
    assert.equal((await worldsVisibleTo(db, admin)).length, 3);
    assert.equal((await worldsVisibleTo(db, admin)).find((w) => w.slug === 'theirs')!.role, 'owner');

    // Login-off local mode sees the public worlds, which is the single-user case.
    assert.deepEqual((await worldsVisibleTo(db, null)).map((w) => w.slug), ['open']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('assertWorldAccess enforces the role ranking and does not confirm existence', async (t) => {
  const ran = await withPg(async (db) => {
    const secret = await createWorld(db, 'Secret');
    await setWorldVisibility(db, secret.id, 'private');
    await grantWorldAccess(db, secret.id, alice.id, 'reader');

    assert.equal(await assertWorldAccess(db, alice, secret.id, 'reader'), 'reader');
    // reader < ingest < owner, so a reader cannot re-ingest.
    await assert.rejects(() => assertWorldAccess(db, alice, secret.id, 'ingest'), /requires ingest access/);
    await assert.rejects(() => assertWorldAccess(db, alice, secret.id, 'owner'), /requires owner access/);

    await grantWorldAccess(db, secret.id, alice.id, 'owner');
    assert.equal(await assertWorldAccess(db, alice, secret.id, 'ingest'), 'owner', 'owner outranks ingest');

    // Someone with no access gets "no world", not "forbidden": telling an
    // unauthorised caller that a named world exists is the leak, not a courtesy.
    await assert.rejects(() => assertWorldAccess(db, bob, secret.id, 'reader'), /no world/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('going private does not break stories already reading the world', async (t) => {
  const ran = await withPg(async (db) => {
    const worldId = await makeWorld(db, 'shared', 'Shared');
    const story = await createStory(db, { title: "Bob's book", worldIds: [worldId], ownerUserId: bob.id });
    const world = await World.forStory(db, story.id);
    await world.graph.upsert({ id: 'char:x', type: 'Character', name: 'Someone' }, 'canon');

    await setWorldVisibility(db, worldId, 'private');

    // Bob can no longer *start* a story against it…
    assert.equal(await worldRoleFor(db, bob, worldId), null);
    // …but the book he already wrote still reads its canon. `story_sources` is a
    // foreign key, not a permission: nobody's writing breaks because a world was
    // locked down, which is the right direction to get this wrong in.
    const still = await World.forStory(db, story.id);
    assert.equal((await still.graph.get('char:x'))?.name, 'Someone');
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------------- routes

async function withServer(
  db: Db,
  user: SessionUser | null,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const worldId = await makeWorld(db, 'home', 'Home');
  const story = await createStory(db, {
    title: 'A story',
    worldIds: [worldId],
    ...(user ? { ownerUserId: user.id } : {}),
  });
  const world = await World.forStory(db, story.id);
  const providers = new ProviderRegistry(new MockProvider());
  const engine = new Engine({ world: () => world, db, providers });
  const server = createApiServer({ world: () => world, db, engine });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('GET /api/worlds omits a private world rather than merely flagging it', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, null, async (base) => {
      const hidden = await createWorld(db, 'Hidden');
      await setWorldVisibility(db, hidden.id, 'private');
      await createWorld(db, 'Visible');

      const res = await fetch(`${base}/api/worlds`);
      const body = (await res.json()) as { worlds: Array<{ slug: string; visibility: string; role: string }> };
      const slugs = body.worlds.map((w) => w.slug);
      assert.ok(slugs.includes('visible'));
      assert.ok(slugs.includes('home'));
      // Not present at all: its existence and title are the leak, so filtering
      // rather than annotating is the point.
      assert.ok(!slugs.includes('hidden'), `private world leaked into ${JSON.stringify(slugs)}`);
      // And the caller is told what they may do, so the UI can hide an action
      // instead of offering one that will fail.
      assert.equal(body.worlds.find((w) => w.slug === 'visible')!.role, 'reader');
      assert.equal(body.worlds.find((w) => w.slug === 'visible')!.visibility, 'public');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('PUT /api/story/sources refuses a private world, closing the indirect path', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, null, async (base) => {
      const hidden = await createWorld(db, 'Hidden');
      await setWorldVisibility(db, hidden.id, 'private');
      await db.query(
        `INSERT INTO canon_entities (world_id, id, type, name, summary, provenance, salience)
         VALUES ($1,'char:secret','Character','A Secret Character','','authored',1)`,
        [hidden.id],
      );

      // The path a visibility check is usually missed on: not listing the world, but
      // pointing a story at it by slug and reading its canon through the overlay.
      const res = await fetch(`${base}/api/story/sources`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slugs: ['home', 'hidden'] }),
      });
      assert.equal(res.status, 404, 'a private world must not be attachable by slug');

      // And nothing was attached, so the canon stayed unreachable.
      const search = await fetch(`${base}/api/search?q=Secret`);
      assert.deepEqual(await search.json(), []);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the visibility and access routes require owner on that world', async (t) => {
  const ran = await withPg(async (db) => {
    // Login-off mode is the LOCAL_USER (''), which has no grants, so a private
    // world is unreachable to it even though it is the only "user".
    await withServer(db, null, async (base) => {
      const owned = await createWorld(db, 'Owned');
      await grantWorldAccess(db, owned.id, '', 'owner');
      const notMine = await createWorld(db, 'Not Mine');
      await setWorldVisibility(db, notMine.id, 'private');

      // Owner: allowed.
      const flip = await fetch(`${base}/api/worlds/owned/visibility`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      });
      assert.equal(flip.status, 200);
      assert.equal((await getWorldBySlug(db, 'owned'))!.visibility, 'private');

      // Grants are listable and settable by the owner.
      const granted = await fetch(`${base}/api/worlds/owned/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: bob.id, role: 'ingest' }),
      });
      assert.equal(granted.status, 200);
      const listed = (await (await fetch(`${base}/api/worlds/owned/access`)).json()) as {
        grants: Array<{ userId: string; role: string }>;
      };
      assert.ok(listed.grants.some((g) => g.userId === bob.id && g.role === 'ingest'));
      assert.equal(await worldRoleFor(db, bob, owned.id), 'ingest');

      // A world the caller has no owner grant on is refused. `not-mine` is private
      // with no grant, so `assertWorldAccess` throws "no world" and the route
      // answers 403 with that message — the caller learns they cannot act on it
      // without being told whether it exists.
      const denied = await fetch(`${base}/api/worlds/not-mine/access`);
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error, /no world/, 'must not confirm the world exists');

      // A bad visibility value is rejected before anything is written.
      const bad = await fetch(`${base}/api/worlds/owned/visibility`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'sort-of' }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await getWorldBySlug(db, 'owned'))!.visibility, 'private', 'unchanged after a rejected value');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

// ---------------------------------------------------------------- blocklist

test('the prose blocklist is per user, not per server', async (t) => {
  const ran = await withPg(async (db) => {
    await blockPhrase(db, alice, 'a testament to', 'I am tired of this one');
    await blockPhrase(db, alice, 'little did they know');
    await blockPhrase(db, bob, 'nestled in the heart of');

    const hers = await blocklistFor(db, alice);
    assert.deepEqual(hers.map((b) => b.pattern), ['a testament to', 'little did they know']);
    assert.equal(hers[0]!.note, 'I am tired of this one');
    // A phrase one player is tired of is not a property of the server: the SQLite
    // table was global, and read by nothing.
    assert.deepEqual((await blocklistFor(db, bob)).map((b) => b.pattern), ['nestled in the heart of']);
    // Login-off local mode has its own list rather than seeing everyone's.
    assert.deepEqual(await blocklistFor(db, null), []);

    // Re-blocking updates the note rather than failing on the primary key.
    await blockPhrase(db, alice, 'a testament to', 'still tired');
    assert.equal((await blocklistFor(db, alice))[0]!.note, 'still tired');
    assert.equal((await blocklistFor(db, alice)).length, 2, 'no duplicate row');

    await unblockPhrase(db, alice, 'a testament to');
    assert.deepEqual((await blocklistFor(db, alice)).map((b) => b.pattern), ['little did they know']);
    assert.equal((await blocklistFor(db, bob)).length, 1, "unblocking is scoped too");

    await assert.rejects(() => blockPhrase(db, alice, '   '), /cannot be empty/);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the blocklist routes round-trip', async (t) => {
  const ran = await withPg(async (db) => {
    await withServer(db, null, async (base) => {
      assert.deepEqual(await (await fetch(`${base}/api/blocklist`)).json(), []);

      const added = await fetch(`${base}/api/blocklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pattern: 'a symphony of', note: 'no' }),
      });
      assert.equal(added.status, 201);
      const listed = (await (await fetch(`${base}/api/blocklist`)).json()) as Array<{ pattern: string }>;
      assert.deepEqual(listed.map((b) => b.pattern), ['a symphony of']);

      const bad = await fetch(`${base}/api/blocklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pattern: '  ' }),
      });
      assert.equal(bad.status, 400);

      const removed = await fetch(`${base}/api/blocklist/${encodeURIComponent('a symphony of')}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.deepEqual(await (await fetch(`${base}/api/blocklist`)).json(), []);
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------- multi-user, multi-world isolation

//
// The property the deployment actually depends on: several people reading
// different worlds and writing different books at the same time, without seeing or
// blocking each other. Asserted here rather than assumed, because the SQLite
// ancestor could not do it at all — one process held one world file open, and
// "switch world" was a server-wide mutation.

/**
 * Each user resolves to their own book, and sees only the canon that book reads.
 *
 * The failure this rules out is the one that matters most: user A's request resolving
 * to user B's story, or reading a world it does not source. Both would be silent.
 */
test('concurrent users on different worlds see only their own book and canon', async (t) => {
  const ran = await withPg(async (db) => {
    const alpha = await makeWorld(db, 'alpha', 'Alpha');
    const beta = await makeWorld(db, 'beta', 'Beta');
    await db.query(
      `INSERT INTO canon_entities (world_id,id,type,name,summary,salience) VALUES
         ($1,'char:a','Character','Hero Alpha','x',1),
         ($2,'char:b','Character','Hero Beta','x',1)`,
      [alpha, beta],
    );
    const alice = userOf('user-alice');
    const bob = userOf('user-bob');
    await createStory(db, { title: "alice's", ownerUserId: alice.id, worldIds: [alpha] });
    await createStory(db, { title: "bob's", ownerUserId: bob.id, worldIds: [beta] });

    // Resolved concurrently, as two simultaneous requests would.
    const [aWorld, bWorld] = await Promise.all([worldFor(db, alice), worldFor(db, bob)]);
    assert.notEqual(aWorld.storyId, bWorld.storyId, 'two users must not share a book');

    const aSees = (await aWorld.graph.search('Hero')).map((e) => e.name);
    const bSees = (await bWorld.graph.search('Hero')).map((e) => e.name);
    assert.deepEqual(aSees, ['Hero Alpha']);
    assert.deepEqual(bSees, ['Hero Beta']);
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * Turns taken at the same time land in the right books.
 *
 * Interleaved deliberately rather than run in sequence: a shared "current story"
 * would show up as one user's event appearing in another's chronicle, and only
 * concurrency exposes it.
 */
test('simultaneous turns do not cross between users', async (t) => {
  const ran = await withPg(async (db) => {
    const shared = await makeWorld(db, 'shared', 'Shared');
    const users = ['u1', 'u2', 'u3'].map((id) => userOf(id));
    for (const u of users) await createStory(db, { title: u.id, ownerUserId: u.id, worldIds: [shared] });

    // All three writing at once, to the same world's canon but their own chronicles.
    await Promise.all(
      users.map(async (u) => {
        const world = await worldFor(db, u);
        for (let i = 0; i < 5; i += 1) {
          await commitDelta(db, world, {
            ...emptyDelta(),
            events: [{ text: `${u.id}-event-${i}`, participants: [], locationId: null, significance: 0.5 }],
          });
        }
      }),
    );

    for (const u of users) {
      const world = await worldFor(db, u);
      const { rows } = await db.query<{ text: string }>(`SELECT text FROM events WHERE story_id = $1`, [
        world.storyId,
      ]);
      assert.equal(rows.length, 5, `${u.id} should have exactly its own five events`);
      const foreign = rows.filter((r) => !r.text.startsWith(u.id));
      assert.deepEqual(foreign, [], `${u.id}'s book contains another user's events`);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * One user, two books open at once — which is what two browser tabs are.
 *
 * `?storyId=` is what makes this work: without it a request resolves to "my most
 * recently played", so both tabs would collapse onto whichever book was touched last.
 * The client keeps that id in `sessionStorage` (per tab, deliberately not
 * `localStorage`), so this test pins the server half of the contract.
 */
test('a single user can hold two different books open via storyIdOverride', async (t) => {
  const ran = await withPg(async (db) => {
    const one = await makeWorld(db, 'one', 'One');
    const two = await makeWorld(db, 'two', 'Two');
    const user = userOf('solo');
    const bookOne = await createStory(db, { title: 'in one', ownerUserId: user.id, worldIds: [one] });
    const bookTwo = await createStory(db, { title: 'in two', ownerUserId: user.id, worldIds: [two] });

    const tabA = await worldFor(db, user, { storyIdOverride: bookOne.id });
    const tabB = await worldFor(db, user, { storyIdOverride: bookTwo.id });
    assert.equal(tabA.storyId, bookOne.id);
    assert.equal(tabB.storyId, bookTwo.id);

    // Without the override both collapse onto the most recently played, which is the
    // documented fallback rather than a bug — worth pinning so a change is deliberate.
    await db.query(`UPDATE stories SET last_played_at = now() WHERE id = $1`, [bookTwo.id]);
    assert.equal((await worldFor(db, user)).storyId, bookTwo.id);
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * Another user's book is unreachable even with its exact id.
 *
 * `?storyId=` is client-supplied, so it is an attack surface: this is the check that
 * stops it being one.
 */
test('storyIdOverride cannot reach another user\'s book', async (t) => {
  const ran = await withPg(async (db) => {
    const w = await makeWorld(db, 'private-book', 'W');
    const mine = await createStory(db, { title: 'mine', ownerUserId: 'owner', worldIds: [w] });
    await assert.rejects(
      () => worldFor(db, userOf('intruder'), { storyIdOverride: mine.id }),
      /does not belong to this user/,
      'a guessed story id must not grant access',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------- the MCP surface too
//
/**
 * An MCP context for the access tests. `engine` is required by the type but unused by
 * the two tools below, so it gets a real one rather than a cast — a lie in a test
 * fixture is how a type stops being load-bearing.
 */
function mcpCtx(db: Db, world: World, user: SessionUser): McpToolContext {
  return {
    world: () => Promise.resolve(world),
    db,
    user,
    dataRoot: 'data',
    engine: new Engine({ world: () => world, db, providers: new ProviderRegistry(new MockProvider()) }),
  };
}
//
// `/mcp` is a second front door to the same data, and a check that exists only on the
// REST side is not a check. Both of these were real bypasses, found because the
// operator noticed MCP and the web UI showing different world lists.

/**
 * `list_worlds` hides a private world, exactly as `GET /api/worlds` does.
 *
 * It listed every world unconditionally, so a private world's existence and title —
 * which is the leak the filter exists to prevent — were readable through MCP.
 */
test('the MCP world list hides a private world the caller has no grant on', async (t) => {
  const ran = await withPg(async (db) => {
    const openId = await makeWorld(db, 'mcp-open', 'Open');
    const secretId = await makeWorld(db, 'mcp-secret', 'Secret');
    await setWorldVisibility(db, secretId, 'private');
    const story = await createStory(db, { worldIds: [openId], ownerUserId: alice.id });
    const world = await World.forStory(db, story.id);

    const seen = await listWorldsTool(mcpCtx(db, world, alice));
    const slugs = (seen.worlds as Array<{ slug: string }>).map((w) => w.slug).sort();
    assert.deepEqual(slugs, ['mcp-open'], 'the private world must not appear');

    // And it does appear once a grant exists — otherwise this test would pass for the
    // wrong reason (a filter that hides everything).
    await grantWorldAccess(db, secretId, alice.id, 'reader');
    const after = await listWorldsTool(mcpCtx(db, world, alice));
    assert.deepEqual(
      (after.worlds as Array<{ slug: string }>).map((w) => w.slug).sort(),
      ['mcp-open', 'mcp-secret'],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

/**
 * `set_story_sources` refuses a world the caller may not read.
 *
 * The subtler of the two: reading canon through the overlay is legitimate *once* a
 * story sources a world, so the permission has to be enforced when the source is added.
 * Without it, an MCP caller could attach a private world and then read all of it.
 */
test('the MCP source setter refuses a world the caller may not read', async (t) => {
  const ran = await withPg(async (db) => {
    const mineId = await makeWorld(db, 'mcp-mine', 'Mine');
    const secretId = await makeWorld(db, 'mcp-locked', 'Locked');
    await setWorldVisibility(db, secretId, 'private');
    const story = await createStory(db, { worldIds: [mineId], ownerUserId: alice.id });
    const world = await World.forStory(db, story.id);
    const ctx = mcpCtx(db, world, alice);

    await assert.rejects(
      () => setStorySourcesTool(ctx, { slugs: ['mcp-mine', 'mcp-locked'] }),
      /no world|not allowed|forbidden|access/i,
      'attaching an unreadable world must fail',
    );

    // The story's sources are unchanged — a rejected call must not half-apply.
    const after = await World.forStory(db, story.id);
    assert.deepEqual(after.sources.map((src) => src.worldId), [mineId]);
  });
  if (!ran) t.skip('no Postgres configured');
});

