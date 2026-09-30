/**
 * Phase 5: the phase 0 contract, run against the Vertex SDK adapter.
 *
 * Auth is stubbed at the `GoogleAuth` environment boundary rather than replaced,
 * so discovery still runs — only the files and CLI it reads are supplied.
 */
import { describe } from 'node:test';
import { VertexSdkProvider } from '../../src/providers/vertex-sdk.ts';
import { GoogleAuth } from '../../src/providers/google.ts';
import type { ProviderContract } from './provider-contract.ts';
import { runProviderContract } from './provider-contract.ts';

const MODEL = 'contract-model';

function stubAuth() {
  return new GoogleAuth({
    env: { GOOGLE_CLOUD_PROJECT: 'contract-project' },
    readFile: (path) =>
      path.includes('application_default_credentials.json')
        ? JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' })
        : null,
    fetcher: (async () =>
      new Response(JSON.stringify({ access_token: 'contract-token', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    run: async () => '',
    now: () => new Date(),
  });
}

const vertexSdk: ProviderContract = {
  label: 'vertex gemini (ai sdk)',
  model: MODEL,
  nativeSchema: true,
  build: ({ fetcher, capabilities, timeoutMs }) =>
    new VertexSdkProvider({
      model: MODEL,
      capabilities: {
        contextWindow: 1_000_000,
        structuredOutput: 'native-schema',
        systemRole: false,
        streaming: true,
        costTier: 'cheap',
        charsPerToken: 4,
        proseQuality: 0.5,
        steerability: 0.5,
        ...(capabilities as object),
      } as never,
      auth: stubAuth(),
      location: 'us-central1',
      fetcher,
      timeoutMs,
    }),
  body: (over = {}) => ({
    candidates: [
      {
        content: { role: 'model', parts: [{ text: over.text ?? 'a plain answer' }] },
        finishReason: over.finishReason === 'length' ? 'MAX_TOKENS' : 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
    modelVersion: MODEL,
  }),
  frames: (over = {}) =>
    [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Once ' }] }, index: 0 }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'upon ' }] }, index: 0 }] },
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'a time' }] },
            finishReason: over.finishReason === 'length' ? 'MAX_TOKENS' : 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: over.tokensIn ?? 11, candidatesTokenCount: over.tokensOut ?? 4, totalTokenCount: 15 },
      },
    ].map((event) => JSON.stringify(event)),
};

describe('phase 5: vertex ai sdk adapter', () => {
  runProviderContract(vertexSdk);
});
