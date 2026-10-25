// Agent SDK: attestation first, then top-ups and blind token payments.
// Caps live here, in code, outside the model. There is no wallet fallback.
// Paying reserves tokens; it does not delete them. A definite refusal restores them, a success
// spends them, and an ambiguous outcome keeps them reserved until resolvePending() settles it.
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
import { Token, TokenVerifier, blindTokens, encodeAuthorization, equalBytes, finalizeTokens, serializeToken } from '@wraps/tokens';
import type { PinnedRelayTransport } from './relay';
import { deriveWireGuardPublicKey, isVerifiedWireGuardReceipt, registerWireGuardPeer as registerPeer, WireGuardRegistrationError, type VerifiedWireGuardReceipt } from './wireguard.js';

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

/**
 * The payment outcome is not known yet (network error, merchant 5xx, settlement pending). The
 * tokens stay reserved: they are not spendable and not lost. Call resolvePending(reservationId).
 */
export class PaymentPendingError extends Error {
  constructor(readonly reservationId: number, readonly url: string, message: string) {
    super(`payment pending (reservation ${reservationId}): ${message}`);
    this.name = 'PaymentPendingError';
  }
}

export class InsufficientTokensError extends Error {
  constructor(readonly needed: number, readonly have: number, purpose?: string) {
    super(`need ${needed} tokens, have ${have}${purpose ? ` (${purpose})` : ''}`);
    this.name = 'InsufficientTokensError';
  }
}

export type SdkEvent =
  /** measurement: PCR0 (mock) or container image digest (Confidential Space). pcr0 is kept as an alias. */
  | { type: 'attested'; pcr0: string; measurement: string; format: string }
  | { type: 'topup-402'; tokens: number; amountRlusd: string; scheme: string }
  | { type: 'topup-done'; tokens: number; balance: number }
  | { type: 'paid'; url: string; price: number; balance: number; spentToday: number }
  | { type: 'refused'; reason: string }
  /** A refused payment's tokens went back to the balance. */
  | { type: 'restored'; url: string; tokens: number; balance: number }
  /** The outcome is unknown; the tokens stay reserved. */
  | { type: 'pending'; url: string; reservationId: number; reason: string }
  /** The tokens were spent but the merchant did not serve (for example, its response was lost). */
  | { type: 'spent-unserved'; url: string; tokens: number; status: number };

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
  /** Direct transport when no relay is configured. Defaults to fetch. */
  transport?: Transport;
  /**
   * Pinned relay (SDK-02). When set, all traffic goes through it: merchant calls use a metered
   * CONNECT, and issuer calls use the relay's restricted tokenless issuer route.
   */
  relayTransport?: PinnedRelayTransport;
  /** Blind tokens spent on each new relay CONNECT. Defaults to 1 (10 MB of metering). */
  relayTokensPerTunnel?: number;
  now?: () => number;
  onEvent?: (e: SdkEvent) => void;
  /** Re-sends after an ambiguous outcome, with the same tokens and quote. Default 2 retries, 250 ms apart. */
  pendingRetry?: { retries?: number; delayMs?: number };
}

/** Tokens taken out of the balance for one payment whose outcome is not final yet. */
interface Reservation {
  id: number;
  url: string;
  init: RequestInit;
  quoteId?: string;
  tokens: Token[];
  /** UTC day the spend was counted on. */
  day: string;
  busy: boolean;
}

export interface PendingPayment {
  reservationId: number;
  url: string;
  tokens: number;
}

export class PrivatePayClient {
  private issuer?: AttestedIssuer;
  /** Calls to the issuer. Over https this is pinned to the attested TLS key. */
  private issuerCall?: Transport;
  private tokenVerifier?: TokenVerifier;
  private tokens: Token[] = [];
  private readonly reservations = new Map<number, Reservation>();
  private nextReservation = 1;
  private spent = { day: '', tokens: 0 };
  private readonly transport: Transport;
  private readonly relayTokensPerTunnel: number;
  private readonly now: () => number;
  private readonly emit: (e: SdkEvent) => void;

  constructor(private readonly opts: PrivatePayOptions) {
    this.transport = opts.transport ?? fetch;
    this.relayTokensPerTunnel = opts.relayTokensPerTunnel ?? 1;
    if (opts.relayTransport && (!Number.isInteger(this.relayTokensPerTunnel) || this.relayTokensPerTunnel < 1 || this.relayTokensPerTunnel > 100)) {
      throw new TypeError('relayTokensPerTunnel must be an integer from 1 through 100');
    }
    this.now = opts.now ?? Date.now;
    this.emit = opts.onEvent ?? (() => {});
  }

