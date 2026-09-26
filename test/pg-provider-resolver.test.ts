import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { sessionUser } from './signed-in.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type CompletionRequest } from '../src/providers/provider.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';
import {
  ProviderKeyForbiddenError,
  ProviderKeyInputError,
  ProviderResolver,
  type ProviderResolverOptions,
} from '../src/providers/resolver-pg.ts';
import type { Queryable } from '../src/db/pg.ts';

const SECRET = Buffer.alloc(32, 5);
const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const models = { narrate: 'gpt-test' };
const keyId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
const alice = sessionUser('alice');
const bob = sessionUser('bob');
const admin = sessionUser('admin');
const ask = (role: string): CompletionRequest => ({ role, messages: [{ role: 'user', content: 'hello' }] });
const sealed = (n: number) => ({ id: keyId(n), label: '', endpointId: 'openai', models, trust: 'sealed' as const, key: ALICE_KEY });
const unlockMode = (n: number) => ({ id: keyId(n), label: '', endpointId: 'openai', models, trust: 'unlock' as const, wrap: fakeWrap, keyHint: 'ghij' });

/** Answers every chat completion; `fail` echoes the key in a 401 body. Records each bearer it saw. */
function stubFetch(fail = false) {
  const bearers: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit = {}) => {
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
    bearers.push(auth);
    return fail
      ? ({ ok: false, status: 401, json: async () => ({}), text: async () => `invalid ${auth}` } as unknown as Response)
      : ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } }),
          text: async () => '',
        } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetcher, bearers };
}

function resolverFor(db: Queryable, over: Partial<ProviderResolverOptions> = {}, fail = false) {
  const { fetcher, bearers } = stubFetch(fail);
  const resolver = new ProviderResolver({
    db,
    server: new ProviderRegistry(new MockProvider({ id: 'server-stub' })),
    shareServerProvider: () => true,
    secretsKey: SECRET,
    fetcher,
    ...over,
  });
  return { resolver, bearers };
}

