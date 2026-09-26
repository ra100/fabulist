import type { Queryable } from '../db/pg.ts';

export type KeySource = 'own' | 'server';

export interface UsageEvent {
  userId: string;
  storyId: string | null;
  role: string;
  providerId: string;
  model: string;
  keySource: KeySource;
  tokensIn: number;
  tokensOut: number;
  /** The own key the call used; stamped in the same statement so metering costs one connection. */
  keyId?: string;
}

export interface UsageRow {
  day: string;
  model: string;
  keySource: KeySource;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface UserUsageRow {
  userId: string;
  keySource: KeySource;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export async function recordUsage(db: Queryable, e: UsageEvent): Promise<void> {
  await db.query(
    `WITH touched AS (
       UPDATE user_provider_keys SET last_used_at = now() WHERE user_id = $1 AND id = $9::text
     )
     INSERT INTO usage_events (user_id, story_id, role, provider_id, model, key_source, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.userId, e.storyId, e.role, e.providerId, e.model, e.keySource, tokens(e.tokensIn), tokens(e.tokensOut), e.keyId ?? null],
  );
}

export async function usageForUser(db: Queryable, userId: string, days: number): Promise<UsageRow[]> {
  const { rows } = await db.query<{
    day: string;
    model: string;
    key_source: KeySource;
    calls: string;
    tokens_in: string;
    tokens_out: string;
  }>(
    `SELECT to_char(date_trunc('day', at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, model, key_source,
            count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
       FROM usage_events
      WHERE user_id = $1 AND at >= now() - make_interval(days => $2::int)
      GROUP BY 1, 2, 3
      ORDER BY 1 DESC, 2, 3`,
    [userId, days],
  );
  return rows.map((r) => ({
    day: r.day,
    model: r.model,
    keySource: r.key_source,
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
  }));
}

export async function usageByUser(db: Queryable, days: number): Promise<UserUsageRow[]> {
  const { rows } = await db.query<{
    user_id: string;
    key_source: KeySource;
    calls: string;
    tokens_in: string;
    tokens_out: string;
  }>(
    `SELECT user_id, key_source, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out
       FROM usage_events
      WHERE at >= now() - make_interval(days => $1::int)
      GROUP BY 1, 2
      ORDER BY sum(tokens_in) + sum(tokens_out) DESC, 1, 2`,
    [days],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    keySource: r.key_source,
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
  }));
}
