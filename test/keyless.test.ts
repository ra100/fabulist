import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signRequest, canonicalRequestFor, type AwsCredentials } from '../src/providers/sigv4.ts';
import { AwsCredentialProvider, parseIni, tokenize, type AwsEnvironment } from '../src/providers/aws.ts';
import { BedrockProvider } from '../src/providers/bedrock.ts';
import { GoogleAuth, VertexProvider, toGeminiSchema, type GoogleEnvironment } from '../src/providers/google.ts';
import { CopilotProvider, findCopilotOAuthToken, type CopilotEnvironment } from '../src/providers/copilot.ts';
import { OpenAICompatProvider } from '../src/providers/http.ts';
import { buildProvider, defaultAuth, PRESETS, PROFILES } from '../src/providers/http.ts';
import { probeAll, probeProvider, usableProfiles } from '../src/providers/probe.ts';
import type { ProviderCapabilities } from '../src/providers/provider.ts';

const CREDS: AwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  source: 'test',
};

function caps(over: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    contextWindow: 64_000, structuredOutput: 'native-schema', systemRole: true, streaming: false,
    costTier: 'free', charsPerToken: 4, proseQuality: 0.5, steerability: 0.5, ...over,
  };
}

/** Captures outgoing requests so the wire format can be asserted on. */
function spy(response: unknown, status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: unknown; raw: string; method: string }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body ? String(init.body) : '';
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Form-encoded, as OAuth token exchange and STS both use.
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    seen.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
      raw,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

function awsEnv(over: Partial<AwsEnvironment> & { files?: Record<string, string> } = {}): AwsEnvironment {
  const files = over.files ?? {};
  return {
    env: over.env ?? {},
    readFile: over.readFile ?? ((p) => files[p] ?? null),
    listDir: over.listDir ?? ((p) => Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1))),
    fetcher: over.fetcher ?? ((async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch),
    run: over.run ?? (async () => ''),
    now: over.now ?? (() => new Date('2024-01-01T00:00:00Z')),
  };
}

// -------------------------------------------------------------------- sigv4

