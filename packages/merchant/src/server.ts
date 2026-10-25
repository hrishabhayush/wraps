// One merchant, two services. Unpaid → 402 "blindtoken" with a single-use quote for this
// resource and price. Paid → issuer /verify, claim (quote, tokens) atomically, issuer /settle,
// check the claim against the attested issuer key, return data with no-store caching.
// An ambiguous /settle (timeout, network error, gateway 5xx) never reopens the quote blindly:
// the merchant asks the issuer's merchant-scoped /settle/status whether its own settle for this
// quote landed (SEC-03), and keeps the claim until it knows. "Spent by someone else" is never
// taken as proof of our own settle, so a payer racing the tokens at a second merchant gets
// served at most once.
import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AttestationVerifier } from '@wraps/attestation';
import {
  AttestedIssuer,
  BlindTokenRequiredBody,
  QUOTE_HEADER,
  SettleStatus,
  SignedClaim,
  Transport,
  fetchAttestedIssuer,
  issuerTransport,
  listenUrl,
  sendJson,
  signMerchantRequest,
  verifyClaim,
} from '@wraps/issuer';
import { challengeHeader, parseAuthorization, serializeToken, tokenId } from '@wraps/tokens';
import { ServiceDef, defaultServices } from './data';

export interface MerchantOptions {
  merchantId?: string;
  issuerUrl: string;
  verifier: AttestationVerifier;
  services?: ServiceDef[];
  injectPrompt?: boolean;
  transport?: Transport;
  log?: (msg: string) => void;
  /** SR5 freshness: how long a 402 quote can be paid. Default 60 s. */
  quoteTtlMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** How often to re-check the issuer's attestation, so 402s follow token key rotation (SR3). Default 10 min. */
  issuerRefreshMs?: number;
  /** Ed25519 key registered with the issuer for this merchant ID. */
  authPrivateKey?: KeyObject;
}

/** M5: paid responses must never be stored by a browser, proxy or CDN. */
export const PAID_RESPONSE_HEADERS = { 'cache-control': 'no-store, private', vary: 'authorization' } as const;

interface MerchantQuote {
  quoteId: string;
  serviceId: string;
  /** Path and query the quote was made for. */
  resource: string;
  price: number;
  expiresAt: number;
  /**
   * open: can be paid. claimed: a request is settling it now. unresolved: a /settle outcome was
   * ambiguous; the quote and its tokens stay held until a retry with the same tokens resolves it.
   * used: paid and served (or settled and refused for a bad claim).
   */
  state: 'open' | 'claimed' | 'unresolved' | 'used';
  /** Token ids held by this quote while it is claimed or unresolved. */
  tokenIds?: string[];
}

/** What one settle attempt proved. */
type SettleOutcome =
  | { kind: 'settled'; claim: SignedClaim }
  /** /settle/status says our settle for this quote landed, but we have no signed claim for it. */
  | { kind: 'settled-by-you' }
  /** The tokens were spent, but not by our settle for this quote. Never serve. */
  | { kind: 'settled-by-other' }
  /** Known not settled: the tokens are not spent and no settle can still land. */
  | { kind: 'refused'; reason: string }
  /** Not known. The settle may still land at the issuer. */
  | { kind: 'unknown'; reason: string };

/** Statuses a gateway sends while the issuer may still be working on the request. */
const GATEWAY_STATUSES = new Set([502, 504]);

const QUOTE_ID = /^[0-9a-f]{32}$/;
const MAX_OPEN_QUOTES = 10_000;

export class Merchant {
  readonly merchantId: string;
  readonly services: ServiceDef[];
  readonly claims: SignedClaim[] = [];
  private issuer?: AttestedIssuer;
  private readonly transport: Transport;
  /** Calls to the issuer. Over https this is pinned to the attested TLS key. */
  private issuerCall?: Transport;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly quotes = new Map<string, MerchantQuote>();
  /** Token ids claimed by a paid request that is still settling at the issuer. */
  private readonly inflight = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  server?: Server;

