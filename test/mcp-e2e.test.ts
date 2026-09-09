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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  // The port has to exist before `mcpResourceUrl` can name it, and the URL has to be
  // right before the server is built — `serverInfo` resolves the advertised icon URLs
  // against it, so a placeholder makes the server advertise `http://127.0.0.1:0/…`.
  //
  // An earlier version passed `:0` with a comment claiming it was "overwritten below
  // once the real port is known"; nothing overwrote it, and the icon test failed on that
  // rather than on anything the server does wrong. Listening on a throwaway server first
  // is the cheap way to learn a free port before committing to it.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const server = createApiServer({
    world: () => cw.world(),
    engine,
    currentStory: cw.stories(),
    currentWorld: cw,
    dataRoot: root,
    mcpAuth: mcpAuth!,
    mcpResourceUrl: `http://127.0.0.1:${port}/mcp`,
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    cw.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A tool result's JSON payload, read the way every test here already does. */
function payload(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!) as Record<string, unknown>;
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

test('every listed tool carries readOnly/destructive/openWorld annotations, matching its actual behaviour', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      // Required for OpenAI's plugin review (readOnlyHint/openWorldHint/destructiveHint on
      // every tool, per developers.openai.com/plugins/deploy/app-review) — this is the one
      // place that would actually notice a new tool landing with no annotations at all.
      const missing = tools.filter((t) => t.annotations === undefined).map((t) => t.name);
      assert.deepEqual(missing, [], `tools missing annotations entirely: ${missing.join(', ')}`);

      const byName = new Map(tools.map((t) => [t.name, t.annotations]));
      // Spot-check a representative read tool, write tool, and destructive tool rather than
      // asserting the whole map here — the exhaustive map lives in the per-tool doc comments
      // in tools.ts/server.ts, and duplicating it in the test would just be a second place to
      // forget to update.
      assert.equal(byName.get('get_state')?.readOnlyHint, true);
      assert.equal(byName.get('get_state')?.destructiveHint, false);
      assert.equal(byName.get('propose_turn')?.destructiveHint, false);
      assert.equal(byName.get('reset_world')?.destructiveHint, true);
      assert.equal(byName.get('resolve_wiki')?.openWorldHint, true);
      assert.equal(byName.get('update_sheet')?.readOnlyHint, false);
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

test('the server tells a client how to use it before any tool is called', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      // `instructions` is what a client surfaces to the model on initialize.
      // Its absence is why a connector can create a book and never commit a
      // turn into it: the two-step turn loop is not guessable from a flat tool
      // list, so the contract is asserted here rather than left to prose.
      const instructions = client.getInstructions();
      assert.ok(instructions, 'the server advertises instructions at all');
      assert.match(instructions!, /commit_narration/, 'names the call that actually saves a turn');
      assert.match(instructions!, /NOTHING IS SAVED UNTIL THIS CALL/, 'and says so unmissably');
      assert.match(instructions!, /start_story/, 'and how a canon-rich book with no protagonist gets one');
      assert.match(instructions!, /close_scene/);

      // A prompt, so "play this world" is a one-click entry point rather than
      // something the user has to phrase correctly.
      const { prompts } = await client.listPrompts();
      const play = prompts.find((p) => p.name === 'play');
      assert.ok(play, 'a play prompt is registered');
      const got = await client.getPrompt({ name: 'play', arguments: { wish: 'a heist' } });
      const text = got.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
      assert.match(text, /a heist/, 'the wish is threaded in');
      assert.match(text, /commit_narration/);
    } finally {
      await transport.close();
    }
  });
});

test('the server advertises a title, description, and resolvable icons on initialize', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      // A connector-picker UI (Claude Desktop, ChatGPT) reads this off
      // `serverInfo` before anyone has connected — never populating it is why
      // a listed connector shows up with no icon and no description next to
      // every first-party one that has both (`src/mcp/server.ts`'s own
      // `serverInfo` header comment). Asserted at the wire, not just as a
      // literal in `buildServer`, so a future refactor cannot silently drop
      // it from the actual `initialize` response.
      const info = client.getServerVersion();
      assert.ok(info, 'the server advertises its identity at all');
      assert.equal(info!.title, 'Fabulist');
      assert.match(info!.description ?? '', /state-first fiction engine/);
      const icons = (info as { icons?: Array<{ src: string; mimeType?: string }> }).icons;
      assert.ok(icons && icons.length > 0, 'at least one icon is advertised');
      for (const icon of icons!) {
        // Absolute and same-origin as the endpoint just connected to — a
        // relative path here would be meaningless to a client that has no
        // notion of "relative to what", and the MCP spec itself only allows
        // an HTTP(S) URL or a data: URI (`Icon.src`, `@modelcontextprotocol/sdk`).
        assert.match(icon.src, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
      }
      const iconPaths = icons!.map((i) => new URL(i.src).pathname);
      assert.deepEqual(iconPaths, ['/favicon.svg', '/icon-192.png', '/icon-512.png']);
    } finally {
      await transport.close();
    }
  });
});

test('a proposed turn tells the caller, in the payload, that it must be committed', async () => {
  await withServer(async (baseUrl) => {
    const { client, transport } = connect(baseUrl);
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'propose_turn', arguments: { text: 'I read quietly at my desk.' } });
      const out = payload(res);
      assert.equal(out.status, 'awaiting-narration');
      assert.ok(out.resumeToken);
      assert.match(String(out.nextStep ?? ''), /commit_narration/, 'the next call is named in the result itself');
      assert.match(String(out.nextStep ?? ''), /[Nn]othing is saved/);

      const committed = await client.callTool({
        name: 'commit_narration',
        arguments: { resumeToken: out.resumeToken, prose: 'He turned the page, and the lamp guttered.' },
      });
      const done = payload(committed);
      assert.equal(done.status, 'narrated');
      assert.match(String(done.nextStep ?? ''), /propose_turn|close_scene/, 'and so is the one after that');
    } finally {
      await transport.close();
    }
  });
});