test('sigv4 matches the published AWS get-vanilla test vector', () => {
  // The whole point of hand-rolling this: correctness is checkable, not a matter
  // of opinion. This is AWS's own reference case.
  const params = {
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    body: '',
    credentials: CREDS,
    now: new Date('2015-08-30T12:36:00Z'),
  };
  const { canonicalRequest, signature } = canonicalRequestFor(params);

  assert.equal(
    canonicalRequest,
    'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' +
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('the authorization header carries credential scope and signed headers', () => {
  const signed = signRequest({
    method: 'POST', url: 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/x/converse',
    region: 'eu-west-1', service: 'bedrock', body: '{}', credentials: CREDS,
    headers: { 'content-type': 'application/json' },
  });
  const auth = signed.headers.authorization!;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
  assert.match(auth, /SignedHeaders=content-type;host;x-amz-date/);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
});

test('a session token is signed in, not merely sent', () => {
  const withToken = signRequest({
    method: 'POST', url: 'https://sts.us-east-1.amazonaws.com/', region: 'us-east-1', service: 'sts',
    body: '', credentials: { ...CREDS, sessionToken: 'TOKEN' }, now: new Date('2024-01-01T00:00:00Z'),
  });
  const without = signRequest({
    method: 'POST', url: 'https://sts.us-east-1.amazonaws.com/', region: 'us-east-1', service: 'sts',
    body: '', credentials: CREDS, now: new Date('2024-01-01T00:00:00Z'),
  });
  assert.equal(withToken.headers['x-amz-security-token'], 'TOKEN');
  assert.match(withToken.headers.authorization!, /x-amz-security-token/);
  assert.notEqual(withToken.headers.authorization, without.headers.authorization);
});

test('path segments are encoded per sigv4 rules, which keep model ids intact', () => {
  // Bedrock model ids contain colons and dots; getting this wrong yields a
  // signature mismatch that reads like a credentials problem.
  const signed = signRequest({
    method: 'POST',
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse',
    region: 'us-east-1', service: 'bedrock', body: '{}', credentials: CREDS,
  });
  assert.match(signed.url, /anthropic\.claude-sonnet-4-20250514-v1%3A0/);
});

test('content-sha256 is opt-in, because it changes the signed header set', () => {
  const base = { method: 'GET', url: 'https://x.amazonaws.com/', region: 'us-east-1', service: 's3', body: '', credentials: CREDS, now: new Date('2024-01-01T00:00:00Z') };
  const without = signRequest(base);
  const withHash = signRequest({ ...base, includeContentSha256: true });
  assert.ok(!('x-amz-content-sha256' in without.headers));
  assert.ok('x-amz-content-sha256' in withHash.headers);
  assert.notEqual(without.headers.authorization, withHash.headers.authorization);
});

// ------------------------------------------------------------------ ini/args

test('the aws config format parses, including profile-prefixed sections', () => {
  const ini = parseIni(`
[default]
region = us-east-1

[profile work]  ; a comment
region=eu-west-1
role_arn = arn:aws:iam::1:role/x
`);
  assert.equal(ini.default?.region, 'us-east-1');
  assert.equal(ini['profile work']?.region, 'eu-west-1');
  assert.equal(ini['profile work']?.role_arn, 'arn:aws:iam::1:role/x', 'values keep their colons');
});

test('credential_process commands tokenize without a shell', () => {
  // Running these through a shell would make a config file a code-execution
  // vector for anything that can write to it.
  assert.deepEqual(tokenize('aws-vault exec work --json'), ['aws-vault', 'exec', 'work', '--json']);
  assert.deepEqual(tokenize('"/path/with space/bin" "arg one" \'arg two\''), ['/path/with space/bin', 'arg one', 'arg two']);
  assert.deepEqual(tokenize('/unquoted path/bin'), ['/unquoted', 'path/bin'], 'unquoted whitespace still splits');
});

// ------------------------------------------------------- aws credential chain

test('environment credentials are used for the profile the environment names', async () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { AWS_ACCESS_KEY_ID: 'AKIA_ENV', AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'ap-south-1' },
  }));
  const resolved = await provider.resolve();
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_ENV');
  assert.equal(resolved.credentials.source, 'environment');
  assert.equal(resolved.region, 'ap-south-1');
});

test('environment credentials do not leak into a different named profile', async () => {
  // Asking for "prod" must not hand back whatever keys happen to be exported.
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_ACCESS_KEY_ID: 'AKIA_ENV', AWS_SECRET_ACCESS_KEY: 'secret' },
    files: { '/h/.aws/credentials': '[prod]\naws_access_key_id=AKIA_PROD\naws_secret_access_key=prodsecret\n' },
  }));
  const resolved = await provider.resolve('prod');
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_PROD');
});

test('static keys come from the credentials file', async () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'work' },
    files: {
      '/h/.aws/credentials': '[work]\naws_access_key_id=AKIA_W\naws_secret_access_key=s\naws_session_token=t\n',
      '/h/.aws/config': '[profile work]\nregion = eu-west-2\n',
    },
  }));
  const resolved = await provider.resolve();
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_W');
  assert.equal(resolved.credentials.sessionToken, 't');
  assert.equal(resolved.region, 'eu-west-2');
});

test('credential_process output is parsed, covering aws-vault and friends', async () => {
  let ran = '';
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'vault' },
    files: { '/h/.aws/config': '[profile vault]\ncredential_process = aws-vault exec work --json\nregion = us-west-2\n' },
    run: async (cmd) => {
      ran = cmd;
      return JSON.stringify({ Version: 1, AccessKeyId: 'AKIA_P', SecretAccessKey: 's', SessionToken: 't', Expiration: '2099-01-01T00:00:00Z' });
    },
  }));
  const resolved = await provider.resolve();
  assert.equal(ran, 'aws-vault exec work --json');
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_P');
  assert.match(resolved.credentials.source, /credential_process/);
});

test('a credential_process returning junk fails with a clear message', async () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'bad' },
    files: { '/h/.aws/config': '[profile bad]\ncredential_process = broken\n' },
    run: async () => 'not json at all',
  }));
  await assert.rejects(() => provider.resolve(), /did not return JSON/);
});

