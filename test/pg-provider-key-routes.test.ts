import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, withPg, type RolePools } from './pg-harness.ts';
import { PEOPLE, fakeAuth, listenSignedIn, sessionUser, type AsUser } from './signed-in.ts';
import { World, worldFor } from '../src/store/index-pg.ts';
import { createStory } from '../src/store/world-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { ProviderResolver, type ProviderResolverOptions } from '../src/providers/resolver-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { SESSION_COOKIE } from '../src/auth/config.ts';
import { getStateTool, proposeTurnTool } from '../src/mcp/tools-pg.ts';
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { ProviderKeyRejectedError } from '../src/providers/byok.ts';
import { createEncryptionEnrollment, storyKeyHandoff, unlockWithPassphrase } from '../web/src/crypto/keys.ts';
import type { Db } from '../src/db/pg.ts';

const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const KEY1 = '00000000-0000-4000-8000-000000000001';
const KEY2 = '00000000-0000-4000-8000-000000000002';
const models = { narrate: 'gpt-test' };
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
type Body = Record<string, unknown>;
const body = (reply: { body: unknown }) => reply.body as Body;

function stubFetch(): typeof fetch {
  return (async (url: string) => {
    const json = String(url).endsWith('/models')
      ? { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }
      : { choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => json, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function storiesFor(db: Db): Promise<Record<'alice' | 'bob' | 'admin', string>> {
  const worldId = await makeWorld(db, 'shared');
  const out = {} as Record<'alice' | 'bob' | 'admin', string>;
  for (const who of ['alice', 'bob', 'admin'] as const) {
    out[who] = (await createStory(db, { title: who, worldIds: [worldId], ownerUserId: PEOPLE[who].id })).id;
  }
  return out;
}

async function withKeyServer(
  roles: RolePools,
  fn: (as: AsUser, resolver: ProviderResolver, base: string) => Promise<void>,
  over: Partial<ProviderResolverOptions> = {},
): Promise<void> {
  const boot = () => worldFor(roles.play, null);
  const resolver = new ProviderResolver({
    db: roles.play,
    server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
    shareServerProvider: () => true,
    secretsKey: Buffer.alloc(32, 5),
    fetcher: stubFetch(),
    keyCallLimit: { burst: 50, perMinute: 60 },
    ...over,
  });
  const engine = new Engine({ world: boot, db: roles.play, ingestDb: roles.ingest, providers: new ProviderRegistry(new MockProvider()) });
  const { as, base, close } = await listenSignedIn(
    createApiServer({ world: boot, db: roles.play, ingestDb: roles.ingest, engine, authConfig: fakeAuth(), providerResolver: resolver }),
  );
  try {
    await fn(as, resolver, base);
  } finally {
    await close();
  }
}

test('a sealed key is saved behind an allowlist and only its hint ever comes back', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    await storiesFor(db);
    await withKeyServer(roles, async (as) => {
      const saved = await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'sealed', key: ALICE_KEY });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(JSON.stringify(saved.body).includes(ALICE_KEY), false);
      const read = body(await as('alice', 'GET', '/api/provider-key'));
      assert.equal((read.key as Body).keyHint, 'ghij');
      assert.equal(read.status, 'own');
      assert.equal(read.sealedAvailable, true);
      assert.equal((read.endpoints as unknown[]).length, 12);
      assert.equal(JSON.stringify(read).includes(ALICE_KEY), false);

      const bad = { id: KEY2, models, trust: 'sealed', key: ALICE_KEY };
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { ...bad, endpointId: 'localhost' })).status, 400);
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { ...bad, endpointId: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' })).status, 400);

      assert.equal(body(await as('bob', 'GET', '/api/provider-key')).key, null);
      assert.equal(body(await as('bob', 'DELETE', '/api/provider-key')).removed, false);
      assert.equal((await as('bob', 'PUT', '/api/provider-key', { ...bad, id: KEY1, endpointId: 'openai' })).status, 409, 'another user\'s key id');
      assert.equal(body(await as('alice', 'GET', '/api/provider-key')).status, 'own', 'Alice\'s key survived Bob');

      const removed = body(await as('alice', 'DELETE', '/api/provider-key'));
      assert.deepEqual(removed, { removed: true, status: 'server' });
    });
    await withKeyServer(roles, async (as) => {
      assert.equal(body(await as('alice', 'GET', '/api/provider-key')).sealedAvailable, false);
      const refused = await as('alice', 'PUT', '/api/provider-key', { id: KEY2, endpointId: 'openai', models, trust: 'sealed', key: ALICE_KEY });
      assert.equal(refused.status, 400);
      assert.match(String(refused.body.error), /sealed keys are disabled/);
    }, { secretsKey: null });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock-mode key is granted by the unlock handoff and revoked by lock or sign-out, only for its owner', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as, resolver, base) => {
      for (const who of ['alice', 'bob'] as const) {
        const { recoveryCode: _code, ...enrollment } = await createEncryptionEnrollment(PEOPLE[who].id, 'a durable private passphrase', [stories[who]]);
        assert.equal((await as(who, 'POST', '/api/encryption/enroll', enrollment)).status, 201);
      }
      const saved = await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'unlock', wrap: fakeWrap, keyHint: 'ghij' });
      assert.equal(body(saved).status, 'locked');
      assert.deepEqual(body(await as('alice', 'GET', '/api/encryption/keys')).providerKey, { keyId: KEY1, wrap: fakeWrap });

      const stolen = await as('bob', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: 'sk-bob-0123456789abcd' }] });
      assert.equal(stolen.status, 403);

      const unlocked = await as('alice', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: ALICE_KEY }] });
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
      assert.equal((body(unlocked).providerGrants as unknown[]).length, 1);
      assert.equal(await resolver.status(sessionUser('alice')), 'own');

      assert.equal(body(await as('alice', 'POST', '/api/encryption/lock', {})).providerLocked, true);
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');

      assert.equal((await as('alice', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: ALICE_KEY }] })).status, 200);
      assert.equal(await resolver.status(sessionUser('alice')), 'own');
      const out = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: `${SESSION_COOKIE}=alice` } });
      assert.equal(out.status, 302);
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Test and model listing are rate-limited per user and their usage is reported to the user and admins', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as) => {
      assert.deepEqual(body(await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY })), { ok: true, model: 'gpt-test' });
      assert.deepEqual(body(await as('alice', 'POST', '/api/provider-key/models', { endpointId: 'openai', key: ALICE_KEY })), { models: ['gpt-a', 'gpt-b'] });
      const limited = await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY });
      assert.equal(limited.status, 429);
      assert.ok(limited.headers.get('retry-after'));

      const mine = body(await as('alice', 'GET', '/api/usage?days=7'));
      assert.equal(mine.days, 7);
      assert.deepEqual((mine.rows as Body[]).map((r) => [r.model, r.keySource, r.calls]), [['gpt-test', 'own', 1]]);
      assert.equal((await as('alice', 'GET', '/api/admin/usage')).status, 403);
      const all = body(await as('admin', 'GET', '/api/admin/usage'));
      assert.ok((all.rows as Body[]).some((r) => r.userId === PEOPLE.alice.id));

      const state = await getStateTool({
        world: () => World.forStory(roles.play, stories.alice),
        db: roles.play,
        user: sessionUser('alice'),
        engine: new Engine({ world: () => worldFor(roles.play, null), db: roles.play, providers: new ProviderRegistry(new MockProvider()) }),
        dataRoot: 'data',
      });
      assert.equal(state.myUsage?.length, 1);
    }, { keyCallLimit: { burst: 2, perMinute: 1 } });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a provider key in the unlock handoff spends a key call, and a refused one never blocks the story keys', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as, resolver) => {
      const { recoveryCode: _code, ...enrollment } = await createEncryptionEnrollment(PEOPLE.alice.id, 'a durable private passphrase', [stories.alice]);
      assert.equal((await as('alice', 'POST', '/api/encryption/enroll', enrollment)).status, 201);
      const opened = await unlockWithPassphrase(PEOPLE.alice.id, enrollment.userKey, enrollment.storyKeys, 'a durable private passphrase');
      const storyKeys = storyKeyHandoff(opened.storyKeys);
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'unlock', wrap: fakeWrap, keyHint: 'ghij' })).status, 200);

      const stale = await as('alice', 'POST', '/api/encryption/unlock', { storyKeys, providerKeys: [{ keyId: KEY2, key: ALICE_KEY }] });
      assert.equal(stale.status, 200, JSON.stringify(stale.body));
      assert.equal((body(stale).grants as unknown[]).length, 1);
      assert.deepEqual(body(stale).providerGrants, []);
      assert.match(String(body(stale).providerError), /own provider key/);

      const limited = await as('alice', 'POST', '/api/encryption/unlock', { providerKeys: [{ keyId: KEY1, key: ALICE_KEY }] });
      assert.equal(limited.status, 429);
      assert.ok(limited.headers.get('retry-after'));
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');

      const storiesOnly = await as('alice', 'POST', '/api/encryption/unlock', { storyKeys });
      assert.equal(storiesOnly.status, 200, 'story-key unlock is not metered as a key call');
      const both = await as('alice', 'POST', '/api/encryption/unlock', { storyKeys, providerKeys: [{ keyId: KEY1, key: ALICE_KEY }] });
      assert.equal(both.status, 200);
      assert.equal((body(both).grants as unknown[]).length, 1);
      assert.match(String(body(both).providerError), /too many provider-key requests/);
    }, { keyCallLimit: { burst: 2, perMinute: 1 } });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a key the provider rejects is a clear 4xx on play, stream, model listing and MCP, never a 500', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await seedWorld(await World.forStory(db, stories.alice));
    const rejecting = (async () =>
      ({ ok: false, status: 401, json: async () => ({}), text: async () => `{"error":"bad key ${ALICE_KEY}"}` }) as unknown as Response) as unknown as typeof fetch;
    await withKeyServer(roles, async (as, resolver, base) => {
      assert.equal((await as('alice', 'PUT', '/api/provider-key', { id: KEY1, endpointId: 'openai', models, trust: 'sealed', key: ALICE_KEY })).status, 200);
      const expected = /Your provider rejected your API key \(401\)\. Check it in Settings → My provider\./;

      const played = await as('alice', 'POST', '/api/play', { input: 'i trim the wick' });
      assert.equal(played.status, 424, JSON.stringify(played.body));
      assert.match(String(played.body.error), expected);
      assert.equal(JSON.stringify(played.body).includes(ALICE_KEY), false);

      const stream = await fetch(`${base}/api/play/stream`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=alice`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'i trim the wick' }),
      }).then((r) => r.text());
      assert.match(stream, /event: error/);
      assert.match(stream, expected);
      assert.equal(stream.includes(ALICE_KEY), false);

      const listed = await as('alice', 'POST', '/api/provider-key/models', { endpointId: 'openai', key: ALICE_KEY });
      assert.equal(listed.status, 424, JSON.stringify(listed.body));
      assert.match(String(listed.body.error), /rejected your API key \(401\)/);

      const user = sessionUser('alice');
      const engine = new Engine({ world: () => worldFor(roles.play, null), db: roles.play, providers: new ProviderRegistry(new MockProvider()) });
      await assert.rejects(
        proposeTurnTool(
          { world: () => World.forStory(roles.play, stories.alice), db: roles.play, user, engine, dataRoot: 'data', providers: (id) => resolver.forRequest(user, id) },
          { text: 'i trim the wick' },
        ),
        (err: Error) => err instanceof ProviderKeyRejectedError && expected.test(err.message),
      );
    }, { fetcher: rejecting });
  });
  if (!ran) t.skip('no Postgres configured');
});
