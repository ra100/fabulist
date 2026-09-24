/**
 * `/api/mcp-diagnostics` is public on purpose — an operator reads it to debug a
 * connector that cannot authenticate yet — so everything in it can be written
 * by anyone who can reach `/mcp`, signed in or not. It must stay small.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMcpDiagnostics, recordMcpRequestFailure } from '../src/mcp/server-pg.ts';

const record = (body: unknown) => {
  recordMcpRequestFailure(body, new Error('boom'), false);
  const last = getMcpDiagnostics().events.at(-1);
  assert.ok(last, 'the failure was recorded');
  return last;
};

test('the public MCP diagnostics feed keeps real method and tool names', () => {
  const last = record({ method: 'tools/call', params: { name: 'propose_turn' } });
  assert.equal(last.method, 'tools/call');
  assert.equal(last.tool, 'propose_turn');
  assert.equal(record({ method: 'notifications/initialized' }).method, 'notifications/initialized');
});

test('the public MCP diagnostics feed never shows caller-written text', () => {
  const huge = record({ method: `tools/call${'m'.repeat(100_000)}`, params: { name: `play${'t'.repeat(100_000)}` } });
  assert.equal(huge.method, 'other');
  assert.equal(huge.tool, 'other');
  const prose = record({ method: 'Visit https://evil.example now', params: { name: 'Free credits at evil.example' } });
  assert.equal(prose.method, 'other');
  assert.equal(prose.tool, 'other');
  assert.equal(record({ method: 'tools/call', params: { name: 'x'.repeat(65) } }).tool, 'other');
});
