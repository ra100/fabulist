import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { STORY_ENVELOPE_VERSION, storyValueAad, type StoryValueContext } from './story-envelope-format.ts';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface StoryValueEnvelope {
  version: number;
  nonce: Buffer;
  ciphertext: Buffer;
}

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
