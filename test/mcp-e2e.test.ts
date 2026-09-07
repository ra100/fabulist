/**
 * True end-to-end MCP test: a real `createApiServer` listening on a real
 * port, a real `@modelcontextprotocol/sdk` client connecting over real HTTP
 * (Streamable HTTP transport, exactly what Claude/ChatGPT use), calling
 * real tools against a real seeded world. Everything below `test/mcp-tools.test.ts`
 * and `test/mcp-auth.test.ts` already covers in isolation; this is the one
 * test that proves the seams between them — auth header parsing, the SDK's
 * own request/response framing, tool registration — actually fit together,
 * the same reasoning `test/api.test.ts` already applies to the plain routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CurrentWorld } from '../src/store/index.ts';
import { createWorldFile } from '../src/store/worlds.ts';
import { seedWorld } from '../src/seed/verrow.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import { Engine } from '../src/loop/engine.ts';
import { createApiServer } from '../src/server/api.ts';
import { buildMcpAuth } from '../src/mcp/auth.ts';

const DEV_TOKEN = 'e2e-test-secret';

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'fabulist-mcp-e2e-'));
  createWorldFile('E2E World', root);
  const cw = CurrentWorld.open('e2e-world', root);
  // Saint Verrow's seed canon, not an empty world: several e2e tests below
  // (the vow-breach interrupt in particular) need real cast/contract data to
  // exercise, exactly the same reasoning `test/engine.test.ts`'s own
  // `setup()` already applies.
  seedWorld(cw.world());
  const mock = new MockProvider();
  const engine = new Engine({ world: () => cw.world(), providers: new ProviderRegistry(mock) });
  const mcpAuth = buildMcpAuth({ MCP_DEV_TOKEN: DEV_TOKEN });
  assert.ok(mcpAuth, 'dev-token mode should build from this env');

  const server = createApiServer({
    world: () => cw.world(),
    engine,
    currentStory: cw.stories(),
    currentWorld: cw,
    dataRoot: root,
    mcpAuth: mcpAuth!,
    mcpResourceUrl: 'http://127.0.0.1:0/mcp', // overwritten below once the real port is known
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    cw.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function connect(baseUrl: string, token = DEV_TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'fabulist-e2e-test', version: '1.0.0' });
  return { client, transport };
}

test('the protected-resource metadata is served unauthenticated', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const meta = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.ok(meta.resource.length > 0);
    assert.ok(Array.isArray(meta.authorization_servers));
  });
});

test('a request to /mcp with no bearer token is rejected with 401 and WWW-Authenticate', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate');
    assert.match(header ?? '', /resource_metadata=/);
  });
});

test('a real MCP client connects, lists tools, and finds propose_turn among them', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(names.includes('propose_turn'));
      assert.ok(names.includes('get_state'));
      assert.ok(names.includes('commit_narration'));
      assert.ok(names.includes('resolve_interrupt'));
    } finally {
      await client.close();
    }
  });
});

test('a wrong bearer token is rejected even after a successful connection elsewhere', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl, 'not-the-right-token');
    await assert.rejects(() => client.connect(transport));
  });
});

test('get_state over a real MCP call returns the seeded world\u2019s actual counts', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'get_state', arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      assert.ok(text);
      const parsed = JSON.parse(text!);
      assert.ok(typeof parsed.session.scene === 'number');
      assert.ok(typeof parsed.counts.entities === 'number');
    } finally {
      await client.close();
    }
  });
});

test('a full turn end to end: propose_turn, then commit_narration, over real MCP calls', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const proposeResult = await client.callTool({
        name: 'propose_turn',
        arguments: { text: 'i look around the cell' },
      });
      const proposeText = (proposeResult.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      const proposal = JSON.parse(proposeText!);
      assert.equal(proposal.status, 'awaiting-narration');
      assert.ok(proposal.resumeToken.length > 0);
      assert.match(proposal.narratorSystemPrompt, /narrator/i);

      const commitResult = await client.callTool({
        name: 'commit_narration',
        arguments: { resumeToken: proposal.resumeToken, prose: 'The cell is cold, and the light through the grate is thin.' },
      });
      const commitText = (commitResult.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      const committed = JSON.parse(commitText!);
      assert.equal(committed.status, 'narrated');
      assert.equal(committed.prose, 'The cell is cold, and the light through the grate is thin.');
    } finally {
      await client.close();
    }
  });
});

test('propose_turn on a vow-breaching action surfaces status interrupted, resolvable over MCP', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const proposeResult = await client.callTool({
        name: 'propose_turn',
        arguments: { text: 'i stab the captain' },
      });
      const proposeText = (proposeResult.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      const proposal = JSON.parse(proposeText!);
      assert.equal(proposal.status, 'interrupted');
      assert.equal(proposal.originalText, 'i stab the captain');

      const resolveResult = await client.callTool({
        name: 'resolve_interrupt',
        arguments: { originalText: proposal.originalText, effect: 'override' },
      });
      const resolveText = (resolveResult.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
      const resolved = JSON.parse(resolveText!);
      assert.equal(resolved.status, 'awaiting-narration');
    } finally {
      await client.close();
    }
  });
});
