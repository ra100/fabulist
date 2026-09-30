/**
 * Bedrock specifics the parity contract does not cover.
 *
 * Issue #169. The contract proves `complete()` behaves the same; these prove the
 * AWS-specific policy survived the move — credential precedence, refresh, region
 * selection, and the fixed-temperature omission that is the reason `bedrock.ts`
 * has that capability flag at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BedrockSdkProvider } from '../src/providers/bedrock-sdk.ts';
import { AwsCredentialProvider } from '../src/providers/aws.ts';
import { BedrockProvider } from '../src/providers/bedrock.ts';
import { PRESETS, buildProvider, caps, resolveTransport } from '../src/providers/http.ts';

const OK = {
  output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  stopReason: 'end_turn',
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

/** An `AwsCredentialProvider` reading only from the injected environment. */
function credentials(over: Record<string, string | undefined> = {}, fetcher: typeof fetch = fetch) {
  return new AwsCredentialProvider({
    env: { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'envsecret', AWS_REGION: 'us-east-1', ...over },
    readFile: () => null,
    listDir: () => [],
    fetcher: fetcher as never,
    run: async () => '',
    now: () => new Date(),
  });
}

// ------------------------------------------------------------- routing

test('bedrock presets route to the SDK adapter and can roll back', () => {
  const env = { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'envsecret' };
  assert.equal(resolveTransport({}), 'sdk');
  assert.ok(buildProvider(PRESETS['bedrock:sonnet']!, env) instanceof BedrockSdkProvider);
  assert.ok(
    buildProvider({ ...PRESETS['bedrock:sonnet']!, transport: 'legacy' }, env) instanceof BedrockProvider,
    'rollback keeps the hand-rolled adapter, including its SigV4',
  );
  assert.ok(
    buildProvider(PRESETS['bedrock:sonnet']!, { ...env, FABULIST_PROVIDER_TRANSPORT: 'legacy' }) instanceof
      BedrockProvider,
  );
});

// --------------------------------------------------------- credentials

test('environment credentials are used and the request is signed for the resolved region', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'contract-model',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    credentials: credentials(),
    fetcher,
  });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.match(seen[0]!.url, /bedrock-runtime\.us-east-1\.amazonaws\.com/, 'the resolved region reaches the host');
  assert.match(seen[0]!.url, /\/model\/contract-model\/converse$/, 'and the model, not a hard-coded one');
  // The SDK signs; Fabulist only decides who the caller is.
  assert.match(seen[0]!.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAENV\//);
});

test('a region override wins over the environment', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'm',
    capabilities: caps(),
    credentials: credentials(),
    region: 'eu-west-2',
    fetcher,
  });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });
  assert.match(seen[0]!.url, /bedrock-runtime\.eu-west-2\.amazonaws\.com/);
});

test('a temporary session token is sent when the profile supplies one', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'm',
    capabilities: caps(),
    credentials: credentials({ AWS_SESSION_TOKEN: 'temporary-token-value' }),
    fetcher,
  });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });
  assert.match(seen[0]!.headers['x-amz-security-token'] ?? '', /^temporary-token-value$/);
});

test('an expiring credential is re-minted rather than served from a stale cache', async () => {
  // `credential_process` is the path that actually produces short-lived
  // credentials, and Fabulist refreshes them five minutes early so a token
  // cannot lapse mid-session and surface as a confusing 403 several turns later.
  // The migration must not have put a second cache in front of the existing one:
  // the SDK has to ask for credentials per request for this to still work.
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let issued = 0;
  const creds = new AwsCredentialProvider({
    env: { AWS_REGION: 'us-east-1' },
    readFile: () => '[default]\ncredential_process = mintkey',
    listDir: () => [],
    fetcher: fetch as never,
    run: async () => {
      issued++;
      return JSON.stringify({
        AccessKeyId: `AKIA${issued}`,
        SecretAccessKey: 'secret',
        Expiration: new Date(clock + 60 * 60_000).toISOString(),
      });
    },
    now: () => new Date(clock),
  });

  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({ modelId: 'm', capabilities: caps(), credentials: creds, fetcher });

  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });
  clock += 70 * 60_000; // the first credential is now expired
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(issued, 2, 'the process ran again rather than a stale credential being reused');
  assert.match(seen[0]!.headers.authorization ?? '', /Credential=AKIA1\//);
  assert.match(seen[1]!.headers.authorization ?? '', /Credential=AKIA2\//);
});

test('an unavailable credential fails the turn without leaking anything', async () => {
  const creds = new AwsCredentialProvider({
    env: { AWS_REGION: 'us-east-1' },
    readFile: () => null,
    listDir: () => [],
    fetcher: fetch as never,
    run: async () => '',
    now: () => new Date(),
  });
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({ modelId: 'm', capabilities: caps(), credentials: creds, fetcher });

  await assert.rejects(
    () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] }),
    (err: Error) => {
      assert.match(err.message, /no credentials for AWS profile/);
      assert.doesNotMatch(err.message, /AKIA/, 'and names no key material');
      return true;
    },
  );
  assert.equal(seen.length, 0, 'nothing was sent unsigned');
});

// ------------------------------------------------------- request shaping

test('a fixed-temperature model sends no temperature field at all', async () => {
  // Bedrock's claude-sonnet-5 answers 400 for any explicit temperature, so the
  // adapter omits it rather than sending the caller's 0 or 1.
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'anthropic.claude-sonnet-5',
    capabilities: caps({ fixedTemperature: true, structuredOutput: 'none' }),
    credentials: credentials(),
    fetcher,
  });

  await provider.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], temperature: 0 });

  assert.equal((seen[0]!.body.inferenceConfig as { temperature?: number } | undefined)?.temperature, undefined);
});

test('an ordinary model still gets its temperature', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'm',
    capabilities: caps({ structuredOutput: 'none' }),
    credentials: credentials(),
    fetcher,
  });
  await provider.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], temperature: 0 });
  assert.equal((seen[0]!.body.inferenceConfig as { temperature?: number }).temperature, 0);
});

test('the system prompt is a top-level field and messages alternate', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'm',
    capabilities: caps({ systemRole: false, structuredOutput: 'none' }),
    credentials: credentials(),
    fetcher,
  });

  await provider.complete({
    role: 'narrate',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'ONE' },
      { role: 'user', content: 'TWO' },
    ],
  });

  const system = seen[0]!.body.system as Array<{ text: string }>;
  assert.equal(system.map((block) => block.text).join(''), 'SYS');
  const messages = seen[0]!.body.messages as Array<{ role: string; content: Array<{ text: string }> }>;
  assert.deepEqual(
    (messages[0]!.content ?? []).map((block) => block.text),
    ['ONE', 'TWO'],
    'both turns survive as content blocks rather than being dropped',
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user'],
    'two consecutive user turns collapse into one, as Converse requires',
  );
});

test('stop sequences are capped at four, the Converse limit', async () => {
  const { fetcher, seen } = spyFetch();
  const provider = new BedrockSdkProvider({
    modelId: 'm',
    capabilities: caps({ structuredOutput: 'none' }),
    credentials: credentials(),
    fetcher,
  });
  await provider.complete({
    role: 'narrate',
    messages: [{ role: 'user', content: 'x' }],
    stop: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  assert.equal((seen[0]!.body.inferenceConfig as { stopSequences?: string[] }).stopSequences?.length, 4);
});
