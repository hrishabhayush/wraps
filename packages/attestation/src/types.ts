import { sha256 } from './ed25519';

/** PCR index → hex value (mock and Nitro formats). Nitro uses SHA-384, so each value is 96 hex chars. */
export type Pcrs = Record<string, string>;

/** What a verifier returns after every check passes. */
export interface VerifiedAttestation {
  format: string;
  moduleId: string;
  timestamp: number;
  /** PCRs (mock / Nitro). Empty for Confidential Space, which measures the container image instead. */
  pcrs: Pcrs;
  /**
   * The code measurement the verifier matched against the published build:
   * PCR0 for mock / Nitro, the container image digest ("sha256:...") for Confidential Space.
   */
  measurement: string;
  /** Hex SHA-256 of the enclave's public keys (see hashPublicKeys). */
  publicKeysHash: string;
  nonce: string;
}

/** Enclave side: makes a receipt over the client nonce and the hash of its public keys. */
export interface AttestationProvider {
  readonly format: string;
  /** Returns an opaque, transportable attestation (base64url). */
  attest(nonce: Uint8Array, publicKeysHash: Uint8Array): Promise<string>;
}

export interface AttestationExpectations {
  /** The fresh nonce the client sent. */
  nonce: Uint8Array;
  /** hashPublicKeys() of the keys the server claims to hold. */
  publicKeysHash: Uint8Array;
}

/** Client side: runs every check. Throws AttestationError on any failure. */
export interface AttestationVerifier {
  readonly format: string;
  verify(attestation: string, expect: AttestationExpectations): Promise<VerifiedAttestation>;
}

export type AttestationErrorCode =
  | 'MALFORMED'
  | 'BAD_CHAIN'
  | 'BAD_SIGNATURE'
  | 'DEBUG_MODE'
  | 'PCR_MISMATCH'
  | 'IMAGE_MISMATCH'
  | 'BAD_PLATFORM'
  | 'BAD_ISSUER'
  | 'BAD_AUDIENCE'
  | 'KEY_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'NONCE_REUSED'
  | 'STALE'
  | 'NOT_IMPLEMENTED';

export class AttestationError extends Error {
  constructor(readonly code: AttestationErrorCode, message: string) {
    super(`attestation refused (${code}): ${message}`);
    this.name = 'AttestationError';
  }
}

/**
 * Canonical hash of named public keys. The enclave puts this in user_data.
 * Format: "wraps-keys-v1" then, sorted by name, u16 name length, name, u32 key length, key.
 */
export function hashPublicKeys(keys: Record<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = [Buffer.from('wraps-keys-v1')];
  for (const name of Object.keys(keys).sort()) {
    const n = Buffer.from(name);
    const k = Buffer.from(keys[name]);
    const nl = Buffer.alloc(2);
    nl.writeUInt16BE(n.length);
    const kl = Buffer.alloc(4);
    kl.writeUInt32BE(k.length);
    parts.push(nl, n, kl, k);
  }
  return sha256(Buffer.concat(parts));
}

export function isAllZero(hexValue: string): boolean {
  return /^0*$/.test(hexValue);
}
