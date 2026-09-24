/**
 * The role split in `schema-pg-roles.sql`, exercised as the roles themselves.
 *
 * The rest of the suite connects as the login (a superuser in CI), which the
 * grants cannot constrain — so a play-path write into a system table passed
 * every test and would only have failed once production connected as
 * `fabulist_play`. These tests run application code through pools that
 * `SET ROLE`, which is what makes the grants load-bearing here: the server test
 * ends with a negative control proving a system write through the play pool is
 * actually refused, so a pass means the routing is right rather than that the
 * roles were never assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, testConnectionString, withPg, type RolePools } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, type AsUser } from './signed-in.ts';
import { Db, assertRole, type DbRole } from '../src/db/pg.ts';
import { getWorldBySlug, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { SetupService } from '../src/setup/service-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';

const SYSTEM_TABLES = new Set([
  'worlds',
  'world_sources',
  'world_meta',
  'world_access',
  'canon_entities',
  'canon_edges',
  'canon_sheets',
  'ingest_pages',
  'migrations',
  'sqlite_import_log',
]);

/** Postgres' `insufficient_privilege`. */
const PERMISSION_DENIED = { code: '42501' };

test('every table has the grant its kind needs: play writes user tables only, ingest writes all', async (t) => {
  const ran = await withPg(async (db, schema) => {
    const rows = await db.many<{ table: string; privilege: string; play: boolean; ingest: boolean }>(
      `SELECT t.tablename AS table, p.privilege,
              has_table_privilege('fabulist_play', format('%I.%I', t.schemaname, t.tablename), p.privilege) AS play,
              has_table_privilege('fabulist_ingest', format('%I.%I', t.schemaname, t.tablename), p.privilege) AS ingest
         FROM pg_tables t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
        WHERE t.schemaname = $1
        ORDER BY 1, 2`,
      [schema],
    );
    assert.ok(rows.length > 30 * 4, 'fixture: the whole schema is covered');
    for (const r of rows) {
      const playShould = r.privilege === 'SELECT' || !SYSTEM_TABLES.has(r.table);
      assert.equal(r.play, playShould, `fabulist_play ${r.privilege} on ${r.table}`);
      assert.equal(r.ingest, true, `fabulist_ingest ${r.privilege} on ${r.table}`);
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the play role is refused system writes the ingest role may make', async (t) => {
  const ran = await withPg(async (db, _schema, { play, ingest }) => {
    const worldId = await makeWorld(db, 'canon');
    assert.equal((await play.one<{ u: string }>('SELECT current_user AS u'))?.u, 'fabulist_play');
    assert.equal((await ingest.one<{ u: string }>('SELECT current_user AS u'))?.u, 'fabulist_ingest');

    const systemWrites: Array<[string, unknown[]]> = [
      [`UPDATE canon_entities SET name = name WHERE world_id = $1`, [worldId]],
      [`INSERT INTO worlds (slug, title) VALUES ('sneaky', 'Sneaky')`, []],
      [`INSERT INTO world_access (world_id, user_id, role) VALUES ($1, 'user:mallory', 'owner')`, [worldId]],
      [`INSERT INTO world_meta (world_id, key, value) VALUES ($1, 'worldTitle', 'Mine now')`, [worldId]],
    ];
    for (const [sql, params] of systemWrites) {
      await assert.rejects(() => play.query(sql, params), PERMISSION_DENIED, sql);
      await ingest.query(sql, params);
    }

    // And the play role can still do its actual job.
    const story = await createStory(play, { title: 'Played', worldIds: [worldId] });
    await play.query(
      `INSERT INTO scene_metadata (story_id, identity, scene, chapter) VALUES ($1, 'raw:2', 2, 1)`,
      [story.id],
    );
    await play.query(`UPDATE stories SET title = 'Still played' WHERE id = $1`, [story.id]);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a pool naming a role its login cannot assume fails, and assertRole says what to grant', async (t) => {
  const ran = await withPg(async (db, schema) => {
    const login = (await db.one<{ u: string }>('SELECT current_user AS u'))!.u;
    const absent = new Db({
      connectionString: testConnectionString()!,
      role: 'fabulist_absent' as DbRole,
      max: 1,
    });
    try {
      await assert.rejects(() => absent.query('SELECT 1'), /fabulist_absent/);
      await assert.rejects(
        () => assertRole(absent, { login, schema }),
        (err: Error) => {
          assert.match(err.message, new RegExp(`GRANT fabulist_play, fabulist_ingest TO "${login}"`));
          assert.match(err.message, /FABULIST_DB_ROLES=off/);
          return true;
        },
      );
    } finally {
      await absent.close();
    }
  });
  if (!ran) t.skip('no Postgres configured');
});

test('assertRole accepts a role pool in the owner schema, and rejects one in another', async (t) => {
  const ran = await withPg(async (db, schema, { play }) => {
    const login = (await db.one<{ u: string }>('SELECT current_user AS u'))!.u;
    await assertRole(play, { login, schema });
    await assertRole(db, { login, schema: 'anything' }); // no role: nothing to check
    await assert.rejects(() => assertRole(play, { login, schema: 'elsewhere' }), /options=-csearch_path%3Delsewhere/);
  });
  if (!ran) t.skip('no Postgres configured');
});

/** `serve-pg.ts`'s wiring, on the role pools. `split: false` hands the play pool to everything. */
async function withRoleServer(
  roles: RolePools,
  fn: (as: AsUser) => Promise<void>,
  { split = true }: { split?: boolean } = {},
): Promise<void> {
  const { play, ingest } = roles;
  const boot = () => worldFor(play, null);
  const providers = new ProviderRegistry(new MockProvider());
  const { as, close } = await listenSignedIn(
    createApiServer({
      world: boot,
      db: play,
      ...(split ? { ingestDb: ingest } : {}),
      engine: new Engine({ world: boot, db: play, ingestDb: ingest, providers }),
      setup: new SetupService({ world: boot, db: ingest, providers }),
      authConfig: fakeAuth(),
    }),
  );
  try {
    await fn(as);
  } finally {
    await close();
  }
}

test('a server wired like serve-pg manages worlds, seeds a sample and closes a scene under the roles', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    await withRoleServer(roles, async (as) => {
      const created = await as('admin', 'POST', '/api/worlds', { title: 'Role Test' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      let slug = (created.body as { slug: string }).slug;

      const renamed = await as('admin', 'PUT', `/api/worlds/${slug}/title`, { title: 'Role Test Renamed' });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      slug = (renamed.body as { slug: string }).slug;

      const visibility = await as('admin', 'PUT', `/api/worlds/${slug}/visibility`, { visibility: 'private' });
      assert.equal(visibility.status, 200, JSON.stringify(visibility.body));
      assert.equal((await getWorldBySlug(db, slug))?.visibility, 'private');

      const grant = await as('admin', 'POST', `/api/worlds/${slug}/access`, { userId: PEOPLE.bob.id });
      assert.equal(grant.status, 200, JSON.stringify(grant.body));
      const revoke = await as('admin', 'DELETE', `/api/worlds/${slug}/access/${encodeURIComponent(PEOPLE.bob.id)}`);
      assert.equal(revoke.status, 200, JSON.stringify(revoke.body));

      const removed = await as('admin', 'DELETE', `/api/worlds/${slug}`);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(await getWorldBySlug(db, slug), undefined);

      await createStory(db, { title: '', ownerUserId: PEOPLE.alice.id });
      const sample = await as('alice', 'POST', '/api/setup/sample');
      assert.equal(sample.status, 200, JSON.stringify(sample.body));
      const closed = await as('alice', 'POST', '/api/scene/close');
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
    });

    // Negative control: without `ingestDb` the same write goes through the play
    // pool, and the database refuses it. Proves the above really ran as the roles.
    await withRoleServer(
      roles,
      async (as) => {
        const refused = await as('admin', 'POST', '/api/worlds', { title: 'Refused' });
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.match(String(refused.body.error), /permission denied for table worlds/);
      },
      { split: false },
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
