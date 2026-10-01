import type { QueryResultRow } from 'pg';
import type { Queryable } from '../db/pg.ts';

export type ProviderTrust = 'unlock' | 'sealed';

export const PROVIDER_MODEL_ROLES = [
  'narrate',
  'classify',
  'integrity',
  'referee',
  'jev-fastpath',
  'director',
  'humanize',
  'summarize',
  'setup',
  'extract',
  'passb',
  'image',
] as const;
export type ProviderModelRole = (typeof PROVIDER_MODEL_ROLES)[number];

export interface ProviderModelAssignment {
  role: ProviderModelRole;
  providerKeyId: string;
  model: string;
}

export interface ProviderKeyRow {
  id: string;
  userId: string;
  label: string;
  endpointId: string;
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
  trust: ProviderTrust;
  nonce: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  version: string;
  created_at: Date;
  last_used_at: Date | null;
}

interface AssignmentRow extends QueryResultRow {
  role: ProviderModelRole;
  provider_key_id: string;
  model_id: string;
}

function fromRow(r: Row): ProviderKeyRow {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    endpointId: r.endpoint_id,
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
export async function providerKeysFor(db: Queryable, userId: string): Promise<ProviderKeyRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, user_id, label, endpoint_id, trust, nonce, ciphertext, key_hint, version, created_at, last_used_at
       FROM user_provider_keys
      WHERE user_id = $1
      ORDER BY created_at, id`,
    [userId],
  );
  return rows.map(fromRow);
}

export async function providerKeyFor(db: Queryable, userId: string, keyId: string): Promise<ProviderKeyRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT id, user_id, label, endpoint_id, trust, nonce, ciphertext, key_hint, version, created_at, last_used_at
       FROM user_provider_keys
      WHERE user_id = $1 AND id = $2`,
    [userId, keyId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function saveProviderKey(db: Queryable, key: NewProviderKey): Promise<void> {
  await db.query(
    `INSERT INTO user_provider_keys (id, user_id, label, endpoint_id, trust, nonce, ciphertext, key_hint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [key.id, key.userId, key.label, key.endpointId, key.trust, key.nonce, key.ciphertext, key.keyHint],
  );
}

export async function deleteProviderKey(db: Queryable, userId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM user_provider_keys WHERE user_id = $1 AND id = $2`, [userId, keyId]);
  return (rowCount ?? 0) > 0;
}

export async function providerModelAssignmentsFor(db: Queryable, userId: string): Promise<ProviderModelAssignment[]> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT role, provider_key_id, model_id
       FROM user_provider_model_assignments
      WHERE user_id = $1
      ORDER BY role`,
    [userId],
  );
  return rows.map((row) => ({ role: row.role, providerKeyId: row.provider_key_id, model: row.model_id }));
}

export async function saveProviderModelAssignments(
  db: Queryable,
  userId: string,
  assignments: ProviderModelAssignment[],
): Promise<void> {
  const json = JSON.stringify(
    assignments.map(({ role, providerKeyId, model }) => ({ role, provider_key_id: providerKeyId, model_id: model })),
  );
  await db.query(
    `WITH desired AS (
       SELECT role, provider_key_id, model_id
         FROM jsonb_to_recordset($2::jsonb) AS d(role text, provider_key_id text, model_id text)
     ), upserted AS (
       INSERT INTO user_provider_model_assignments (user_id, role, provider_key_id, model_id)
       SELECT $1, role, provider_key_id, model_id FROM desired
       ON CONFLICT (user_id, role) DO UPDATE SET
         provider_key_id = EXCLUDED.provider_key_id, model_id = EXCLUDED.model_id, updated_at = now()
       RETURNING role
     )
     DELETE FROM user_provider_model_assignments existing
      WHERE existing.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM desired WHERE desired.role = existing.role)
        AND (SELECT count(*) FROM upserted) >= 0`,
    [userId, json],
  );
}

export function summarizeProviderKey(row: ProviderKeyRow): ProviderKeySummary {
  const { userId: _userId, nonce: _nonce, ciphertext: _ciphertext, version: _version, ...summary } = row;
  return summary;
}
