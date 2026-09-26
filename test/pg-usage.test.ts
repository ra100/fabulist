import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { recordUsage, usageByUser, usageForUser } from '../src/store/usage-pg.ts';

test("usage groups a user's calls by day, model and key source, and never mixes users", async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const base = { storyId: null, role: 'narrate', providerId: 'openai' };
    await recordUsage(roles.play, {
      ...base,
      userId: 'user:alice',
      model: 'gpt-a',
      keySource: 'own',
      tokensIn: 10,
      tokensOut: 2,
    });
    await recordUsage(roles.play, {
      ...base,
      userId: 'user:alice',
      model: 'gpt-a',
      keySource: 'own',
      tokensIn: 5,
      tokensOut: 1,
    });
    await recordUsage(roles.play, {
      ...base,
      userId: 'user:alice',
      model: 'srv',
      keySource: 'server',
      tokensIn: 3,
      tokensOut: 3,
    });
    await recordUsage(roles.play, {
      ...base,
      userId: 'user:bob',
      model: 'gpt-a',
      keySource: 'own',
      tokensIn: 100,
      tokensOut: 100,
    });
    await recordUsage(roles.play, {
      ...base,
      userId: 'user:carol',
      model: 'gpt-a',
      keySource: 'own',
      tokensIn: -5,
      tokensOut: Number.NaN,
    });
    await db.query(
      `INSERT INTO usage_events (user_id, role, provider_id, model, key_source, tokens_in, tokens_out, at)
       VALUES ('user:alice', 'narrate', 'openai', 'old', 'own', 1, 1, now() - interval '40 days')`,
    );
    const today = new Date().toISOString().slice(0, 10);

    assert.deepEqual(await usageForUser(roles.play, 'user:alice', 30), [
      { day: today, model: 'gpt-a', keySource: 'own', calls: 2, tokensIn: 15, tokensOut: 3 },
      { day: today, model: 'srv', keySource: 'server', calls: 1, tokensIn: 3, tokensOut: 3 },
    ]);
    assert.deepEqual(await usageForUser(roles.play, 'user:carol', 30), [
      { day: today, model: 'gpt-a', keySource: 'own', calls: 1, tokensIn: 0, tokensOut: 0 },
    ]);
    assert.deepEqual((await usageByUser(roles.play, 30)).slice(0, 3), [
      { userId: 'user:bob', keySource: 'own', calls: 1, tokensIn: 100, tokensOut: 100 },
      { userId: 'user:alice', keySource: 'own', calls: 2, tokensIn: 15, tokensOut: 3 },
      { userId: 'user:alice', keySource: 'server', calls: 1, tokensIn: 3, tokensOut: 3 },
    ]);
  });
  if (!ran) t.skip('no Postgres configured');
});

test('one statement records a call and stamps the key it used', async (t) => {
  const ran = await withPg(async (db, _schema, roles) => {
    const keyId = '00000000-0000-4000-8000-000000000001';
    await db.query(
      `INSERT INTO user_provider_keys (id, user_id, endpoint_id, models, trust, nonce, ciphertext, key_hint)
       VALUES ($1, 'user:alice', 'openai', '{"narrate":"gpt-test"}', 'sealed', $2, $3, 'abcd')`,
      [keyId, Buffer.alloc(12, 1), Buffer.alloc(40, 2)],
    );
    let statements = 0;
    const counting = { query: (sql: string, params?: unknown[]) => (statements++, roles.play.query(sql, params)) } as typeof roles.play;
    await recordUsage(counting, {
      userId: 'user:alice',
      storyId: null,
      role: 'narrate',
      providerId: 'openai',
      model: 'gpt-test',
      keySource: 'own',
      tokensIn: 4,
      tokensOut: 2,
      keyId,
    });
    assert.equal(statements, 1);
    const row = await db.one<{ calls: string; last_used_at: Date | null }>(
      `SELECT (SELECT count(*) FROM usage_events WHERE user_id = 'user:alice') AS calls, last_used_at
         FROM user_provider_keys WHERE id = $1`,
      [keyId],
    );
    assert.equal(row?.calls, '1');
    assert.ok(row?.last_used_at);
  });
  if (!ran) t.skip('no Postgres configured');
});