test('sso exchanges a cached token for role credentials', async () => {
  const { fetcher, seen } = spy({
    roleCredentials: { accessKeyId: 'AKIA_SSO', secretAccessKey: 's', sessionToken: 't', expiration: 4102444800000 },
  });
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'sso' },
    files: {
      '/h/.aws/config': '[profile sso]\nsso_start_url = https://x.awsapps.com/start\nsso_region = eu-west-1\nsso_account_id = 111\nsso_role_name = Dev\n',
      '/h/.aws/sso/cache/abc.json': JSON.stringify({ startUrl: 'https://x.awsapps.com/start', accessToken: 'SSOTOKEN', expiresAt: '2099-01-01T00:00:00Z' }),
    },
    fetcher,
  }));
  const resolved = await provider.resolve();
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_SSO');
  assert.match(seen[0]!.url, /portal\.sso\.eu-west-1\.amazonaws\.com/);
  assert.equal(seen[0]!.headers['x-amz-sso_bearer_token'], 'SSOTOKEN');
});

test('an expired sso token says to log in rather than failing obscurely', async () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'sso' },
    files: {
      '/h/.aws/config': '[profile sso]\nsso_start_url = https://x/start\nsso_account_id = 1\nsso_role_name = D\n',
      '/h/.aws/sso/cache/abc.json': JSON.stringify({ startUrl: 'https://x/start', accessToken: 'OLD', expiresAt: '2020-01-01T00:00:00Z' }),
    },
  }));
  await assert.rejects(() => provider.resolve(), /aws sso login/);
});

test('an sso-session profile resolves through its shared session block', async () => {
  const { fetcher } = spy({ roleCredentials: { accessKeyId: 'AKIA_S', secretAccessKey: 's' } });
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'p' },
    files: {
      '/h/.aws/config': '[profile p]\nsso_session = corp\nsso_account_id = 1\nsso_role_name = D\n\n[sso-session corp]\nsso_start_url = https://corp/start\nsso_region = us-east-2\n',
      '/h/.aws/sso/cache/x.json': JSON.stringify({ sessionName: 'corp', accessToken: 'T', expiresAt: '2099-01-01T00:00:00Z' }),
    },
    fetcher,
  }));
  assert.equal((await provider.resolve()).credentials.accessKeyId, 'AKIA_S');
});

test('assume-role chains from a source profile and signs the sts call', async () => {
  const { fetcher, seen } = spy({
    AssumeRoleResponse: { AssumeRoleResult: { Credentials: { AccessKeyId: 'AKIA_ROLE', SecretAccessKey: 's', SessionToken: 't', Expiration: '2099-01-01T00:00:00Z' } } },
  });
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'target' },
    files: {
      '/h/.aws/credentials': '[base]\naws_access_key_id=AKIA_BASE\naws_secret_access_key=s\n',
      '/h/.aws/config': '[profile target]\nrole_arn = arn:aws:iam::9:role/Target\nsource_profile = base\nregion = us-east-1\n',
    },
    fetcher,
  }));
  const resolved = await provider.resolve();
  assert.equal(resolved.credentials.accessKeyId, 'AKIA_ROLE');
  assert.match(seen[0]!.url, /sts\.us-east-1\.amazonaws\.com/);
  assert.match((seen[0]!.headers as Record<string, string>).authorization!, /^AWS4-HMAC-SHA256 Credential=AKIA_BASE/);
});

test('a circular source_profile chain is detected instead of recursing forever', async () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'a' },
    files: { '/h/.aws/config': '[profile a]\nrole_arn = arn:1\nsource_profile = b\n\n[profile b]\nrole_arn = arn:2\nsource_profile = a\n' },
  }));
  await assert.rejects(() => provider.resolve(), /circular/);
});

test('a profile with nothing configured explains everything it tried', async () => {
  const provider = new AwsCredentialProvider(awsEnv({ env: { HOME: '/h', AWS_PROFILE: 'ghost' } }));
  await assert.rejects(() => provider.resolve(), /Tried environment, credentials file, credential_process, SSO and assume-role/);
});