test('resolution falls back from the own key to the shared server provider to mock', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let share = true;
    const { resolver } = resolverFor(roles.play, { shareServerProvider: () => share });
    assert.equal((await resolver.forRequest(null)).get('narrate').id, 'server-stub', 'login-off keeps the server registry');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.status(alice), 'server');
    share = false;
    assert.equal((await resolver.forRequest(alice)).get('extract').id, 'mock', 'no key and no sharing: the agent keeps the world');
    assert.equal(await resolver.status(alice), 'none');
    assert.equal((await resolver.forRequest(admin)).get('narrate').id, 'server-stub', 'admins always reach the server provider');
    await resolver.save(alice, sealed(1));
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'openai');
    assert.equal(await resolver.status(alice), 'own');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a sealed key reaches the provider and meters as own usage without storing plaintext', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver, bearers } = resolverFor(roles.play);
    const summary = await resolver.save(alice, sealed(2));
    assert.equal(summary.keyHint, 'ghij');
    assert.equal(JSON.stringify(summary).includes(ALICE_KEY), false);
    const row = await db.one<{ ciphertext: Buffer }>(`SELECT ciphertext FROM user_provider_keys WHERE user_id = $1`, [alice.id]);
    assert.equal(row!.ciphertext.includes(Buffer.from(ALICE_KEY)), false);

    await (await resolver.forRequest(alice, 'story-1')).get('referee').complete(ask('referee'));
    assert.deepEqual(bearers, [`Bearer ${ALICE_KEY}`]);
    const usage = await db.query(`SELECT role, key_source, story_id, tokens_in FROM usage_events WHERE user_id = $1`, [alice.id]);
    assert.deepEqual(usage.rows, [{ role: 'referee', key_source: 'own', story_id: 'story-1', tokens_in: 7 }]);
    const touched = await db.one<{ last_used_at: Date | null }>(`SELECT last_used_at FROM user_provider_keys WHERE user_id = $1`, [alice.id]);
    assert.ok(touched?.last_used_at, 'last_used_at is stamped on use');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('sealed mode is refused without FABULIST_SECRETS_KEY and an existing sealed key falls back', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, sealed(3));
    const { resolver: keyless } = resolverFor(roles.play, { secretsKey: null });
    assert.equal(keyless.sealedAvailable, false);
    await assert.rejects(keyless.save(bob, { ...sealed(4) }), (err: Error) => err instanceof ProviderKeyInputError && /sealed keys are disabled/.test(err.message));
    assert.equal((await keyless.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await keyless.status(alice), 'unavailable');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock-mode key is usable only while its grant is live, and a lock mid-turn stops the next call', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let now = Date.parse('2026-09-26T10:00:00.000Z');
    const { resolver, bearers } = resolverFor(roles.play, { grants: new EphemeralProviderKeyStore(() => now, 60_000) });
    await resolver.save(alice, unlockMode(5));
    assert.equal(await resolver.status(alice), 'locked');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');

    await resolver.unlock(alice, [{ keyId: keyId(5), key: ALICE_KEY }]);
    const midTurn = await resolver.forRequest(alice);
    assert.equal(midTurn.get('narrate').id, 'openai');
    await midTurn.get('classify').complete(ask('classify'));
    resolver.lock(alice.id);
    await assert.rejects(midTurn.get('extract').complete(ask('extract')), ProviderKeyLockedError);
    assert.equal(bearers.length, 1, 'nothing was sent after the lock');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.status(alice), 'locked');

    await resolver.unlock(alice, [{ keyId: keyId(5), key: ALICE_KEY }]);
    now += 60_000;
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub', 'an expired grant falls back');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a user can neither see, unlock, use nor delete another user\'s key', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver } = resolverFor(roles.play);
    await resolver.save(alice, unlockMode(6));
    await assert.rejects(resolver.unlock(bob, [{ keyId: keyId(6), key: 'sk-bob-stolen-0123456789' }]), ProviderKeyForbiddenError);
    assert.equal(await resolver.summary(bob), null);
    assert.equal(await resolver.unlockRecord(bob), null);
    assert.equal((await resolver.forRequest(bob)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.remove(bob), false);
    assert.equal((await resolver.summary(alice))?.id, keyId(6));

    await resolver.save(alice, sealed(7));
    await db.query(
      `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
       SELECT $1, $2, endpoint_id, models, trust, nonce, ciphertext, key_hint FROM user_provider_keys WHERE user_id = $3`,
      [keyId(8), bob.id, alice.id],
    );
    resolver.invalidate(bob.id);
    assert.equal((await resolver.forRequest(bob)).get('narrate').id, 'server-stub', 'a copied wrap is bound to its owner');
    assert.equal(await resolver.status(bob), 'unavailable');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('deleting or replacing a key takes effect on the next request and on in-flight registries', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver, bearers } = resolverFor(roles.play);
    await resolver.save(alice, sealed(9));
    const beforeDelete = await resolver.forRequest(alice);
    assert.equal(beforeDelete.get('narrate').id, 'openai');
    assert.equal(await resolver.remove(alice), true);
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    await assert.rejects(beforeDelete.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);

    await resolver.save(alice, sealed(10));
    const beforeReplace = await resolver.forRequest(alice);
    await resolver.save(alice, { ...sealed(11), key: 'sk-alice-rotated-0123456789' });
    await assert.rejects(beforeReplace.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    await (await resolver.forRequest(alice)).get('narrate').complete(ask('narrate'));
    assert.deepEqual(bearers, ['Bearer sk-alice-rotated-0123456789']);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a delete that lands while a cache fill is reading does not leave the old key cached', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, sealed(12));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = true;
    const slowDb: Queryable = {
      query: (async (sql: string, params?: unknown[]) => {
        const result = await roles.play.query(sql, params);
        if (gated && sql.includes('FROM user_provider_keys')) {
          gated = false;
          await gate;
        }
        return result;
      }) as Queryable['query'],
    };
    const { resolver } = resolverFor(slowDb);
    const pending = resolver.forRequest(alice);
    while (gated) await new Promise((r) => setTimeout(r, 1));
    await resolver.remove(alice);
    release();
    const stale = await pending;
    await assert.rejects(stale.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('Test is a metered live call whose failure text never carries the key, and key calls are rate-limited', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const ok = resolverFor(roles.play, { keyCallLimit: { burst: 2, perMinute: 1 } }).resolver;
    assert.deepEqual(await ok.test(alice, { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY }), { ok: true, model: 'gpt-test' });
    const probe = await db.query(`SELECT role, key_source FROM usage_events WHERE user_id = $1`, [alice.id]);
    assert.deepEqual(probe.rows, [{ role: 'probe', key_source: 'own' }]);
    await assert.rejects(ok.test(alice, { endpointId: 'localhost', model: 'm', key: ALICE_KEY }), ProviderKeyInputError);

    const failing = resolverFor(roles.play, {}, true).resolver;
    const failed = await failing.test(alice, { endpointId: 'openai', model: 'gpt-test', key: ALICE_KEY });
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes(ALICE_KEY), false);

    assert.equal(ok.takeKeyCall(alice.id), null);
    assert.equal(ok.takeKeyCall(alice.id), null);
    assert.equal(typeof ok.takeKeyCall(alice.id), 'number');
    assert.equal(ok.takeKeyCall(bob.id), null, 'buckets are per user');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock-mode wrap is capped at a 512-byte key in save and in the table', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver } = resolverFor(roles.play);
    const wrapOf = (bytes: number) => ({ ...fakeWrap, ciphertext: Buffer.alloc(bytes, 2).toString('base64') });
    await resolver.save(alice, { ...unlockMode(11), wrap: wrapOf(528) });
    await assert.rejects(resolver.save(alice, { ...unlockMode(12), wrap: wrapOf(529) }), ProviderKeyInputError);
    await assert.rejects(db.query(
      `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
       VALUES ($1, 'bob', 'openai', '{}', 'unlock', $2, $3, '')`,
      [keyId(13), Buffer.alloc(12), Buffer.alloc(529)],
    ), /check constraint/);
  });
  if (!ran) t.skip('no Postgres configured');
});

