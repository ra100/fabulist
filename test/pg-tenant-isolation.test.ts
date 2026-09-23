/**
 * Tenant isolation on a signed-in, multi-user instance.
 *
 * Every long-lived service (`SetupService`, `IllustrationService`, `Engine`) is
 * built once per process around the login-off resolver: `serve-pg.ts` hands them
 * `worldFor(play, null)`, which is "the most recently played story on the whole
 * instance". For a single-user laptop that is the right answer. For a signed-in
 * request it is somebody else's book, so any route or MCP tool that falls back to
 * the service's own getter instead of passing the request's `world` acts on a
 * stranger's story.
 *
 * These tests build exactly that shape — a service over the login-off resolver,
 * two users, and the *other* user's story played most recently — and prove each
 * destructive or revealing path acts on the caller's own story, or refuses.
 *
 * Canon is the second boundary. A shared public world is read by everyone, so
 * writing into it needs `ingest` on that world (or admin), not merely a story
 * that happens to be bound to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, sessionUser, type AsUser, type Who } from './signed-in.ts';
import { World, createWorld, worldFor } from '../src/store/index-pg.ts';
import { createStory, getStory } from '../src/store/world-pg.ts';
import { worldRoleFor } from '../src/store/access-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { IllustrationService } from '../src/illustration/service-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import {
  composeIllustrationPromptTool,
  createCustomWorldTool,
  rebuildCanonTool,
  resetStoryTool,
  useSampleWorldTool,
  type McpToolContext,
} from '../src/mcp/tools-pg.ts';
import type { Db } from '../src/db/pg.ts';

/** Exactly what `serve-pg.ts` hands every long-lived service. */
const loginOffResolver = (db: Db) => () => worldFor(db, null);

/**
 * Makes `storyId` the one the login-off resolver lands on. Called again after any
 * write that stamps `last_played_at` (seeding does), or a fixture can drift into
 * testing the caller's own story by accident and pass for the wrong reason.
 */
async function playedMostRecently(db: Db, storyId: string): Promise<void> {
  await db.query(`UPDATE stories SET last_played_at = now() + interval '1 day' WHERE id = $1`, [storyId]);
  assert.equal((await worldFor(db, null)).storyId, storyId, 'fixture: the login-off resolver lands on this story');
}

/**
 * Alice and Bob each own a book reading one shared world, and Bob's is the most
 * recently played on the instance — so the login-off resolver lands on Bob's.
 */
async function twoTenants(db: Db, sharedTitle = 'Shared') {
  const shared = await makeWorld(db, 'shared', sharedTitle);
  const alice = await createStory(db, { title: 'Alice’s book', worldIds: [shared], ownerUserId: PEOPLE.alice.id });
  const bob = await createStory(db, { title: 'Bob’s book', worldIds: [shared], ownerUserId: PEOPLE.bob.id });
  await playedMostRecently(db, bob.id);
  return { shared, aliceStory: alice.id, bobStory: bob.id };
}

async function withSignedInServer(
  db: Db,
  fn: (as: AsUser) => Promise<void>,
  opts: { provider?: MockProvider } = {},
): Promise<void> {
  const boot = loginOffResolver(db);
  const providers = new ProviderRegistry(opts.provider ?? new MockProvider());
  const { as, close } = await listenSignedIn(
    createApiServer({
      world: boot,
      db,
      engine: new Engine({ world: boot, db, providers }),
      setup: new SetupService({ world: boot, db, providers }),
      authConfig: fakeAuth(),
    }),
  );
  try {
    await fn(as);
  } finally {
    await close();
  }
}

function mcpContext(
  db: Db,
  who: Who,
  opts: { provider?: MockProvider; illustrations?: IllustrationService } = {},
): McpToolContext {
  const boot = loginOffResolver(db);
  const user = sessionUser(who);
  const providers = new ProviderRegistry(opts.provider ?? new MockProvider());
  return {
    db,
    user,
    world: () => worldFor(db, user),
    selectStory: () => {},
    engine: new Engine({ world: boot, db, providers }),
    setup: new SetupService({ world: boot, db, providers }),
    ...(opts.illustrations ? { illustrations: opts.illustrations } : {}),
    dataRoot: 'data',
  };
}

