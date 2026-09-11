import type { QueryResultRow } from 'pg';
import type { Db, Queryable } from '../db/pg.ts';
import type { StoryId } from '../domain/types.ts';

export const ENCRYPTION_KEY_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const MIN_CIPHERTEXT_BYTES = 32;

export interface EncryptedKeyEnvelope {
  nonce: string;
  ciphertext: string;
}

export interface UserKeyRecord {
  version: number;
  passphraseKdf: 'pbkdf2-sha256';
  passphraseKdfParams: { iterations: number };
  passphraseSalt: string;
  passphraseWrap: EncryptedKeyEnvelope;
  recoverySalt: string;
  recoveryWrap: EncryptedKeyEnvelope;
  recoveryCodeHint: string;
}

export interface StoryKeyRecord {
  storyId: StoryId;
  version: number;
  wrap: EncryptedKeyEnvelope;
}

export interface EncryptionKeyBundle {
  userKey: UserKeyRecord | null;
  storyKeys: StoryKeyRecord[];
}

interface UserKeyRow extends QueryResultRow {
  version: number;
  passphrase_kdf: 'pbkdf2-sha256';
  passphrase_kdf_params: unknown;
  passphrase_salt: Buffer;
  passphrase_nonce: Buffer;
  passphrase_ciphertext: Buffer;
  recovery_salt: Buffer;
  recovery_nonce: Buffer;
  recovery_ciphertext: Buffer;
  recovery_code_hint: string;
}

interface StoryKeyRow extends QueryResultRow {
  story_id: string;
  version: number;
  nonce: Buffer;
  ciphertext: Buffer;
}

function toBase64(value: Buffer): string {
  return value.toString('base64');
}

function fromBase64(value: string, expectedLength?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid encrypted key encoding');
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error('invalid encrypted key length');
  }
  return decoded;
}

function keyRecordFromRow(row: UserKeyRow): UserKeyRecord {
  const params = row.passphrase_kdf_params;
  if (
    !params ||
    typeof params !== 'object' ||
    !('iterations' in params) ||
    typeof params.iterations !== 'number' ||
    !Number.isSafeInteger(params.iterations)
  ) {
    throw new Error(`invalid passphrase KDF parameters for encryption key ${row.version}`);
  }
  return {
    version: row.version,
    passphraseKdf: row.passphrase_kdf,
    passphraseKdfParams: { iterations: params.iterations },
    passphraseSalt: toBase64(row.passphrase_salt),
    passphraseWrap: {
      nonce: toBase64(row.passphrase_nonce),
      ciphertext: toBase64(row.passphrase_ciphertext),
    },
    recoverySalt: toBase64(row.recovery_salt),
    recoveryWrap: {
      nonce: toBase64(row.recovery_nonce),
      ciphertext: toBase64(row.recovery_ciphertext),
    },
    recoveryCodeHint: row.recovery_code_hint,
  };
}

function storyKeyFromRow(row: StoryKeyRow): StoryKeyRecord {
  return {
    storyId: row.story_id,
    version: row.version,
    wrap: { nonce: toBase64(row.nonce), ciphertext: toBase64(row.ciphertext) },
  };
}

function assertUserKeyRecord(value: UserKeyRecord): void {
  if (
    value.version !== ENCRYPTION_KEY_VERSION ||
    value.passphraseKdf !== 'pbkdf2-sha256' ||
    value.passphraseKdfParams.iterations !== PBKDF2_ITERATIONS ||
    !/^[A-Za-z0-9_-]{4,32}$/.test(value.recoveryCodeHint)
  ) {
    throw new Error('invalid encryption key configuration');
  }
  fromBase64(value.passphraseSalt, SALT_BYTES);
  fromBase64(value.recoverySalt, SALT_BYTES);
  fromBase64(value.passphraseWrap.nonce, NONCE_BYTES);
  fromBase64(value.recoveryWrap.nonce, NONCE_BYTES);
  fromBase64(value.passphraseWrap.ciphertext);
  fromBase64(value.recoveryWrap.ciphertext);
  if (
    fromBase64(value.passphraseWrap.ciphertext).length < MIN_CIPHERTEXT_BYTES ||
    fromBase64(value.recoveryWrap.ciphertext).length < MIN_CIPHERTEXT_BYTES
  ) {
    throw new Error('invalid encrypted key length');
  }
}

