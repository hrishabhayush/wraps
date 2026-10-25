// Client-side helper used by the SDK and the merchant: fetch the issuer's
// attestation with a fresh nonce and verify it before trusting any key.
import { randomBytes } from 'node:crypto';
import { AttestationError, AttestationVerifier, VerifiedAttestation, fromB64u, hashPublicKeys } from '@wraps/attestation';
import { AttestationResponse } from './protocol';

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export interface AttestedIssuer {
  url: string;
  issuerName: string;
  tokenKey: Uint8Array;
  claimKey: Uint8Array;
  attestation: VerifiedAttestation;
}

export async function fetchAttestedIssuer(
  issuerUrl: string,
  verifier: AttestationVerifier,
  transport: Transport = fetch,
): Promise<AttestedIssuer> {
  const nonce = randomBytes(32);
  const res = await transport(`${issuerUrl}/attestation?nonce=${nonce.toString('hex')}`);
  if (!res.ok) throw new AttestationError('MALFORMED', `issuer returned HTTP ${res.status}`);
  const body = (await res.json()) as AttestationResponse;
  if (body.format !== verifier.format) {
    throw new AttestationError('MALFORMED', `issuer sent format ${body.format}, verifier expects ${verifier.format}`);
  }
  const tokenKey = fromB64u(body.publicKeys.token);
  const claimKey = fromB64u(body.publicKeys.claim);
  const attestation = await verifier.verify(body.attestation, {
    nonce,
    publicKeysHash: hashPublicKeys({ token: tokenKey, claim: claimKey }),
  });
  return { url: issuerUrl, issuerName: body.issuerName, tokenKey, claimKey, attestation };
}
