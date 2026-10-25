// Agent SDK: attestation first, then top-ups and blind token payments.
// Caps live here, in code, outside the model. There is no wallet fallback.
import type { AttestationVerifier } from '@wraps/attestation';
import { b64u, fromB64u } from '@wraps/attestation';
import {
  AttestedIssuer,
  BlindTokenRequiredBody,
  PAYMENT_HEADER,
  PaymentRequiredBody,
  QUOTE_HEADER,
  TopUpWallet,
  Transport,
  fetchAttestedIssuer,
  issuerTransport,
  tokensToRlusd,
} from '@wraps/issuer';
import { Token, TokenVerifier, blindTokens, encodeAuthorization, equalBytes, finalizeTokens } from '@wraps/tokens';

export interface Caps {
  /** Most tokens one call may cost. A 402 above this is refused. */
  perCallTokens: number;
  /** Most tokens spent on purchases per UTC day. */
  dailyTokens: number;
  /** Most tokens bought in one top-up. */
  maxTopUpTokens: number;
}

export class PaymentRefusedError extends Error {
  constructor(readonly code: 'PER_CALL_CAP' | 'DAILY_CAP' | 'TOP_UP_CAP' | 'UNSUPPORTED_SCHEME' | 'WRONG_ISSUER' | 'NOT_ATTESTED' | 'BAD_QUOTE', message: string) {
    super(`payment refused (${code}): ${message}`);
    this.name = 'PaymentRefusedError';
  }
}

export class InsufficientTokensError extends Error {
  constructor(readonly needed: number, readonly have: number) {
    super(`need ${needed} tokens, have ${have}`);
    this.name = 'InsufficientTokensError';
  }
}

export type SdkEvent =
  /** measurement: PCR0 (mock) or container image digest (Confidential Space). pcr0 is kept as an alias. */
  | { type: 'attested'; pcr0: string; measurement: string; format: string }
  | { type: 'topup-402'; tokens: number; amountRlusd: string; scheme: string }
  | { type: 'topup-done'; tokens: number; balance: number }
  | { type: 'paid'; url: string; price: number; balance: number; spentToday: number }
  | { type: 'refused'; reason: string };

export interface Quote {
  url: string;
  service: string;
  price: number;
}

export interface PrivatePayOptions {
  issuerUrl: string;
  verifier: AttestationVerifier;
  wallet: TopUpWallet;
  caps: Caps;
  /**
   * How HTTP leaves the agent. Defaults to fetch. SDK-02 plugs the relay tunnel in here,
   * so every call (attestation, top-up, purchases) goes through it.
   */
  transport?: Transport;
  now?: () => number;
  onEvent?: (e: SdkEvent) => void;
}

export class PrivatePayClient {
  private issuer?: AttestedIssuer;
  /** Calls to the issuer. Over https this is pinned to the attested TLS key. */
  private issuerCall?: Transport;
  private tokenVerifier?: TokenVerifier;
  private tokens: Token[] = [];
  private spent = { day: '', tokens: 0 };
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly emit: (e: SdkEvent) => void;

  constructor(private readonly opts: PrivatePayOptions) {
    this.transport = opts.transport ?? fetch;
    this.now = opts.now ?? Date.now;
    this.emit = opts.onEvent ?? (() => {});
  }

  get caps(): Caps {
    return this.opts.caps;
  }
  get balance(): number {
    return this.tokens.length;
  }
  get spentToday(): number {
    this.rollDay();
    return this.spent.tokens;
  }
  /** Tokens the daily cap still allows. */
  get budgetLeft(): number {
    return Math.max(0, this.opts.caps.dailyTokens - this.spentToday);
  }
  get attestedIssuer(): AttestedIssuer | undefined {
    return this.issuer;
  }

  /** Verifies the issuer's attestation. Nothing else works until this succeeds. Throws AttestationError. */
  async connect(): Promise<AttestedIssuer> {
    this.issuer = undefined;
    this.issuerCall = undefined;
    const issuer = await fetchAttestedIssuer(this.opts.issuerUrl, this.opts.verifier, this.transport);
    this.issuerCall = issuerTransport(issuer, this.transport);
    this.issuer = issuer;
    this.tokenVerifier = new TokenVerifier(issuer.tokenKey, issuer.issuerName);
    const m = issuer.attestation.measurement;
    this.emit({ type: 'attested', pcr0: m, measurement: m, format: issuer.attestation.format });
    return issuer;
  }

  private attested(): AttestedIssuer {
    if (!this.issuer) throw new PaymentRefusedError('NOT_ATTESTED', 'issuer attestation not verified; call connect()');
    return this.issuer;
  }

