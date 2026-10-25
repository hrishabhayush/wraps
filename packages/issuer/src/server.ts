// Issuer HTTP API.
//   GET  /attestation?nonce=<hex>   receipt over nonce + hash of public keys
//   POST /quote    {tokens}         price, payout address and quoteId to pay (no x402, for wallet apps)
//   POST /issue    {requests, payment?}  blind signatures once paid: payment in the body, or x402
//                                   (402 quote, then the x-payment header) for agents
//   POST /verify   {tokens}         read-only: signature valid and not spent
//   POST /settle   {merchantId, tokens}  mark spent, add to tab, signed running-total claim
//   GET  /reserves                  signed "outstanding ≤ funds held"
import { createServer, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { IssuerCore, IssuerError } from './core';
import { HttpError, RateLimiter, readJson, sendJson } from './http';
import { PAYMENT_HEADER, PaymentRequiredBody } from './protocol';

export interface IssuerServerOptions {
  /** Attestation requests per IP per minute. */
  attestationRateLimit?: number;
  /** Browser origins allowed to call the API (e.g. the Wraps desktop app's webview). */
  corsOrigins?: string[];
  /** Serve https with this key and self-signed certificate (PEM). */
  tls?: { keyPem: string; certPem: string };
}

export function createIssuerServer(core: IssuerCore, opts: IssuerServerOptions = {}): Server {
  const limiter = new RateLimiter(opts.attestationRateLimit ?? 60, 60_000);

  const cors = new Set(opts.corsOrigins ?? []);
  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', `content-type, ${PAYMENT_HEADER}`);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    try {
      const url = new URL(req.url ?? '/', 'http://issuer');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') return sendJson(res, 200, { ok: true, issuer: core.name });

      if (route === 'GET /attestation') {
        if (!limiter.allow(req.socket.remoteAddress ?? '?')) throw new HttpError(429, 'too many attestation requests');
        const nonceHex = url.searchParams.get('nonce') ?? '';
        if (!/^[0-9a-fA-F]+$/.test(nonceHex) || nonceHex.length % 2) throw new HttpError(400, 'nonce must be hex');
        return sendJson(res, 200, await core.attestation(new Uint8Array(Buffer.from(nonceHex, 'hex'))));
      }

      if (route === 'POST /quote') {
        const body = await readJson(req);
        const tokens = body.tokens;
        if (!Number.isInteger(tokens) || tokens < 1) throw new HttpError(400, 'tokens must be a positive integer');
        return sendJson(res, 200, core.quote(tokens));
      }
      if (route === 'POST /issue') {
        const body = await readJson(req);
        const requests: string[] = body.requests;
        // Payment proof in the body ({quoteId, txHash, ...}) or, for x402 clients, in the header.
        const payment = body.payment && typeof body.payment === 'object'
          ? Buffer.from(JSON.stringify(body.payment)).toString('base64url')
          : req.headers[PAYMENT_HEADER];
        if (typeof payment === 'string' && payment) {
          return sendJson(res, 200, { responses: await core.issuePaid(requests, payment) });
        }
        if (!Array.isArray(requests) || requests.length === 0) throw new HttpError(400, 'requests must be a non-empty array');
        const pr: PaymentRequiredBody = {
          x402Version: 1,
          error: 'payment required to issue tokens',
          accepts: [core.quote(requests.length)],
        };
        return sendJson(res, 402, pr);
      }

      if (route === 'POST /verify') {
        const body = await readJson(req);
        const { valid, results } = await core.verify(body.tokens);
        return sendJson(res, 200, { valid, results });
      }

      if (route === 'POST /settle') {
        const body = await readJson(req);
        return sendJson(res, 200, await core.settle(body.merchantId, body.tokens));
      }

      if (route === 'GET /reserves') return sendJson(res, 200, core.reserves());

      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof IssuerError || e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[issuer] internal error', e);
      sendJson(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  };
  return opts.tls ? createHttpsServer({ key: opts.tls.keyPem, cert: opts.tls.certPem }, handler) : createServer(handler);
}
