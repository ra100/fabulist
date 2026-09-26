import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  nonce: Buffer;
  ciphertext: Buffer;
}

/** `null` when unset; throws when set but unusable so a typo cannot silently disable sealed keys. */
export function secretsKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.FABULIST_SECRETS_KEY?.trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('FABULIST_SECRETS_KEY must be base64');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`FABULIST_SECRETS_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

function aad(userId: string, keyId: string): Buffer {
  return Buffer.from(`fabulist:sealed:user:${userId}:provider:${keyId}:v1`, 'utf8');
}

function assertKey(secretsKey: Buffer): void {
  if (secretsKey.length !== KEY_BYTES) throw new Error('invalid secrets key');
}

export function sealProviderKey(secretsKey: Buffer, userId: string, keyId: string, apiKey: string): SealedSecret {
  assertKey(secretsKey);
  if (!userId || !keyId || !apiKey) throw new Error('incomplete provider key');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretsKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(userId, keyId));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce, ciphertext };
}

export function openProviderKey(secretsKey: Buffer, userId: string, keyId: string, sealed: SealedSecret): string {
  assertKey(secretsKey);
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= TAG_BYTES) {
    throw new Error('invalid sealed provider key');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretsKey, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId, keyId));
    decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error('sealed provider key cannot be decrypted');
  }
}