test('credentials expiring soon are re-resolved rather than used', async () => {
  let calls = 0;
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'p' },
    files: { '/h/.aws/config': '[profile p]\ncredential_process = helper\n' },
    run: async () => {
      calls++;
      // Two minutes out: inside the refresh margin, so never reused.
      return JSON.stringify({ AccessKeyId: 'A', SecretAccessKey: 'S', Expiration: '2024-01-01T00:02:00Z' });
    },
    now: () => new Date('2024-01-01T00:00:00Z'),
  }));
  await provider.resolve();
  await provider.resolve();
  assert.equal(calls, 2, 'expiring mid-session shows up as a confusing 403 later');
});

test('long-lived credentials are cached', async () => {
  let calls = 0;
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'p' },
    files: { '/h/.aws/config': '[profile p]\ncredential_process = helper\n' },
    run: async () => {
      calls++;
      return JSON.stringify({ AccessKeyId: 'A', SecretAccessKey: 'S', Expiration: '2099-01-01T00:00:00Z' });
    },
  }));
  await provider.resolve();
  await provider.resolve();
  assert.equal(calls, 1);
});

test('profiles from both config and credentials files are listed', () => {
  const provider = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h' },
    files: { '/h/.aws/credentials': '[a]\nx=1\n', '/h/.aws/config': '[profile b]\ny=2\n' },
  }));
  assert.deepEqual(provider.listProfiles(), ['a', 'b']);
});

// ------------------------------------------------------------------- bedrock

