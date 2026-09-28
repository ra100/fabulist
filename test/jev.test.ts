import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevProvider } from '../src/providers/http.ts';
import { checkWithJev } from '../src/loop/jev-fastpath.ts';
import type { CompletionRequest } from '../src/providers/provider.ts';
import { clearAnswers, ScriptedJevProvider, jevTestCapabilities } from './jev-fixtures.ts';

test('Jev adapter sends typed Decisions API payload and records usage', async () => {
  let sentUrl = '';
  let sentHeaders: HeadersInit | undefined;
  let sentBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    sentUrl = String(input);
    sentHeaders = init?.headers;
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: 'typesafe/jev-1.13',
      answers: { referee: { choice: 'clear_no_cost_allow', probabilities: { clear_no_cost_allow: 1 } } },
      usage: { input_tokens: 42, output_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = new JevProvider({
    apiKey: 'test-token',
    baseUrl: 'https://openrouter.ai/api/',
    model: 'typesafe/jev-1.13',
    capabilities: jevTestCapabilities,
    fetcher,
  });
  const req: CompletionRequest = {
    role: 'jev-fastpath',
    messages: [{ role: 'user', content: 'state text' }],
    schema: {
      name: 'jev_fast_checks',
      schema: {
        properties: {
          referee: {
            instructions: 'Allow only when there is no cost.',
            criteria: { clear_no_cost_allow: 'No cost', full_referee_review: 'Anything else' },
          },
        },
      },
    },
  };

  const result = await provider.complete(req);
  assert.equal(sentUrl, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(new Headers(sentHeaders).get('authorization'), 'Bearer test-token');
  assert.equal(sentBody?.model, 'typesafe/jev-1.13');
  assert.equal(sentBody?.state, 'state text');
  assert.deepEqual(sentBody?.questions, {
    referee: {
      type: 'choice',
      instructions: 'Allow only when there is no cost.',
      criteria: { clear_no_cost_allow: 'No cost', full_referee_review: 'Anything else' },
    },
  });
  assert.equal(result.tokensIn, 42);
  assert.equal(result.tokensOut, 3);
});

test('Jev accepts each role independently at its own safe probability cutoff', async () => {
  const provider = new ScriptedJevProvider(clearAnswers({ integrityProbability: 0.998, refereeProbability: 0.995 }));
  const calls: string[] = [];
  const verdicts = await checkWithJev({
    optionalProvider: () => provider,
    log: (role) => calls.push(role),
  }, {
    rawInput: 'I carefully copy the page.',
    refereeState: 'The scriptorium is open.',
    integrityState: 'The character has sworn to preserve the codex.',
  });

  assert.deepEqual(verdicts, { referee: true }, 'the lower integrity score falls back without discarding the clear Referee answer');
  assert.deepEqual(calls, ['jev-fastpath']);
  const schema = provider.requests[0]?.schema?.schema as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['integrity', 'referee']);
});

test('Jev asks only Referee when the Integrity gate would not run', async () => {
  const provider = new ScriptedJevProvider(clearAnswers());
  const verdicts = await checkWithJev({
    optionalProvider: () => provider,
    log: () => {},
  }, { rawInput: 'The bells ring.', refereeState: 'The world context.' });

  assert.deepEqual(verdicts, { referee: true });
  const schema = provider.requests[0]?.schema?.schema as { properties?: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['referee']);
});

test('Jev unsafe choices, uncertain probabilities, and malformed answers all fall back', async () => {
  const unsafe = new ScriptedJevProvider(clearAnswers({
    integrityChoice: 'full_integrity_review',
    refereeChoice: 'full_referee_review',
  }));
  assert.deepEqual(await checkWithJev({ optionalProvider: () => unsafe, log: () => {} }, {
    rawInput: 'I break the vow.',
    refereeState: 'A cost may apply.',
    integrityState: 'An active vow forbids this.',
  }), {});

  const weak = new ScriptedJevProvider(clearAnswers({ integrityProbability: 0.9, refereeProbability: 0.9 }));
  assert.deepEqual(await checkWithJev({ optionalProvider: () => weak, log: () => {} }, {
    rawInput: 'Maybe it works.',
    refereeState: 'Uncertain.',
    integrityState: 'Uncertain.',
  }), {});

  const partial = new ScriptedJevProvider({
    answers: { referee: { choice: 'clear_no_cost_allow', probabilities: { clear_no_cost_allow: 0.995 } } },
  });
  assert.deepEqual(await checkWithJev({ optionalProvider: () => partial, log: () => {} }, {
    rawInput: 'Maybe it works.',
    refereeState: 'Uncertain.',
    integrityState: 'Character context.',
  }), { referee: true }, 'a missing character answer does not discard the independently clear world answer');

  const malformed = new ScriptedJevProvider('not json');
  assert.deepEqual(await checkWithJev({ optionalProvider: () => malformed, log: () => {} }, {
    rawInput: 'Maybe it works.',
    refereeState: 'Uncertain.',
  }), {});
});

test('all risky world rulings and character distances stay on their full-model routes', async () => {
  const worldOutcomes = ['allow-with-cost', 'spawn', 'reinterpret', 'friction', 'contradiction', 'no-go', 'uncertain'];
  for (const refereeChoice of worldOutcomes) {
    const provider = new ScriptedJevProvider(clearAnswers({ refereeChoice }));
    const result = await checkWithJev({ optionalProvider: () => provider, log: () => {} }, {
      rawInput: 'I try an uncertain action.',
      refereeState: 'The world may impose a consequence.',
    });
    assert.equal(result.referee, undefined, refereeChoice);
  }

  const characterOutcomes = ['stretch', 'off-key', 'contract-breach', 'incoherent', 'uncertain'];
  for (const integrityChoice of characterOutcomes) {
    const provider = new ScriptedJevProvider(clearAnswers({ integrityChoice }));
    const result = await checkWithJev({ optionalProvider: () => provider, log: () => {} }, {
      rawInput: 'I do something unlike myself.',
      refereeState: 'No world facts.',
      integrityState: 'The character has active vows.',
    });
    assert.equal(result.integrity, undefined, integrityChoice);
  }
});

test('oversized context skips Jev without adding a request cost', async () => {
  const provider = new ScriptedJevProvider(clearAnswers());
  const verdicts = await checkWithJev({
    optionalProvider: () => provider,
    log: () => {},
  }, {
    rawInput: 'I act.',
    refereeState: 'x'.repeat(140_000),
  });

  assert.deepEqual(verdicts, {});
  assert.equal(provider.requests.length, 0);
});

test('Jev API errors are recorded and leave both full-model fallbacks available', async () => {
  const provider = new ScriptedJevProvider(new Error('timeout'));
  const telemetry: Array<{ ok: boolean; role: string }> = [];
  const verdicts = await checkWithJev({
    optionalProvider: () => provider,
    log: () => {},
    onProviderCall: (call) => telemetry.push({ ok: call.ok, role: call.role }),
  }, { rawInput: 'I try.', refereeState: 'Context.' });

  assert.deepEqual(verdicts, {});
  assert.deepEqual(telemetry, [{ ok: false, role: 'jev-fastpath' }]);
});

test('an unconfigured optional Jev route makes no request', async () => {
  let called = false;
  const verdicts = await checkWithJev({
    optionalProvider: () => undefined,
    log: () => { called = true; },
  }, { rawInput: 'I wait.', refereeState: 'Context.' });

  assert.deepEqual(verdicts, {});
  assert.equal(called, false);
});
