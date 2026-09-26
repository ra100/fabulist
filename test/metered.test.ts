import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, type CompletionRequest, type Provider } from '../src/providers/provider.ts';
import { MeteredRegistry, type UsageSink } from '../src/providers/metered.ts';
import { ProviderKeyLockedError } from '../src/providers/byok.ts';

const ask = (role: string): CompletionRequest => ({ role, messages: [{ role: 'user', content: 'hello' }] });

function sink() {
  const seen: Array<Parameters<UsageSink>[0]> = [];
  const fn: UsageSink = async (call) => {
    seen.push(call);
  };
  return { fn, seen };
}

function failing(error: Error): Provider {
  return {
    id: 'stub',
    model: 'stub-1',
    capabilities: new MockProvider().capabilities,
    complete: async () => {
      throw error;
    },
  };
}

test('every call through a metered registry is recorded with its role, provider and tokens', async () => {
  const { fn, seen } = sink();
  const registry = new MeteredRegistry(new ProviderRegistry(new MockProvider({ id: 'stub' })), fn);
  const result = await registry.get('narrate').complete(ask('narrate'));
  assert.deepEqual(seen, [
    {
      role: 'narrate',
      providerId: 'stub',
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    },
  ]);
  assert.equal(registry.get('extract').id, 'stub', 'the wrapper keeps the id upkeep is decided on');
  assert.equal(registry.all().length, 1);
});

test('the deterministic mock is never metered', async () => {
  const { fn, seen } = sink();
  await new MeteredRegistry(new ProviderRegistry(new MockProvider()), fn).get('narrate').complete(ask('narrate'));
  assert.equal(seen.length, 0);
});

test('provider errors are scrubbed of key-shaped strings and a locked key keeps its type', async () => {
  const leaky = new Error('https://api.example.com returned 401: {"auth":"Bearer sk-proj-abcdefghijklmnopqrstuv"}');
  await assert.rejects(
    new MeteredRegistry(new ProviderRegistry(failing(leaky)), sink().fn).get('narrate').complete(ask('narrate')),
    (err: Error) => {
      assert.doesNotMatch(err.message, /sk-proj-/);
      assert.match(err.message, /returned 401/);
      return true;
    },
  );
  await assert.rejects(
    new MeteredRegistry(new ProviderRegistry(failing(new ProviderKeyLockedError())), sink().fn)
      .get('narrate')
      .complete(ask('narrate')),
    ProviderKeyLockedError,
  );
});

test('a failing usage sink never fails the call it measures', async () => {
  const registry = new MeteredRegistry(new ProviderRegistry(new MockProvider({ id: 'stub' })), async () => {
    throw new Error('db down');
  });
  assert.equal(typeof (await registry.get('narrate').complete(ask('narrate'))).text, 'string');
});
