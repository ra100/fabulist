/**
 * Vertex specifics the parity contract does not cover.
 *
 * Issue #170. The contract proves `complete()` behaves the same; these prove the
 * auth discovery this app implements survived the move, and that no token
 * escapes into an error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VertexSdkProvider } from '../src/providers/vertex-sdk.ts';
import { VertexProvider } from '../src/providers/google.ts';
import { GoogleAuth } from '../src/providers/google.ts';
import { PRESETS, buildProvider, caps, resolveTransport } from '../src/providers/http.ts';

const OK = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
};

function spyFetch(response: unknown = OK) {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const CLIENT_SECRET = 'GOCSPX-very-secret-value-0123456789';
const REFRESH_TOKEN = '1//refresh-token-value-abcdefghijklmnop';

const ADC_USER = JSON.stringify({
  type: 'authorized_user',
  client_id: 'cid',
  client_secret: CLIENT_SECRET,
  refresh_token: REFRESH_TOKEN,
});

/**
 * A `GoogleAuth` wired to the given environment, with only its I/O stubbed.
 * Defaults to an authorized-user ADC record, which is the discovery path this
 * app implements for a normal `gcloud auth application-default login`.
 */
function auth(env: Record<string, string | undefined>, readFile: (p: string) => string | null = (path) =>
  path.includes('application_default_credentials.json') ? ADC_USER : null,
) {
  return new GoogleAuth({
    env,
    readFile,
    fetcher: (async () =>
      new Response(JSON.stringify({ access_token: 'minted-token', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    run: async () => '',
    now: () => new Date(),
  });
}

// ------------------------------------------------------------- routing

test('google presets route to the SDK adapter and can roll back', () => {
  assert.equal(resolveTransport({}), 'sdk');
  assert.ok(buildProvider(PRESETS['google:gemini-pro']!, {}) instanceof VertexSdkProvider);
  assert.ok(
    buildProvider({ ...PRESETS['google:gemini-pro']!, transport: 'legacy' }, {}) instanceof VertexProvider,
    'rollback keeps the hand-rolled adapter and its own discovery',
  );
});

test('a keyless google provider still constructs, so setup can list it', () => {
  // The wizard builds every preset to show why one is unavailable. Throwing
  // here would take the whole provider list down instead of one row.
  assert.doesNotThrow(() => buildProvider(PRESETS['google:gemini-pro']!, {}));
});

// ----------------------------------------------------- auth discovery

test('a project id from the environment reaches the request URL', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'my-project' }),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.match(seen[0]!.url, /\/projects\/my-project\//);
  assert.match(seen[0]!.url, /:generateContent$/);
});

test('a project id in the spec overrides the environment', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps(),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'from-env' }),
    project: 'from-spec',
    location: 'europe-west4',
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.match(seen[0]!.url, /\/projects\/from-spec\//);
  assert.match(seen[0]!.url, /europe-west4-aiplatform\.googleapis\.com/);
});

test('an undiscoverable project fails on the call, naming the fix', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps(),
    auth: auth({}, () => null),
    fetcher,
  });

  await assert.rejects(
    () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] }),
    /no Google Cloud project\. Set GOOGLE_CLOUD_PROJECT/,
  );
  assert.equal(seen.length, 0);
});

test('a refresh-token credential is exchanged for a bearer token', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'p' }),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(seen[0]!.headers.authorization, 'Bearer minted-token');
  const sent = JSON.stringify(seen[0]!.body);
  assert.doesNotMatch(sent, new RegExp(REFRESH_TOKEN), 'the refresh token is never in the request body');
  assert.doesNotMatch(sent, new RegExp(CLIENT_SECRET), 'nor is the client secret');
});

test('a token from the gcloud CLI fallback still reaches the request', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    // No ADC file and no token endpoint: only the CLI fallback can answer.
    auth: new GoogleAuth({
      env: { GOOGLE_CLOUD_PROJECT: 'p' },
      readFile: () => null,
      fetcher: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      run: async () => 'cli-minted-token',
      now: () => new Date(),
    }),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(seen[0]!.headers.authorization, 'Bearer cli-minted-token');
});

test('no token or secret survives into an error', async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ error: { code: 401, message: 'invalid credentials', status: 'UNAUTHENTICATED' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'p' }),
    fetcher,
  });

  await assert.rejects(
    () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'the wardens spoke' }] }),
    (err: Error & { status?: number }) => {
      assert.match(err.message, /401/, 'the status survives, which is what BYOK branches on');
      assert.doesNotMatch(err.message, new RegExp(REFRESH_TOKEN));
      assert.doesNotMatch(err.message, new RegExp(CLIENT_SECRET));
      assert.doesNotMatch(err.message, /minted-token/, 'and no token either');
      assert.doesNotMatch(err.message, /wardens/, 'nor the prompt');
      return true;
    },
  );
});

// ------------------------------------------------------- request shaping

test('the system prompt is a systemInstruction, not a message', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'p' }),
    fetcher,
  });

  await provider.complete({
    role: 'narrate',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'U' },
    ],
  });

  assert.equal((seen[0]!.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text, 'SYS');
  assert.doesNotMatch(JSON.stringify(seen[0]!.body.contents), /SYS/, 'and not carried as a turn');
});

test('stop sequences are capped at five, the Gemini limit', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new VertexSdkProvider({
    model: 'gemini-contract',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    auth: auth({ GOOGLE_CLOUD_PROJECT: 'p' }),
    fetcher,
  });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }], stop: ['a', 'b', 'c', 'd', 'e', 'f'] });
  const config = seen[0]!.body.generationConfig as { stopSequences?: string[] };
  assert.equal(config.stopSequences?.length, 5);
});
