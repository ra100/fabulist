import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderKeyRejectedError } from '../src/providers/byok.ts';
import { OpenAIImageProvider, openAIImageSize } from '../src/providers/openaiImage.ts';

const KEY = 'sk-image-0123456789abcdefghij';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function stub(status = 200, payload: unknown = { data: [{ b64_json: PNG.toString('base64') }] }) {
  const calls: Array<{ url: string; authorization: string; body: Record<string, unknown>; redirect?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init.headers).get('authorization') ?? '',
      body: JSON.parse(String(init.body)),
      redirect: init.redirect,
    });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}

test('an OpenAI image is generated with the saved key and model and returned as bytes', async () => {
  const { fetcher, calls } = stub();
  const provider = new OpenAIImageProvider({ model: 'gpt-image-1', apiKey: () => KEY, fetcher });
  const result = await provider.generate({ prompt: 'a lighthouse', negativePrompt: 'text', width: 1216, height: 832 });

  assert.deepEqual([...result.bytes], [...PNG]);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.seed, null);
  assert.equal(result.model, 'gpt-image-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0]?.authorization, 'Bearer ' + KEY);
  assert.equal(calls[0]?.redirect, 'error', 'a redirect must not carry the key elsewhere');
  assert.deepEqual(calls[0]?.body, {
    model: 'gpt-image-1',
    prompt: 'a lighthouse\n\nAvoid: text',
    n: 1,
    size: '1536x1024',
  });
});

test('DALL·E is asked for base64 rather than a URL', async () => {
  const { fetcher, calls } = stub();
  await new OpenAIImageProvider({ model: 'dall-e-3', apiKey: () => KEY, fetcher }).generate({ prompt: 'p' });
  assert.equal(calls[0]?.body.response_format, 'b64_json');
  assert.equal(calls[0]?.body.size, '1024x1024');
});

test('a refused key surfaces as a rejected credential without echoing the key', async () => {
  const { fetcher } = stub(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
  const provider = new OpenAIImageProvider({ model: 'gpt-image-1', apiKey: () => KEY, fetcher });
  await assert.rejects(provider.generate({ prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ProviderKeyRejectedError);
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
});

test('a response with no image is an error, not an empty picture', async () => {
  const { fetcher } = stub(200, { data: [] });
  const provider = new OpenAIImageProvider({ model: 'gpt-image-1', apiKey: () => KEY, fetcher });
  await assert.rejects(provider.generate({ prompt: 'p' }), /returned no image/);
});

test('sizes follow each model family and the requested aspect', () => {
  assert.equal(openAIImageSize('gpt-image-1', 832, 1216), '1024x1536');
  assert.equal(openAIImageSize('gpt-image-1'), '1024x1024');
  assert.equal(openAIImageSize('dall-e-3', 1216, 832), '1792x1024');
  assert.equal(openAIImageSize('dall-e-2', 1216, 832), '1024x1024');
});