  /** Buys n tokens: POST /issue, read the 402, pay it with the wallet, unblind. */
  async topUp(n: number): Promise<number> {
    const issuer = this.attested();
    if (!Number.isInteger(n) || n <= 0) throw new PaymentRefusedError('BAD_QUOTE', 'top-up must be a positive whole number');
    if (n > this.opts.caps.maxTopUpTokens) {
      throw new PaymentRefusedError('TOP_UP_CAP', `top-up of ${n} is above the cap of ${this.opts.caps.maxTopUpTokens}`);
    }
    const pending = await blindTokens(issuer.tokenKey, n, issuer.issuerName);
    const requests = pending.map((p) => b64u(p.request));

    const first = await this.post('/issue', { requests });
    if (first.status !== 402) throw new Error(`expected 402 from /issue, got ${first.status}`);
    const req = (first.body as PaymentRequiredBody).accepts?.find((a) => a.scheme === this.opts.wallet.scheme);
    if (!req) throw new PaymentRefusedError('UNSUPPORTED_SCHEME', 'issuer offers no scheme this wallet can pay');
    if (req.tokens !== n || req.amountRlusd !== tokensToRlusd(n)) {
      throw new PaymentRefusedError('BAD_QUOTE', `issuer quoted ${req.amountRlusd} RLUSD for ${req.tokens} tokens, expected ${tokensToRlusd(n)} for ${n}`);
    }
    this.emit({ type: 'topup-402', tokens: n, amountRlusd: req.amountRlusd, scheme: req.scheme });

    const payment = await this.opts.wallet.pay(req);
    const paid = await this.post('/issue', { requests }, { [PAYMENT_HEADER]: payment });
    if (paid.status !== 200) throw new Error(`top-up failed: ${paid.body.error ?? paid.status}`);
    const fresh = await finalizeTokens(pending, (paid.body.responses as string[]).map(fromB64u));
    // Every token must verify under the attested key. This stops an issuer tagging users with a side key.
    for (const t of fresh) {
      if (!(await this.tokenVerifier!.verify(t))) throw new Error('issuer returned a token that does not verify under its attested key');
    }
    this.tokens.push(...fresh);
    this.emit({ type: 'topup-done', tokens: n, balance: this.balance });
    return this.balance;
  }

  /** Asks the price without paying. Returns null if the resource is free. */
  async quote(url: string): Promise<Quote | null> {
    this.attested();
    const res = await this.transport(url);
    if (res.status !== 402) return null;
    const body = (await res.json()) as BlindTokenRequiredBody;
    this.checkChallenge(res, body);
    return { url, service: body.service, price: body.price };
  }

  /**
   * Fetches a resource. Pays a "blindtoken" 402 if it is within the caps.
   * Any other 402 scheme is refused: the SDK never falls back to a wallet payment.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    this.attested();
    const first = await this.transport(url, init);
    if (first.status !== 402) return first;
    const body = (await first.json()) as BlindTokenRequiredBody;
    this.checkChallenge(first, body);
    const price = body.price;
    // SR1: a quote made for another resource must not be paid from this call.
    if (body.resource !== undefined) {
      const u = new URL(url);
      if (body.resource !== u.pathname + u.search) this.refuse('BAD_QUOTE', `402 quote is for ${body.resource}, not ${u.pathname + u.search}`);
    }

    if (price > this.opts.caps.perCallTokens) {
      return this.refuse('PER_CALL_CAP', `price ${price} is above the per-call cap of ${this.opts.caps.perCallTokens}`);
    }
    if (this.spentToday + price > this.opts.caps.dailyTokens) {
      return this.refuse('DAILY_CAP', `price ${price} would exceed the daily cap (${this.spentToday}/${this.opts.caps.dailyTokens} spent)`);
    }
    if (this.tokens.length < price) throw new InsufficientTokensError(price, this.tokens.length);

    // Count the spend before sending, so concurrent calls cannot slip past the cap.
    this.spent.tokens += price;
    const pay = this.tokens.splice(0, price);
    const headers = new Headers(init.headers);
    headers.set('authorization', encodeAuthorization(pay));
    // M3: name the merchant's single-use quote, so the payment is bound to this resource and price.
    if (body.quoteId) headers.set(QUOTE_HEADER, body.quoteId);
    const res = await this.transport(url, { ...init, headers });
    this.emit({ type: 'paid', url, price, balance: this.balance, spentToday: this.spent.tokens });
    return res;
  }

  private checkChallenge(res: Response, body: BlindTokenRequiredBody) {
    const issuer = this.attested();
    if (body?.scheme !== 'blindtoken') {
      this.refuse('UNSUPPORTED_SCHEME', `402 asks for scheme "${body?.scheme}"; only blindtoken is allowed, no wallet fallback`);
    }
    if (!Number.isInteger(body.price) || body.price <= 0) this.refuse('BAD_QUOTE', `bad price ${body.price}`);
    // The merchant must want tokens from the issuer we attested, under the same key.
    const m = /token-key=([A-Za-z0-9_\-+/=]+)/.exec(res.headers.get('www-authenticate') ?? '');
    const key = m ? new Uint8Array(Buffer.from(m[1], 'base64url')) : new Uint8Array();
    if (!equalBytes(key, issuer.tokenKey) || body.issuerName !== issuer.issuerName) {
      this.refuse('WRONG_ISSUER', 'merchant asks for tokens from an issuer key we did not attest');
    }
  }

  private refuse(code: PaymentRefusedError['code'], message: string): never {
    this.emit({ type: 'refused', reason: `${code}: ${message}` });
    throw new PaymentRefusedError(code, message);
  }

  private rollDay() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.spent.day) this.spent = { day, tokens: 0 };
  }

  private async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const url = `${this.attested().url}${path}`;
    const res = await this.issuerCall!(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }
}
