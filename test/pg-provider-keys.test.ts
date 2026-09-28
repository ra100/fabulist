import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import {
  deleteProviderKey,
  providerKeyFor,
  providerKeysFor,
  providerModelAssignmentsFor,
  saveProviderKey,
  saveProviderModelAssignments,
  summarizeProviderKey,
} from '../src/auth/provider-keys-pg.ts';
import { recordUsage } from '../src/store/usage-pg.ts';

const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
const INSERT_KEY =
  'INSERT INTO user_provider_keys (id, user_id, endpoint_id, trust, nonce, ciphertext, key_hint) VALUES ($1, $2, $3, $4, $5, $6, $7)';
const key = (id: string, userId: string, endpointId = 'openai') => ({
  id,
  userId,
  label: endpointId,
  endpointId,
  trust: 'sealed' as const,
  nonce: Buffer.alloc(12, 1),
  ciphertext: Buffer.alloc(40, 2),
  keyHint: 'abcd',
});

test('provider credentials and usage events are writable by the play role and allow multiple rows per user', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await roles.play.query(INSERT_KEY, [
      ID1,
      'user:alice',
      'openai',
      'sealed',
      Buffer.alloc(12, 1),
      Buffer.alloc(40, 2),
      'abcd',
    ]);
    await roles.play.query(INSERT_KEY, [
      ID2,
      'user:alice',
      'anthropic',
      'sealed',
      Buffer.alloc(12, 1),
      Buffer.alloc(40, 2),
      'wxyz',
    ]);
    await roles.play.query(
      "INSERT INTO usage_events (user_id, story_id, role, provider_id, model, key_source, tokens_in, tokens_out) VALUES ('user:alice', NULL, 'narrate', 'openai', 'gpt-test', 'own', 10, 2)",
    );

    await assert.rejects(
      roles.play.query(INSERT_KEY, [
        'key-3',
        'user:bob',
        'openai',
        'plain',
        Buffer.alloc(12, 1),
        Buffer.alloc(40, 2),
        'abcd',
      ]),
      /violates check constraint/,
    );
    await assert.rejects(
      roles.play.query(INSERT_KEY, [
        ID1,
        'user:bob',
        'openai',
        'sealed',
        Buffer.alloc(12, 1),
        Buffer.alloc(40, 2),
        'abcd',
      ]),
      /duplicate key value/,
      'credential IDs are globally unique',
    );
    await assert.rejects(
      roles.play.query(INSERT_KEY, [
        'key-4',
        'user:bob',
        'openai',
        'sealed',
        Buffer.alloc(11, 1),
        Buffer.alloc(40, 2),
        'abcd',
      ]),
      /violates check constraint/,
      'a GCM nonce is 12 bytes',
    );
    await assert.rejects(
      roles.play.query(
        "INSERT INTO usage_events (user_id, role, provider_id, model, key_source, tokens_in, tokens_out) VALUES ('user:alice', 'narrate', 'openai', 'gpt-test', 'free', 1, 1)",
      ),
      /violates check constraint/,
    );

    assert.equal(
      (await roles.play.query("SELECT count(*)::int AS n FROM user_provider_keys WHERE user_id = 'user:alice'")).rows[0]
        ?.n,
      2,
    );
    assert.equal(
      (
        await roles.play.query(
          "SELECT has_table_privilege('fabulist_play', 'user_provider_model_assignments', 'INSERT') AS ok",
        )
      ).rows[0]?.ok,
      true,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('provider credentials are owner-scoped, independently stored, and deletions clear only their assignments', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    await saveProviderKey(roles.play, key(ID1, 'user:alice', 'openai'));
    await saveProviderKey(roles.play, key(ID2, 'user:alice', 'anthropic'));
    const alice = await providerKeysFor(roles.play, 'user:alice');
    assert.deepEqual(
      alice.map((row) => row.id),
      [ID1, ID2],
    );
    assert.equal((await providerKeyFor(roles.play, 'user:alice', ID2))?.endpointId, 'anthropic');
    assert.equal(await providerKeyFor(roles.play, 'user:bob', ID1), null);
    await assert.rejects(saveProviderKey(roles.play, key(ID1, 'user:bob')), { code: '23505' });

    const assignments = [
      { role: 'narrate' as const, providerKeyId: ID1, model: 'gpt-narrate' },
      { role: 'extract' as const, providerKeyId: ID2, model: 'claude-extract' },
    ];
    await saveProviderModelAssignments(roles.play, 'user:alice', assignments);
    assert.deepEqual(await providerModelAssignmentsFor(roles.play, 'user:alice'), assignments);
    await assert.rejects(saveProviderModelAssignments(roles.play, 'user:bob', assignments), { code: '23503' });

    const call = {
      storyId: null,
      role: 'narrate',
      providerId: 'openai',
      model: 'gpt-narrate',
      keySource: 'own' as const,
      tokensIn: 1,
      tokensOut: 1,
      keyId: ID1,
    };
    await recordUsage(roles.play, { ...call, userId: 'user:bob' });
    assert.equal(
      (await providerKeyFor(roles.play, 'user:alice', ID1))?.lastUsedAt,
      null,
      'another user cannot touch it',
    );
    await recordUsage(roles.play, { ...call, userId: 'user:alice' });
    assert.ok((await providerKeyFor(roles.play, 'user:alice', ID1))?.lastUsedAt);

    const summary = summarizeProviderKey(alice[0]!);
    assert.deepEqual(Object.keys(summary).sort(), [
      'createdAt',
      'endpointId',
      'id',
      'keyHint',
      'label',
      'lastUsedAt',
      'trust',
    ]);
    assert.equal(await deleteProviderKey(roles.play, 'user:alice', ID1), true);
    assert.deepEqual(await providerModelAssignmentsFor(roles.play, 'user:alice'), [assignments[1]]);
    assert.equal((await providerKeysFor(roles.play, 'user:alice')).length, 1);
    assert.equal(await deleteProviderKey(roles.play, 'user:alice', ID1), false);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM user_provider_model_assignments WHERE user_id = 'user:alice'"))
        .rows[0]?.n,
      1,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('migration 011 copies old encrypted-key model settings into per-role assignments and preserves the credential', async (t) => {
  const ran = await withPg(async (db) => {
    await db.query('ALTER TABLE user_provider_keys ADD COLUMN models JSONB');
    await db.query(
      'INSERT INTO user_provider_keys (id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint) VALUES ($1, \'user:alice\', \'\', \'openai\', \'{"narrate":"old-narrate","mechanics":"old-mechanics","extract":"old-extract"}\', \'sealed\', $2, $3, \'abcd\')',
      [ID1, Buffer.alloc(12, 3), Buffer.alloc(40, 4)],
    );
    await db.query(
      "INSERT INTO user_provider_keys (id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint) VALUES ($1, 'user:bob', '', 'anthropic', '{\"narrate\":\"old-bob\"}', 'unlock', $2, $3, 'wxyz')",
      [ID2, Buffer.alloc(12, 5), Buffer.alloc(40, 6)],
    );
    const before = await db.query('SELECT id, trust, nonce, ciphertext, key_hint FROM user_provider_keys ORDER BY id');
    const migration = readFileSync(
      new URL('../src/db/migrations-pg/011-provider-model-assignments.sql', import.meta.url),
      'utf8',
    );
    await db.query(migration);

    const rows = await db.query<{ user_id: string; role: string; provider_key_id: string; model_id: string }>(
      'SELECT user_id, role, provider_key_id, model_id FROM user_provider_model_assignments ORDER BY user_id, role',
    );
    const alice = rows.rows.filter((row) => row.user_id === 'user:alice');
    assert.equal(alice.length, 10);
    assert.deepEqual(
      alice.find((row) => row.role === 'narrate'),
      { user_id: 'user:alice', role: 'narrate', provider_key_id: ID1, model_id: 'old-narrate' },
    );
    assert.deepEqual(
      alice
        .filter((row) =>
          ['classify', 'integrity', 'referee', 'director', 'humanize', 'summarize', 'setup'].includes(row.role),
        )
        .map((row) => row.model_id),
      Array(7).fill('old-mechanics'),
    );
    assert.deepEqual(
      alice.filter((row) => ['extract', 'passb'].includes(row.role)).map((row) => row.model_id),
      ['old-extract', 'old-extract'],
    );
    const bob = rows.rows.filter((row) => row.user_id === 'user:bob');
    assert.equal(bob.length, 10);
    assert.ok(
      bob.every((row) => row.model_id === 'old-bob'),
      'missing mechanics/extract keep the narration model',
    );

    const after = await db.query('SELECT id, trust, nonce, ciphertext, key_hint FROM user_provider_keys ORDER BY id');
    assert.deepEqual(after.rows, before.rows, 'migration preserves existing encrypted bytes and trust modes');
    const legacyColumn = await db.query<{ absent: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'user_provider_keys' AND column_name = 'models') AS absent",
    );
    assert.equal(legacyColumn.rows[0]?.absent, true);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('migration 011 is recorded and grants both play tables', async (t) => {
  const ran = await withPg(async (db) => {
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM migrations WHERE version IN (10, 11) ORDER BY version',
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      ['010-byok-provider-keys.sql', '011-provider-model-assignments.sql'],
    );
    const grants = await db.query<{ ok: boolean }>(
      "SELECT has_table_privilege('fabulist_play', 'user_provider_keys', 'INSERT') AND has_table_privilege('fabulist_play', 'user_provider_model_assignments', 'INSERT') AND has_table_privilege('fabulist_play', 'usage_events', 'INSERT') AND has_sequence_privilege('fabulist_play', 'usage_events_id_seq', 'USAGE') AS ok",
    );
    assert.equal(grants.rows[0]?.ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});
