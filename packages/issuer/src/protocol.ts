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
  /** Hex RFC 9578 token_key_id of the current token key (SHA-256 of its bytes). */
  tokenKeyId?: string;
  /** Unix ms after which tokens signed with the current key are refused (SR3). */
  tokenKeyNotAfter?: number;
  /** All accepted token keys with their validity windows, signed with the attested claim key. */
  tokenKeys?: SignedTokenKeys;
}

/** One issuer token-signing key epoch (SR3: tokens expire with their key). */
export interface TokenKeyEpoch {
  /** Hex token_key_id. */
  keyId: string;
  /** base64url SPKI bytes. */
  publicKey: string;
  notBefore: number;
  notAfter: number;
  /** The key new tokens are signed with. */
  current: boolean;
}

export interface TokenKeysStatement {
  v: 1;
  issuer: string;
  keys: TokenKeyEpoch[];
  at: number;
}

export interface SignedTokenKeys {
  statement: TokenKeysStatement;
  signature: string;
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

/**
 * One confirmed payout to a merchant, signed with the attested claim key. It links the merchant's
 * claims to an on-chain transfer: `paidTotalTokens` is everything paid so far, and `claimSeq` /
 * `claimTotalTokens` are the merchant's latest claim when the transfer confirmed.
 */
export interface PayoutRecord {
  v: 1;
  issuer: string;
  merchantId: string;
  amountTokens: number;
  amountRlusd: string;
  /** On-chain tx hash (XRPL EVM), or a mock reference. */
  txRef: string;
  /** Registered address the RLUSD went to, when the rail is on-chain. */
  payTo?: string;
  /** RLUSD contract and chain ID, when the rail is on-chain. */
  token?: string;
  chainId?: number;
  paidTotalTokens: number;
  claimSeq: number;
  claimTotalTokens: number;
  at: number;
}

export interface SignedPayoutRecord {
  payout: PayoutRecord;
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

/**
 * Header a paying client sends with its tokens: the quoteId from the merchant's 402.
 * It binds the payment to one resource and one price (SR1, M3).
 */
export const QUOTE_HEADER = 'x-blindtoken-quote';

/** 402 a merchant sends for the blind token scheme. */
export interface BlindTokenRequiredBody {
  scheme: 'blindtoken';
  price: number;
  unit: 'token';
  service: string;
  issuer: string;
  issuerName: string;
  /** Single-use quote for this resource and price. Send it back in the QUOTE_HEADER. */
  quoteId?: string;
  /** Path and query the quote is for. */
  resource?: string;
  /** Unix ms. A payment after this is refused as stale (SR5). */
  expiresAt?: number;
}

const CLAIM_CONTEXT = 'wraps-claim-v1';
const RESERVES_CONTEXT = 'wraps-reserves-v1';
const TOKEN_KEYS_CONTEXT = 'wraps-token-keys-v1';
const PAYOUT_CONTEXT = 'wraps-payout-v1';

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

export function signTokenKeys(key: KeyObject, statement: TokenKeysStatement): SignedTokenKeys {
  return { statement, signature: b64u(ed25519Sign(key, framed(TOKEN_KEYS_CONTEXT, statement))) };
}

export function verifyTokenKeys(signed: SignedTokenKeys, claimPublicKey: Uint8Array): boolean {
  return ed25519Verify(claimPublicKey, framed(TOKEN_KEYS_CONTEXT, signed.statement), fromB64u(signed.signature));
}

export function signPayoutRecord(key: KeyObject, payout: PayoutRecord): SignedPayoutRecord {
  return { payout, signature: b64u(ed25519Sign(key, framed(PAYOUT_CONTEXT, payout))) };
}

export function verifyPayoutRecord(signed: SignedPayoutRecord, claimPublicKey: Uint8Array): boolean {
  return ed25519Verify(claimPublicKey, framed(PAYOUT_CONTEXT, signed.payout), fromB64u(signed.signature));
}
