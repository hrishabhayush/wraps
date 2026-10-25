// HTTPS server with the enclave's self-signed certificate.
// Built-in routes: GET /attestation?nonce=<hex>, GET /healthz. Everything else goes to the app.
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EnclaveIdentity } from './identity';
import { appPort, listenHost } from './mode';
import { log } from './log';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface EnclaveServerOptions {
  identity: EnclaveIdentity;
  /** The app's request handler. Express, Hono (node adapter) or a plain function all fit. */
  handler?: Handler;
  port?: number;
  host?: string;
  /** Attestation rate limit (SPEC §12). Default: 5 per second, bursts of 20. */
  attestationRatePerSec?: number;
  attestationBurst?: number;
}

/** Min and max nonce length in bytes. NSM accepts more; we keep requests small. */
const NONCE_MIN = 16;
const NONCE_MAX = 64;

export function startEnclaveServer(opts: EnclaveServerOptions): Server {
  const bucket = new TokenBucket(opts.attestationRatePerSec ?? 5, opts.attestationBurst ?? 20);
  const attestation = attestationHandler(opts.identity, bucket);

  const server = createServer(
    { key: opts.identity.tls.keyPem, cert: opts.identity.tls.certPem, minVersion: 'TLSv1.3' },
    (req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/attestation') return void attestation(req, res);
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, role: opts.identity.role });
      if (opts.handler) return void Promise.resolve(opts.handler(req, res)).catch((err) => fail(res, err));
      json(res, 404, { error: 'not_found' });
    },
  );
  const port = opts.port ?? appPort();
  const host = opts.host ?? listenHost();
  server.listen(port, host, () =>
    log('info', 'enclave server listening', { role: opts.identity.role, port, tlsSpkiSha256: opts.identity.tls.spkiSha256 }),
  );
  return server;
}

/** Standalone handler, for apps that run their own server. */
export function attestationHandler(identity: EnclaveIdentity, bucket = new TokenBucket(5, 20)): Handler {
  return async (req, res) => {
    if (!bucket.take()) return json(res, 429, { error: 'rate_limited' });
    const nonceHex = new URL(req.url ?? '/', 'https://enclave').searchParams.get('nonce') ?? '';
    if (!/^[0-9a-fA-F]+$/.test(nonceHex) || nonceHex.length % 2 !== 0) {
      return json(res, 400, { error: 'bad_nonce', detail: 'nonce must be hex' });
    }
    const nonce = Buffer.from(nonceHex, 'hex');
    if (nonce.length < NONCE_MIN || nonce.length > NONCE_MAX) {
      return json(res, 400, { error: 'bad_nonce', detail: `nonce must be ${NONCE_MIN} to ${NONCE_MAX} bytes` });
    }
    try {
      json(res, 200, await identity.attest(nonce));
    } catch (err) {
      fail(res, err);
    }
  };
}

export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function fail(res: ServerResponse, err: unknown): void {
  log('error', 'request failed', { error: (err as Error).message });
  if (!res.headersSent) json(res, 500, { error: 'internal' });
  else res.end();
}
