// One merchant, two services. Unpaid → 402 "blindtoken". Paid → issuer /verify,
// then /settle, check the claim against the attested issuer key, return data.
import { createServer, Server } from 'node:http';
import type { AttestationVerifier } from '@wraps/attestation';
import {
  AttestedIssuer,
  BlindTokenRequiredBody,
  SignedClaim,
  Transport,
  fetchAttestedIssuer,
  listenUrl,
  sendJson,
  verifyClaim,
} from '@wraps/issuer';
import { challengeHeader, parseAuthorization, serializeToken } from '@wraps/tokens';
import { ServiceDef, defaultServices } from './data';

export interface MerchantOptions {
  merchantId?: string;
  issuerUrl: string;
  verifier: AttestationVerifier;
  services?: ServiceDef[];
  injectPrompt?: boolean;
  transport?: Transport;
  log?: (msg: string) => void;
}

export class Merchant {
  readonly merchantId: string;
  readonly services: ServiceDef[];
  readonly claims: SignedClaim[] = [];
  private issuer?: AttestedIssuer;
  private readonly transport: Transport;
  private readonly log: (msg: string) => void;
  server?: Server;

  constructor(private readonly opts: MerchantOptions) {
    this.merchantId = opts.merchantId ?? 'merchant-research-data';
    this.services = opts.services ?? defaultServices({ injectPrompt: opts.injectPrompt });
    this.transport = opts.transport ?? fetch;
    this.log = opts.log ?? ((m) => console.log(`[merchant] ${m}`));
  }

  get latestClaim(): SignedClaim | undefined {
    return this.claims[this.claims.length - 1];
  }

  /** Checks the issuer's attestation first, then listens. */
  async start(port = 0): Promise<string> {
    this.issuer = await fetchAttestedIssuer(this.opts.issuerUrl, this.opts.verifier, this.transport);
    this.log(`issuer attestation verified (PCR0 ${this.issuer.attestation.pcrs['0'].slice(0, 12)}…)`);
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

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
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

      const issuer = this.issuer!;
      const tokens = parseAuthorization(req.headers.authorization);
      if (tokens.length === 0) return this.paymentRequired(res, svc);
      if (tokens.length !== svc.price) {
        return this.paymentRequired(res, svc, `send exactly ${svc.price} tokens, got ${tokens.length}`);
      }
      const serialized = tokens.map(serializeToken);

      const verify = await this.callIssuer('/verify', { tokens: serialized });
      if (!verify.ok || !verify.body.valid) {
        const reason = verify.body.results?.find((r: any) => !r.ok)?.reason ?? verify.body.error;
        return this.paymentRequired(res, svc, `tokens rejected: ${reason}`);
      }
      const settle = await this.callIssuer('/settle', { merchantId: this.merchantId, tokens: serialized });
      if (!settle.ok) return this.paymentRequired(res, svc, `settle failed: ${settle.body.error}`);
      const claim = settle.body as SignedClaim;
      const prev = this.latestClaim?.claim.totalTokens ?? 0;
      if (!verifyClaim(claim, issuer.claimKey) || claim.claim.merchantId !== this.merchantId || claim.claim.totalTokens < prev + svc.price) {
        // The tokens are spent, but the issuer's promise is bad. Refuse to serve and shout.
        this.log('ALERT: issuer claim failed verification');
        return sendJson(res, 502, { error: 'issuer claim failed verification' });
      }
      this.claims.push(claim);
      this.log(`${svc.name}: paid ${svc.price} tokens. Issuer owes us ${claim.claim.totalTokens} tokens (${claim.claim.totalRlusd} RLUSD), claim #${claim.claim.seq} verified`);
      return sendJson(res, 200, { service: svc.id, data: svc.handler(url.searchParams) });
    } catch (e) {
      console.error('[merchant] error', e);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private paymentRequired(res: import('node:http').ServerResponse, svc: ServiceDef, error?: string) {
    const issuer = this.issuer!;
    const body: BlindTokenRequiredBody & { error?: string } = {
      scheme: 'blindtoken',
      price: svc.price,
      unit: 'token',
      service: svc.id,
      issuer: issuer.url,
      issuerName: issuer.issuerName,
      ...(error ? { error } : {}),
    };
    sendJson(res, 402, body, { 'www-authenticate': challengeHeader(issuer.tokenKey, issuer.issuerName) });
  }

  private async callIssuer(path: string, body: unknown): Promise<{ ok: boolean; body: any }> {
    const r = await this.transport(`${this.opts.issuerUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, body: await r.json() };
  }
}
