import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { STORY_ENVELOPE_VERSION, storyValueAad, type StoryValueContext } from './story-envelope-format.ts';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface StoryValueEnvelope {
  version: number;
  nonce: Buffer;
  ciphertext: Buffer;
}

/**
 * Deterministic, per-story lookup token. The caller must supply an already
 * normalized value; plaintext is never stored with or recoverable from it.
 */
export function storyBlindIndex(key: Buffer, domain: string, value: string): string {
  assertKey(key);
  if (!domain || !value) throw new Error('incomplete private-story blind-index input');
  return createHmac('sha256', key)
    .update(`fabulist:story-blind-index:v1:${domain}\u0000${value}`, 'utf8')
    .digest('base64url');
}

const BINARY_MAGIC = Buffer.from('FSEB', 'ascii');

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('invalid private-story key');
}

export function encryptStoryValue(key: Buffer, context: StoryValueContext, value: unknown): StoryValueEnvelope {
  assertKey(key);
  const plaintext = JSON.stringify(value);
  if (plaintext === undefined) throw new Error('cannot encrypt an undefined story value');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(storyValueAad(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { version: STORY_ENVELOPE_VERSION, nonce, ciphertext };
}

export function decryptStoryValue(key: Buffer, context: StoryValueContext, envelope: StoryValueEnvelope): unknown {
  assertKey(key);
  if (
    envelope.version !== STORY_ENVELOPE_VERSION ||
    envelope.nonce.length !== NONCE_BYTES ||
    envelope.ciphertext.length <= TAG_BYTES
  ) {
    throw new Error('invalid encrypted story value');
  }
  try {
    const ciphertext = envelope.ciphertext.subarray(0, -TAG_BYTES);
    const tag = envelope.ciphertext.subarray(-TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(storyValueAad(context), 'utf8'));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('private story value cannot be decrypted');
  }
}

/**
 * AES-GCM envelope for a private file. It deliberately reuses story-value AAD
 * so a file cannot be moved to another story, record, or field and still
 * decrypt. The compact on-disk framing is magic, version, nonce, ciphertext.
 */
export function encryptStoryBytes(key: Buffer, context: StoryValueContext, value: Uint8Array): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(storyValueAad(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([BINARY_MAGIC, Buffer.from([STORY_ENVELOPE_VERSION]), nonce, ciphertext]);
}

export function decryptStoryBytes(key: Buffer, context: StoryValueContext, envelope: Uint8Array): Buffer {
  assertKey(key);
  const bytes = Buffer.from(envelope);
  const header = BINARY_MAGIC.length + 1 + NONCE_BYTES;
  if (
    bytes.length <= header + TAG_BYTES ||
    !bytes.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC) ||
    bytes[BINARY_MAGIC.length] !== STORY_ENVELOPE_VERSION
  ) {
    throw new Error('invalid encrypted story bytes');
  }
  try {
    const nonce = bytes.subarray(BINARY_MAGIC.length + 1, header);
    const ciphertext = bytes.subarray(header, -TAG_BYTES);
    const tag = bytes.subarray(-TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(storyValueAad(context), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('private story bytes cannot be decrypted');
  }
}
