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
import { World, createWorld, getWorldBySlug } from '../src/store/index-pg.ts';
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
