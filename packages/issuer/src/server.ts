// Issuer HTTP API.
//   GET  /attestation?nonce=<hex>   receipt over nonce + hash of public keys
//   POST /quote    {tokens}         price, payout address and quoteId to pay (no x402, for wallet apps)
//   POST /issue    {requests, payment?}  blind signatures once paid: payment in the body, or x402
//                                   (402 quote, then the x-payment header) for agents
//   POST /verify   {tokens}         read-only: signature valid and not spent
//   POST /settle   {merchantId, quoteId?, tokens}  mark spent, add to tab, signed running-total claim.
//                                   With a quoteId it is idempotent per (merchantId, quoteId) (SEC-03).
//   POST /settle/status {merchantId, quoteId, tokens}  read-only: settled-by-you, settled-by-other,
//                                   unspent or expired. Never names another merchant (SEC-03).
//   GET  /reserves                  signed "outstanding ≤ funds held"
//   GET  /keys                      token key epochs with not-after times, signed with the claim key
//   GET  /payouts?merchantId=<id>   signed payout records (amount, tx hash) for one merchant
//   GET  /payouts/pending           admin: next payout batch and its transfers, nothing sent
//   POST /payouts/run               admin: send one payout batch now
// Admin routes need `authorization: Bearer <adminToken>`, or a loopback caller when no token is set.
import { timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { IssuerCore, IssuerError } from './core';
import { HttpError, RateLimiter, readJson, readJsonWithRaw, sendJson } from './http';
import type { PayoutScheduler } from './payout';
import { PAYMENT_HEADER, PaymentRequiredBody } from './protocol';
import { MerchantAuthConfig, verifyMerchantRequest } from './merchant-auth';

export interface IssuerServerOptions {
  /** Attestation requests per IP per minute. */
  attestationRateLimit?: number;
  /** Browser origins allowed to call the API (e.g. the Wraps desktop app's webview). */
  corsOrigins?: string[];
  /** Serve https with this key and self-signed certificate (PEM). */
  tls?: { keyPem: string; certPem: string };
  /** Payout job, for the admin routes. */
  payouts?: PayoutScheduler;
  /** Bearer token for admin routes. Without it, only loopback callers are allowed. */
  adminToken?: string;
  /** Per-merchant settlement and payout-history authentication. Missing config denies all merchants. */
  merchantAuth?: MerchantAuthConfig;
}

function isAdmin(req: IncomingMessage, token?: string): boolean {
  if (token) {
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createIssuerServer(core: IssuerCore, opts: IssuerServerOptions = {}): Server {
  const limiter = new RateLimiter(opts.attestationRateLimit ?? 60, 60_000);

  const cors = new Set(opts.corsOrigins ?? []);
  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', `content-type, ${PAYMENT_HEADER}, x-wraps-merchant-signature, x-wraps-merchant-timestamp, x-wraps-merchant-nonce, authorization`);
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
        const { value: body, raw } = await readJsonWithRaw(req);
        await authenticateMerchant(req, core, opts.merchantAuth, String(body?.merchantId ?? ''), req.url ?? '/settle', raw);
        return sendJson(res, 200, await core.settle(body.merchantId, body.tokens, body.quoteId ?? undefined));
      }

      if (route === 'POST /settle/status') {
        const { value: body, raw } = await readJsonWithRaw(req);
        await authenticateMerchant(req, core, opts.merchantAuth, String(body?.merchantId ?? ''), req.url ?? '/settle/status', raw);
        return sendJson(res, 200, { status: await core.settleStatus(body.merchantId, body.quoteId, body.tokens) });
      }

      if (route === 'GET /reserves') return sendJson(res, 200, core.reserves());
      if (route === 'GET /keys') {
        await core.refreshTokenKey();
        return sendJson(res, 200, core.tokenKeys());
      }

      if (route === 'GET /payouts') {
        const merchantId = url.searchParams.get('merchantId') ?? '';
        if (!merchantId) throw new HttpError(400, 'merchantId required');
        await authenticateMerchant(req, core, opts.merchantAuth, merchantId, req.url ?? '/payouts', Buffer.alloc(0));
        return sendJson(res, 200, { merchantId, payouts: core.payoutHistory(merchantId) });
      }
      if (route === 'GET /payouts/pending' || route === 'POST /payouts/run') {
        const job = opts.payouts;
        if (!job) throw new HttpError(404, 'not found');
        if (!isAdmin(req, opts.adminToken)) throw new HttpError(403, 'admin only');
        const rail = job.rail as { name?: string; canSend?: boolean; address?: string };
        const info = { rail: rail.name ?? 'custom', canSend: rail.canSend ?? true, from: rail.address, caps: job.caps };
        if (route === 'GET /payouts/pending') return sendJson(res, 200, json({ ...info, ...job.preview() }));
        const paid = await job.runOnce().catch((e: Error) => {
          throw new HttpError(409, e.message);
        });
        return sendJson(res, 200, { ...info, paid, unpaid: core.pendingPayouts() });
      }

      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof IssuerError || e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[issuer] internal error', e);
      sendJson(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  };
  return opts.tls ? createHttpsServer({ key: opts.tls.keyPem, cert: opts.tls.certPem }, handler) : createServer(handler);
}

async function authenticateMerchant(
  req: IncomingMessage,
  core: IssuerCore,
  config: MerchantAuthConfig | undefined,
  merchantId: string,
  path: string,
  rawBody: Uint8Array,
): Promise<void> {
  if (config?.developmentMode && isLoopback(req.socket.remoteAddress ?? '')) return;
  const result = verifyMerchantRequest(config, merchantId, req.method ?? 'GET', path, rawBody, req.headers, core.currentTime());
  if (!result.ok) throw new HttpError(result.status, result.message);
  if (result.nonce && result.timestamp !== undefined) {
    await core.consumeMerchantNonce(merchantId, result.nonce, result.timestamp, config?.timestampWindowMs ?? 60_000);
  }
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
