import { STORY_ENVELOPE_VERSION, storyValueAad, type StoryValueContext } from '../../../src/crypto/story-envelope-format.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BrowserStoryValueEnvelope {
  version: number;
  nonce: string;
  ciphertext: string;
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error('invalid encrypted story-value encoding');
  }
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('invalid private-story key');
  return globalThis.crypto.subtle.importKey('raw', bufferSource(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptStoryValueInBrowser(
  key: Uint8Array,
  context: StoryValueContext,
  value: unknown,
): Promise<BrowserStoryValueEnvelope> {
  const plaintext = JSON.stringify(value);
  if (plaintext === undefined) throw new Error('cannot encrypt an undefined story value');
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: encoder.encode(storyValueAad(context)), tagLength: 128 },
    await importKey(key),
    encoder.encode(plaintext),
  );
  return { version: STORY_ENVELOPE_VERSION, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptStoryValueInBrowser(
  key: Uint8Array,
  context: StoryValueContext,
  envelope: BrowserStoryValueEnvelope,
): Promise<unknown> {
  if (envelope.version !== STORY_ENVELOPE_VERSION) throw new Error('unsupported encrypted story-value version');
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(fromBase64(envelope.nonce)),
        additionalData: encoder.encode(storyValueAad(context)),
        tagLength: 128,
      },
      await importKey(key),
      bufferSource(fromBase64(envelope.ciphertext)),
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('private story value cannot be decrypted');
  }
}
