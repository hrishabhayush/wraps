// Issuer logic without HTTP. State lives in memory (SPEC §12: don't restart the enclave).
import { createHash, randomBytes } from 'node:crypto';
import { AttestationProvider, Ed25519KeyPair, b64u, fromB64u, generateEd25519, hashPublicKeys } from '@wraps/attestation';
import {
  DEFAULT_ISSUER_NAME,
  IssuerKeyPair,
  Token,
  TokenIssuer,
  TokenVerifier,
  deserializeToken,
  generateIssuerKeys,
  serializeToken,
  toHex,
  tokenId,
  tokenKeyId,
} from '@wraps/tokens';
import {
  AttestationResponse,
  PaymentRequirement,
  SignedClaim,
  SignedPayoutRecord,
  SignedReserves,
  SettleStatus,
  SignedTokenKeys,
  TokenKeyEpoch,
  VerifyResult,
  signClaim,
  signPayoutRecord,
  signReserves,
  signTokenKeys,
  tokensToRlusd,
} from './protocol';
import { TopUpRail } from './rail';
import {
  InFlightPayoutRecord,
  IssuerSettlementState,
  IssuerStateSnapshot,
  IssuerStateStore,
  IssuerTabState,
  MemoryIssuerStateStore,
  MerchantNonceRecord,
} from './state-store';

export class IssuerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'IssuerError';
  }
}

export interface IssuerOptions {
  name?: string;
  provider: AttestationProvider;
  rail: TopUpRail;
  /** More rails offered beside `rail`, one per scheme. A quote names the scheme it was made for. */
  extraRails?: TopUpRail[];
  /** SPKI of the TLS key, if the issuer serves https. It joins the attested key hash as "tls". */
  tlsPublicKey?: Uint8Array;
  /** Most blinded requests in one /issue call. */
  maxBatch?: number;
  quoteTtlMs?: number;
  log?: (msg: string) => void;
  /**
   * SR3 (USENIX'26): how long tokens from one signing key stay valid. A key's not-after time is
   * its start plus this. Default 30 days.
   */
  tokenKeyLifetimeMs?: number;
  /**
   * The issuer stops signing with a key once less than this much of its life is left, and makes
   * a new key epoch. So every token gets at least this long to be spent. Default: half the lifetime.
   */
  minTokenLifetimeMs?: number;
  /** Clock. Tests move it to expire key epochs and quotes. */
  now?: () => number;
  /** State storage. The in-memory implementation is the safe default, including Confidential Space. */
  stateStore?: IssuerStateStore;
}

/** One token-signing key and the window in which its tokens are valid. */
interface KeyEpoch {
  keyId: string;
  keys: IssuerKeyPair;
  issuer: TokenIssuer;
  verifier: TokenVerifier;
  notBefore: number;
  notAfter: number;
}

interface Tab extends IssuerTabState {}

interface Quote {
  requirement: PaymentRequirement;
  used: boolean;
}

/**
 * One settle call made with a quote (SEC-03). Kept so a repeat of the same call returns the same
 * claim, and so the merchant can later ask whether its own settle landed.
 */
interface Settlement extends IssuerSettlementState {}

/** Merchant quote IDs: opaque, short, URL-safe. */
const SETTLE_QUOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PayoutLine {
  merchantId: string;
  amountTokens: number;
  amountRlusd: string;
}

/** A payout line once its transfer is confirmed. */
export interface PaidLine extends PayoutLine {
  /** On-chain tx hash, or a mock reference. */
  txRef?: string;
  payTo?: string;
  token?: string;
  chainId?: number;
}

export const DEFAULT_TOKEN_KEY_LIFETIME_MS = 30 * 24 * 3600_000;

