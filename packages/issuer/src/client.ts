// Client-side helper used by the SDK and the merchant: fetch the issuer's
// attestation with a fresh nonce and verify it before trusting any key.
//
// Over https, the attestation must also cover the TLS key the server used on that very
// connection. After that, issuerTransport() pins every later request to that key.
import { randomBytes } from 'node:crypto';
import { AttestationError, AttestationVerifier, VerifiedAttestation, fromB64u, hashPublicKeys } from '@wraps/attestation';
import { AttestationResponse } from './protocol';
import { fetchRecordingPeer, pinnedTransport } from './tls';

export interface PeerResponse {
  response: Response;
  peerSpki: Uint8Array;
}

export interface Transport {
  (url: string, init?: RequestInit): Promise<Response>;
  /** HTTPS first contact must use the configured route and expose the TLS peer key. */
  fetchWithPeer?: (url: string, init?: RequestInit) => Promise<PeerResponse>;
  /** Must enforce this SPKI during TLS handshake, before sending the HTTP request. */
  fetchPinned?: (url: string, expectedSpki: Uint8Array, init?: RequestInit) => Promise<Response>;
}

export interface AttestedIssuer {
  url: string;
  issuerName: string;
  tokenKey: Uint8Array;
  claimKey: Uint8Array;
  /** SPKI of the issuer's TLS key, when it serves https. Every later request is pinned to it. */
  tlsKey?: Uint8Array;
  attestation: VerifiedAttestation;
}

export async function fetchAttestedIssuer(
  issuerUrl: string,
  verifier: AttestationVerifier,
  transport: Transport = fetch,
): Promise<AttestedIssuer> {
  const nonce = randomBytes(32);
  const url = `${issuerUrl}/attestation?nonce=${nonce.toString('hex')}`;
  const https = new URL(issuerUrl).protocol === 'https:';
  let res: Response;
  let peerSpki: Uint8Array | undefined;
  if (https) {
    const fetchWithPeer = transport === fetch ? fetchRecordingPeer : transport.fetchWithPeer;
    if (!fetchWithPeer) {
      throw new AttestationError('KEY_MISMATCH', 'custom HTTPS transport must expose the peer key with fetchWithPeer');
    }
    ({ response: res, peerSpki } = await fetchWithPeer(url));
  } else res = await transport(url);
  if (!res.ok) throw new AttestationError('MALFORMED', `issuer returned HTTP ${res.status}`);
  const body = (await res.json()) as AttestationResponse;
  if (body.format !== verifier.format) {
    throw new AttestationError('MALFORMED', `issuer sent format ${body.format}, verifier expects ${verifier.format}`);
  }
  if (!body.publicKeys?.token || !body.publicKeys?.claim) throw new AttestationError('MALFORMED', 'issuer sent no token or claim key');
  // Hash every key the issuer names. A key we do not hash is a key we cannot trust.
  const keys: Record<string, Uint8Array> = {};
  for (const [name, k] of Object.entries(body.publicKeys)) if (typeof k === 'string') keys[name] = fromB64u(k);

  let tlsKey: Uint8Array | undefined;
  if (https) {
    if (!keys.tls) throw new AttestationError('KEY_MISMATCH', 'issuer serves https but its attestation names no TLS key');
    if (!Buffer.from(keys.tls).equals(Buffer.from(peerSpki!))) {
      throw new AttestationError('KEY_MISMATCH', 'the TLS key on this connection is not the TLS key in the attestation');
    }
    tlsKey = keys.tls;
  }
  const attestation = await verifier.verify(body.attestation, { nonce, publicKeysHash: hashPublicKeys(keys) });
  return { url: issuerUrl, issuerName: body.issuerName, tokenKey: keys.token, claimKey: keys.claim, tlsKey, attestation };
}

/** Transport for calls to an attested issuer: pinned to its TLS key over https, `fallback` otherwise. */
export function issuerTransport(issuer: AttestedIssuer, fallback: Transport = fetch): Transport {
  if (new URL(issuer.url).protocol !== 'https:') return fallback;
  if (!issuer.tlsKey) throw new AttestationError('KEY_MISMATCH', 'https issuer without an attested TLS key');
  return pinnedTransport(issuer.url, issuer.tlsKey, fallback);
}
