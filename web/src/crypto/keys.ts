const VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();

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
  storyId: string;
  version: number;
  wrap: EncryptedKeyEnvelope;
}

export interface EncryptionEnrollment {
  userKey: UserKeyRecord;
  storyKeys: StoryKeyRecord[];
  recoveryCode: string;
}

export interface UnlockedStoryKeys {
  masterKey: Uint8Array;
  storyKeys: Map<string, Uint8Array>;
}

export interface StoryKeyHandoff {
  storyId: string;
  key: string;
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('this browser does not support Web Crypto');
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  requireCrypto().getRandomValues(bytes);
  return bytes;
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
    throw new Error('invalid encrypted-key encoding');
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return fromBase64(base64);
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function aad(value: string): ArrayBuffer {
  return bufferSource(encoder.encode(value));
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey('raw', bufferSource(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function derivePassphraseKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  if (passphrase.length < 12) throw new Error('choose a passphrase of at least 12 characters');
  const material = await requireCrypto().subtle.importKey('raw', aad(passphrase), 'PBKDF2', false, ['deriveKey']);
  return requireCrypto().subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferSource(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function deriveRecoveryKey(recoveryCode: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await requireCrypto().subtle.importKey('raw', bufferSource(fromBase64Url(recoveryCode)), 'HKDF', false, ['deriveKey']);
  return requireCrypto().subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bufferSource(salt), info: aad('fabulist:recovery-key:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(key: CryptoKey, plaintext: Uint8Array, associatedData: string): Promise<EncryptedKeyEnvelope> {
  const nonce = randomBytes(12);
  const ciphertext = await requireCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: aad(associatedData), tagLength: 128 },
    key,
    bufferSource(plaintext),
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function decrypt(key: CryptoKey, envelope: EncryptedKeyEnvelope, associatedData: string): Promise<Uint8Array> {
  try {
    const plaintext = await requireCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: bufferSource(fromBase64(envelope.nonce)), additionalData: aad(associatedData), tagLength: 128 },
      key,
      bufferSource(fromBase64(envelope.ciphertext)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('incorrect passphrase or recovery code');
  }
}

function masterAad(userId: string, wrap: 'passphrase' | 'recovery'): string {
  return `fabulist:user:${userId}:master:${wrap}:v${VERSION}`;
}

function storyAad(userId: string, storyId: string): string {
  return `fabulist:user:${userId}:story:${storyId}:dek:v${VERSION}`;
}

export async function createEncryptionEnrollment(userId: string, passphrase: string, storyIds: string[]): Promise<EncryptionEnrollment> {
  if (!storyIds.length) throw new Error('create a story before enabling private storage');
  if (new Set(storyIds).size !== storyIds.length) throw new Error('duplicate story identifier');

  const masterKey = randomBytes(32);
  const passphraseSalt = randomBytes(16);
  const recoverySalt = randomBytes(16);
  const recoveryCode = toBase64Url(randomBytes(32));
  const passphraseKey = await derivePassphraseKey(passphrase, passphraseSalt);
  const recoveryKey = await deriveRecoveryKey(recoveryCode, recoverySalt);
  const storyKeys = await Promise.all(storyIds.map(async (storyId) => {
    const dataKey = randomBytes(32);
    return {
      storyId,
      version: VERSION,
      wrap: await encrypt(await importAesKey(masterKey), dataKey, storyAad(userId, storyId)),
    };
  }));

  return {
    userKey: {
      version: VERSION,
      passphraseKdf: 'pbkdf2-sha256',
      passphraseKdfParams: { iterations: PBKDF2_ITERATIONS },
      passphraseSalt: toBase64(passphraseSalt),
      passphraseWrap: await encrypt(passphraseKey, masterKey, masterAad(userId, 'passphrase')),
      recoverySalt: toBase64(recoverySalt),
      recoveryWrap: await encrypt(recoveryKey, masterKey, masterAad(userId, 'recovery')),
      recoveryCodeHint: recoveryCode.slice(0, 8),
    },
    storyKeys,
    recoveryCode,
  };
}

async function unlock(
  userId: string,
  userKey: UserKeyRecord,
  storyKeys: StoryKeyRecord[],
  wrappingKey: CryptoKey,
  wrap: 'passphrase' | 'recovery',
): Promise<UnlockedStoryKeys> {
  if (
    userKey.version !== VERSION ||
    userKey.passphraseKdf !== 'pbkdf2-sha256' ||
    userKey.passphraseKdfParams.iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error('unsupported private-storage key version');
  }
  const masterKey = await decrypt(
    wrappingKey,
    wrap === 'passphrase' ? userKey.passphraseWrap : userKey.recoveryWrap,
    masterAad(userId, wrap),
  );
  const masterCryptoKey = await importAesKey(masterKey);
  const unlocked = await Promise.all(storyKeys.map(async (storyKey) => {
    if (storyKey.version !== VERSION) throw new Error('unsupported private-storage story key version');
    return [storyKey.storyId, await decrypt(masterCryptoKey, storyKey.wrap, storyAad(userId, storyKey.storyId))] as const;
  }));
  return { masterKey, storyKeys: new Map(unlocked) };
}

export async function unlockWithPassphrase(
  userId: string,
  userKey: UserKeyRecord,
  storyKeys: StoryKeyRecord[],
  passphrase: string,
): Promise<UnlockedStoryKeys> {
  const key = await derivePassphraseKey(passphrase, fromBase64(userKey.passphraseSalt), userKey.passphraseKdfParams.iterations);
  return unlock(userId, userKey, storyKeys, key, 'passphrase');
}

export async function unlockWithRecoveryCode(
  userId: string,
  userKey: UserKeyRecord,
  storyKeys: StoryKeyRecord[],
  recoveryCode: string,
): Promise<UnlockedStoryKeys> {
  const key = await deriveRecoveryKey(recoveryCode, fromBase64(userKey.recoverySalt));
  return unlock(userId, userKey, storyKeys, key, 'recovery');
}

/** Converts browser-unwrapped keys to a one-request TLS handoff, never storage. */
export function storyKeyHandoff(storyKeys: Map<string, Uint8Array>): StoryKeyHandoff[] {
  return [...storyKeys]
    .map(([storyId, key]) => ({ storyId, key: toBase64(key) }))
    .sort((a, b) => a.storyId.localeCompare(b.storyId));
}

/** Clear temporary browser byte arrays after handing them to the active server session. */
export function eraseUnlockedStoryKeys(unlocked: UnlockedStoryKeys): void {
  unlocked.masterKey.fill(0);
  for (const key of unlocked.storyKeys.values()) key.fill(0);
  unlocked.storyKeys.clear();
}