  get caps(): Caps {
    return this.opts.caps;
  }
  /** Spendable tokens. Reserved tokens are not included. */
  get balance(): number {
    return this.tokens.length;
  }
  /** Tokens held by payments whose outcome is not final yet. */
  get reservedTokens(): number {
    let n = 0;
    for (const r of this.reservations.values()) n += r.tokens.length;
    return n;
  }
  get pendingPayments(): PendingPayment[] {
    return [...this.reservations.values()].map((r) => ({ reservationId: r.id, url: r.url, tokens: r.tokens.length }));
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
    const issuerRoute = this.opts.relayTransport ? issuerRouteThroughRelay(this.opts.relayTransport) : this.transport;
    const issuer = await fetchAttestedIssuer(this.opts.issuerUrl, this.opts.verifier, issuerRoute);
    this.issuerCall = issuerTransport(issuer, issuerRoute);
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
    const res = await this.requestMerchant(url);
    if (res.status !== 402) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
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
    const first = await this.requestMerchant(url, init);
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
    // With a relay, the paid request needs its own CONNECT, so one more meter batch.
    const meter = this.opts.relayTransport ? this.relayTokensPerTunnel : 0;
    if (this.spentToday + price + meter > this.opts.caps.dailyTokens) {
      const what = meter ? `price ${price} plus relay metering ${meter}` : `price ${price}`;
      return this.refuse('DAILY_CAP', `${what} would exceed the daily cap (${this.spentToday}/${this.opts.caps.dailyTokens} spent)`);
    }
    if (this.tokens.length < price + meter) {
      throw new InsufficientTokensError(
        price + meter,
        this.tokens.length,
        meter ? `${meter} relay meter token(s) plus ${price} merchant token(s)` : undefined,
      );
    }

    // Count the spend and reserve the tokens before sending, so concurrent calls cannot slip past
    // the cap or pick the same tokens.
    this.spent.tokens += price;
    const r: Reservation = {
      id: this.nextReservation++,
      url,
      init,
      quoteId: body.quoteId,
      tokens: this.tokens.splice(0, price),
      day: this.spent.day,
      busy: false,
    };
    this.reservations.set(r.id, r);
    return this.settleReservation(r, this.opts.pendingRetry?.retries ?? 2);
  }

