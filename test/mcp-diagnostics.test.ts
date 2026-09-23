/**
 * `/api/mcp-diagnostics` is public on purpose — an operator reads it to debug a
 * connector that cannot authenticate yet — so everything in it can be written
 * by anyone who can reach `/mcp`, signed in or not. It must stay small.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMcpDiagnostics, recordMcpRequestFailure } from '../src/mcp/server-pg.ts';

test('the public MCP diagnostics feed keeps only a short prefix of caller-supplied names', () => {
  recordMcpRequestFailure(
    { method: `tools/call${'m'.repeat(100_000)}`, params: { name: `play${'t'.repeat(100_000)}` } },
    new Error('boom'),
    false,
  );
  const last = getMcpDiagnostics().events.at(-1);
  assert.ok(last, 'the failure was recorded');
  assert.ok(last.method.startsWith('tools/call'), 'enough is kept to diagnose with');
  assert.ok(last.method.length <= 64, `method kept ${last.method.length} characters`);
  assert.ok(last.tool?.startsWith('play'));
  assert.ok((last.tool ?? '').length <= 64, `tool kept ${(last.tool ?? '').length} characters`);
});
