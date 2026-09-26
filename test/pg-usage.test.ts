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
