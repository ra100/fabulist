import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionUser } from './signed-in.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { ProviderResolver } from '../src/providers/resolver-pg.ts';
import type { Queryable } from '../src/db/pg.ts';

const apiKey = 'sk-test-0123456789abcdefghij';
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;
const user = sessionUser('alice');

function resolver(fetcher: typeof fetch) {
  return new ProviderResolver({
    db,
    server: new ProviderRegistry(new MockProvider()),
    shareServerProvider: () => false,
    secretsKey: null,
    fetcher,
  });
}

function response(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => '',
    }) as unknown as Response) as typeof fetch;
}

test('provider key test checks catalog access without a generation request', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  const result = await resolver(fetcher).test(user, { endpointId: 'openai', key: apiKey });

  assert.equal(result.status, 'verified');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0]?.init.method, undefined);
  assert.equal(calls[0]?.init.body, undefined);
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
});

test('provider key test reports rejection, unsupported catalogs, and network failure without exposing the key', async () => {
  const rejected = await resolver(response(401, { error: apiKey })).test(user, { endpointId: 'openai', key: apiKey });
  const unsupported = await resolver(response(404, {})).test(user, { endpointId: 'openai', key: apiKey });
  const network = await resolver((async () => {
    throw new Error('network failure ' + apiKey);
  }) as typeof fetch).test(user, { endpointId: 'openai', key: apiKey });

  assert.equal(rejected.status, 'rejected');
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(network.status, 'unavailable');
  for (const result of [rejected, unsupported, network]) assert.equal(JSON.stringify(result).includes(apiKey), false);
});
