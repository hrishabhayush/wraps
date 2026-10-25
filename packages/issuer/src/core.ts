// Issuer logic without HTTP. State lives in memory (SPEC §12: don't restart the enclave).
import { randomBytes } from 'node:crypto';
import { AttestationProvider, Ed25519KeyPair, b64u, fromB64u, generateEd25519, hashPublicKeys } from '@wraps/attestation';
import {
  DEFAULT_ISSUER_NAME,
  IssuerKeyPair,
  Token,
  TokenIssuer,
  TokenVerifier,
  deserializeToken,
  generateIssuerKeys,
  tokenId,
} from '@wraps/tokens';
import {
  AttestationResponse,
  PaymentRequirement,
  SignedClaim,
  SignedReserves,
  VerifyResult,
  signClaim,
  signReserves,
  tokensToRlusd,
} from './protocol';
import { TopUpRail } from './rail';

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
  /** SPKI of the TLS key, if the issuer serves https. It joins the attested key hash as "tls". */
  tlsPublicKey?: Uint8Array;
  /** Most blinded requests in one /issue call. */
  maxBatch?: number;
  quoteTtlMs?: number;
  log?: (msg: string) => void;
}

interface Tab {
  earned: number;
  paid: number;
  seq: number;
}

interface Quote {
  requirement: PaymentRequirement;
  used: boolean;
}

export interface PayoutLine {
  merchantId: string;
  amountTokens: number;
  amountRlusd: string;
}

export class IssuerCore {
  readonly name: string;
  readonly publicKeys: { token: Uint8Array; claim: Uint8Array; tls?: Uint8Array };
  private readonly tokenIssuer: TokenIssuer;
  private readonly verifier: TokenVerifier;
  private readonly spent = new Set<string>();
  private readonly tabs = new Map<string, Tab>();
  private readonly quotes = new Map<string, Quote>();
  private fundsHeld = 0;
  private unspentIssued = 0;
  private readonly log: (msg: string) => void;

  private constructor(
    private readonly opts: IssuerOptions,
    tokenKeys: IssuerKeyPair,
    private readonly claimKeys: Ed25519KeyPair,
  ) {
    this.name = opts.name ?? DEFAULT_ISSUER_NAME;
    this.tokenIssuer = new TokenIssuer(tokenKeys, this.name);
    this.verifier = new TokenVerifier(tokenKeys.publicKeyBytes, this.name);
    this.publicKeys = { token: tokenKeys.publicKeyBytes, claim: claimKeys.publicKeyBytes };
    if (opts.tlsPublicKey) this.publicKeys.tls = opts.tlsPublicKey;
    this.log = opts.log ?? (() => {});
  }

  /** Keys are made here, at start-up, inside the (future) enclave. */
  static async create(opts: IssuerOptions): Promise<IssuerCore> {
    return new IssuerCore(opts, await generateIssuerKeys(), generateEd25519());
  }

  get rail(): TopUpRail {
    return this.opts.rail;
  }

  // --- attestation -------------------------------------------------------

  async attestation(nonce: Uint8Array): Promise<AttestationResponse> {
    if (nonce.length < 16 || nonce.length > 64) throw new IssuerError(400, 'nonce must be 16 to 64 bytes');
    const attestation = await this.opts.provider.attest(nonce, hashPublicKeys(this.publicKeys));
    return {
      format: this.opts.provider.format,
      attestation,
      issuerName: this.name,
      publicKeys: {
        token: b64u(this.publicKeys.token),
        claim: b64u(this.publicKeys.claim),
        ...(this.publicKeys.tls ? { tls: b64u(this.publicKeys.tls) } : {}),
      },
    };
  }

  // --- issuance (top-up) -------------------------------------------------

  quote(tokens: number): PaymentRequirement {
    // Never quote more than one /issue call can sign, or a payer could pay and get nothing.
    if (tokens > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'too many tokens for one top-up');
    const quoteId = randomBytes(16).toString('hex');
    const requirement: PaymentRequirement = {
      scheme: this.rail.scheme,
      network: this.rail.network,
      asset: 'RLUSD',
      amountRlusd: tokensToRlusd(tokens),
      tokens,
      payTo: this.rail.payTo,
      quoteId,
      expiresAt: Date.now() + (this.opts.quoteTtlMs ?? 5 * 60_000),
      description: `${tokens} private payment tokens`,
    };
    this.quotes.set(quoteId, { requirement, used: false });
    return requirement;
  }

