/**
 * Why the `legacy` rollback can exist at all.
 *
 * Issue #171 asks for the rollback switch to be retired or justified. It is
 * justified: both transports are held to the *same* executable contract, so the
 * hand-rolled adapters are covered rather than merely present, and deleting them
 * once the switch expires is a deletion with no behaviour left to re-verify.
 *
 * This file is that justification as a test. If someone removes a legacy adapter
 * without retiring the rollback, adds a kind that resolves to neither transport,
 * or drops the documentation, it fails here rather than at a user's turn.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRESETS, resolveTransport } from '../src/providers/http.ts';

/** Provider kinds that speak to a supported AI SDK module. */
const SDK_KINDS = new Set(['openai-compat', 'anthropic', 'bedrock', 'google']);

/** Provider kinds that are retained bespoke paths, so they have no transport choice. */
const LEGACY_ONLY_KINDS = new Set(['ollama', 'copilot', 'jev', 'mock']);

test('every preset resolves to a transport that exists', () => {
  for (const [key, spec] of Object.entries(PRESETS)) {
    if (LEGACY_ONLY_KINDS.has(spec.kind)) continue;
    assert.ok(SDK_KINDS.has(spec.kind), `${key} has an unknown kind ${spec.kind}`);
    assert.ok(
      ['sdk', 'legacy'].includes(resolveTransport(spec, {})),
      `${key} resolves to a transport that must exist`,
    );
  }
});

test('only migrated kinds are offered a transport choice', () => {
  for (const [key, spec] of Object.entries(PRESETS)) {
    if (spec.transport !== undefined) {
      assert.ok(SDK_KINDS.has(spec.kind), `${key} (${spec.kind}) has no transport choice to make`);
    }
  }
});

test('both transports stay reachable, so the rollback is still a switch', () => {
  // If this stops holding, the rollback has quietly become one-way.
  for (const kind of SDK_KINDS) {
    assert.equal(resolveTransport({ transport: 'legacy' }), 'legacy', kind);
    assert.equal(resolveTransport({ transport: 'sdk' }), 'sdk', kind);
  }
});

test('a dialect is never carried by the SDK adapter', () => {
  for (const dialect of ['vllm', 'llamacpp'] as const) {
    assert.equal(resolveTransport({ dialect }), 'legacy', dialect);
    assert.throws(() => resolveTransport({ dialect, transport: 'sdk' }), /does not support/, dialect);
  }
});

test('the retained custom paths and the rollback are documented with an expiry', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /FABULIST_PROVIDER_TRANSPORT=legacy/, 'the operator lever is documented');
  assert.match(readme, /next minor release/, 'and carries an expiry rather than being permanent');
  for (const [label, pattern] of [
    ['vLLM', /vLLM and llama\.cpp/],
    ['Ollama', /\*\*Ollama\*\*/],
    ['Copilot', /GitHub Copilot/],
    ['images', /\*\*Image generation\*\*/],
  ] as const) {
    assert.match(readme, pattern, `${label} is named as a retained path`);
  }
});