export class IssuerCore {
  readonly name: string;
  /** Current keys. `token` changes when a new key epoch starts. "tls" is the SPKI of the TLS key, if served over https. */
  readonly publicKeys: { token: Uint8Array; claim: Uint8Array; tls?: Uint8Array };
  private readonly epochs = new Map<string, KeyEpoch>();
  private current!: KeyEpoch;
  private readonly now: () => number;
  private readonly spent = new Set<string>();
  /** SEC-03: settlements made with a quote, by merchantId + quoteId. */
  private readonly settlements = new Map<string, Settlement>();
  /** Durable record of every successful settlement, including legacy no-quote relay settles. */
  private settlementHistory: Settlement[] = [];
  private readonly tabs = new Map<string, Tab>();
  private readonly quotes = new Map<string, Quote>();
  private readonly payouts = new Map<string, SignedPayoutRecord[]>();
  private inFlightPayoutState: InFlightPayoutRecord[] = [];
  private merchantNonces: MerchantNonceRecord[] = [];
  private fundsHeld = 0;
  private unspentIssued = 0;
  private readonly log: (msg: string) => void;
  private stateQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly opts: IssuerOptions,
    tokenKeys: IssuerKeyPair,
    private readonly claimKeys: Ed25519KeyPair,
    private readonly stateStore: IssuerStateStore,
    state?: IssuerStateSnapshot,
  ) {
    this.name = opts.name ?? DEFAULT_ISSUER_NAME;
    this.now = opts.now ?? Date.now;
    this.publicKeys = { token: tokenKeys.publicKeyBytes, claim: claimKeys.publicKeyBytes };
    if (opts.tlsPublicKey) this.publicKeys.tls = opts.tlsPublicKey;
    this.addEpoch(tokenKeys);
    this.log = opts.log ?? (() => {});
    if (state) this.restoreState(state);
  }

  private get lifetimeMs(): number {
    return this.opts.tokenKeyLifetimeMs ?? DEFAULT_TOKEN_KEY_LIFETIME_MS;
  }

  private addEpoch(keys: IssuerKeyPair) {
    const now = this.now();
    const epoch: KeyEpoch = {
      keyId: toHex(tokenKeyId(keys.publicKeyBytes)),
      keys,
      issuer: new TokenIssuer(keys, this.name),
      verifier: new TokenVerifier(keys.publicKeyBytes, this.name),
      notBefore: now,
      notAfter: now + this.lifetimeMs,
    };
    this.epochs.set(epoch.keyId, epoch);
    this.current = epoch;
    this.publicKeys.token = keys.publicKeyBytes;
  }

  /**
   * Starts a new key epoch. New tokens are signed with the new key. Old keys stay verifiable
   * until their not-after time, then their tokens are refused as expired (SR3).
   */
  async rotateTokenKey(keys?: IssuerKeyPair): Promise<TokenKeyEpoch> {
    // Expired epochs are kept (they are small) so their tokens get a clear "expired" answer.
    this.addEpoch(keys ?? (await generateIssuerKeys()));
    this.log(`token key rotated: ${this.current.keyId.slice(0, 12)}…`);
    return this.epochView(this.current);
  }

  /**
   * Starts a new epoch if the current key has too little life left to give new tokens.
   * Called where clients learn the key (attestation, /keys), because a blinded request is
   * bound to one key: rotating between blinding and signing would strand the request.
   */
  async refreshTokenKey(): Promise<void> {
    const minLife = this.opts.minTokenLifetimeMs ?? this.lifetimeMs / 2;
    if (this.current.notAfter - this.now() < minLife) await this.rotateTokenKey();
  }

  /**
   * Blinded requests must be for the current, unexpired key. Checked before any payment is
   * redeemed, so a stale client loses nothing. RFC 9578 TokenRequest for type 0x0002 is
   * token_type (2 bytes) || truncated_token_key_id (1 byte) || blinded_msg.
   */
  private checkSigningKey(requests: string[], epoch: KeyEpoch = this.current) {
    if (this.now() > epoch.notAfter) throw new IssuerError(409, 'token key expired; fetch /attestation and blind again');
    const truncated = tokenKeyId(epoch.keys.publicKeyBytes)[31];
    for (const r of requests) {
      const bytes = typeof r === 'string' ? fromB64u(r) : new Uint8Array();
      if (bytes.length < 3 || bytes[2] !== truncated) {
        throw new IssuerError(409, 'token request is not for the current token key; fetch /attestation and blind again');
      }
    }
  }

  private epochView(e: KeyEpoch, current: KeyEpoch = this.current): TokenKeyEpoch {
    return { keyId: e.keyId, publicKey: b64u(e.keys.publicKeyBytes), notBefore: e.notBefore, notAfter: e.notAfter, current: e === current };
  }

  /** Every key whose tokens are still accepted, signed with the attested claim key. */
  tokenKeys(current: KeyEpoch = this.current): SignedTokenKeys {
    const now = this.now();
    const keys = [...this.epochs.values()].filter((e) => e === current || now <= e.notAfter).map((e) => this.epochView(e, current));
    return signTokenKeys(this.claimKeys.privateKey, { v: 1, issuer: this.name, keys, at: now });
  }

  /** Keys are made here, at start-up, inside the (future) enclave. */
  static async create(opts: IssuerOptions): Promise<IssuerCore> {
    const stateStore = opts.stateStore ?? new MemoryIssuerStateStore();
    const state = await stateStore.load();
    return new IssuerCore(opts, await generateIssuerKeys(), generateEd25519(), stateStore, state);
  }

  /** Issuer clock for timestamp validation in the HTTP layer. */
  currentTime(): number {
    return this.now();
  }

  private snapshot(): IssuerStateSnapshot {
    return {
      version: 1,
      spent: [...this.spent],
      settlements: this.settlementHistory.map((s) => ({ ...s, tokens: [...s.tokens] })),
      tabs: Object.fromEntries(this.tabs),
      fundsHeld: this.fundsHeld,
      unspentIssued: this.unspentIssued,
      payouts: Object.fromEntries([...this.payouts].map(([id, history]) => [id, [...history]])),
      inFlightPayouts: this.inFlightPayoutState.map((p) => ({ ...p })),
      merchantNonces: this.merchantNonces.map((n) => ({ ...n })),
    };
  }

  private restoreState(state: IssuerStateSnapshot) {
    this.spent.clear();
    for (const id of state.spent) this.spent.add(id);
    this.settlements.clear();
    this.settlementHistory = state.settlements.map((settlement) => ({ ...settlement, tokens: [...settlement.tokens] }));
    for (const settlement of this.settlementHistory) {
      if (settlement.quoteId) this.settlements.set(settlementKey(settlement.merchantId, settlement.quoteId), settlement);
    }
    this.tabs.clear();
    for (const [id, tab] of Object.entries(state.tabs)) this.tabs.set(id, { ...tab });
    this.payouts.clear();
    for (const [id, history] of Object.entries(state.payouts)) this.payouts.set(id, [...history]);
    this.inFlightPayoutState = state.inFlightPayouts.map((p) => ({ ...p }));
    this.merchantNonces = state.merchantNonces.map((n) => ({ ...n }));
    this.fundsHeld = state.fundsHeld;
    this.unspentIssued = state.unspentIssued;
  }

  private withStateLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.stateQueue.then(fn, fn);
    this.stateQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mutateState<T>(fn: (state: IssuerStateSnapshot) => T): Promise<T> {
    return this.withStateLock(async () => {
      const next = this.snapshot();
      const result = fn(next);
      // The journal fsync completes before we expose the mutation to callers.
      await this.stateStore.append(next);
      this.restoreState(next);
      return result;
    });
  }

  /** Persist a signed merchant request nonce before the route can acknowledge it. */
  async consumeMerchantNonce(merchantId: string, nonce: string, timestamp: number, windowMs: number): Promise<void> {
    await this.mutateState((state) => {
      state.merchantNonces = state.merchantNonces.filter((n) => n.timestamp >= this.now() - windowMs);
      if (state.merchantNonces.some((n) => n.merchantId === merchantId && n.nonce === nonce)) {
        throw new IssuerError(409, 'merchant request nonce was already used');
      }
      state.merchantNonces.push({ merchantId, nonce, timestamp });
    });
  }

  /** Current in-flight payout transfers, including raw signed bytes needed to safely resume. */
  inFlightPayouts(): InFlightPayoutRecord[] {
    return this.inFlightPayoutState.map((p) => ({ ...p }));
  }

  /** Called by the payout rail and fsynced before a newly signed transfer is sent. */
  async persistInFlightPayouts(records: InFlightPayoutRecord[]): Promise<void> {
    await this.mutateState((state) => {
      state.inFlightPayouts = records.map((r) => ({ ...r }));
    });
  }

  get rail(): TopUpRail {
    return this.opts.rail;
  }

  /** Every top-up rail, the default first. */
  get rails(): TopUpRail[] {
    return [this.opts.rail, ...(this.opts.extraRails ?? [])];
  }

  private railFor(scheme: string): TopUpRail {
    const rail = this.rails.find((r) => r.scheme === scheme);
    if (!rail) throw new IssuerError(400, `unsupported payment scheme: ${scheme}`);
    return rail;
  }

  // --- attestation -------------------------------------------------------

  async attestation(nonce: Uint8Array): Promise<AttestationResponse> {
    if (nonce.length < 16 || nonce.length > 64) throw new IssuerError(400, 'nonce must be 16 to 64 bytes');
    await this.refreshTokenKey();
    // Snapshot one epoch and build every field from it, before the await. A rotation while the
    // provider attests must not mix keys from two epochs in one response.
    const epoch = this.current;
    const keys: { token: Uint8Array; claim: Uint8Array; tls?: Uint8Array } = { token: epoch.keys.publicKeyBytes, claim: this.publicKeys.claim };
    if (this.publicKeys.tls) keys.tls = this.publicKeys.tls;
    const tokenKeys = this.tokenKeys(epoch);
    const attestation = await this.opts.provider.attest(nonce, hashPublicKeys(keys));
    return {
      format: this.opts.provider.format,
      attestation,
      issuerName: this.name,
      publicKeys: {
        token: b64u(keys.token),
        claim: b64u(keys.claim),
        ...(keys.tls ? { tls: b64u(keys.tls) } : {}),
      },
      tokenKeyId: epoch.keyId,
      tokenKeyNotAfter: epoch.notAfter,
      tokenKeys,
    };
  }

  // --- issuance (top-up) -------------------------------------------------

  /** One quote per rail, for a 402 answer. */
  quoteAll(tokens: number): PaymentRequirement[] {
    return this.rails.map((r) => this.quote(tokens, r.scheme));
  }

  quote(tokens: number, scheme = this.rail.scheme): PaymentRequirement {
    const rail = this.railFor(scheme);
    // SR5: no zero, negative or fractional quotes. They are economically meaningless.
    if (!Number.isInteger(tokens) || tokens < 1) throw new IssuerError(400, 'tokens must be a positive integer');
    // Never quote more than one /issue call can sign, or a payer could pay and get nothing.
    if (tokens > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'too many tokens for one top-up');
    const quoteId = randomBytes(16).toString('hex');
    const requirement: PaymentRequirement = {
      scheme: rail.scheme,
      network: rail.network,
      asset: 'RLUSD',
      amountRlusd: tokensToRlusd(tokens),
      tokens,
      payTo: rail.payTo,
      quoteId,
      expiresAt: this.now() + (this.opts.quoteTtlMs ?? 5 * 60_000),
      description: `${tokens} private payment tokens`,
    };
    this.quotes.set(quoteId, { requirement, used: false });
    return requirement;
  }

  /**
   * /issue with a payment attached. Signs first with the epoch captured here, then redeems, then
   * releases the signatures. So a key rotation during the await cannot strand a paid request, and
   * a request that cannot be signed never has its payment redeemed.
   */
  async issuePaid(requests: string[], paymentHeader: string): Promise<string[]> {
    this.checkBatch(requests);
    const epoch = this.current;
    this.checkSigningKey(requests, epoch);
    let quoteId: string | undefined;
    try {
      quoteId = JSON.parse(Buffer.from(paymentHeader, 'base64url').toString('utf8')).quoteId;
    } catch {
      /* handled below */
    }
    const q = quoteId ? this.quotes.get(quoteId) : undefined;
    if (!q || q.used) throw new IssuerError(402, 'unknown or used quote');
    if (this.now() > q.requirement.expiresAt) throw new IssuerError(402, 'quote expired');
    if (requests.length > q.requirement.tokens) {
      throw new IssuerError(402, `paid for ${q.requirement.tokens} tokens, asked for ${requests.length}: refusing to issue beyond funds`);
    }
    q.used = true;
    let signed: string[];
    try {
      // Blind signatures are held back until the payment is redeemed. Nothing is released yet.
      signed = (await epoch.issuer.issue(requests.map(fromB64u))).map(b64u);
    } catch (e) {
      q.used = false;
      throw new IssuerError(400, `bad token request: ${(e as Error).message}`);
    }
    let redeemed;
    try {
      redeemed = await this.railFor(q.requirement.scheme).redeem(paymentHeader, q.requirement);
    } catch (e) {
      q.used = false;
      throw new IssuerError(402, `payment refused: ${(e as Error).message}`);
    }
    // Persist the funds/tokens together before releasing any blind signatures to the caller.
    await this.mutateState((state) => {
      state.fundsHeld += redeemed.amountTokens;
      state.unspentIssued += requests.length;
    });
    if (this.outstanding() > this.fundsHeld) {
      this.log(`warning: outstanding ${this.outstanding()} is above funds held ${this.fundsHeld} after a paid issue`);
    }
    this.log(`top-up redeemed: ${tokensToRlusd(redeemed.amountTokens)} RLUSD (${redeemed.txRef.slice(0, 18)}…)`);
    return signed;
  }

  /** Signs blinded requests. Refuses if it would push outstanding above funds held. */
  async signBlinded(requests: string[]): Promise<string[]> {
    this.checkBatch(requests);
    const epoch = this.current;
    this.checkSigningKey(requests, epoch);
    // Reserve in durable state before the await so concurrent calls and restarts cannot over-issue.
    await this.mutateState((state) => {
      const unpaid = Object.values(state.tabs).reduce((sum, tab) => sum + tab.earned - tab.paid, 0);
      const outstanding = state.unspentIssued + unpaid;
      if (outstanding + requests.length > state.fundsHeld) {
        throw new IssuerError(402, `refusing to issue beyond funds held (outstanding ${outstanding}, funds ${state.fundsHeld}, asked ${requests.length})`);
      }
      state.unspentIssued += requests.length;
    });
    try {
      const out = await epoch.issuer.issue(requests.map(fromB64u));
      return out.map(b64u);
    } catch (e) {
      await this.mutateState((state) => { state.unspentIssued -= requests.length; });
      throw new IssuerError(400, `bad token request: ${(e as Error).message}`);
    }
  }

  private checkBatch(requests: string[]) {
    if (!Array.isArray(requests) || requests.length === 0) throw new IssuerError(400, 'requests must be a non-empty array');
    if (requests.length > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'batch too large');
  }

  // --- redemption --------------------------------------------------------

  /**
   * Read-only: canonical encoding, known key epoch not past its not-after time, signature valid,
   * not spent. Duplicates in one batch are invalid.
   */
  async verify(serialized: string[]): Promise<VerifyResult & { tokens: (Token | null)[] }> {
    if (!Array.isArray(serialized) || serialized.length === 0) throw new IssuerError(400, 'tokens must be a non-empty array');
    // SR6/SR5: bound the work one request can cause.
    if (serialized.length > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'too many tokens in one request');
    const seen = new Set<string>();
    const results: VerifyResult['results'] = [];
    const tokens: (Token | null)[] = [];
    for (const s of serialized) {
      let t: Token | null = null;
      try {
        t = typeof s === 'string' ? deserializeToken(s) : null;
        // M1 canonical encoding: truncated, padded or trailing bytes do not round-trip.
        if (t && serializeToken(t) !== s) t = null;
      } catch {
        t = null;
      }
      if (!t) {
        results.push({ ok: false, reason: 'malformed' });
        tokens.push(null);
        continue;
      }
      tokens.push(t);
      const epoch = this.epochs.get(toHex(t.authInput.tokenKeyId));
      if (!epoch || !(await epoch.verifier.verify(t))) {
        results.push({ ok: false, reason: 'bad signature' });
        continue;
      }
      if (this.now() > epoch.notAfter) {
        results.push({ ok: false, reason: 'expired' });
        continue;
      }
      const id = tokenId(t);
      if (this.spent.has(id)) results.push({ ok: false, reason: 'already spent' });
      else if (seen.has(id)) results.push({ ok: false, reason: 'duplicate in request' });
      else results.push({ ok: true });
      seen.add(id);
    }
    return { valid: results.every((r) => r.ok), results, tokens };
  }

  /**
   * Marks tokens spent (across all merchants), adds them to the merchant's tab, returns a signed claim.
   *
   * SEC-03: with a quoteId, settle is idempotent per (merchantId, quoteId). The issuer records the
   * settlement. A repeat with the same tokens returns the original claim, even after the tokens
   * expire. A repeat with other tokens is refused. Without a quoteId (relay, app), the old
   * behaviour stays: a repeat is refused as "already spent".
   */
  async settle(merchantId: string, serialized: string[], quoteId?: string): Promise<SignedClaim> {
    if (typeof merchantId !== 'string' || !merchantId) throw new IssuerError(400, 'merchantId required');
    if (quoteId !== undefined && (typeof quoteId !== 'string' || !SETTLE_QUOTE_ID.test(quoteId))) {
      throw new IssuerError(400, 'malformed quoteId');
    }
    const key = quoteId === undefined ? undefined : settlementKey(merchantId, quoteId);
    const fingerprint = fingerprintTokens(serialized);
    if (key) {
      const replay = this.replay(key, fingerprint);
      if (replay) return replay;
    }
    const checked = await this.verify(serialized);
    // SR7: verification is redone here, never trusted from an earlier /verify. The persistent
    // mutation lock rechecks spent state after verification, and its append completes before ack.
    return this.withStateLock(async () => {
      if (key) {
        const replay = this.replay(key, fingerprint);
        if (replay) return replay;
      }
      const ids = checked.tokens.map((t) => (t ? tokenId(t) : ''));
      if (!checked.valid || ids.some((id) => this.spent.has(id))) {
        const reason = checked.results.find((r) => !r.ok)?.reason ?? 'already spent';
        throw new IssuerError(409, `tokens rejected: ${reason}`);
      }
      const next = this.snapshot();
      for (const id of ids) next.spent.push(id);
      next.unspentIssued -= ids.length;
      const tab = next.tabs[merchantId] ?? { earned: 0, paid: 0, seq: 0 };
      tab.earned += ids.length;
      tab.seq += 1;
      next.tabs[merchantId] = tab;
      const result = signClaim(this.claimKeys.privateKey, {
        v: 1,
        issuer: this.name,
        merchantId,
        totalTokens: tab.earned,
        totalRlusd: tokensToRlusd(tab.earned),
        seq: tab.seq,
        at: this.now(),
      });
      next.settlements.push({ merchantId, ...(quoteId ? { quoteId } : {}), fingerprint: fingerprint!, tokens: [...serialized].sort(), result });
      await this.stateStore.append(next);
      this.restoreState(next);
      return result;
    });
  }

  /** The original claim for a repeat settle, undefined if the quote is not settled yet. Throws for other tokens. */
  private replay(key: string, fingerprint: string | undefined): SignedClaim | undefined {
    const s = this.settlements.get(key);
    if (!s) return undefined;
    if (s.fingerprint !== fingerprint) throw new IssuerError(409, 'quote already settled with other tokens');
    return s.result;
  }

  /**
   * SEC-03: merchant-scoped settlement lookup, read-only. After an ambiguous /settle, the merchant
   * asks whether its own settle for this quote landed. The answer is one of:
   *   settled-by-you    this merchant settled exactly these tokens for this quote
   *   settled-by-other  at least one token is spent, but not by this (merchant, quote) settle
   *   expired           not spent, and too old to settle
   *   unspent           not spent and still valid
   * Spent is checked before expired, so a settled token that later expires still reports settled.
   * It never names the other merchant, its quote or any payer data.
   */
  async settleStatus(merchantId: string, quoteId: string, serialized: string[]): Promise<SettleStatus> {
    if (typeof merchantId !== 'string' || !merchantId) throw new IssuerError(400, 'merchantId required');
    if (typeof quoteId !== 'string' || !SETTLE_QUOTE_ID.test(quoteId)) throw new IssuerError(400, 'quoteId required');
    if (!Array.isArray(serialized) || serialized.length === 0) throw new IssuerError(400, 'tokens must be a non-empty array');
    if (serialized.length > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'too many tokens in one request');
    const key = settlementKey(merchantId, quoteId);
    const fingerprint = fingerprintTokens(serialized);
    const mine = () => this.settlements.get(key)?.fingerprint === fingerprint;
    if (mine()) return 'settled-by-you';

    const checked = await this.verify(serialized);
    // No await from here: classify against one snapshot of the settlements and the spent list.
    if (mine()) return 'settled-by-you';
    let spent = false;
    let expired = false;
    for (let i = 0; i < serialized.length; i++) {
      const t = checked.tokens[i];
      const reason = checked.results[i].reason;
      if (!t || reason === 'malformed') throw new IssuerError(400, 'tokens rejected: malformed');
      if (reason === 'bad signature') throw new IssuerError(409, 'tokens rejected: bad signature');
      if (reason === 'duplicate in request') throw new IssuerError(400, 'tokens rejected: duplicate in request');
      // verify() reports "expired" before it looks at the spent list, so look here first.
      if (this.spent.has(tokenId(t))) spent = true;
      else if (reason === 'expired') expired = true;
    }
    if (spent) return 'settled-by-other';
    return expired ? 'expired' : 'unspent';
  }

  // --- reserves and payouts ----------------------------------------------

  outstanding(): number {
    return this.unspentIssued + this.unpaidTabs();
  }

  private unpaidTabs(): number {
    let sum = 0;
    for (const t of this.tabs.values()) sum += t.earned - t.paid;
    return sum;
  }

  /** "Claims outstanding ≤ funds held", signed with the attested claim key. */
  reserves(): SignedReserves {
    const outstanding = this.outstanding();
    return signReserves(this.claimKeys.privateKey, {
      v: 1,
      issuer: this.name,
      fundsHeldTokens: this.fundsHeld,
      unspentIssuedTokens: this.unspentIssued,
      unpaidTabsTokens: this.unpaidTabs(),
      outstandingTokens: outstanding,
      solvent: outstanding <= this.fundsHeld,
      at: this.now(),
    });
  }

  /** Takes every unpaid tab for a payout batch. Call markPaid after the transfer succeeds. */
  pendingPayouts(): PayoutLine[] {
    const out: PayoutLine[] = [];
    for (const [merchantId, t] of this.tabs) {
      const amount = t.earned - t.paid;
      if (amount > 0) out.push({ merchantId, amountTokens: amount, amountRlusd: tokensToRlusd(amount) });
    }
    return out;
  }

  /**
   * Call only after the transfer is confirmed. With a txRef, a signed payout record is added to
   * the merchant's history (GET /payouts), so the merchant can match claims to on-chain transfers.
   */
  async markPaid(lines: PaidLine[], remainingInFlight = this.inFlightPayoutState): Promise<void> {
    await this.mutateState((state) => {
      state.inFlightPayouts = remainingInFlight.map((p) => ({ ...p }));
      for (const l of lines) {
        const tab = state.tabs[l.merchantId];
        if (!tab || !Number.isInteger(l.amountTokens) || l.amountTokens <= 0) continue;
        const amountTokens = Math.min(l.amountTokens, tab.earned - tab.paid);
        if (amountTokens <= 0) continue;
        tab.paid += amountTokens;
        state.fundsHeld -= amountTokens;
        if (l.txRef === undefined) continue;
        const history = state.payouts[l.merchantId] ?? [];
        history.push(
          signPayoutRecord(this.claimKeys.privateKey, {
            v: 1,
            issuer: this.name,
            merchantId: l.merchantId,
            amountTokens,
            amountRlusd: tokensToRlusd(amountTokens),
            txRef: l.txRef,
            ...(l.payTo ? { payTo: l.payTo } : {}),
            ...(l.token ? { token: l.token } : {}),
            ...(l.chainId !== undefined ? { chainId: l.chainId } : {}),
            paidTotalTokens: tab.paid,
            claimSeq: tab.seq,
            claimTotalTokens: tab.earned,
            at: this.now(),
          }),
        );
        state.payouts[l.merchantId] = history;
      }
    });
  }

  /** Signed payout records for one merchant, oldest first. */
  payoutHistory(merchantId: string): SignedPayoutRecord[] {
    return [...(this.payouts.get(merchantId) ?? [])];
  }
}

function settlementKey(merchantId: string, quoteId: string): string {
  return `${merchantId}\0${quoteId}`;
}

/** Order-independent fingerprint of a token set. Undefined for input that is not a string array. */
function fingerprintTokens(serialized: unknown): string | undefined {
  if (!Array.isArray(serialized) || !serialized.every((s) => typeof s === 'string')) return undefined;
  return createHash('sha256').update([...serialized].sort().join('\n')).digest('hex');
}
