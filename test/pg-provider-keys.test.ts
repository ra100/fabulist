import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';

const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

const insertKey = `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
                   VALUES ($1, $2, 'openai', '{"narrate":"gpt-test"}', $3, $4, $5, 'abcd')`;

test('provider keys and usage events are writable by the play role and constrained per column', async (t) => {
  const ran = await withPg(async (_db, _schema, roles) => {
    await roles.play.query(insertKey, [ID1, 'user:alice', 'sealed', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]);
    await roles.play.query(
      `INSERT INTO usage_events (user_id, story_id, role, provider_id, model, key_source, tokens_in, tokens_out)
       VALUES ('user:alice', NULL, 'narrate', 'openai', 'gpt-test', 'own', 10, 2)`,
    );

    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:bob', 'plain', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]),
      /violates check constraint/,
    );
    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:alice', 'sealed', Buffer.alloc(12, 1), Buffer.alloc(40, 2)]),
      /duplicate key value/,
      'one key per user',
    );
    await assert.rejects(
      roles.play.query(insertKey, [ID2, 'user:bob', 'sealed', Buffer.alloc(11, 1), Buffer.alloc(40, 2)]),
      /violates check constraint/,
      'a GCM nonce is 12 bytes',
    );
    await assert.rejects(
      roles.play.query(
        `INSERT INTO usage_events (user_id, role, provider_id, model, key_source, tokens_in, tokens_out)
         VALUES ('user:alice', 'narrate', 'openai', 'gpt-test', 'free', 1, 1)`,
      ),
      /violates check constraint/,
    );
  });
  if (!ran) t.skip('no Postgres configured');
});

test('migration 010 is recorded and grants the play role both tables and the usage sequence', async (t) => {
  const ran = await withPg(async (db) => {
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM migrations WHERE version = 10`);
    assert.deepEqual(rows.map((r) => r.name), ['010-byok-provider-keys.sql']);
    const grants = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('fabulist_play', 'user_provider_keys', 'INSERT')
          AND has_table_privilege('fabulist_play', 'usage_events', 'INSERT')
          AND has_sequence_privilege('fabulist_play', 'usage_events_id_seq', 'USAGE') AS ok`,
    );
    assert.equal(grants.rows[0]?.ok, true);
  });
  if (!ran) t.skip('no Postgres configured');
});
