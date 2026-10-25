// AWS Nitro attestation: STUBS. The infra lane (INF-12 to INF-14) owns the
// enclave side. Fill these in once a real enclave returns documents.
import { readFileSync } from 'node:fs';
import {
  AttestationError,
  AttestationExpectations,
  AttestationProvider,
  AttestationVerifier,
  Pcrs,
  VerifiedAttestation,
} from './types';

export const NITRO_FORMAT = 'aws-nitro-v1';

export interface NitroVerifierOptions {
  /** Expected PCRs, from infra/pcrs.json (see loadExpectedPcrs). */
  expectedPcrs: Pcrs;
  /** SHA-256 fingerprint of the AWS Nitro root certificate (G1). Check it by hand (SPEC §7). */
  awsRootCertSha256: string;
  maxAgeMs?: number;
}

/**
 * Real Nitro verifier. NOT IMPLEMENTED YET.
 *
 * TODO(SDK-01 / INF-12): implement, keeping the same checks and error codes as
 * MockAttestationVerifier, so the SDK does not change:
 *  1. Decode the base64url attestation as CBOR COSE_Sign1 (cbor-x). Payload is a CBOR map:
 *     module_id, digest ("SHA384"), timestamp, pcrs, certificate, cabundle, public_key, user_data, nonce.
 *  2. Build the chain cabundle[0] (root) .. cabundle[n] .. certificate with @peculiar/x509.
 *     Check root SHA-256 == awsRootCertSha256, every signature, and validity at `timestamp`.
 *  3. Verify the COSE_Sign1 signature (ES384, P-384) with the leaf certificate key.
 *  4. Reject all-zero PCR0/1/2 (debug mode)          -> 'DEBUG_MODE'.
 *  5. Compare PCRs with expectedPcrs                 -> 'PCR_MISMATCH'.
 *  6. user_data == expect.publicKeysHash             -> 'KEY_MISMATCH'.
 *  7. nonce == expect.nonce, and never seen before   -> 'NONCE_MISMATCH' / 'NONCE_REUSED'.
 *  8. timestamp within maxAgeMs                      -> 'STALE'.
 */
export class NitroAttestationVerifier implements AttestationVerifier {
  readonly format = NITRO_FORMAT;
  constructor(readonly opts: NitroVerifierOptions) {}

  async verify(_attestation: string, _expect: AttestationExpectations): Promise<VerifiedAttestation> {
    throw new AttestationError('NOT_IMPLEMENTED', 'NitroAttestationVerifier is a stub; use MockAttestationVerifier until INF-12 lands');
  }
}

/**
 * Enclave side. NOT IMPLEMENTED YET.
 *
 * TODO(INF-12): call the Nitro Security Module (/dev/nsm, e.g. via aws-nitro-enclaves-nsm-api)
 * with nonce = the client nonce and user_data = publicKeysHash. Return the raw
 * COSE_Sign1 bytes as base64url.
 */
export class NitroAttestationProvider implements AttestationProvider {
  readonly format = NITRO_FORMAT;
  async attest(_nonce: Uint8Array, _publicKeysHash: Uint8Array): Promise<string> {
    throw new AttestationError('NOT_IMPLEMENTED', 'NitroAttestationProvider is a stub (INF-12)');
  }
}

/**
 * Reads expected PCRs from infra/pcrs.json. The infra lane decides the final format;
 * this accepts either { "issuer": { "PCR0": "..", ... }, "relay": {...} } or a flat { "PCR0": ".." }.
 */
export function loadExpectedPcrs(path: string, role: 'issuer' | 'relay'): Pcrs {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const section = raw[role] ?? raw;
  const out: Pcrs = {};
  for (const [k, v] of Object.entries(section)) {
    const m = /^(?:PCR)?(\d+)$/i.exec(k);
    if (m && typeof v === 'string') out[m[1]] = v;
  }
  if (!out['0']) throw new Error(`${path} has no PCR0 for ${role}`);
  return out;
}
