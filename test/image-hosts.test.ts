/**
 * Bedrock error-hint and image-provider host configuration.
 *
 * Both halves exist because of the same class of bug: a message or a default
 * that quietly points at the wrong cause. The Bedrock hint asserted that every
 * 403 was a model-access problem, which sent a real debugging session into the
 * Bedrock console while the actual fault was an expired `aws_session_token`.
 * The image providers accepted a `baseUrl` in their spec that nothing could
 * ever write, so ComfyUI and Unsloth were pinned to loopback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockHint } from '../src/providers/bedrock.ts';
import { ConfigService, validateImageSpec } from '../src/config/service.ts';
import { defaultConfig, type Config } from '../src/config/config.ts';
import { SwappableImageRegistry } from '../src/providers/image.ts';
import { UnslothImageProvider } from '../src/providers/unslothImage.ts';
import { ComfyUIProvider } from '../src/providers/comfyui.ts';

// --------------------------------------------------------------- bedrock hint

/** The exact body an expired token produces, confirmed against the live API. */
const EXPIRED = JSON.stringify({ message: 'The security token included in the request is invalid' });

test('an expired token is named as such, not blamed on model access', () => {
  const hint = bedrockHint(403, EXPIRED, 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us-east-1');
  assert.match(hint, /expired/i);
  assert.match(hint, /aws sso login/);
  assert.doesNotMatch(hint, /model access/i, 'the old message sent people to the wrong console');
});

test('every AWS spelling of a stale credential lands on the credentials hint', () => {
  // AWS uses a different code depending on credential kind, and the status is
  // 403 for all of them — so the body, not the status, has to decide.
  for (const code of [
    'UnrecognizedClientException',
    'InvalidClientTokenId',
    'ExpiredToken',
    'ExpiredTokenException',
    'InvalidSecurityToken',
  ]) {
    const hint = bedrockHint(403, JSON.stringify({ __type: code, message: 'nope' }), 'm', 'us-east-1');
    assert.match(hint, /expired/i, `${code} should read as a credential problem`);
  }
});

test('a genuine model-access 403 still says model access', () => {
  const body = JSON.stringify({ message: "You don't have access to the model with the specified model ID." });
  const hint = bedrockHint(403, body, 'us.anthropic.claude-sonnet-5', 'us-east-1');
  assert.match(hint, /model access is enabled/);
  assert.match(hint, /us\.anthropic\.claude-sonnet-5/);
  assert.match(hint, /us-east-1/);
});

test('an IAM policy gap is distinguished from an unentitled model', () => {
  const body = JSON.stringify({
    __type: 'AccessDeniedException',
    message: 'User: arn:aws:sts::1:assumed-role/x is not authorized to perform: bedrock:InvokeModel',
  });
  const hint = bedrockHint(403, body, 'm', 'us-east-1');
  assert.match(hint, /IAM policy/);
  assert.doesNotMatch(hint, /expired/i, 'valid credentials with a missing permission is a third, different case');
});

test('the inference-profile 400 keeps its own specific instruction', () => {
  const body = JSON.stringify({
    message: 'Invocation of model ID ... isn\'t supported. Retry your request with the ID or ARN of an inference profile',
  });
  const hint = bedrockHint(400, body, 'anthropic.claude-sonnet-5', 'us-east-1');
  assert.match(hint, /inference profile/);
  assert.match(hint, /us\./, 'the fix is the us. prefix these presets already use');
});

test('throttling and unremarkable statuses do not invent a cause', () => {
  assert.match(bedrockHint(429, '{"__type":"ThrottlingException"}', 'm', 'us-east-1'), /throttled/i);
  assert.equal(bedrockHint(500, '{"message":"internal"}', 'm', 'us-east-1'), '', 'no hint beats a wrong hint');
});

// ------------------------------------------------------ image spec validation

test('a LAN address is accepted for comfyui and unsloth alike', () => {
  const comfy = validateImageSpec('comfyui:gpu-box', {
    kind: 'comfyui',
    model: 'sdxl.safetensors',
    baseUrl: 'http://192.168.1.40:8188',
  });
  assert.equal(comfy.spec?.baseUrl, 'http://192.168.1.40:8188');
  assert.equal(comfy.issues.filter((i) => i.severity !== 'warning').length, 0, 'a LAN host is legal');

  const unsloth = validateImageSpec('unsloth:gpu-box', {
    kind: 'unsloth',
    model: 'loaded',
    baseUrl: 'http://10.0.0.5:8888',
    apiKeyEnv: 'UNSLOTH_API_KEY',
  });
  assert.equal(unsloth.spec?.baseUrl, 'http://10.0.0.5:8888');
});

test('a domain with https and a path prefix survives intact', () => {
  // A reverse-proxied instance is the realistic remote case, and stripping the
  // path would send every request to the wrong host root.
  const r = validateImageSpec('comfyui:remote', {
    kind: 'comfyui',
    model: 'flux.safetensors',
    baseUrl: 'https://gpu.example.com/comfy/',
  });
  assert.equal(r.spec?.baseUrl, 'https://gpu.example.com/comfy', 'only the trailing slash goes');
  assert.equal(r.issues.length, 0, 'https to a remote host is unremarkable');
});

test('a remote plain-http host is warned about but still accepted', () => {
  const r = validateImageSpec('unsloth:lan', {
    kind: 'unsloth',
    model: 'loaded',
    baseUrl: 'http://192.168.1.40:8888',
    apiKeyEnv: 'UNSLOTH_API_KEY',
  });
  assert.ok(r.spec, 'a trusted LAN is a legitimate setup, so this must not be rejected');
  const warning = r.issues.find((i) => i.severity === 'warning');
  assert.ok(warning, 'but the key crossing the network in clear text is worth saying');
  assert.match(warning!.message, /unencrypted/);
  assert.match(warning!.message, /API key/, 'unsloth carries a bearer token, unlike comfyui');
});

test('loopback over http draws no warning, in any of its spellings', () => {
  for (const host of ['http://127.0.0.1:8188', 'http://localhost:8188', 'http://[::1]:8188']) {
    const r = validateImageSpec('comfyui:local', { kind: 'comfyui', model: 'sdxl.safetensors', baseUrl: host });
    assert.equal(r.issues.length, 0, `${host} is local and needs no TLS advice`);
  }
});

test('a malformed or non-http url is rejected with a usable example', () => {
  for (const bad of ['not a url', 'ftp://host/x', 'ws://host:8188']) {
    const r = validateImageSpec('x', { kind: 'comfyui', model: 'm', baseUrl: bad });
    const err = r.issues.find((i) => i.field.endsWith('.baseUrl') && i.severity !== 'warning');
    assert.ok(err, `${bad} should be refused`);
    assert.match(err!.message, /192\.168/, 'the message shows the shape wanted');
  }
});

test('a local unsloth needs no api key at all', () => {
  // The desktop install authenticates from its own on-disk secret, so requiring
  // a key here would turn the common local case into a configuration errand.
  const r = validateImageSpec('unsloth:x', { kind: 'unsloth', model: 'loaded', baseUrl: 'http://127.0.0.1:8888' });
  assert.ok(r.spec, 'a keyless loopback spec is valid');
  assert.equal(r.issues.length, 0, 'and draws no complaint');
});

test('a remote unsloth without a key is warned about, since no local secret can reach it', () => {
  const r = validateImageSpec('unsloth:remote', { kind: 'unsloth', model: 'loaded', baseUrl: 'https://gpu.example.com' });
  assert.ok(r.spec, 'still saved: the key may be exported later');
  const warning = r.issues.find((i) => i.field.endsWith('.apiKeyEnv'));
  assert.ok(warning, 'but a remote instance cannot use this machine\u2019s desktop login');
  assert.equal(warning!.severity, 'warning');
});

test('an unknown kind and a missing model are both refused', () => {
  assert.equal(validateImageSpec('x', { kind: 'midjourney', model: 'm' }).spec, null);
  assert.equal(validateImageSpec('x', { kind: 'comfyui', model: '   ' }).spec, null);
  assert.equal(validateImageSpec('x', 'not an object').spec, null);
});

// -------------------------------------------------------- config round-trip

function service(initial: Partial<Config> = {}) {
  let saved: Config | null = null;
  const imageRegistry = new SwappableImageRegistry(null, 'none');
  const svc = new ConfigService({
    path: '/tmp/does-not-exist.json',
    imageRegistry,
    env: { UNSLOTH_API_KEY: 'sk-unsloth-test' },
    load: () => ({ ...defaultConfig(), ...initial }),
    save: (cfg) => {
      saved = cfg;
    },
  });
  return { svc, imageRegistry, saved: () => saved };
}

test('an image provider override is persisted, which it never used to be', () => {
  const { svc, saved } = service();
  const result = svc.putImageProvider('comfyui:local', {
    kind: 'comfyui',
    model: 'sdxl.safetensors',
    baseUrl: 'http://192.168.1.40:8188',
  });

  assert.equal(result.config.imageProviders?.['comfyui:local']?.baseUrl, 'http://192.168.1.40:8188');
  assert.equal(saved()?.imageProviders?.['comfyui:local']?.baseUrl, 'http://192.168.1.40:8188', 'and it reached the file');
});

test('editing the host swaps the live image registry, so no restart is needed', () => {
  const { svc, imageRegistry } = service({ imageProfile: 'comfyui:local' });
  svc.putImageProvider('comfyui:local', {
    kind: 'comfyui',
    model: 'sdxl.safetensors',
    baseUrl: 'http://192.168.1.40:8188',
  });

  const provider = imageRegistry.get();
  assert.ok(provider instanceof ComfyUIProvider, 'the rebuilt provider is live in the registry');
  // The base url is private, so assert through the behaviour that depends on it.
  assert.equal(provider!.model, 'sdxl.safetensors');
});

test('an unsloth override reaching the registry keeps conditioning on', () => {
  const { svc, imageRegistry } = service({ imageProfile: 'unsloth:local' });
  const result = svc.putImageProvider('unsloth:local', {
    kind: 'unsloth',
    model: 'loaded',
    baseUrl: 'http://10.0.0.5:8888',
    apiKeyEnv: 'UNSLOTH_API_KEY',
  });

  assert.equal(result.issues.filter((i) => i.severity !== 'warning').length, 0);
  const provider = imageRegistry.get();
  assert.ok(provider instanceof UnslothImageProvider);
  assert.equal(provider!.capabilities.imageConditioning, true);
});

test('a keyless unsloth spec still builds into a live provider', () => {
  // Previously this threw, so illustration stayed off until a key was exported.
  // Now the provider is constructed and resolves a credential per request,
  // falling back to the local desktop secret.
  let saved: Config | null = null;
  const imageRegistry = new SwappableImageRegistry(null, 'none');
  const svc = new ConfigService({
    path: '/tmp/does-not-exist.json',
    imageRegistry,
    env: {},
    load: () => ({ ...defaultConfig(), imageProfile: 'unsloth:local' }),
    save: (cfg) => {
      saved = cfg;
    },
  });

  const result = svc.putImageProvider('unsloth:local', {
    kind: 'unsloth',
    model: 'loaded',
    baseUrl: 'http://127.0.0.1:8888',
    apiKeyEnv: 'UNSLOTH_API_KEY',
  });

  assert.equal(result.issues.filter((i) => i.severity !== 'warning').length, 0, 'no blocking issue');
  assert.ok(imageRegistry.get() instanceof UnslothImageProvider, 'the provider is live even with no key exported');
  assert.ok(saved, 'and the spec was saved');
});

test('removing an override reverts to the preset instead of erasing the provider', () => {
  const { svc } = service({
    imageProviders: { 'comfyui:local': { kind: 'comfyui', model: 'mine.safetensors', baseUrl: 'http://192.168.1.40:8188' } },
  });
  const result = svc.removeImageProvider('comfyui:local');
  assert.equal(result.config.imageProviders?.['comfyui:local'], undefined, 'the override is gone');
  // The preset of the same name still exists, so the key remains offerable.
  assert.ok(svc.imageProviderKeys().includes('comfyui:local'));
  assert.equal(svc.resolveImageSpec('comfyui:local')?.baseUrl, 'http://127.0.0.1:8188', 'back to the preset default');
});

test('the key list and spec resolver merge presets with overrides', () => {
  const { svc } = service({
    imageProviders: { 'comfyui:gpu-box': { kind: 'comfyui', model: 'x.safetensors', baseUrl: 'http://10.0.0.9:8188' } },
  });
  const keys = svc.imageProviderKeys();
  assert.ok(keys.includes('comfyui:gpu-box'), 'a custom key is offerable');
  assert.ok(keys.includes('mock') && keys.includes('unsloth:local'), 'presets are still there');
  assert.equal(svc.resolveImageSpec('comfyui:gpu-box')?.baseUrl, 'http://10.0.0.9:8188');
});