test('bedrock uses the converse shape with system lifted out', async () => {
  const { fetcher, seen } = spy({ output: { message: { content: [{ text: 'prose' }] } }, usage: { inputTokens: 7, outputTokens: 3 } });
  const provider = new BedrockProvider({
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    capabilities: caps(),
    fetcher,
    awsEnvironment: awsEnv({ env: { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S', AWS_REGION: 'eu-west-1' } }),
  });
  const res = await provider.complete({ role: 'narrate', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U' }] });

  assert.equal(res.text, 'prose');
  assert.equal(res.tokensIn, 7);
  assert.match(seen[0]!.url, /bedrock-runtime\.eu-west-1\.amazonaws\.com.*converse$/);
  const body = seen[0]!.body as { system?: Array<{ text: string }>; messages: Array<{ role: string }> };
  assert.deepEqual(body.system, [{ text: 'SYS' }], 'converse takes system as its own field');
  assert.equal(body.messages[0]?.role, 'user');
  assert.match((seen[0]!.headers as Record<string, string>).authorization!, /^AWS4-HMAC-SHA256/);
});

test('bedrock gets structured output through a forced tool call', async () => {
  const { fetcher, seen } = spy({ output: { message: { content: [{ toolUse: { input: { a: 1 } } }] } } });
  const provider = new BedrockProvider({
    modelId: 'm', capabilities: caps(), fetcher,
    awsEnvironment: awsEnv({ env: { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' } }),
  });
  const res = await provider.complete({
    role: 'extract', messages: [{ role: 'user', content: 'x' }],
    schema: { name: 'delta', schema: { type: 'object' } },
  });

  const body = seen[0]!.body as { toolConfig?: { toolChoice?: { tool?: { name: string } } } };
  assert.equal(body.toolConfig?.toolChoice?.tool?.name, 'delta', 'the model is obliged to use the schema');
  assert.deepEqual(JSON.parse(res.text), { a: 1 });
  assert.equal(res.schemaEnforced, true);
});

test('consecutive same-role messages are collapsed, as converse requires', async () => {
  const { fetcher, seen } = spy({ output: { message: { content: [{ text: 'x' }] } } });
  const provider = new BedrockProvider({
    modelId: 'm', capabilities: caps(), fetcher,
    awsEnvironment: awsEnv({ env: { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' } }),
  });
  await provider.complete({
    role: 'x',
    messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }, { role: 'assistant', content: 'three' }],
  });
  const messages = (seen[0]!.body as { messages: Array<{ role: string; content: unknown[] }> }).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content.length, 2, 'the two user turns merged');
});

test('a bedrock 403 points at model access rather than credentials', async () => {
  const { fetcher } = spy({ message: 'denied' }, 403);
  const provider = new BedrockProvider({
    modelId: 'anthropic.claude-x', capabilities: caps(), fetcher, region: 'us-east-1',
    awsEnvironment: awsEnv({ env: { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' } }),
  });
  await assert.rejects(
    () => provider.complete({ role: 'x', messages: [{ role: 'user', content: 'x' }] }),
    /model access is enabled for anthropic\.claude-x in region us-east-1/,
  );
});

// -------------------------------------------------------------------- google

function googleEnv(over: Partial<GoogleEnvironment> & { files?: Record<string, string> } = {}): GoogleEnvironment {
  const files = over.files ?? {};
  return {
    env: over.env ?? { HOME: '/h' },
    readFile: over.readFile ?? ((p) => files[p] ?? null),
    fetcher: over.fetcher ?? ((async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch),
    run: over.run ?? (async () => { throw new Error('no gcloud'); }),
    now: over.now ?? (() => new Date('2024-01-01T00:00:00Z')),
  };
}

const ADC_PATH = '/h/.config/gcloud/application_default_credentials.json';

test('application default credentials are exchanged for an access token', async () => {
  const { fetcher, seen } = spy({ access_token: 'ya29.token', expires_in: 3600 });
  const auth = new GoogleAuth(googleEnv({
    files: { [ADC_PATH]: JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'sec', refresh_token: 'rt', quota_project_id: 'proj-1' }) },
    fetcher,
  }));
  const token = await auth.accessToken();
  assert.equal(token.accessToken, 'ya29.token');
  assert.match(token.source, /application default/);
  assert.equal(auth.project(), 'proj-1', 'the project comes from the same file');
  assert.match(seen[0]!.url, /oauth2\.googleapis\.com\/token/);
});

test('a google access token is cached until close to expiry', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const auth = new GoogleAuth(googleEnv({
    files: { [ADC_PATH]: JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }) },
    fetcher,
  }));
  await auth.accessToken();
  await auth.accessToken();
  assert.equal(calls, 1);
});

test('a service account key is signed into a jwt assertion', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const { fetcher, seen } = spy({ access_token: 'sa.token', expires_in: 3600 });

  const auth = new GoogleAuth(googleEnv({
    env: { HOME: '/h', GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json' },
    files: { '/keys/sa.json': JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: pem, project_id: 'proj-sa' }) },
    fetcher,
  }));
  const token = await auth.accessToken();

  assert.equal(token.accessToken, 'sa.token');
  assert.match(token.source, /service account \(bot@/);
  assert.equal(auth.project(), 'proj-sa');
  // The assertion must be a real three-part JWT with a decodable header.
  const assertion = String((seen[0]!.body as Record<string, string>).assertion ?? '');
  const [header, claims, signature] = assertion.split('.');
  assert.ok(header && claims && signature, 'three JWT parts');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, string>;
  assert.equal(decoded.iss, 'bot@p.iam.gserviceaccount.com');
  assert.equal(decoded.aud, 'https://oauth2.googleapis.com/token');
});

test('gcloud is the fallback when there is no credentials file', async () => {
  const auth = new GoogleAuth(googleEnv({ run: async () => 'gcloud-token' }));
  const token = await auth.accessToken();
  assert.equal(token.accessToken, 'gcloud-token');
  assert.match(token.source, /gcloud/);
});

test('with nothing configured, google says exactly which command to run', async () => {
  const auth = new GoogleAuth(googleEnv());
  await assert.rejects(() => auth.accessToken(), /gcloud auth application-default login/);
});

test('vertex sends systemInstruction and model-role turns', async () => {
  const { fetcher, seen } = spy({
    candidates: [{ content: { parts: [{ text: 'prose' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  });
  const auth = new GoogleAuth(googleEnv({
    files: { [ADC_PATH]: JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r', quota_project_id: 'p1' }) },
    fetcher: spy({ access_token: 't', expires_in: 3600 }).fetcher,
  }));
  const provider = new VertexProvider({ model: 'gemini-2.5-pro', capabilities: caps(), auth, fetcher, location: 'europe-west4' });
  const res = await provider.complete({ role: 'narrate', messages: [{ role: 'system', content: 'SYS' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'U' }] });

  assert.equal(res.text, 'prose');
  assert.match(seen[0]!.url, /europe-west4-aiplatform\.googleapis\.com.*\/p1\/.*gemini-2\.5-pro:generateContent/);
  const body = seen[0]!.body as { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: string }> };
  assert.equal(body.systemInstruction?.parts[0]?.text, 'SYS');
  assert.equal(body.contents[0]?.role, 'model', 'assistant turns are "model" in Gemini');
  assert.match((seen[0]!.headers as Record<string, string>).authorization!, /^Bearer /);
});

test('vertex refuses to guess a project', async () => {
  const auth = new GoogleAuth(googleEnv({
    files: { [ADC_PATH]: JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }) },
    fetcher: spy({ access_token: 't', expires_in: 3600 }).fetcher,
  }));
  const provider = new VertexProvider({ model: 'g', capabilities: caps(), auth });
  await assert.rejects(() => provider.complete({ role: 'x', messages: [{ role: 'user', content: 'x' }] }), /GOOGLE_CLOUD_PROJECT/);
});

test('json schema is translated into what gemini actually accepts', () => {
  // Gemini's responseSchema is OpenAPI-flavoured: it rejects additionalProperties
  // and union types, both of which the engine's schemas use freely.
  const translated = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: ['string', 'null'] }, b: { type: 'array', items: { type: 'object', additionalProperties: false } } },
  }) as Record<string, unknown>;

  assert.ok(!('additionalProperties' in translated));
  const a = (translated.properties as Record<string, Record<string, unknown>>).a!;
  assert.equal(a.type, 'string');
  assert.equal(a.nullable, true);
  const items = ((translated.properties as Record<string, Record<string, unknown>>).b!.items) as Record<string, unknown>;
  assert.ok(!('additionalProperties' in items), 'translation recurses');
});

// ------------------------------------------------------------------- copilot

function copilotEnv(files: Record<string, string>, fetcher?: typeof fetch): CopilotEnvironment {
  return {
    env: { HOME: '/h' },
    readFile: (p) => files[p] ?? null,
    listDir: () => [],
    fetcher: fetcher ?? ((async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch),
    now: () => new Date('2024-01-01T00:00:00Z'),
  };
}

test('the copilot provider refuses to construct without explicit acknowledgement', () => {
  // It uses an undocumented endpoint and may breach Copilot terms, so nothing
  // should reach it by accident.
  assert.throws(
    () => new CopilotProvider({ model: 'gpt-4o', capabilities: caps(), allowUnofficial: false }),
    /unofficial and disabled by default/,
  );
});

test('the stored oauth token is found in either known layout', () => {
  const apps = findCopilotOAuthToken(copilotEnv({
    '/h/.config/github-copilot/apps.json': JSON.stringify({ 'github.com:Iv1.abc': { oauth_token: 'gho_apps_abcdefghijklmnopqrstuvwxyz012345' } }),
  }));
  assert.equal(apps?.token, 'gho_apps_abcdefghijklmnopqrstuvwxyz012345');

  const hosts = findCopilotOAuthToken(copilotEnv({
    '/h/.config/github-copilot/hosts.json': JSON.stringify({ 'github.com': { oauth_token: 'gho_hosts_abcdefghijklmnopqrstuvwxyz01234' } }),
  }));
  assert.equal(hosts?.token, 'gho_hosts_abcdefghijklmnopqrstuvwxyz01234');
  assert.match(hosts!.source, /^~\/\.config/, 'the home path is not leaked in full');
});

test('no stored token yields null rather than a throw', () => {
  assert.equal(findCopilotOAuthToken(copilotEnv({})), null);
});

test('copilot exchanges the oauth token for a session token before calling', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('copilot_internal')) {
      return { ok: true, status: 200, json: async () => ({ token: 'sess', expires_at: 4102444800 }) } as unknown as Response;
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'out' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const provider = new CopilotProvider({
    model: 'gpt-4o', capabilities: caps({ structuredOutput: 'none' }), allowUnofficial: true, fetcher,
    copilotEnvironment: copilotEnv({ '/h/.config/github-copilot/apps.json': JSON.stringify({ 'github.com': { oauth_token: 'gho_abcdefghijklmnopqrstuvwxyz0123456789' } }) }),
  });
  const res = await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(res.text, 'out');
  assert.match(calls[0]!, /copilot_internal\/v2\/token/);
  assert.match(calls[1]!, /api\.githubcopilot\.com\/chat\/completions/);
});

test('a missing copilot login is reported as such', async () => {
  const provider = new CopilotProvider({
    model: 'gpt-4o', capabilities: caps(), allowUnofficial: true, copilotEnvironment: copilotEnv({}),
  });
  await assert.rejects(() => provider.complete({ role: 'x', messages: [{ role: 'user', content: 'x' }] }), /Sign in to Copilot/);
});

// -------------------------------------------------------------- local servers

test('a local server gets no authorization header at all', async () => {
  const { fetcher, seen } = spy({ choices: [{ message: { content: 'x' } }] });
  const provider = new OpenAICompatProvider('vllm', {
    apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', capabilities: caps(), fetcher,
  });
  await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'x' }] });
  // vLLM and llama.cpp 401 on a bogus bearer, and Ollama has no notion of one.
  assert.ok(!('authorization' in (seen[0]!.headers as Record<string, string>)));
});

test('vllm constrains generation with guided_json, not response_format', async () => {
  const { fetcher, seen } = spy({ choices: [{ message: { content: '{}' } }] });
  const provider = new OpenAICompatProvider('vllm', {
    apiKey: '', baseUrl: 'http://x/v1', model: 'm', capabilities: caps(), fetcher, dialect: 'vllm',
  });
  await provider.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema: { name: 'd', schema: { type: 'object' } } });
  const body = seen[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.guided_json, { type: 'object' });
  assert.equal(body.response_format, undefined, 'vLLM silently ignores response_format for schemas');
});

