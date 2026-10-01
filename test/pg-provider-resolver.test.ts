import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { sessionUser } from './signed-in.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type CompletionRequest } from '../src/providers/provider.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';
import { usageSettled } from '../src/providers/metered.ts';
import { EphemeralProviderKeyStore } from '../src/auth/ephemeral-provider-keys.ts';
import { ProviderKeyInputError, ProviderResolver, type ProviderResolverOptions } from '../src/providers/resolver-pg.ts';
import type { Queryable } from '../src/db/pg.ts';

const SECRET = Buffer.alloc(32, 5);
const ALICE_KEY = 'sk-alice-0123456789abcdefghij';
const ANTHROPIC_KEY = 'sk-ant-alice-0123456789abcdefghij';
const keyId = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const fakeWrap = { nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
const alice = sessionUser('alice');
const bob = sessionUser('bob');
const admin = sessionUser('admin');
const ask = (role: string): CompletionRequest => ({ role, messages: [{ role: 'user', content: 'hello' }] });

/**
 * Real `Response` objects, and real `Headers`.
 *
 * The provider adapters resolve credentials by wrapping `fetch` and setting a
 * `Headers` instance, and the AI SDK transports read `response.headers` and
 * `response.body`. A duck-typed `{ ok, status, json }` stub answers neither, so
 * the test would fail for a reason that says nothing about the behaviour it is
 * checking.
 */
function stubFetch(status = 200) {
  const calls: Array<{ url: string; authorization: string; apiKey: string; model: string }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    calls.push({
      url,
      authorization: headers.get('authorization') ?? '',
      apiKey: headers.get('x-api-key') ?? '',
      model: body.model ?? '',
    });
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/messages')) {
      // Anthropic's Messages envelope, which its SDK parser validates strictly.
      return new Response(
        JSON.stringify({
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: body.model ?? 'm',
          content: [{ type: 'text', text: 'ready' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-stub',
        model: body.model ?? 'm',
        choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

function resolverFor(db: Queryable, over: Partial<ProviderResolverOptions> = {}, status = 200) {
  const stub = stubFetch(status);
  const server = new MockProvider({ id: 'server-stub' });
  const resolver = new ProviderResolver({
    db,
    server: new ProviderRegistry(server),
    shareServerProvider: () => true,
    secretsKey: SECRET,
    fetcher: stub.fetcher,
    ...over,
  });
  return { resolver, calls: stub.calls, server };
}

function sealed(n: number, endpointId = 'openai', key = ALICE_KEY) {
  return { id: keyId(n), label: 'test ' + n, endpointId, trust: 'sealed' as const, key };
}

function unlockMode(n: number) {
  return {
    id: keyId(n),
    label: 'unlock ' + n,
    endpointId: 'openai',
    trust: 'unlock' as const,
    wrap: fakeWrap,
    keyHint: 'ghij',
  };
}

test('resolution keeps existing shared-server and mock fallback until a role is assigned', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    let share = true;
    const { resolver } = resolverFor(roles.play, { shareServerProvider: () => share });
    assert.equal(
      (await resolver.forRequest(null)).get('narrate').id,
      'server-stub',
      'login-off keeps the server registry',
    );
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');
    assert.equal(await resolver.status(alice), 'server');
    share = false;
    assert.equal((await resolver.forRequest(alice)).get('extract').id, 'mock');
    assert.equal(await resolver.status(alice), 'none');
    assert.equal(
      (await resolver.forRequest(admin)).get('narrate').id,
      'server-stub',
      'admins reach the server provider',
    );

    await resolver.save(alice, sealed(1));
    assert.equal(
      (await resolver.forRequest(alice)).get('narrate').id,
      'mock',
      'an unassigned credential is not selected implicitly',
    );
    await resolver.saveAssignments(alice, [{ role: 'narrate', providerKeyId: keyId(1), model: 'gpt-narrate' }]);
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'openai');
    assert.equal((await resolver.forRequest(alice)).get('referee').model, 'gpt-narrate');
    assert.equal(await resolver.status(alice), 'own');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('each role routes through its assigned credential and unassigned roles use Narration', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const { resolver, calls } = resolverFor(roles.play);
    await resolver.save(alice, sealed(2, 'openai', ALICE_KEY));
    await resolver.save(alice, sealed(3, 'anthropic', ANTHROPIC_KEY));
    await resolver.saveAssignments(alice, [
      { role: 'narrate', providerKeyId: keyId(2), model: 'gpt-narration' },
      { role: 'classify', providerKeyId: keyId(3), model: 'claude-classify' },
      { role: 'extract', providerKeyId: keyId(2), model: 'gpt-extract' },
    ]);

    const registry = await resolver.forRequest(alice, 'story-1');
    for (const role of ['narrate', 'classify', 'extract', 'director']) {
      await registry.get(role).complete(ask(role));
    }
    assert.deepEqual(
      calls.map(({ url, authorization, apiKey, model }) => ({
        url: url.split('/').slice(-2).join('/'),
        authorization,
        apiKey,
        model,
      })),
      [
        { url: 'chat/completions', authorization: 'Bearer ' + ALICE_KEY, apiKey: '', model: 'gpt-narration' },
        { url: 'v1/messages', authorization: '', apiKey: ANTHROPIC_KEY, model: 'claude-classify' },
        { url: 'chat/completions', authorization: 'Bearer ' + ALICE_KEY, apiKey: '', model: 'gpt-extract' },
        { url: 'chat/completions', authorization: 'Bearer ' + ALICE_KEY, apiKey: '', model: 'gpt-narration' },
      ],
    );
    await usageSettled();
    const touched = await db.query<{ id: string; used: boolean }>(
      'SELECT id, last_used_at IS NOT NULL AS used FROM user_provider_keys WHERE user_id = $1 ORDER BY id',
      [alice.id],
    );
    assert.deepEqual(touched.rows, [
      { id: keyId(2), used: true },
      { id: keyId(3), used: true },
    ]);
    const usage = await db.query<{ role: string; key_source: string; story_id: string }>(
      'SELECT DISTINCT role, key_source, story_id FROM usage_events WHERE user_id = $1 ORDER BY role',
      [alice.id],
    );
    assert.ok(usage.rows.every((row) => row.key_source === 'own' && row.story_id === 'story-1'));
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a locked explicit role credential errors instead of using Narration or the shared server key', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver, calls, server } = resolverFor(roles.play);
    await resolver.save(alice, sealed(4));
    await resolver.save(alice, unlockMode(5));
    await resolver.saveAssignments(alice, [
      { role: 'narrate', providerKeyId: keyId(4), model: 'gpt-narration' },
      { role: 'classify', providerKeyId: keyId(5), model: 'gpt-classify' },
    ]);
    const registry = await resolver.forRequest(alice);
    await assert.rejects(registry.get('classify').complete(ask('classify')), ProviderKeyLockedError);
    assert.equal(JSON.stringify(calls), '[]', 'the assigned locked key was not replaced with another credential');
    assert.equal(server.calls.length, 0, 'the configured shared provider was not used');
    await registry.get('narrate').complete(ask('narrate'));
    assert.equal(calls[0]?.authorization, 'Bearer ' + ALICE_KEY);
    assert.equal(await resolver.status(alice), 'locked');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('saved model discovery uses the selected credential, even when another credential is also saved', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver, calls } = resolverFor(roles.play);
    await resolver.save(alice, sealed(6, 'openai', ALICE_KEY));
    await resolver.save(alice, sealed(7, 'anthropic', ANTHROPIC_KEY));
    assert.deepEqual(await resolver.modelsForSaved(alice, keyId(7)), ['gpt-a', 'gpt-b']);
    assert.deepEqual(
      calls.map(({ url, authorization, apiKey }) => ({ url, authorization, apiKey })),
      [
        {
          url: 'https://api.anthropic.com/v1/models',
          authorization: '',
          apiKey: ANTHROPIC_KEY,
        },
      ],
    );
    assert.deepEqual(await resolver.modelsForSaved(alice, keyId(6)), ['gpt-a', 'gpt-b']);
    assert.deepEqual(
      calls.map((call) => call.authorization || call.apiKey),
      [ANTHROPIC_KEY, 'Bearer ' + ALICE_KEY],
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('provider key test verifies by listing models and reports rejected, unsupported, and network failure without leaking the key', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const success = resolverFor(roles.play);
    assert.deepEqual(await success.resolver.test(alice, { endpointId: 'openai', key: ALICE_KEY }), {
      status: 'verified',
      message: 'Provider access verified (2 models listed).',
    });
    assert.equal(success.calls[0]?.url, 'https://api.openai.com/v1/models');
    assert.equal(success.calls[0]?.authorization, 'Bearer ' + ALICE_KEY);
    assert.equal(
      success.calls.some((call) => call.url.endsWith('/chat/completions')),
      false,
      'key test makes no generation call',
    );

    const rejectingFetch = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => ALICE_KEY,
      }) as unknown as Response) as typeof fetch;
    const rejected = await resolverFor(roles.play, { fetcher: rejectingFetch }).resolver.test(alice, {
      endpointId: 'openai',
      key: ALICE_KEY,
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(JSON.stringify(rejected).includes(ALICE_KEY), false);

    const unsupportedFetch = (async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      }) as unknown as Response) as typeof fetch;
    const unsupported = await resolverFor(roles.play, { fetcher: unsupportedFetch }).resolver.test(alice, {
      endpointId: 'openai',
      key: ALICE_KEY,
    });
    assert.equal(unsupported.status, 'unsupported');

    const networkFetch = (async () => {
      throw new Error('network error ' + ALICE_KEY);
    }) as typeof fetch;
    const unavailable = await resolverFor(roles.play, { fetcher: networkFetch }).resolver.test(alice, {
      endpointId: 'openai',
      key: ALICE_KEY,
    });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(JSON.stringify(unavailable).includes(ALICE_KEY), false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('saving and removing credentials is independent; removing one clears only its model assignments and grant', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const grants = new EphemeralProviderKeyStore();
    const { resolver } = resolverFor(roles.play, { grants });
    await resolver.save(alice, unlockMode(8));
    await resolver.save(alice, sealed(9));
    await resolver.saveAssignments(alice, [
      { role: 'narrate', providerKeyId: keyId(8), model: 'gpt-unlock' },
      { role: 'extract', providerKeyId: keyId(9), model: 'gpt-extract' },
    ]);
    await resolver.unlock(alice, [{ keyId: keyId(8), key: ALICE_KEY }]);
    const version = (
      await roles.play.query<{ version: string }>('SELECT version FROM user_provider_keys WHERE id = $1', [keyId(8)])
    ).rows[0]!.version;
    assert.equal(grants.get(alice.id, keyId(8), version), ALICE_KEY);

    assert.equal(await resolver.remove(alice, keyId(8)), true);
    assert.deepEqual(grants.list(alice.id), []);
    assert.deepEqual(await resolver.assignments(alice), [
      { role: 'extract', providerKeyId: keyId(9), model: 'gpt-extract' },
    ]);
    assert.equal(await resolver.status(alice), 'own');
    assert.equal(await resolver.remove(alice, keyId(8)), false);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an unlock racing a delete never leaves a plaintext grant for the removed row', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await resolverFor(roles.play).resolver.save(alice, unlockMode(10));
    const db = roles.play;
    let release!: () => void;
    let held = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    const gated: Queryable = {
      query: (async (sql: string, params?: unknown[]) => {
        const hit = armed && sql.includes('FROM user_provider_keys');
        if (hit) {
          armed = false;
          held = true;
          await gate;
        }
        return db.query(sql, params);
      }) as Queryable['query'],
    };
    const { resolver } = resolverFor(gated);
    const pending = resolver.unlock(alice, [{ keyId: keyId(10), key: ALICE_KEY }]);
    while (!held) await new Promise((resolve) => setTimeout(resolve, 1));
    await resolver.remove(alice, keyId(10));
    release();
    await assert.rejects(pending);
    assert.deepEqual(resolver.grants.list(alice.id), []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an explicit assignment cannot be saved to a credential owned by another user', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver } = resolverFor(roles.play);
    await resolver.save(bob, sealed(11));
    await assert.rejects(
      resolver.saveAssignments(alice, [{ role: 'narrate', providerKeyId: keyId(11), model: 'gpt-test' }]),
      (error: Error) => error instanceof ProviderKeyInputError && /saved providers/.test(error.message),
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('an image assignment routes illustrations through the saved OpenAI credential, separately from text', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const imageCalls: Array<{ url: string; authorization: string; model: string }> = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      imageCalls.push({
        url: String(input),
        authorization: new Headers(init.headers).get('authorization') ?? '',
        model: body.model,
      });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { resolver } = resolverFor(roles.play, { fetcher });

    assert.equal(await resolver.imageProviderFor(alice), null, 'no assignment keeps the server image profile');
    assert.equal(await resolver.imageProviderFor(null), null);

    await resolver.save(alice, sealed(40));
    await resolver.saveAssignments(alice, [{ role: 'image', providerKeyId: keyId(40), model: 'gpt-image-1' }]);
    assert.equal(await resolver.status(alice), 'server', 'an image-only assignment does not claim the text roles');
    assert.equal((await resolver.forRequest(alice)).get('narrate').id, 'server-stub');

    const image = await resolver.imageProviderFor(alice);
    assert.ok(image);
    await image.generate({ prompt: 'a lighthouse' });
    assert.deepEqual(imageCalls, [
      {
        url: 'https://api.openai.com/v1/images/generations',
        authorization: `Bearer ${ALICE_KEY}`,
        model: 'gpt-image-1',
      },
    ]);
    assert.equal(await resolver.imageProviderFor(bob), null, 'another user never gets this assignment');

    await resolver.remove(alice, keyId(40));
    assert.equal(await resolver.imageProviderFor(alice), null, 'removing the credential clears its image assignment');
    assert.deepEqual(await resolver.assignments(alice), []);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('the image role refuses a credential that cannot make images and a locked one', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    const { resolver } = resolverFor(roles.play);
    await resolver.save(alice, sealed(41, 'anthropic', ANTHROPIC_KEY));
    await assert.rejects(
      resolver.saveAssignments(alice, [{ role: 'image', providerKeyId: keyId(41), model: 'claude' }]),
      ProviderKeyInputError,
    );

    await resolver.save(alice, unlockMode(42));
    await resolver.saveAssignments(alice, [{ role: 'image', providerKeyId: keyId(42), model: 'gpt-image-1' }]);
    const image = await resolver.imageProviderFor(alice);
    assert.ok(image);
    await assert.rejects(
      image.generate({ prompt: 'p' }),
      ProviderKeyLockedError,
      'a locked key is not swapped for the server profile',
    );
  });
  if (!ran) t.skip('no Postgres configured');
});
