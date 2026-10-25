// Wire types shared by issuer, merchant and SDK.
import { b64u, ed25519Sign, ed25519Verify, fromB64u } from '@wraps/attestation';
import type { KeyObject } from 'node:crypto';

/** 1 token = 0.10 RLUSD (SPEC §4: 100 tokens for 10 RLUSD). */
export const RLUSD_PER_TOKEN = 0.1;
export const tokensToRlusd = (tokens: number): string => (tokens * RLUSD_PER_TOKEN).toFixed(2);

/** x402-style header that carries a top-up payment on the retried /issue call. */
export const PAYMENT_HEADER = 'x-payment';

/** One way to pay, as listed in a 402 body (x402 "accepts" entry). */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: 'RLUSD';
  amountRlusd: string;
  tokens: number;
  payTo: string;
  quoteId: string;
  expiresAt: number;
  description: string;
}

export interface PaymentRequiredBody {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirement[];
}

export interface AttestationResponse {
  format: string;
  attestation: string;
  issuerName: string;
  /** base64url public keys. Their hashPublicKeys() is in the attestation. "tls" is the SPKI of the TLS key, if served over https. */
  publicKeys: { token: string; claim: string; tls?: string };
}

/** Running total the issuer owes a merchant. Signed with the attested claim key. */
export interface Claim {
  v: 1;
  issuer: string;
  merchantId: string;
  totalTokens: number;
  totalRlusd: string;
  seq: number;
  at: number;
}

export interface SignedClaim {
  claim: Claim;
  signature: string;
}

export interface ReservesStatement {
  v: 1;
  issuer: string;
  fundsHeldTokens: number;
  unspentIssuedTokens: number;
  unpaidTabsTokens: number;
  outstandingTokens: number;
  solvent: boolean;
  at: number;
}

export interface SignedReserves {
  reserves: ReservesStatement;
  signature: string;
}

export interface VerifyResult {
  valid: boolean;
  results: { ok: boolean; reason?: string }[];
}

/** 402 a merchant sends for the blind token scheme. */
export interface BlindTokenRequiredBody {
  scheme: 'blindtoken';
  price: number;
  unit: 'token';
  service: string;
  issuer: string;
  issuerName: string;
}

const CLAIM_CONTEXT = 'wraps-claim-v1';
const RESERVES_CONTEXT = 'wraps-reserves-v1';

function framed(context: string, obj: unknown): Uint8Array {
  return new TextEncoder().encode(`${context}\0${JSON.stringify(obj)}`);
}

export function signClaim(key: KeyObject, claim: Claim): SignedClaim {
  return { claim, signature: b64u(ed25519Sign(key, framed(CLAIM_CONTEXT, claim))) };
}

export function verifyClaim(signed: SignedClaim, claimPublicKey: Uint8Array): boolean {
  return ed25519Verify(claimPublicKey, framed(CLAIM_CONTEXT, signed.claim), fromB64u(signed.signature));
}

export function signReserves(key: KeyObject, reserves: ReservesStatement): SignedReserves {
  return { reserves, signature: b64u(ed25519Sign(key, framed(RESERVES_CONTEXT, reserves))) };
}

export function verifyReserves(signed: SignedReserves, claimPublicKey: Uint8Array): boolean {
  return ed25519Verify(claimPublicKey, framed(RESERVES_CONTEXT, signed.reserves), fromB64u(signed.signature));
}
