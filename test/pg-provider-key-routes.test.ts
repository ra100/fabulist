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
import { seedWorld } from '../src/seed/verrow-pg.ts';
import { createEncryptionEnrollment } from '../web/src/crypto/keys.ts';
import type { Db } from '../src/db/pg.ts';

const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const ANTHROPIC_KEY = 'sk-ant-alice-0123456789abcdefghij';
const KEY1 = '00000000-0000-4000-8000-000000000001';
const KEY2 = '00000000-0000-4000-8000-000000000002';
const KEY3 = '00000000-0000-4000-8000-000000000003';
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
type Body = Record<string, unknown>;
const body = (reply: { body: unknown }) => reply.body as Body;

function providerFetch(
  calls: Array<{ url: string; authorization: string; apiKey: string; model: string }> = [],
  status = 200,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const requestBody = init.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    calls.push({
      url,
      authorization: headers.authorization ?? '',
      apiKey: headers['x-api-key'] ?? '',
      model: requestBody.model ?? '',
    });
    if (url.endsWith('/models')) {
      const ok = status >= 200 && status < 300;
      return {
        ok,
        status,
        json: async () => ({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }),
        text: async () => '',
      } as unknown as Response;
    }
    if (url.endsWith('/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'ready' }],
          usage: { input_tokens: 7, output_tokens: 1 },
        }),
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ready' } }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
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
    fetcher: providerFetch(),
    keyCallLimit: { burst: 50, perMinute: 60 },
    ...over,
  });
  const engine = new Engine({
    world: boot,
    db: roles.play,
    ingestDb: roles.ingest,
    providers: new ProviderRegistry(new MockProvider()),
  });
  const { as, base, close } = await listenSignedIn(
    createApiServer({
      world: boot,
      db: roles.play,
      ingestDb: roles.ingest,
      engine,
      authConfig: fakeAuth(),
      providerResolver: resolver,
    }),
  );
  try {
    await fn(as, resolver, base);
  } finally {
    await close();
  }
}

async function storiesFor(db: Db): Promise<Record<'alice' | 'bob' | 'admin', string>> {
  const worldId = await makeWorld(db, 'shared');
  const out = {} as Record<'alice' | 'bob' | 'admin', string>;
  for (const who of ['alice', 'bob', 'admin'] as const) {
    out[who] = (await createStory(db, { title: who, worldIds: [worldId], ownerUserId: PEOPLE[who].id })).id;
  }
  return out;
}