/** Holds the first query matching `match` at the gate, before or after it runs. */
function gatedDb(db: Queryable, match: (sql: string) => boolean, before = false) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { held: false, release };
  let armed = true;
  const gated: Queryable = {
    query: (async (sql: string, params?: unknown[]) => {
      const hit = armed && match(sql);
      if (hit) armed = false;
      if (hit && before) {
        state.held = true;
        await gate;
      }
      const result = await db.query(sql, params);
      if (hit && !before) {
        state.held = true;
        await gate;
      }
      return result;
    }) as Queryable['query'],
  };
  return { gated, state };
}

test('an unlock racing a delete never leaves a plaintext grant for the removed row', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, unlockMode(14));
    const read = gatedDb(roles.play, (sql) => sql.includes('FROM user_provider_keys'));
    const { resolver } = resolverFor(read.gated);
    const pending = resolver.unlock(alice, [{ keyId: keyId(14), key: ALICE_KEY }]);
    while (!read.state.held) await new Promise((r) => setTimeout(r, 1));
    await resolver.remove(alice);
    read.state.release();
    await assert.rejects(pending, ProviderKeyForbiddenError);
    assert.deepEqual(resolver.grants.list(alice.id), []);

    await resolverFor(roles.play).resolver.save(alice, unlockMode(15));
    const del = gatedDb(roles.play, (sql) => sql.startsWith('DELETE FROM user_provider_keys'), true);
    const { resolver: racing } = resolverFor(del.gated);
    const removing = racing.remove(alice);
    while (!del.state.held) await new Promise((r) => setTimeout(r, 1));
    await racing.unlock(alice, [{ keyId: keyId(15), key: ALICE_KEY }]);
    del.state.release();
    assert.equal(await removing, true);
    assert.deepEqual(racing.grants.list(alice.id), [], 'the delete drops a grant that landed while it ran');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('replacing a key under the same client id still stops in-flight registries and grants', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver, bearers } = resolverFor(roles.play);
    await resolver.save(alice, sealed(16));
    const beforeReplace = await resolver.forRequest(alice);
    await resolver.save(alice, { ...sealed(16), key: 'sk-alice-rotated-0123456789' });
    await resolver.forRequest(alice);
    await assert.rejects(beforeReplace.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    assert.deepEqual(bearers, []);

    const other = resolverFor(roles.play).resolver;
    await resolver.save(alice, unlockMode(17));
    await resolver.unlock(alice, [{ keyId: keyId(17), key: ALICE_KEY }]);
    await other.save(alice, unlockMode(17));
    resolver.invalidate(alice.id);
    assert.equal(await resolver.status(alice), 'locked', 'a grant is bound to the row version, not the client id');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a delete in another process is seen once the cached row is a minute old', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let now = Date.parse('2026-09-26T10:00:00.000Z');
    const writer = resolverFor(roles.play).resolver;
    const { resolver: reader, bearers } = resolverFor(roles.play, { now: () => now });
    await writer.save(alice, sealed(18));
    const inFlight = await reader.forRequest(alice);
    assert.equal(await reader.status(alice), 'own');
    await writer.remove(alice);
    now += 59_000;
    assert.equal(await reader.status(alice), 'own', 'still cached');
    now += 1_000;
    assert.equal(await reader.status(alice), 'server');
    await assert.rejects(inFlight.get('narrate').complete(ask('narrate')), ProviderKeyLockedError);
    assert.deepEqual(bearers, []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a sealed key the server secret cannot open reports unavailable and falls back instead of failing calls', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, sealed(19));
    const { resolver: rotated, bearers } = resolverFor(roles.play, { secretsKey: Buffer.alloc(32, 6) });
    assert.equal(await rotated.status(alice), 'unavailable');
    assert.equal((await rotated.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.deepEqual(bearers, []);
  });
  if (!ran) t.skip('no Postgres configured');
});
