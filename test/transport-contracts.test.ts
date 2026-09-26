import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forkStoryBodySchema,
  encryptionEnrollmentBodySchema,
  encryptionLockBodySchema,
  encryptionUnlockBodySchema,
  illustrationBodySchema,
  providerKeyBodySchema,
  knowledgeBodySchema,
  playResponseSchema,
  rollbackBodySchema,
  splitSceneBodySchema,
  setupPreviewBodySchema,
  sheetBodySchema,
  stateResponseSchema,
  storySourcesBodySchema,
  worldAccessBodySchema,
} from '../src/server/contracts.ts';
import { api } from '../web/src/api.ts';

test('mutation contracts reject unknown fields and invalid nested values', () => {
  const invalid = [
    sheetBodySchema.safeParse({ condition: { mood: 'fine' } }),
    sheetBodySchema.safeParse({ locks: ['condition.mood'], typo: true }),
    knowledgeBodySchema.safeParse({ entityId: 'char:a', level: 'heard' }),
    knowledgeBodySchema.safeParse({ entityId: 'char:a', level: 'knows', distortion: 2 }),
    illustrationBodySchema.safeParse({ visualStyle: 'oil-painting' }),
    forkStoryBodySchema.safeParse({ atScene: -1 }),
    rollbackBodySchema.safeParse({ scene: 1, chapter: 2 }),
    rollbackBodySchema.safeParse({}),
    rollbackBodySchema.safeParse({ scene: 1, turnId: 'turn:2' }),
    splitSceneBodySchema.safeParse({}),
    splitSceneBodySchema.safeParse({ turnId: 'turn:2', scene: 1 }),
    storySourcesBodySchema.safeParse({ slugs: [] }),
    worldAccessBodySchema.safeParse({ userId: 'user:a', role: 'writer' }),
    setupPreviewBodySchema.safeParse({ baseUrl: 'not a url', seeds: ['start'] }),
    setupPreviewBodySchema.safeParse({ baseUrl: 'https://example.test', seeds: ['start'], maxPages: 0 }),
    encryptionEnrollmentBodySchema.safeParse({
      userKey: { version: 1, passphraseKdf: 'pbkdf2-sha256', passphraseKdfParams: { iterations: 1 } },
      storyKeys: [],
    }),
    encryptionUnlockBodySchema.safeParse({ storyKeys: [{ storyId: 'story-a', key: 'not base64!' }] }),
  ];

  assert.ok(invalid.every((result) => !result.success));
});

