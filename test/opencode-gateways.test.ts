/**
 * OpenCode's two hosted gateways: Zen and Go.
 *
 * Both are plain OpenAI-compatible endpoints sharing one key, and both are
 * offered to each user in their own provider list rather than as operator
 * presets. That is the same shape as mistral, xai, groq, cerebras, together,
 * fireworks and kilo: a key a user brings, stored per user, not a secret an
 * operator exports for everybody. There is no preset and no `PROFILES` entry,
 * because a user who has a key assigns it to roles themselves in the panel.
 *
 * The two things that can silently break here are the base URLs and the fact
 * that both are fixed https hosts. A typo in a base leaves an endpoint that
 * always fails with no local cause; a non-fixed host would let a key holder
 * aim this server anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYOK_ENDPOINTS, byokEndpoint, discoverModels } from '../src/providers/byok.ts';
import { PRESETS, PROFILES } from '../src/providers/http.ts';

const ZEN = 'https://opencode.ai/zen/v1';
const GO = 'https://opencode.ai/zen/go/v1';

test('both gateways are offered as user-key endpoints on exactly two fixed https bases', () => {
  for (const [id, base] of [
    ['opencode-zen', ZEN],
    ['opencode-go', GO],
  ] as const) {
    const endpoint = byokEndpoint(id);
    assert.equal(endpoint?.baseUrl, base, id);
    assert.equal(endpoint?.kind, 'openai-compat', id);
    // The personal list may only offer fixed https hosts, or a key holder could
    // aim this server at anything.
    assert.match(endpoint?.baseUrl ?? '', /^https:\/\/[a-z0-9.-]+\.[a-z]+(\/[\w./-]*)?$/, id);
    assert.equal(endpoint?.baseUrl.endsWith('/'), false, id);
    assert.ok(BYOK_ENDPOINTS.some((e) => e.label.startsWith('OpenCode')), `${id} is labelled`);
  }
  assert.equal(byokEndpoint('opencode'), undefined, 'no bare "opencode" endpoint');
  assert.equal(byokEndpoint('localhost'), undefined);
});

test('nothing about OpenCode is left in the operator-side presets or profiles', () => {
  // These are the operator's env-var secrets and the wizard's role routing.
  // A user-supplied key has no business in either, and an `OPENCODE_API_KEY`
  // preset would put one shared key in front of every user.
  for (const key of Object.keys(PRESETS)) assert.ok(!key.startsWith('opencode'), key);
  for (const name of Object.keys(PROFILES)) assert.ok(!name.startsWith('opencode'), name);
  for (const spec of Object.values(PRESETS)) {
    assert.notEqual(spec.apiKeyEnv, 'OPENCODE_API_KEY');
  }
});

test('a gateway key discovers its own model catalog, and the free ones are real', async () => {
  // Stubs the OpenAI list shape rather than calling the network: the point is
  // that `discoverModels` reads `data[].id` off these bases, not which models
  // happen to be listed today.
  for (const id of ['opencode-zen', 'opencode-go']) {
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'space-bunny-free' }] }),
    })) as unknown as typeof fetch;
    const found = await discoverModels(byokEndpoint(id)!, 'sk-user-key', fetcher);
    assert.equal(found.status, 'verified', id);
    assert.deepEqual(found.models, ['glm-5.3', 'space-bunny-free'], id);
  }
});

test('a rejected gateway key is a key rejection, and a billing failure is not confused with one', async () => {
  // 401/403 raise, so the panel can say "your key was rejected" rather than
  // showing a raw provider body. 402/429 mean the key is fine and the account is
  // out of credit or throttled, so they must not be reported as a bad key.
  for (const status of [401, 403]) {
    const fetcher = (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch;
    await assert.rejects(
      discoverModels(byokEndpoint('opencode-zen')!, 'sk-bad', fetcher),
      /provider rejected your API key/i,
      `status ${status}`,
    );
  }
  for (const status of [402, 429]) {
    const fetcher = (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch;
    const found = await discoverModels(byokEndpoint('opencode-zen')!, 'sk-good', fetcher);
    assert.equal(found.status, 'unavailable', `status ${status}`);
    assert.deepEqual(found.models, [], `status ${status}`);
  }
});