  /** /issue with a payment attached. Redeems the payment, then signs. */
  async issuePaid(requests: string[], paymentHeader: string): Promise<string[]> {
    this.checkBatch(requests);
    let quoteId: string | undefined;
    try {
      quoteId = JSON.parse(Buffer.from(paymentHeader, 'base64url').toString('utf8')).quoteId;
    } catch {
      /* handled below */
    }
    const q = quoteId ? this.quotes.get(quoteId) : undefined;
    if (!q || q.used) throw new IssuerError(402, 'unknown or used quote');
    if (Date.now() > q.requirement.expiresAt) throw new IssuerError(402, 'quote expired');
    if (requests.length > q.requirement.tokens) {
      throw new IssuerError(402, `paid for ${q.requirement.tokens} tokens, asked for ${requests.length}: refusing to issue beyond funds`);
    }
    q.used = true;
    let redeemed;
    try {
      redeemed = await this.rail.redeem(paymentHeader, q.requirement);
    } catch (e) {
      q.used = false;
      throw new IssuerError(402, `payment refused: ${(e as Error).message}`);
    }
    this.fundsHeld += redeemed.amountTokens;
    this.log(`top-up redeemed: ${tokensToRlusd(redeemed.amountTokens)} RLUSD (${redeemed.txRef.slice(0, 18)}…)`);
    return this.signBlinded(requests);
  }

  /** Signs blinded requests. Refuses if it would push outstanding above funds held. */
  async signBlinded(requests: string[]): Promise<string[]> {
    this.checkBatch(requests);
    if (this.outstanding() + requests.length > this.fundsHeld) {
      throw new IssuerError(402, `refusing to issue beyond funds held (outstanding ${this.outstanding()}, funds ${this.fundsHeld}, asked ${requests.length})`);
    }
    // Reserve before the await so concurrent calls can't both pass the check.
    this.unspentIssued += requests.length;
    try {
      const out = await this.tokenIssuer.issue(requests.map(fromB64u));
      return out.map(b64u);
    } catch (e) {
      this.unspentIssued -= requests.length;
      throw new IssuerError(400, `bad token request: ${(e as Error).message}`);
    }
  }

  private checkBatch(requests: string[]) {
    if (!Array.isArray(requests) || requests.length === 0) throw new IssuerError(400, 'requests must be a non-empty array');
    if (requests.length > (this.opts.maxBatch ?? 200)) throw new IssuerError(400, 'batch too large');
  }

  // --- redemption --------------------------------------------------------

  /** Read-only: signature valid and not spent. Duplicates in one batch are invalid. */
  async verify(serialized: string[]): Promise<VerifyResult & { tokens: (Token | null)[] }> {
    if (!Array.isArray(serialized) || serialized.length === 0) throw new IssuerError(400, 'tokens must be a non-empty array');
    const seen = new Set<string>();
    const results: VerifyResult['results'] = [];
    const tokens: (Token | null)[] = [];
    for (const s of serialized) {
      let t: Token;
      try {
        t = deserializeToken(s);
      } catch {
        results.push({ ok: false, reason: 'malformed' });
        tokens.push(null);
        continue;
      }
      tokens.push(t);
      if (!(await this.verifier.verify(t))) {
        results.push({ ok: false, reason: 'bad signature' });
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

  /** Marks tokens spent (across all merchants), adds them to the merchant's tab, returns a signed claim. */
  async settle(merchantId: string, serialized: string[]): Promise<SignedClaim> {
    if (typeof merchantId !== 'string' || !merchantId) throw new IssuerError(400, 'merchantId required');
    const checked = await this.verify(serialized);
    // From here to the end there is no await, so the check and the mark are atomic.
    const ids = checked.tokens.map((t) => (t ? tokenId(t) : ''));
    if (!checked.valid || ids.some((id) => this.spent.has(id))) {
      const reason = checked.results.find((r) => !r.ok)?.reason ?? 'already spent';
      throw new IssuerError(409, `tokens rejected: ${reason}`);
    }
    for (const id of ids) this.spent.add(id);
    this.unspentIssued -= ids.length;
    const tab = this.tabs.get(merchantId) ?? { earned: 0, paid: 0, seq: 0 };
    tab.earned += ids.length;
    tab.seq += 1;
    this.tabs.set(merchantId, tab);
    return signClaim(this.claimKeys.privateKey, {
      v: 1,
      issuer: this.name,
      merchantId,
      totalTokens: tab.earned,
      totalRlusd: tokensToRlusd(tab.earned),
      seq: tab.seq,
      at: Date.now(),
    });
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
      at: Date.now(),
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

  markPaid(lines: PayoutLine[]) {
    for (const l of lines) {
      const t = this.tabs.get(l.merchantId);
      if (!t) continue;
      t.paid += l.amountTokens;
      this.fundsHeld -= l.amountTokens;
    }
  }
}