test('mutation contracts preserve documented defaults and valid clients', () => {
  assert.deepEqual(worldAccessBodySchema.parse({ userId: 'user:a' }), { userId: 'user:a' });
  assert.deepEqual(setupPreviewBodySchema.parse({
    baseUrl: 'https://example.test/wiki',
    seeds: ['Start'],
  }), {
    baseUrl: 'https://example.test/wiki',
    seeds: ['Start'],
  });
  assert.deepEqual(illustrationBodySchema.parse({}), {});
  assert.deepEqual(rollbackBodySchema.parse({ turnId: 'turn:2', mode: 'destructive' }), {
    turnId: 'turn:2',
    mode: 'destructive',
  });
  assert.deepEqual(splitSceneBodySchema.parse({ turnId: 'turn:2' }), { turnId: 'turn:2' });
  assert.equal(encryptionEnrollmentBodySchema.safeParse({
    userKey: {
      version: 1,
      passphraseKdf: 'pbkdf2-sha256',
      passphraseKdfParams: { iterations: 600_000 },
      passphraseSalt: 'AAAAAAAAAAAAAAAAAAAAAA==',
      passphraseWrap: { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      recoverySalt: 'AAAAAAAAAAAAAAAAAAAAAA==',
      recoveryWrap: { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      recoveryCodeHint: 'abcdefgh',
    },
    storyKeys: [{
      storyId: 'story-private',
      version: 1,
      wrap: { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    }],
  }).success, true);
  assert.deepEqual(encryptionLockBodySchema.parse({}), {});
  assert.equal(encryptionUnlockBodySchema.safeParse({
    storyKeys: [{ storyId: 'story-private', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }],
  }).success, true);
});

test('play response contract detects server drift', () => {
  assert.equal(playResponseSchema.safeParse({
    outcome: {
      kind: 'interrupted',
      interrupt: { message: 'Choose', options: [] },
      distance: 'near',
      reasoning: 'A vow applies',
    },
    seeded: 0,
    tick: null,
  }).success, true);
  assert.equal(playResponseSchema.safeParse({
    outcome: { kind: 'narrated', prose: 'Done', turn: {} },
    seeded: 'zero',
    tick: null,
  }).success, false);
});

test('state response contract detects drift in critical counters and session data', () => {
  assert.equal(stateResponseSchema.safeParse({
    worldTitle: 'Test',
    session: {
      scene: 'one',
      turn: 0,
      playerCharacterId: '',
      currentLocationId: null,
      style: {},
      knobs: {},
    },
    counts: { entities: 1, edges: 0, canon: 1, chronicle: 0 },
    scenes: [],
    threads: [],
    directives: [],
    pendingConsequences: 0,
    hiddenFired: 0,
    divergences: [],
    usage: { tokensIn: 0, tokensOut: 0, calls: 0, byRole: {} },
  }).success, false);
});

test('browser play rejects malformed successful JSON responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(api.play('wait'), /malformed JSON response from \/play/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser streaming play reports response drift instead of calling onDone', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'event: done\ndata: {"outcome":{"kind":"narrated","prose":"Done","turn":{}},"seeded":"zero","tick":null}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const errors: string[] = [];
  let completed = false;
  try {
    await api.playStream('wait', false, {
      onDone: () => {
        completed = true;
      },
      onError: (message) => errors.push(message),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(completed, false);
  assert.match(errors[0] ?? '', /malformed play completion/);
});

test('browser streaming play aborts in-flight fetches without stale callbacks', async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  let sawSignal = false;
  let releaseFetch!: () => void;
  const fetchReady = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    sawSignal = init?.signal === abort.signal;
    releaseFetch();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  const callbacks: string[] = [];
  try {
    const streaming = api.playStream('wait', false, {
      onStage: () => callbacks.push('stage'),
      onToken: () => callbacks.push('token'),
      onDone: () => callbacks.push('done'),
      onError: () => callbacks.push('error'),
      signal: abort.signal,
    });
    await fetchReady;
    abort.abort();
    await streaming;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sawSignal, true);
  assert.deepEqual(callbacks, []);
});

test('provider-key contracts reject custom base URLs and accept a provider-only unlock', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const sealed = { id, endpointId: 'openai', models: { narrate: 'gpt-test' }, trust: 'sealed', key: 'sk-test-0123456789' };
  assert.equal(providerKeyBodySchema.safeParse(sealed).success, true);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, baseUrl: 'http://169.254.169.254/v1' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, id: 'not-a-uuid' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, key: 'has space in it' }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...sealed, models: { narrate: '../../etc' } }).success, false);
  assert.equal(encryptionUnlockBodySchema.safeParse({ providerKeys: [{ keyId: id, key: 'sk-test-0123456789' }] }).success, true);
  assert.equal(encryptionUnlockBodySchema.safeParse({}).success, false, 'nothing to unlock');
  const unlock = { id, endpointId: 'openai', models: { narrate: 'gpt-test' }, trust: 'unlock', keyHint: 'abcd' };
  const wrap = (nonceBytes: number, ciphertextBytes: number) => ({
    nonce: Buffer.alloc(nonceBytes).toString('base64'),
    ciphertext: Buffer.alloc(ciphertextBytes).toString('base64'),
  });
  assert.equal(providerKeyBodySchema.safeParse({ ...unlock, wrap: wrap(12, 528) }).success, true);
  assert.equal(providerKeyBodySchema.safeParse({ ...unlock, wrap: wrap(12, 529) }).success, false, 'wrap larger than a 512-byte key');
  assert.equal(providerKeyBodySchema.safeParse({ ...unlock, wrap: wrap(12, 750_000) }).success, false);
  assert.equal(providerKeyBodySchema.safeParse({ ...unlock, wrap: wrap(24, 48) }).success, false, 'nonce must be 12 bytes');
});
