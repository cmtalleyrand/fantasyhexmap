/**
 * Optional at-rest encryption for the API key in browser mode.
 *
 * What this defends against: someone with access to the same browser profile -
 * a shared or borrowed machine, a synced profile, a backup - reading the key out
 * of local storage. With a passphrase set, what is stored is AES-GCM ciphertext
 * under a PBKDF2-derived key, and the passphrase is never stored at all.
 *
 * What it does not defend against, stated plainly because encryption invites
 * over-confidence: script running on this origin while the key is unlocked can
 * read it from memory, since the page must be able to use it. The defence there
 * is the Content-Security-Policy and loading no third-party code, not this.
 */

const ITERATIONS = 310_000;

export interface EncryptedKey {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function encryptKey(apiKey: string, passphrase: string): Promise<EncryptedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    enc.encode(apiKey),
  );
  return { v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

/** Throws on a wrong passphrase - AES-GCM authenticates, so this is reliable. */
export async function decryptKey(payload: EncryptedKey, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, fromB64(payload.salt));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(payload.iv) as BufferSource },
      key,
      fromB64(payload.data) as BufferSource,
    );
    return dec.decode(plain);
  } catch {
    throw new Error('That passphrase does not unlock the stored key.');
  }
}
