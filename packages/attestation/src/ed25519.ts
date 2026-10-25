// Small Ed25519 helpers over node:crypto. Used for the mock attestation chain
// and for the issuer's claim-signing key. No hand-rolled crypto.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'node:crypto';

export interface Ed25519KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI DER bytes of the public key. */
  publicKeyBytes: Uint8Array;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function generateEd25519(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, publicKeyBytes: spki(publicKey) };
}

/** Deterministic key from a 32-byte seed. Only for mock keys that several processes must share. */
export function ed25519FromSeed(seed: Uint8Array): Ed25519KeyPair {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyBytes: spki(publicKey) };
}

export function ed25519Sign(privateKey: KeyObject, data: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, data, privateKey));
}

export function ed25519Verify(publicKeyBytes: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: 'der', type: 'spki' });
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

function spki(k: KeyObject): Uint8Array {
  return new Uint8Array(k.export({ format: 'der', type: 'spki' }));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function sha384(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha384').update(data).digest());
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
