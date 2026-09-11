import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forkStoryBodySchema,
  illustrationBodySchema,
  knowledgeBodySchema,
  playResponseSchema,
  rollbackBodySchema,
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
    storySourcesBodySchema.safeParse({ slugs: [] }),
    worldAccessBodySchema.safeParse({ userId: 'user:a', role: 'writer' }),
    setupPreviewBodySchema.safeParse({ baseUrl: 'not a url', seeds: ['start'] }),
    setupPreviewBodySchema.safeParse({ baseUrl: 'https://example.test', seeds: ['start'], maxPages: 0 }),
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