test('llama.cpp takes a bare json_schema alongside json_object', async () => {
  const { fetcher, seen } = spy({ choices: [{ message: { content: '{}' } }] });
  const provider = new OpenAICompatProvider('llamacpp', {
    apiKey: '', baseUrl: 'http://x/v1', model: 'm', capabilities: caps(), fetcher, dialect: 'llamacpp',
  });
  await provider.complete({ role: 'extract', messages: [{ role: 'user', content: 'x' }], schema: { name: 'd', schema: { type: 'object' } } });
  const body = seen[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.json_schema, { type: 'object' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

// ----------------------------------------------------------- build + presets

test('keyless providers build with no environment at all', () => {
  for (const key of ['ollama:qwen2.5', 'vllm:local', 'llamacpp:local', 'unsloth:local', 'lmstudio:local']) {
    const provider = buildProvider(PRESETS[key]!, {});
    assert.ok(provider.model, `${key} built`);
  }
});

test('bedrock and google build without any api key', () => {
  assert.equal(buildProvider(PRESETS['bedrock:sonnet']!, {}).id, 'bedrock');
  assert.equal(buildProvider(PRESETS['google:gemini-pro']!, {}).id, 'google');
});

test('copilot will not build until acknowledged', () => {
  assert.throws(() => buildProvider(PRESETS['copilot:gpt-4o']!, {}), /unofficial/);
  assert.equal(buildProvider({ ...PRESETS['copilot:gpt-4o']!, allowUnofficial: true }, {}).id, 'copilot');
});

test('api-key providers still refuse to build without their key', () => {
  assert.throws(() => buildProvider(PRESETS['openai:gpt-4o']!, {}), /OPENAI_API_KEY/);
});

test('default auth mode follows the provider kind', () => {
  assert.equal(defaultAuth('ollama'), 'none');
  assert.equal(defaultAuth('bedrock'), 'aws-profile');
  assert.equal(defaultAuth('google'), 'google-oauth');
  assert.equal(defaultAuth('copilot'), 'copilot-oauth');
  assert.equal(defaultAuth('anthropic'), 'api-key');
});

test('every preset still declares at least the 64k floor', () => {
  for (const [key, spec] of Object.entries(PRESETS)) {
    assert.ok((spec.capabilities?.contextWindow ?? 64_000) >= 64_000, `${key}`);
  }
});

test('there is a profile for each keyless route', () => {
  for (const name of ['local', 'vllm', 'llamacpp', 'bedrock', 'google', 'copilot']) {
    assert.ok(PROFILES[name], `profile ${name} exists`);
  }
});

// --------------------------------------------------------------------- probe

test('a reachable local server probes ready', async () => {
  const fetcher = (async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
  const res = await probeProvider('vllm:local', PRESETS['vllm:local']!, { fetcher });
  assert.equal(res.status, 'ready');
  assert.match(res.detail, /listening/);
});

test('an unreachable local server probes unavailable with the command to start it', async () => {
  const fetcher = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const res = await probeProvider('vllm:local', PRESETS['vllm:local']!, { fetcher });
  assert.equal(res.status, 'unavailable');
  assert.match(res.fix, /vllm serve/);
});

test('llama.cpp gets its own start command, with a context size', async () => {
  const fetcher = (async () => {
    throw new Error('refused');
  }) as unknown as typeof fetch;
  const res = await probeProvider('llamacpp:local', PRESETS['llamacpp:local']!, { fetcher });
  assert.match(res.fix, /llama-server .*--ctx-size 65536/);
});

test('a missing api key probes unavailable with the variable to export', async () => {
  const res = await probeProvider('openai:gpt-4o', PRESETS['openai:gpt-4o']!, { env: {} });
  assert.equal(res.status, 'unavailable');
  assert.match(res.fix, /export OPENAI_API_KEY/);
});

test('a working aws profile probes ready and names its source', async () => {
  const aws = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1' },
    files: { '/h/.aws/credentials': '[work]\naws_access_key_id=A\naws_secret_access_key=S\n' },
  }));
  const res = await probeProvider('bedrock:sonnet', PRESETS['bedrock:sonnet']!, { aws });
  assert.equal(res.status, 'ready');
  assert.match(res.detail, /profile "work".*region eu-west-1/);
  assert.match(res.note ?? '', /model access/, 'credentials resolving is not the same as model entitlement');
});

test('a broken aws profile suggests the profiles that do exist', async () => {
  const aws = new AwsCredentialProvider(awsEnv({
    env: { HOME: '/h', AWS_PROFILE: 'missing' },
    files: { '/h/.aws/credentials': '[work]\naws_access_key_id=A\naws_secret_access_key=S\n[personal]\naws_access_key_id=B\naws_secret_access_key=C\n' },
  }));
  const res = await probeProvider('bedrock:sonnet', PRESETS['bedrock:sonnet']!, { aws });
  assert.equal(res.status, 'unavailable');
  assert.match(res.fix, /AWS_PROFILE=<one of: personal, work>/);
});

test('a google login without a project is reported precisely', async () => {
  const google = new GoogleAuth(googleEnv({
    files: { [ADC_PATH]: JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }) },
    fetcher: spy({ access_token: 't', expires_in: 3600 }).fetcher,
  }));
  const res = await probeProvider('google:gemini-pro', PRESETS['google:gemini-pro']!, { google });
  assert.equal(res.status, 'unavailable');
  assert.match(res.detail, /no project is set/);
  assert.match(res.fix, /GOOGLE_CLOUD_PROJECT/);
});

test('copilot probes unavailable while unacknowledged, even with a token present', async () => {
  const res = await probeProvider('copilot:gpt-4o', PRESETS['copilot:gpt-4o']!, {});
  assert.equal(res.status, 'unavailable');
});

test('probing everything sorts ready first and never throws', async () => {
  const fetcher = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const results = await probeAll({}, { env: { OPENAI_API_KEY: 'k' }, fetcher });
  assert.ok(results.length >= Object.keys(PRESETS).length);
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.indexOf('ready'), 0, 'the useful answer is at the top');
  assert.ok(results.every((r) => typeof r.detail === 'string'));
});

test('a profile is only usable when every one of its roles is', () => {
  const results = [
    { key: 'vllm:local', status: 'ready' as const, kind: 'openai-compat', model: 'm', auth: 'none' as const, detail: '', fix: '' },
  ];
  assert.deepEqual(usableProfiles(results, PROFILES), ['vllm']);
  assert.ok(!usableProfiles(results, PROFILES).includes('bedrock'));
});

test('offline probing skips local reachability instead of reporting a false negative', async () => {
  const res = await probeProvider('ollama:qwen2.5', PRESETS['ollama:qwen2.5']!, { offline: true });
  assert.equal(res.status, 'unknown');
});