  /**
   * Re-sends a pending payment with the same tokens and quote. Returns the final response, or
   * throws PaymentPendingError again if the outcome is still unknown.
   */
  async resolvePending(reservationId: number): Promise<Response> {
    this.attested();
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`no pending payment ${reservationId}`);
    return this.settleReservation(r, 0);
  }

  /**
   * Sends a reserved payment. 2xx/3xx: spent. 4xx (402 included): refused, so restore the tokens
   * the issuer says are unspent. 5xx or a network error: unknown, so retry, then keep them reserved.
   */
  private async settleReservation(r: Reservation, retries: number): Promise<Response> {
    if (r.busy) throw new PaymentPendingError(r.id, r.url, 'already being resolved');
    r.busy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response | undefined;
        let reason: string;
        try {
          res = await this.send(r);
          reason = `merchant answered ${res.status}`;
        } catch (e) {
          reason = `network error: ${(e as Error).message}`;
        }
        if (res && res.status < 400) {
          this.reservations.delete(r.id);
          this.emit({ type: 'paid', url: r.url, price: r.tokens.length, balance: this.balance, spentToday: this.spentToday });
          return res;
        }
        if (res && res.status < 500) {
          if (await this.restore(r, res.status)) return res;
          reason = `${reason}; could not check the tokens at the issuer`;
        }
        if (attempt >= retries) {
          this.emit({ type: 'pending', url: r.url, reservationId: r.id, reason });
          throw new PaymentPendingError(r.id, r.url, reason);
        }
        await new Promise((ok) => setTimeout(ok, this.opts.pendingRetry?.delayMs ?? 250));
      }
    } finally {
      r.busy = false;
    }
  }

  private send(r: Reservation): Promise<Response> {
    const headers = new Headers(r.init.headers);
    headers.set('authorization', encodeAuthorization(r.tokens));
    // M3: name the merchant's single-use quote, so the payment is bound to this resource and price.
    if (r.quoteId) headers.set(QUOTE_HEADER, r.quoteId);
    // Merchant tokens travel inside end-to-end TLS. Each attempt pays a fresh relay meter batch;
    // if that batch cannot be paid, the attempt fails and the reservation stays pending.
    return this.requestMerchant(r.url, { ...r.init, headers }, false);
  }

  /**
   * Sends a merchant request. With a relay, takes one meter batch out of the balance and counts it
   * against the daily cap before the CONNECT. The relay may settle a meter token before a failure is
   * visible, so the batch is never refunded or reused.
   */
  private async requestMerchant(url: string, init?: RequestInit, refuseOnCap = true): Promise<Response> {
    const relay = this.opts.relayTransport;
    if (!relay) return this.transport(url, init);
    const meter = this.relayTokensPerTunnel;
    this.rollDay();
    if (this.spent.tokens + meter > this.opts.caps.dailyTokens) {
      const message = `relay metering ${meter} would exceed the daily cap (${this.spent.tokens}/${this.opts.caps.dailyTokens} spent)`;
      if (refuseOnCap) return this.refuse('DAILY_CAP', message);
      throw new Error(message);
    }
    if (this.tokens.length < meter) {
      throw new InsufficientTokensError(meter, this.tokens.length, 'relay meter tokens are required before a CONNECT; call topUp() first');
    }
    const batch = this.tokens.splice(0, meter);
    this.spent.tokens += meter;
    return relay.fetchWithTokens(url, init, batch);
  }

  /**
   * The merchant refused. Asks the issuer (read-only /verify) which tokens are still unspent and
   * puts those back. Spent ones are dropped and reported, never reused. Returns false, keeping the
   * reservation, if the issuer gives no answer.
   */
  private async restore(r: Reservation, status: number): Promise<boolean> {
    let results: { ok: boolean; reason?: string }[];
    try {
      const v = await this.post('/verify', { tokens: r.tokens.map(serializeToken) });
      results = v.body?.results;
      if (v.status !== 200 || !Array.isArray(results) || results.length !== r.tokens.length) return false;
    } catch {
      return false;
    }
    const back = r.tokens.filter((_, i) => results[i].ok);
    const gone = r.tokens.length - back.length;
    this.reservations.delete(r.id);
    this.tokens.unshift(...back);
    this.rollDay();
    if (this.spent.day === r.day) this.spent.tokens = Math.max(0, this.spent.tokens - back.length);
    if (back.length) this.emit({ type: 'restored', url: r.url, tokens: back.length, balance: this.balance });
    if (gone) this.emit({ type: 'spent-unserved', url: r.url, tokens: gone, status });
    return true;
  }

  /** Spend blind tokens to activate this configured peer's metered WireGuard quota. */
  async registerWireGuardPeer(receipt: VerifiedWireGuardReceipt, clientPrivateKey: string, tlsPort = 443): Promise<number> {
    this.attested();
    const publicKey = deriveWireGuardPublicKey(clientPrivateKey);
    if (!isVerifiedWireGuardReceipt(receipt) || !receipt.peers.some((peer) => peer.publicKey === publicKey)) {
      throw new TypeError('a verified receipt containing this peer is required');
    }
    const tokenCount = 1;
    if (this.spentToday + tokenCount > this.opts.caps.dailyTokens) {
      throw new PaymentRefusedError('DAILY_CAP', 'WireGuard quota reservation would exceed the daily token cap');
    }
    if (this.tokens.length < tokenCount) throw new InsufficientTokensError(tokenCount, this.tokens.length);
    // Consume locally before network I/O: a lost response may follow a successful
    // relay settlement, so retrying the same tokens would create ambiguity.
    const reservedDay = this.spent.day;
    const batch = this.tokens.splice(0, tokenCount);
    this.spent.tokens += tokenCount;
    try {
      await registerPeer(receipt, clientPrivateKey, batch, tlsPort);
    } catch (error) {
      if (error instanceof WireGuardRegistrationError && error.outcome === 'rejected') {
        this.tokens.unshift(...batch);
        if (this.spent.day === reservedDay) this.spent.tokens = Math.max(0, this.spent.tokens - tokenCount);
      }
      throw error;
    }
    return tokenCount;
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

/** Issuer calls through the relay's tokenless issuer route, with the issuer TLS key pinned. */
function issuerRouteThroughRelay(relay: PinnedRelayTransport): Transport {
  const route = ((url: string, init?: RequestInit) => relay.fetchIssuer(url, init)) as Transport;
  route.fetchWithPeer = (url, init) => relay.fetchIssuerWithPeer(url, init);
  route.fetchPinned = (url, expectedSpki, init) => relay.fetchIssuer(url, init, expectedSpki);
  return route;
}