function assertStoryKeyRecord(value: StoryKeyRecord): void {
  if (!value.storyId || value.version !== ENCRYPTION_KEY_VERSION) {
    throw new Error('invalid story encryption key');
  }
  fromBase64(value.wrap.nonce, NONCE_BYTES);
  if (fromBase64(value.wrap.ciphertext).length < MIN_CIPHERTEXT_BYTES) {
    throw new Error('invalid encrypted key length');
  }
}

export async function encryptionKeysForUser(db: Queryable, userId: string): Promise<EncryptionKeyBundle> {
  const [userResult, storyResult] = await Promise.all([
    db.query<UserKeyRow>(
      `SELECT version, passphrase_kdf, passphrase_kdf_params, passphrase_salt,
              passphrase_nonce, passphrase_ciphertext, recovery_salt, recovery_nonce,
              recovery_ciphertext, recovery_code_hint
         FROM user_encryption_keys
        WHERE user_id = $1`,
      [userId],
    ),
    db.query<StoryKeyRow>(
      `SELECT story_id, version, nonce, ciphertext
         FROM story_encryption_keys
        WHERE owner_user_id = $1
        ORDER BY story_id`,
      [userId],
    ),
  ]);
  return {
    userKey: userResult.rows[0] ? keyRecordFromRow(userResult.rows[0]) : null,
    storyKeys: storyResult.rows.map(storyKeyFromRow),
  };
}

/**
 * Saves browser-generated key wraps. The app verifies ownership but neither
 * receives nor derives a passphrase, recovery code, master key, or story key.
 */
export async function enrollEncryptionKeys(
  db: Db,
  userId: string,
  userKey: UserKeyRecord,
  storyKeys: StoryKeyRecord[],
): Promise<void> {
  assertUserKeyRecord(userKey);
  if (!storyKeys.length) throw new Error('at least one story key is required');
  for (const storyKey of storyKeys) assertStoryKeyRecord(storyKey);

  const storyIds = [...new Set(storyKeys.map((key) => key.storyId))];
  if (storyIds.length !== storyKeys.length) throw new Error('duplicate story encryption key');
  const owned = await db.query<{ id: string }>(
    `SELECT id FROM stories WHERE owner_user_id = $1 AND id = ANY($2::text[])`,
    [userId, storyIds],
  );
  if (owned.rows.length !== storyIds.length) throw new Error('can only enroll encryption keys for your own stories');

  await db.tx(async (tx) => {
    const existing = await tx.query<{ user_id: string }>(`SELECT user_id FROM user_encryption_keys WHERE user_id = $1`, [
      userId,
    ]);
    if (existing.rows[0]) throw new Error('encryption is already configured; use key rotation instead');

    await tx.query(
      `INSERT INTO user_encryption_keys
         (user_id, version, passphrase_kdf, passphrase_kdf_params, passphrase_salt,
          passphrase_nonce, passphrase_ciphertext, recovery_salt, recovery_nonce,
          recovery_ciphertext, recovery_code_hint)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
      [
        userId,
        userKey.version,
        userKey.passphraseKdf,
        JSON.stringify(userKey.passphraseKdfParams),
        fromBase64(userKey.passphraseSalt, SALT_BYTES),
        fromBase64(userKey.passphraseWrap.nonce, NONCE_BYTES),
        fromBase64(userKey.passphraseWrap.ciphertext),
        fromBase64(userKey.recoverySalt, SALT_BYTES),
        fromBase64(userKey.recoveryWrap.nonce, NONCE_BYTES),
        fromBase64(userKey.recoveryWrap.ciphertext),
        userKey.recoveryCodeHint,
      ],
    );

    for (const storyKey of storyKeys) {
      await tx.query(
        `INSERT INTO story_encryption_keys (story_id, owner_user_id, version, nonce, ciphertext)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          storyKey.storyId,
          userId,
          storyKey.version,
          fromBase64(storyKey.wrap.nonce, NONCE_BYTES),
          fromBase64(storyKey.wrap.ciphertext),
        ],
      );
    }
  });
}