test('providers can be tested before saving, loaded by selected credential, assigned by role, and removed individually', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const calls: Array<{ url: string; authorization: string; apiKey: string; model: string }> = [];
    await withKeyServer(
      roles,
      async (as) => {
        const tested = body(
          await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'anthropic', key: ANTHROPIC_KEY }),
        );
        assert.deepEqual(tested, { status: 'verified', message: 'Provider access verified (2 models listed).' });
        assert.deepEqual(
          calls[0],
          {
            url: 'https://api.anthropic.com/v1/models',
            authorization: '',
            apiKey: ANTHROPIC_KEY,
            model: '',
          },
          'test sends the selected provider and typed key to its model-list endpoint',
        );

        const listedFromTypedKey = body(
          await as('alice', 'POST', '/api/provider-key/models', { endpointId: 'anthropic', key: ANTHROPIC_KEY }),
        );
        assert.deepEqual(listedFromTypedKey.models, ['gpt-a', 'gpt-b']);

        const first = await as('alice', 'POST', '/api/provider-keys', {
          id: KEY1,
          label: 'Writing',
          endpointId: 'openai',
          trust: 'sealed',
          key: ALICE_KEY,
        });
        assert.equal(first.status, 201, JSON.stringify(first.body));
        const second = await as('alice', 'POST', '/api/provider-keys', {
          id: KEY2,
          label: 'Analysis',
          endpointId: 'anthropic',
          trust: 'sealed',
          key: ANTHROPIC_KEY,
        });
        assert.equal(second.status, 201, JSON.stringify(second.body));
        assert.equal(JSON.stringify(first.body).includes(ALICE_KEY), false);
        assert.equal(JSON.stringify(second.body).includes(ANTHROPIC_KEY), false);

        const read = body(await as('alice', 'GET', '/api/provider-keys'));
        const saved = read.keys as Array<Body>;
        assert.deepEqual(
          saved.map((entry) => (entry.key as Body).id),
          [KEY1, KEY2],
        );
        assert.equal((saved[0]!.key as Body).keyHint, 'ghij');
        assert.equal(saved[0]!.status, 'ready');
        assert.equal(JSON.stringify(read).includes(ALICE_KEY), false);
        assert.equal((read.endpoints as unknown[]).length, 12);

        const assignments = [
          { role: 'narrate', providerKeyId: KEY1, model: 'gpt-narrate' },
          { role: 'classify', providerKeyId: KEY2, model: 'claude-classify' },
        ];
        const configured = body(await as('alice', 'PUT', '/api/provider-models', { assignments }));
        assert.deepEqual(configured.assignments, assignments);
        assert.deepEqual(body(await as('alice', 'GET', '/api/provider-models')).assignments, assignments);

        const savedModels = body(await as('alice', 'GET', '/api/provider-keys/' + KEY2 + '/models'));
        assert.deepEqual(savedModels.models, ['gpt-a', 'gpt-b']);

        const removed = body(await as('alice', 'DELETE', '/api/provider-keys/' + KEY2));
        assert.equal(removed.removed, true);
        assert.deepEqual(body(await as('alice', 'GET', '/api/provider-models')).assignments, [assignments[0]]);
        assert.equal(body(await as('bob', 'DELETE', '/api/provider-keys/' + KEY1)).removed, false);
        assert.equal(
          (
            await as('alice', 'POST', '/api/provider-keys', {
              id: KEY3,
              label: '',
              endpointId: 'localhost',
              trust: 'sealed',
              key: ALICE_KEY,
            })
          ).status,
          400,
        );
      },
      { fetcher: providerFetch(calls) },
    );

    assert.deepEqual(
      calls.map(({ url, authorization, apiKey }) => ({ url, authorization, apiKey })),
      [
        { url: 'https://api.anthropic.com/v1/models', authorization: '', apiKey: ANTHROPIC_KEY },
        { url: 'https://api.anthropic.com/v1/models', authorization: '', apiKey: ANTHROPIC_KEY },
        { url: 'https://api.anthropic.com/v1/models', authorization: '', apiKey: ANTHROPIC_KEY },
      ],
    );
    const remaining = await db.query<{ id: string }>('SELECT id FROM user_provider_keys WHERE user_id = $1', [
      PEOPLE.alice.id,
    ]);
    assert.deepEqual(remaining.rows, [{ id: KEY1 }]);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('unlock-mode credentials coexist and the browser can unlock all saved wraps', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const stories = await storiesFor(db);
    await withKeyServer(roles, async (as, resolver, base) => {
      for (const who of ['alice', 'bob'] as const) {
        const { recoveryCode: _code, ...enrollment } = await createEncryptionEnrollment(
          PEOPLE[who].id,
          'a durable private passphrase',
          [stories[who]],
        );
        assert.equal((await as(who, 'POST', '/api/encryption/enroll', enrollment)).status, 201);
      }
      const saveOne = await as('alice', 'POST', '/api/provider-keys', {
        id: KEY1,
        endpointId: 'openai',
        trust: 'unlock',
        wrap: fakeWrap,
        keyHint: 'ghij',
      });
      const saveTwo = await as('alice', 'POST', '/api/provider-keys', {
        id: KEY2,
        endpointId: 'anthropic',
        trust: 'unlock',
        wrap: fakeWrap,
        keyHint: 'wxyz',
      });
      assert.equal(saveOne.status, 201);
      assert.equal(saveTwo.status, 201);
      await as('alice', 'PUT', '/api/provider-models', {
        assignments: [
          { role: 'narrate', providerKeyId: KEY1, model: 'gpt-narrate' },
          { role: 'classify', providerKeyId: KEY2, model: 'claude-classify' },
        ],
      });
      const bundle = body(await as('alice', 'GET', '/api/encryption/keys'));
      assert.deepEqual(
        (bundle.providerKeys as Array<Body>).map((record) => record.keyId),
        [KEY1, KEY2],
      );

      const stolen = await as('bob', 'POST', '/api/encryption/unlock', {
        providerKeys: [{ keyId: KEY1, key: 'sk-bob-0123456789abcd' }],
      });
      assert.equal(stolen.status, 403);

      const unlocked = await as('alice', 'POST', '/api/encryption/unlock', {
        providerKeys: [
          { keyId: KEY1, key: ALICE_KEY },
          { keyId: KEY2, key: ANTHROPIC_KEY },
        ],
      });
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
      assert.equal((body(unlocked).providerGrants as unknown[]).length, 2);
      assert.equal(await resolver.status(sessionUser('alice')), 'own');

      const locked = body(await as('alice', 'POST', '/api/encryption/lock', {}));
      assert.equal(locked.providerLocked, true);
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');

      const half = await as('alice', 'POST', '/api/encryption/unlock', {
        providerKeys: [{ keyId: KEY1, key: ALICE_KEY }],
      });
      assert.equal(half.status, 200);
      assert.equal(
        await resolver.status(sessionUser('alice')),
        'locked',
        'the other assigned credential remains locked',
      );
      const all = await as('alice', 'POST', '/api/encryption/unlock', {
        providerKeys: [
          { keyId: KEY1, key: ALICE_KEY },
          { keyId: KEY2, key: ANTHROPIC_KEY },
        ],
      });
      assert.equal(all.status, 200);
      const out = await fetch(base + '/auth/logout', {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: SESSION_COOKIE + '=alice' },
      });
      assert.equal(out.status, 302);
      assert.equal(await resolver.status(sessionUser('alice')), 'locked');
    });
  });
  if (!ran) t.skip('no Postgres configured');
});

test('key test distinguishes success, rejection, unsupported catalogs, and network failures without making generation calls', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const calls: string[] = [];
    const outcomes: Array<{ status: number | 'network'; expected: string }> = [
      { status: 200, expected: 'verified' },
      { status: 401, expected: 'rejected' },
      { status: 404, expected: 'unsupported' },
      { status: 'network', expected: 'unavailable' },
    ];
    let index = 0;
    const fetcher = (async (input: string | URL | Request) => {
      calls.push(String(input));
      const outcome = outcomes[index++]!;
      if (outcome.status === 'network') throw new Error('connection failed');
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        json: async () => ({ data: [{ id: 'model-a' }] }),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;
    await withKeyServer(
      roles,
      async (as) => {
        for (const outcome of outcomes) {
          const reply = body(
            await as('alice', 'POST', '/api/provider-key/test', { endpointId: 'openai', key: ALICE_KEY }),
          );
          assert.equal(reply.status, outcome.expected);
          assert.equal(JSON.stringify(reply).includes(ALICE_KEY), false);
        }
      },
      { fetcher },
    );
    assert.deepEqual(calls, [
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/models',
    ]);
    assert.ok(calls.every((url) => !url.endsWith('/chat/completions')));
  });
  if (!ran) t.skip('no Postgres configured');
});