async function canonCount(db: Db, worldId: number): Promise<number> {
  const row = await db.one<{ n: string }>(`SELECT count(*) AS n FROM canon_entities WHERE world_id = $1`, [worldId]);
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------ story reset

test('a signed-in reset replaces the caller’s own story, never the instance’s most recently played one', async (t) => {
  const ran = await withPg(async (db) => {
    const { shared, aliceStory, bobStory } = await twoTenants(db);
    await withSignedInServer(db, async (as) => {
      const reset = await as('alice', 'POST', '/api/setup/reset');
      assert.equal(reset.status, 200, JSON.stringify(reset.body));

      assert.ok(await getStory(db, bobStory), 'Bob’s book survives Alice’s reset');
      assert.equal(await getStory(db, aliceStory), undefined, 'Alice’s own book is the one replaced');
      const replacementId = String(reset.body.storyId);
      const replacement = await getStory(db, replacementId);
      assert.equal(replacement?.ownerUserId, PEOPLE.alice.id, 'the replacement belongs to Alice, not to nobody');
      assert.deepEqual(
        (await World.forStory(db, replacementId)).sources.map((s) => s.worldId),
        [shared],
        'and reads the canon her old book read',
      );
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('MCP reset_story replaces the connection’s own story, never the instance’s most recently played one', async (t) => {
  const ran = await withPg(async (db) => {
    const { aliceStory, bobStory } = await twoTenants(db);
    const result = await resetStoryTool(mcpContext(db, 'alice'));

    assert.ok(await getStory(db, bobStory), 'Bob’s book survives Alice’s reset_story');
    assert.equal(await getStory(db, aliceStory), undefined, 'Alice’s own book is the one replaced');
    assert.equal((await getStory(db, result.storyId))?.ownerUserId, PEOPLE.alice.id);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('resetMyStory refuses a world resolved for a story the user does not own', async (t) => {
  const ran = await withPg(async (db) => {
    const { bobStory } = await twoTenants(db);
    const setup = new SetupService({
      world: loginOffResolver(db),
      db,
      providers: new ProviderRegistry(new MockProvider()),
    });
    const bobsWorld = await World.forStory(db, bobStory);
    await assert.rejects(
      () => setup.resetMyStory({ world: bobsWorld, user: sessionUser('alice') }),
      /does not belong to this user/,
    );
    assert.ok(await getStory(db, bobStory), 'nothing was deleted');
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------- illustration prompts

test('MCP compose_illustration_prompt reads the caller’s story, not the most recently played one', async (t) => {
  const ran = await withPg(async (db) => {
    const { aliceStory, bobStory } = await twoTenants(db);
    const bobWorld = await World.forStory(db, bobStory);
    await bobWorld.graph.upsert(
      {
        id: 'char:marisol-quint',
        type: 'Character',
        name: 'Marisol Quint',
        summary: 'Bob’s private protagonist.',
        provenance: 'emergent:0',
        confidence: 1,
        salience: 0.9,
        depthLevel: 3,
        props: {},
        createdScene: 0,
      },
      'chronicle',
    );
    await bobWorld.graph.upsert(
      {
        id: 'loc:glass-orchard',
        type: 'Location',
        name: 'The Glass Orchard',
        summary: 'Where Bob’s story is set.',
        provenance: 'emergent:0',
        confidence: 1,
        salience: 0.9,
        depthLevel: 3,
        props: {},
        createdScene: 0,
      },
      'chronicle',
    );
    const aliceWorld = await World.forStory(db, aliceStory);
    await aliceWorld.session.set({ currentLocationId: 'loc:glass-orchard' });
    const turn = await aliceWorld.chronicle.addTurn({
      scene: 1,
      turn: 1,
      rawInput: 'i look around',
      intent: null,
      delta: null,
      bookProse: 'Alice looks around.',
      pinned: false,
      meta: { integrity: null, referee: null, move: null, frameLog: null, lint: null, providerCalls: [] },
    });

    const illustrations = new IllustrationService({ world: loginOffResolver(db), providers: { get: () => null } });
    const ctx = mcpContext(db, 'alice', { illustrations });
    await playedMostRecently(db, bobStory);

    await assert.rejects(
      () => composeIllustrationPromptTool(ctx, { subject: 'portrait', entityId: 'char:marisol-quint' }),
      /no such entity/,
      'a character that exists only in Bob’s story is not found from Alice’s',
    );
    const scene = await composeIllustrationPromptTool(ctx, { subject: 'scene', turnId: turn.id });
    assert.doesNotMatch(
      JSON.stringify(scene),
      /Glass Orchard/,
      'Bob’s location does not leak into Alice’s scene prompt',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------------ canon rebuild

test('MCP rebuild_canon is refused to a non-admin and leaves shared canon intact', async (t) => {
  const ran = await withPg(async (db) => {
    const { shared, bobStory } = await twoTenants(db);
    await seedWorld(await World.forStory(db, bobStory));
    const before = await canonCount(db, shared);
    assert.ok(before > 10, 'fixture: the shared world has canon');

    await assert.rejects(() => rebuildCanonTool(mcpContext(db, 'alice')), /administrator/);
    assert.equal(await canonCount(db, shared), before, 'no canon was deleted');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('rebuild_canon empties the admin’s own world, not the most recently played story’s', async (t) => {
  const ran = await withPg(async (db) => {
    const { shared, bobStory } = await twoTenants(db);
    const adminsWorld = await makeWorld(db, 'admins', 'Admin’s world');
    const adminStory = await createStory(db, {
      title: 'Admin’s book',
      worldIds: [adminsWorld],
      ownerUserId: PEOPLE.admin.id,
    });
    await seedWorld(await World.forStory(db, bobStory));
    const sharedBefore = await canonCount(db, shared);

    await seedWorld(await World.forStory(db, adminStory.id));
    await playedMostRecently(db, bobStory);
    const viaMcp = await rebuildCanonTool(mcpContext(db, 'admin'));
    assert.equal(viaMcp.worldId, adminsWorld, 'MCP rebuilt the world the admin’s own story reads');
    assert.equal(await canonCount(db, shared), sharedBefore, 'the world Bob is reading is untouched');

    await seedWorld(await World.forStory(db, adminStory.id));
    await playedMostRecently(db, bobStory);
    await withSignedInServer(db, async (as) => {
      const viaRest = await as('admin', 'POST', '/api/canon/rebuild');
      assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
      assert.equal(viaRest.body.worldId, adminsWorld, 'REST rebuilt the world the admin’s own story reads');
      assert.equal(await canonCount(db, shared), sharedBefore, 'the world Bob is reading is untouched');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

// ------------------------------------------------------ canon authoring rights

/** A shared world that already holds canon and a title, read by both tenants. */
async function sharedWorldWithCanon(db: Db) {
  const tenants = await twoTenants(db, 'Star Trek');
  await db.query(
    `INSERT INTO canon_entities (world_id, id, type, name, summary, provenance, salience)
     VALUES ($1,'char:jean-luc-picard','Character','Jean-Luc Picard','Captain of the Enterprise.','ingest',1)`,
    [tenants.shared],
  );
  await (await World.forStory(db, tenants.bobStory)).chronicle.setMeta('worldTitle', 'Star Trek');
  return tenants;
}

async function worldTitle(db: Db, storyId: string): Promise<string> {
  return (await World.forStory(db, storyId)).chronicle.getMeta('worldTitle', '');
}

test('a signed-in reader cannot author canon into a shared world, over REST or MCP', async (t) => {
  const ran = await withPg(async (db) => {
    const { shared, bobStory } = await sharedWorldWithCanon(db);
    const before = await canonCount(db, shared);
    // `MockProvider` records every call it answers, so a refusal can be shown to have cost nothing.
    const model = new MockProvider();

    await withSignedInServer(
      db,
      async (as) => {
        const sample = await as('alice', 'POST', '/api/setup/sample');
        assert.equal(sample.status, 403, JSON.stringify(sample.body));
        assert.match(String(sample.body.error), /requires ingest access/);

        const custom = await as('alice', 'POST', '/api/setup/custom', {
          description: 'A starship whose crew are all secretly the same person.',
        });
        assert.equal(custom.status, 403, JSON.stringify(custom.body));

        const pack = await as('alice', 'POST', '/api/setup/pack', { packId: 'harbour-lane' });
        assert.equal(pack.status, 403, JSON.stringify(pack.body));
      },
      { provider: model },
    );

    await assert.rejects(() => useSampleWorldTool(mcpContext(db, 'alice')), /requires ingest access/);
    await assert.rejects(
      () => createCustomWorldTool(mcpContext(db, 'alice', { provider: model }), { description: 'Anything at all.' }),
      /requires ingest access/,
    );

    assert.equal(model.calls.length, 0, 'a refused authoring request never reaches the model');
    assert.equal(await canonCount(db, shared), before, 'the shared canon is unchanged');
    assert.equal(await worldTitle(db, bobStory), 'Star Trek', 'and so is its title');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an admin may still author into a shared world', async (t) => {
  const ran = await withPg(async (db) => {
    const { shared } = await sharedWorldWithCanon(db);
    await createStory(db, { title: 'Admin’s book', worldIds: [shared], ownerUserId: PEOPLE.admin.id });
    const before = await canonCount(db, shared);
    await withSignedInServer(db, async (as) => {
      const sample = await as('admin', 'POST', '/api/setup/sample');
      assert.equal(sample.status, 200, JSON.stringify(sample.body));
    });
    assert.ok((await canonCount(db, shared)) > before, 'the admin’s sample went into the shared world');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a user who binds a fresh world owns it, and can keep authoring into it', async (t) => {
  const ran = await withPg(async (db) => {
    const placeholder = await createWorld(db, '');
    await createStory(db, { title: '', ownerUserId: PEOPLE.alice.id });
    await withSignedInServer(db, async (as) => {
      const first = await as('alice', 'POST', '/api/setup/sample');
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(
        await worldRoleFor(db, sessionUser('alice'), placeholder.id),
        'owner',
        'binding a fresh world makes Alice its owner',
      );

      const again = await as('alice', 'POST', '/api/setup/sample');
      assert.equal(again.status, 200, JSON.stringify(again.body));
    });
    assert.equal(
      await worldRoleFor(db, sessionUser('bob'), placeholder.id),
      'reader',
      'Bob may read it but not write it',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
