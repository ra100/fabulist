import type { QueryResultRow } from 'pg';
import type { Queryable } from '../db/pg.ts';

export type ProviderTrust = 'unlock' | 'sealed';

export interface ProviderModels {
  narrate: string;
  mechanics?: string;
  extract?: string;
}

export interface ProviderKeyRow {
  id: string;
  userId: string;
  label: string;
  endpointId: string;
  models: ProviderModels;
  trust: ProviderTrust;
  nonce: Buffer;
  ciphertext: Buffer;
  keyHint: string;
  version: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type NewProviderKey = Omit<ProviderKeyRow, 'version' | 'createdAt' | 'lastUsedAt'>;
export type ProviderKeySummary = Omit<ProviderKeyRow, 'userId' | 'nonce' | 'ciphertext' | 'version'>;

interface Row extends QueryResultRow {
  id: string;
  user_id: string;
  label: string;
  endpoint_id: string;
  models: ProviderModels;
  trust: ProviderTrust;
  nonce: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  version: string;
  created_at: Date;
  last_used_at: Date | null;
}

function fromRow(r: Row): ProviderKeyRow {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    endpointId: r.endpoint_id,
    models: r.models,
    trust: r.trust,
    nonce: r.nonce,
    ciphertext: r.ciphertext,
    keyHint: r.key_hint,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}

// Every statement filters by user_id: this module is the owner-only boundary (the schema has no RLS).
export async function providerKeyFor(db: Queryable, userId: string): Promise<ProviderKeyRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint, version, created_at, last_used_at
       FROM user_provider_keys
      WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function saveProviderKey(db: Queryable, key: NewProviderKey): Promise<void> {
  await db.query(
    `INSERT INTO user_provider_keys (id, user_id, label, endpoint_id, models, trust, nonce, ciphertext, key_hint)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       id = EXCLUDED.id, label = EXCLUDED.label, endpoint_id = EXCLUDED.endpoint_id, models = EXCLUDED.models,
       trust = EXCLUDED.trust, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext,
       key_hint = EXCLUDED.key_hint, version = gen_random_uuid(), created_at = now(), last_used_at = NULL`,
    [key.id, key.userId, key.label, key.endpointId, JSON.stringify(key.models), key.trust, key.nonce, key.ciphertext, key.keyHint],
  );
}

export async function deleteProviderKey(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM user_provider_keys WHERE user_id = $1`, [userId]);
  return (rowCount ?? 0) > 0;
}

export async function touchProviderKey(db: Queryable, userId: string, keyId: string): Promise<void> {
  await db.query(`UPDATE user_provider_keys SET last_used_at = now() WHERE user_id = $1 AND id = $2`, [userId, keyId]);
}

export function summarizeProviderKey(row: ProviderKeyRow): ProviderKeySummary {
  const { userId: _userId, nonce: _nonce, ciphertext: _ciphertext, version: _version, ...summary } = row;
  return summary;
}
