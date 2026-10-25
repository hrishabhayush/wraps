// One merchant, two services. Unpaid → 402 "blindtoken" with a single-use quote for this
// resource and price. Paid → issuer /verify, claim (quote, tokens) atomically, issuer /settle,
// check the claim against the attested issuer key, return data with no-store caching.
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AttestationVerifier } from '@wraps/attestation';
import {
  AttestedIssuer,
  BlindTokenRequiredBody,
  QUOTE_HEADER,
  SignedClaim,
  Transport,
  fetchAttestedIssuer,
  issuerTransport,
  listenUrl,
  sendJson,
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
  state: 'open' | 'claimed' | 'used';
}

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
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    return listenUrl(this.server);
  }

  close(): Promise<void> {
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

      const issuer = this.issuer!;
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

      // Read-only check first, so a replay gets the real reason ("already spent").
      const verify = await this.callIssuer('/verify', { tokens: serialized });
      if (!verify.ok || !verify.body.valid) {
        const reason = verify.body.results?.find((r: any) => !r.ok)?.reason ?? verify.body.error;
        return this.paymentRequired(res, svc, resource, `tokens rejected: ${reason}`);
      }

      // SR1 / M3: the payment must name a quote made for exactly this resource and price.
      const quoteHeader = req.headers[QUOTE_HEADER];
      const quoteId = typeof quoteHeader === 'string' ? quoteHeader : '';
      const refusal = this.checkQuote(quoteId, svc, resource);
      if (refusal) return this.paymentRequired(res, svc, resource, refusal);

      // M3: claim (quote, tokens) atomically before any await. No other request can use this
      // quote, or these tokens at this merchant, until the claim is released or finished.
      if (ids.some((id) => this.inflight.has(id))) {
        return this.paymentRequired(res, svc, resource, 'tokens are already being settled');
      }
      const quote = this.quotes.get(quoteId)!;
      quote.state = 'claimed';
      for (const id of ids) this.inflight.add(id);
      let settled = false;
      try {
        // SR4: data is released only after the issuer has settled (marked the tokens spent).
        // SR7: the issuer re-verifies inside /settle; the /verify above is not trusted.
        const settle = await this.callIssuer('/settle', { merchantId: this.merchantId, tokens: serialized });
        if (!settle.ok) return this.paymentRequired(res, svc, resource, `settle failed: ${settle.body.error}`);
        settled = true;
        const claim = settle.body as SignedClaim;
        const prev = this.latestClaim?.claim.totalTokens ?? 0;
        if (!verifyClaim(claim, issuer.claimKey) || claim.claim.merchantId !== this.merchantId || claim.claim.totalTokens < prev + svc.price) {
          // The tokens are spent, but the issuer's promise is bad. Refuse to serve and shout.
          this.log('ALERT: issuer claim failed verification');
          return sendJson(res, 502, { error: 'issuer claim failed verification' });
        }
        this.claims.push(claim);
        this.log(`${svc.name}: paid ${svc.price} tokens. Issuer owes us ${claim.claim.totalTokens} tokens (${claim.claim.totalRlusd} RLUSD), claim #${claim.claim.seq} verified`);
        return sendJson(res, 200, { service: svc.id, quoteId, data: svc.handler(url.searchParams) }, PAID_RESPONSE_HEADERS);
      } finally {
        for (const id of ids) this.inflight.delete(id);
        // Unsettled payment: the quote can be paid again. Settled: it is used up for good.
        quote.state = settled ? 'used' : 'open';
      }
    } catch (e) {
      console.error('[merchant] error', e);
      sendJson(res, 500, { error: 'internal error' });
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
    for (const [id, q] of this.quotes) if (q.state !== 'claimed' && (q.state === 'used' || now > q.expiresAt)) this.quotes.delete(id);
    if (this.quotes.size >= MAX_OPEN_QUOTES) this.quotes.delete(this.quotes.keys().next().value!);
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

  private async callIssuer(path: string, body: unknown): Promise<{ ok: boolean; body: any }> {
    const r = await this.issuerCall!(`${this.opts.issuerUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, body: await r.json() };
  }
}
