// Key helpers. Every key is generated in memory at boot and never written to disk.
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface SigningKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** SubjectPublicKeyInfo, DER. This is what goes into the attestation. */
  spkiDer: Buffer;
}

/** Generate a signing key pair in memory. Ed25519 by default. */
export function generateSigningKeyPair(alg: 'ed25519' | 'p256' = 'ed25519'): SigningKeyPair {
  const { publicKey, privateKey } =
    alg === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey, privateKey, spkiDer: toSpkiDer(publicKey) };
}

/** Accepts a KeyObject, a PEM string or SPKI DER bytes. Returns SPKI DER. */
export function toSpkiDer(key: KeyObject | string | Uint8Array): Buffer {
  if (typeof key === 'string') return createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (key instanceof Uint8Array) return Buffer.from(key);
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return pub.export({ type: 'spki', format: 'der' });
}

/**
 * The user_data hash ("wraps-keys-sha256-v1").
 *
 * Input: a map of key name -> standard base64 of the SPKI DER.
 * Output: SHA-256 over JSON.stringify of the [name, value] pairs, sorted by name.
 * This matches keysHash() in packages/attestation/src/measure.ts.
 */
export const USER_DATA_ALG = 'wraps-keys-sha256-v1';

export function keysHash(publicKeysB64: Record<string, string>): Buffer {
  const canonical = JSON.stringify(
    Object.keys(publicKeysB64)
      .sort()
      .map((k) => [k, publicKeysB64[k]]),
  );
  return createHash('sha256').update(canonical).digest();
}
