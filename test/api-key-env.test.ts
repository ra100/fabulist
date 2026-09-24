/**
 * Which environment variable a provider spec may read its key from.
 *
 * A spec's key is sent as a bearer token to the spec's own `baseUrl`, and both are
 * editable from the admin config screen. An unrestricted variable name would let
 * one config edit post any server secret — the session cookie password, the
 * database URL — to a host of the editor's choosing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateImageSpec, validateSpec } from '../src/config/service.ts';
import { apiKeyFromEnv, buildProvider } from '../src/providers/http.ts';
import { probeImageProviders } from '../src/providers/imageConfig.ts';

const SECRETS = ['WORKOS_COOKIE_PASSWORD', 'FABULIST_PG', 'DATABASE_URL', 'WORKOS_API_KEY', 'MCP_DEV_TOKEN', 'HOME'];
const env = { OPENAI_API_KEY: 'sk-real', ...Object.fromEntries(SECRETS.map((name) => [name, `secret-${name}`])) };

test('a provider key is read only from a *_API_KEY variable that is not the app’s own', () => {
  assert.equal(apiKeyFromEnv(env, 'OPENAI_API_KEY'), 'sk-real');
  for (const name of SECRETS) assert.equal(apiKeyFromEnv(env, name), '', name);
  assert.equal(apiKeyFromEnv(env, undefined), '');
});

test('validation rejects a spec that names a server secret as its key', () => {
  for (const name of SECRETS) {
    const text = validateSpec('evil', { kind: 'openai-compat', model: 'm', baseUrl: 'https://evil.example', apiKeyEnv: name });
    assert.ok(text.issues.some((i) => i.field === 'evil.apiKeyEnv' && i.severity !== 'warning'), `text ${name}`);
    const image = validateImageSpec('evil', { kind: 'unsloth', baseUrl: 'https://evil.example', apiKeyEnv: name });
    assert.ok(image.issues.some((i) => i.field === 'evil.apiKeyEnv' && i.severity !== 'warning'), `image ${name}`);
  }
  const fine = validateSpec('ok', { kind: 'openai-compat', model: 'm', baseUrl: 'https://api.example', apiKeyEnv: 'GROQ_API_KEY' });
  assert.ok(!fine.issues.some((i) => i.field === 'ok.apiKeyEnv'));
});

test('a spec that slipped past validation still cannot send a server secret', async () => {
  // Text: the key is resolved at construction, so a refused name is simply missing.
  assert.throws(
    () =>
      buildProvider(
        { kind: 'openai-compat', model: 'm', baseUrl: 'https://evil.example', apiKeyEnv: 'WORKOS_COOKIE_PASSWORD' },
        env,
      ),
    /missing WORKOS_COOKIE_PASSWORD/,
  );
  // Image: the probe is the path that sends the key to the configured host.
  const sent: string[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.stringify(init?.headers ?? {}));
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  await probeImageProviders({ evil: { kind: 'unsloth', model: 'm', baseUrl: 'https://evil.example', apiKeyEnv: 'FABULIST_PG' } }, { fetcher, env });
  assert.ok(sent.length > 0, 'the probe did call the host');
  assert.ok(sent.every((h) => !h.includes('secret-')), `no secret in any request: ${sent.join(' ')}`);
});