  constructor(private readonly opts: MerchantOptions) {
    this.merchantId = opts.merchantId ?? 'merchant-research-data';
    this.services = opts.services ?? defaultServices({ injectPrompt: opts.injectPrompt });
    // SR5: a zero, negative or fractional price is economically meaningless. Refuse the config.
    for (const s of this.services) {
      if (!Number.isInteger(s.price) || s.price < 1) throw new Error(`service ${s.id}: price must be a positive whole number of tokens`);
    }
    this.transport = opts.transport ?? fetch;
    this.log = opts.log ?? ((m) => console.log(`[merchant] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  get latestClaim(): SignedClaim | undefined {
    return this.claims[this.claims.length - 1];
  }

  /** Checks the issuer's attestation first, then listens. */
  async start(port = 0): Promise<string> {
    this.issuer = await fetchAttestedIssuer(this.opts.issuerUrl, this.opts.verifier, this.transport);
    this.issuerCall = issuerTransport(this.issuer, this.transport);
    const pinned = this.issuer.tlsKey ? ', TLS key pinned' : '';
    this.log(`issuer attestation verified (${this.issuer.attestation.format}, ${this.issuer.attestation.measurement.slice(0, 19)}…${pinned})`);
    this.refreshTimer = setInterval(() => void this.refreshIssuer(), this.opts.issuerRefreshMs ?? 10 * 60_000);
    this.refreshTimer.unref();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    return listenUrl(this.server);
  }

  /** Re-verifies the issuer's attestation. On failure, keeps the last verified issuer. */
  async refreshIssuer(): Promise<void> {
    try {
      this.issuer = await fetchAttestedIssuer(this.opts.issuerUrl, this.opts.verifier, this.transport);
      this.issuerCall = issuerTransport(this.issuer, this.transport);
    } catch (e) {
      this.log(`issuer attestation refresh failed: ${(e as Error).message}`);
    }
  }

  close(): Promise<void> {
    clearInterval(this.refreshTimer);
    return new Promise((r) => {
      if (!this.server) return r();
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://merchant');
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      if (url.pathname === '/services') {
        return sendJson(res, 200, this.services.map(({ id, path, name, price, description }) => ({ id, path, name, price, description })));
      }
      if (url.pathname === '/claims') {
        return sendJson(res, 200, { merchantId: this.merchantId, latest: this.latestClaim ?? null, count: this.claims.length });
      }
      const svc = this.services.find((s) => s.path === url.pathname);
      if (!svc) return sendJson(res, 404, { error: 'not found' });
      const resource = url.pathname + url.search;

      const tokens = parseAuthorization(req.headers.authorization);
      if (tokens.length === 0) {
        const error = req.headers.authorization ? 'malformed authorization header' : undefined;
        return this.paymentRequired(res, svc, resource, error);
      }
      if (tokens.length !== svc.price) {
        return this.paymentRequired(res, svc, resource, `send exactly ${svc.price} tokens, got ${tokens.length}`);
      }
      const serialized = tokens.map(serializeToken);
      const ids = tokens.map(tokenId);

      // A retry for a quote whose settle was ambiguous goes straight to settlement: its tokens may
      // already be spent by our own earlier /settle, so the read-only check below would refuse it.
      const quoteHeader = req.headers[QUOTE_HEADER];
      const quoteId = typeof quoteHeader === 'string' ? quoteHeader : '';
      const held = QUOTE_ID.test(quoteId) ? this.quotes.get(quoteId) : undefined;
      if (held?.state === 'unresolved') {
        if (held.serviceId !== svc.id || held.resource !== resource || held.price !== svc.price) {
          return this.paymentRequired(res, svc, resource, 'quote is for a different resource');
        }
        if (!sameIds(held.tokenIds ?? [], ids)) {
          return this.paymentRequired(res, svc, resource, 'quote has a settlement pending for other tokens');
        }
        held.state = 'claimed'; // no await since the check: one retry resolves it at a time
        return await this.settleAndServe(res, svc, url, held, serialized, ids, true);
      }

      // Read-only check first, so a replay gets the real reason ("already spent").
      const verify = await this.callIssuer('/verify', { tokens: serialized });
      if (!verify.ok || !verify.body.valid) {
        const reason = verify.body.results?.find((r: any) => !r.ok)?.reason ?? verify.body.error;
        return this.paymentRequired(res, svc, resource, `tokens rejected: ${reason}`);
      }

      // SR1 / M3: the payment must name a quote made for exactly this resource and price.
      const refusal = this.checkQuote(quoteId, svc, resource);
      if (refusal) return this.paymentRequired(res, svc, resource, refusal);

      // M3: claim (quote, tokens) atomically before any await. No other request can use this
      // quote, or these tokens at this merchant, until the claim is released or finished.
      if (ids.some((id) => this.inflight.has(id))) {
        return this.paymentRequired(res, svc, resource, 'tokens are already being settled');
      }
      const quote = this.quotes.get(quoteId)!;
      quote.state = 'claimed';
      quote.tokenIds = ids;
      for (const id of ids) this.inflight.add(id);
      return await this.settleAndServe(res, svc, url, quote, serialized, ids, false);
    } catch (e) {
      console.error('[merchant] error', e);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  /**
   * Settles a claimed quote, then serves, refuses, or holds it. The quote reopens only when the
   * merchant knows the tokens were not settled. If it cannot know, the quote and tokens stay held
   * ("unresolved") and the payer is told to retry with the same tokens and quote.
   */
  private async settleAndServe(
    res: ServerResponse,
    svc: ServiceDef,
    url: URL,
    quote: MerchantQuote,
    serialized: string[],
    ids: string[],
    retry: boolean,
  ): Promise<void> {
    const resource = quote.resource;
    // Default: if anything below throws, we do not know the outcome, so keep the claim.
    let next: MerchantQuote['state'] = 'unresolved';
    try {
      // SR4: data is released only after the issuer has settled (marked the tokens spent).
      // SR7: the issuer re-verifies inside /settle; the /verify before the claim is not trusted.
      const outcome = await this.settle(quote.quoteId, serialized, retry);
      if (outcome.kind === 'settled-by-other') {
        // SEC-03: the payer spent these tokens elsewhere while our settle was in doubt. Our settle
        // can no longer land (the issuer refuses spent tokens), so the quote reopens for a fresh
        // payment, and nothing is served for these tokens.
        next = 'open';
        this.log(`${svc.name}: tokens for quote ${quote.quoteId} were settled elsewhere; refusing`);
        return this.paymentRequired(res, svc, resource, 'settle failed: tokens were spent elsewhere');
      }
      if (outcome.kind === 'refused') {
        next = 'open';
        return this.paymentRequired(res, svc, resource, `settle failed: ${outcome.reason}`);
      }
      if (outcome.kind === 'unknown') {
        this.log(`${svc.name}: settle outcome unknown (${outcome.reason}); quote ${quote.quoteId} held until resolved`);
        return sendJson(
          res,
          503,
          { error: `settlement pending: ${outcome.reason}; retry with the same tokens and quote`, pending: true, quoteId: quote.quoteId },
          { 'retry-after': '1' },
        );
      }
      next = 'used';
      if (outcome.kind === 'settled-by-you') {
        // Our settle landed but its answer was lost. The issuer's tab includes these tokens and
        // the next signed claim will show them. Serve once: the quote is used from here on.
        this.log(`${svc.name}: paid ${svc.price} tokens (settle confirmed by /settle/status, claim lost in transit)`);
        return sendJson(res, 200, { service: svc.id, quoteId: quote.quoteId, data: svc.handler(url.searchParams) }, PAID_RESPONSE_HEADERS);
      }
      const claim = outcome.claim;
      const prev = this.latestClaim?.claim.totalTokens ?? 0;
      const prevSeq = this.latestClaim?.claim.seq ?? 0;
      // On a retry, idempotent /settle returns the original claim of our earlier settle. Later
      // claims may have arrived since, so an older claim is accepted there, but not stored.
      const replayed = retry && claim.claim.seq <= prevSeq;
      if (!verifyClaim(claim, this.issuer!.claimKey) || claim.claim.merchantId !== this.merchantId || (!replayed && claim.claim.totalTokens < prev + svc.price)) {
        // The tokens are spent, but the issuer's promise is bad. Refuse to serve and shout.
        this.log('ALERT: issuer claim failed verification');
        return sendJson(res, 502, { error: 'issuer claim failed verification' });
      }
      if (!replayed) this.claims.push(claim);
      this.log(`${svc.name}: paid ${svc.price} tokens. Issuer owes us ${claim.claim.totalTokens} tokens (${claim.claim.totalRlusd} RLUSD), claim #${claim.claim.seq} verified`);
      return sendJson(res, 200, { service: svc.id, quoteId: quote.quoteId, data: svc.handler(url.searchParams) }, PAID_RESPONSE_HEADERS);
    } finally {
      quote.state = next;
      // Unresolved: keep the tokens held, so no other quote at this merchant can take them.
      if (next !== 'unresolved') {
        for (const id of ids) this.inflight.delete(id);
        quote.tokenIds = undefined;
      }
    }
  }

  /**
   * One /settle call, classified. 2xx with a claim: settled. 4xx: the issuer refused, and its
   * settle is atomic, so nothing was marked. Anything else is ambiguous, so ask /settle/status
   * (read-only, merchant-scoped) whether our settle for this quote landed. /settle is idempotent
   * per (merchantId, quoteId, tokens), so a retry with the same tokens returns the original claim.
   */
  private async settle(quoteId: string, serialized: string[], retry: boolean): Promise<SettleOutcome> {
    let status = 0;
    let reason: string;
    try {
      const r = await this.requestIssuer('/settle', { merchantId: this.merchantId, quoteId, tokens: serialized }, true);
      status = r.status;
      const body = await r.json().catch(() => undefined);
      if (r.ok && body?.claim && typeof body.signature === 'string') return { kind: 'settled', claim: body as SignedClaim };
      reason = body?.error ?? `issuer answered ${r.status}`;
      // A first attempt refused by the issuer is final. On a retry, "already spent" means the
      // tokens were spent by someone else (our own settle would replay), but look it up to be sure.
      if (status >= 400 && status < 500 && !(retry && /already spent/.test(reason))) return { kind: 'refused', reason };
    } catch (e) {
      reason = `issuer unreachable: ${(e as Error).message}`;
    }

    let lookup: { ok: boolean; body: any };
    try {
      lookup = await this.callIssuer('/settle/status', { merchantId: this.merchantId, quoteId, tokens: serialized }, true);
    } catch (e) {
      return { kind: 'unknown', reason: `${reason}; /settle/status failed: ${(e as Error).message}` };
    }
    const answer: SettleStatus | undefined = lookup.ok ? lookup.body?.status : undefined;
    switch (answer) {
      case 'settled-by-you':
        return { kind: 'settled-by-you' };
      case 'settled-by-other':
        return { kind: 'settled-by-other' };
      case 'expired':
        // Not spent and too old: the issuer refuses to settle it, now or later.
        return { kind: 'refused', reason: `${reason}; tokens expired` };
      case 'unspent': {
        // Not spent. If the issuer itself answered, its settle is over and did not land. After a
        // network error or a gateway status, the request may still reach the issuer later.
        const issuerAnswered = status !== 0 && !GATEWAY_STATUSES.has(status);
        return issuerAnswered ? { kind: 'refused', reason } : { kind: 'unknown', reason };
      }
      default: {
        // A 4xx from the lookup means the tokens themselves are bad (malformed, bad signature):
        // no settle of them can land. Anything else is no answer.
        const status4xx = !lookup.ok && typeof lookup.body?.error === 'string';
        if (status4xx && /tokens rejected/.test(lookup.body.error)) return { kind: 'refused', reason: `${reason}; ${lookup.body.error}` };
        return { kind: 'unknown', reason: `${reason}; /settle/status gave no answer` };
      }
    }
  }

  /** Returns why a quote cannot pay for this request, or undefined if it can. */
  private checkQuote(quoteId: string, svc: ServiceDef, resource: string): string | undefined {
    if (!quoteId) return `payment must reference a quote (${QUOTE_HEADER})`;
    if (!QUOTE_ID.test(quoteId)) return 'malformed quote id';
    const q = this.quotes.get(quoteId);
    if (!q) return 'unknown quote';
    if (q.state !== 'open') return 'quote already used';
    if (this.now() > q.expiresAt) return 'quote expired';
    if (q.serviceId !== svc.id || q.resource !== resource || q.price !== svc.price) return 'quote is for a different resource';
    return undefined;
  }

  private newQuote(svc: ServiceDef, resource: string): MerchantQuote {
    const now = this.now();
    // Never drop a quote that holds tokens: that would lose a paid request.
    const holds = (q: MerchantQuote) => q.state === 'claimed' || q.state === 'unresolved';
    for (const [id, q] of this.quotes) if (!holds(q) && (q.state === 'used' || now > q.expiresAt)) this.quotes.delete(id);
    if (this.quotes.size >= MAX_OPEN_QUOTES) {
      for (const [id, q] of this.quotes) {
        if (!holds(q)) {
          this.quotes.delete(id);
          break;
        }
      }
    }
    const q: MerchantQuote = {
      quoteId: randomBytes(16).toString('hex'),
      serviceId: svc.id,
      resource,
      price: svc.price,
      expiresAt: now + (this.opts.quoteTtlMs ?? 60_000),
      state: 'open',
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }

  private paymentRequired(res: ServerResponse, svc: ServiceDef, resource: string, error?: string) {
    const issuer = this.issuer!;
    const q = this.newQuote(svc, resource);
    const body: BlindTokenRequiredBody & { error?: string } = {
      scheme: 'blindtoken',
      price: svc.price,
      unit: 'token',
      service: svc.id,
      issuer: issuer.url,
      issuerName: issuer.issuerName,
      quoteId: q.quoteId,
      resource,
      expiresAt: q.expiresAt,
      ...(error ? { error } : {}),
    };
    sendJson(res, 402, body, { 'www-authenticate': challengeHeader(issuer.tokenKey, issuer.issuerName) });
  }

  private async callIssuer(path: string, body: unknown, authenticate = false): Promise<{ ok: boolean; body: any }> {
    const r = await this.requestIssuer(path, body, authenticate);
    return { ok: r.ok, body: await r.json() };
  }

  private requestIssuer(path: string, payload: unknown, authenticate = false): Promise<Response> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authenticate && this.opts.authPrivateKey) {
      Object.assign(headers, signMerchantRequest(
        this.opts.authPrivateKey,
        this.merchantId,
        'POST',
        path,
        body,
        this.now(),
      ));
    }
    return this.issuerCall!(`${this.opts.issuerUrl}${path}`, {
      method: 'POST',
      headers,
      body,
    });
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}
