// Top-up rails: how an agent pays the issuer for a batch of tokens.
// Server side (TopUpRail) lives in the issuer. Client side (TopUpWallet) lives in the SDK.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { b64u, ed25519Sign, ed25519Verify, fromB64u, generateEd25519, hex, sha256 } from '@wraps/attestation';
import { PaymentRequirement, tokensToRlusd } from './protocol';

export interface RedeemResult {
  /** Tokens' worth of funds that reached the issuer. */
  amountTokens: number;
  /** On-chain reference, e.g. the VoucherRedeemed tx hash. */
  txRef: string;
}

export interface VoucherRedeemedEvent {
  txHash: string;
  payer: string;
  payee: string;
  amountRlusd: string;
  quoteId: string;
  at: number;
}

/** Issuer side of a top-up rail. */
export interface TopUpRail extends EventEmitter {
  readonly scheme: string;
  readonly network: string;
  readonly payTo: string;
  /** Checks and redeems the payment carried in the retried request. Throws if invalid. */
  redeem(paymentHeader: string, requirement: PaymentRequirement): Promise<RedeemResult>;
}

/** Agent side of a top-up rail. Signs the payment for a 402 requirement. */
export interface TopUpWallet {
  readonly scheme: string;
  readonly address: string;
  pay(requirement: PaymentRequirement): Promise<string>;
}

// ---------------------------------------------------------------------------
// MOCK rail. Simulates an AP4M voucher: the agent signs, the issuer redeems,
// a fake VoucherRedeemed event fires. No chain, no real money.
// ---------------------------------------------------------------------------

export const MOCK_SCHEME = 'mock-ap4m-voucher';

interface MockVoucher {
  v: 1;
  quoteId: string;
  payer: string;
  payerPublicKey: string;
  payee: string;
  amountTokens: number;
  nonce: string;
  signature?: string;
}

function voucherBytes(v: MockVoucher): Uint8Array {
  const { signature: _s, ...rest } = v;
  return new TextEncoder().encode(`wraps-mock-voucher-v1\0${JSON.stringify(rest)}`);
}

const addressOf = (publicKey: Uint8Array) => `mock:${hex(sha256(publicKey)).slice(0, 40)}`;

export class MockTopUpRail extends EventEmitter implements TopUpRail {
  readonly scheme = MOCK_SCHEME;
  readonly network = 'mock-xrpl-evm-testnet';
  private readonly redeemed = new Set<string>();

  constructor(readonly payTo = 'mock:issuer-payout-address') {
    super();
  }

  async redeem(paymentHeader: string, req: PaymentRequirement): Promise<RedeemResult> {
    let v: MockVoucher;
    try {
      v = JSON.parse(Buffer.from(paymentHeader, 'base64url').toString('utf8'));
    } catch {
      throw new Error('voucher is not valid JSON');
    }
    const pub = fromB64u(v.payerPublicKey ?? '');
    if (v.quoteId !== req.quoteId) throw new Error('voucher is for a different quote');
    if (v.payee !== this.payTo) throw new Error('voucher pays a different address');
    if (!(v.amountTokens >= req.tokens)) throw new Error('voucher amount is below the price');
    if (v.payer !== addressOf(pub)) throw new Error('payer does not match its key');
    if (!v.signature || !ed25519Verify(pub, voucherBytes(v), fromB64u(v.signature))) throw new Error('bad voucher signature');
    const id = `${v.payer}:${v.nonce}`;
    if (this.redeemed.has(id)) throw new Error('voucher already redeemed');
    this.redeemed.add(id);

    const event: VoucherRedeemedEvent = {
      txHash: `0x${randomBytes(32).toString('hex')}`,
      payer: v.payer,
      payee: v.payee,
      amountRlusd: tokensToRlusd(v.amountTokens),
      quoteId: v.quoteId,
      at: Date.now(),
    };
    this.emit('VoucherRedeemed', event);
    return { amountTokens: v.amountTokens, txRef: event.txHash };
  }
}

export class MockTopUpWallet implements TopUpWallet {
  readonly scheme = MOCK_SCHEME;
  private readonly key = generateEd25519();
  readonly address = addressOf(this.key.publicKeyBytes);

  async pay(req: PaymentRequirement): Promise<string> {
    if (req.scheme !== this.scheme) throw new Error(`wallet cannot pay scheme ${req.scheme}`);
    const v: MockVoucher = {
      v: 1,
      quoteId: req.quoteId,
      payer: this.address,
      payerPublicKey: b64u(this.key.publicKeyBytes),
      payee: req.payTo,
      amountTokens: req.tokens,
      nonce: randomBytes(16).toString('hex'),
    };
    v.signature = b64u(ed25519Sign(this.key.privateKey, voucherBytes(v)));
    return Buffer.from(JSON.stringify(v)).toString('base64url');
  }
}

// ---------------------------------------------------------------------------
// AP4M rail: STUB. Owned by lane 3 (PAY-03).
// ---------------------------------------------------------------------------

/**
 * TODO(PAY-03): real AP4M rail, SPEC §4 step 3:
 *   Issuer → Agent: 402 Payment Required, AP4M x402, N RLUSD
 *   Agent: signs an AP4M voucher, submits it (no human)
 *   Issuer: redeems → VoucherRedeemed on-chain (PaymentLedger contract)
 *   AP4M: RLUSD → issuer's merchant payout address
 * Use the vendored AP4M starter files (vendor/ap4m/, INF-18) and the AP4M API
 * reference. Do not guess field names: check `VoucherRedeemed` fields at the booth (SPEC §19).
 * redeem() must resolve only after the redemption is confirmed, and must emit
 * 'VoucherRedeemed' with the real tx hash.
 */
export class Ap4mRail extends EventEmitter implements TopUpRail {
  readonly scheme = 'ap4m-x402';
  readonly network = 'xrpl-evm-testnet';
  constructor(readonly payTo: string) {
    super();
  }
  async redeem(_paymentHeader: string, _req: PaymentRequirement): Promise<RedeemResult> {
    throw new Error('Ap4mRail is not implemented yet (PAY-03). Use MockTopUpRail.');
  }
}

/** TODO(PAY-03 / SDK-03): agent side of AP4M. Signs the voucher with the agent's own AP4M wallet. */
export class Ap4mWallet implements TopUpWallet {
  readonly scheme = 'ap4m-x402';
  constructor(readonly address: string) {}
  async pay(_req: PaymentRequirement): Promise<string> {
    throw new Error('Ap4mWallet is not implemented yet (PAY-03). Use MockTopUpWallet.');
  }
}
