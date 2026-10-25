import { X509Certificate } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hashPublicKeys, type AttestationProvider } from '@wraps/attestation';

export interface RelayAttestationResponse {
  format: string;
  publicKeys: { tunnel: string };
  tlsCertificate: string;
  attestation: string;
}

export interface RelayAttestationOptions {
  /** Self-signed TLS certificate for the listener, generated inside the workload. */
  tlsCertificate: string;
  /** Workload attestation provider (Google Confidential Space in production). */
  provider: AttestationProvider;
}

export interface RelayAttestationListenOptions extends RelayAttestationOptions {
  /** Defaults to 127.0.0.1; set explicitly when exposed through the workload. */
  host?: string;
  /** Defaults to 8080. The SDK must be configured with this HTTP URL. */
  port?: number;
  /** Maximum receipts per client IP in one minute. Defaults to 60. */
  requestsPerMinute?: number;
}

/**
 * Create the SDK's nonce-bound relay receipt from the TLS listener certificate.
 * The returned SPKI is the same key used by the relay TLS server.
 */
export async function createRelayAttestationResponse(
  nonce: Uint8Array,
  options: RelayAttestationOptions,
): Promise<RelayAttestationResponse> {
  if (nonce.byteLength !== 32) throw new TypeError('attestation nonce must be 32 bytes');

  const certificate = new X509Certificate(options.tlsCertificate);
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
    throw new TypeError('relay TLS certificate must be self-signed');
  }

  const tunnelKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const publicKeys = { tunnel: new Uint8Array(tunnelKey) };
  const publicKeysHash = hashPublicKeys(publicKeys);
  const attestation = await options.provider.attest(nonce, publicKeysHash);

  return {
    format: options.provider.format,
    publicKeys: { tunnel: Buffer.from(publicKeys.tunnel).toString('base64url') },
    tlsCertificate: options.tlsCertificate,
    attestation,
  };
}

/**
 * Handle GET /attestation?nonce=<64 hex chars>. Returns false for other paths
 * so the caller can route those to the relay or a health handler.
 */
export async function serveRelayAttestation(
  req: IncomingMessage,
  res: ServerResponse,
  options: RelayAttestationOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://relay.invalid');
  if (url.pathname !== '/attestation') return false;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'GET required' });
    return true;
  }

  const nonces = url.searchParams.getAll('nonce');
  if (nonces.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(nonces[0])) {
    sendJson(res, 400, { error: 'nonce must be 32 bytes encoded as hex' });
    return true;
  }

  try {
    const receipt = await createRelayAttestationResponse(Buffer.from(nonces[0], 'hex'), options);
    sendJson(res, 200, receipt);
  } catch {
    // Do not expose provider details or certificate material on failure.
    sendJson(res, 503, { error: 'attestation unavailable' });
  }
  return true;
}

/** Create the separate HTTP listener used for nonce-bound receipts. */
export function createRelayAttestationServer(options: RelayAttestationOptions & { requestsPerMinute?: number }): Server {
  const limits = new Map<string, { count: number; startedAt: number }>();
  const max = options.requestsPerMinute ?? 60;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('requestsPerMinute must be a positive integer');
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void (async () => {
      const address = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(address, limits, max)) {
        sendJson(res, 429, { error: 'attestation rate limit exceeded' });
        return;
      }
      if (!(await serveRelayAttestation(req, res, options))) {
        sendJson(res, 404, { error: 'not found' });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 503, { error: 'attestation unavailable' });
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}

/** Start the separately configurable HTTP receipt listener. */
export function startRelayAttestationServer(options: RelayAttestationListenOptions): Server {
  const server = createRelayAttestationServer(options);
  server.listen(options.port ?? 8080, options.host ?? '127.0.0.1');
  return server;
}

function isRateLimited(
  address: string,
  limits: Map<string, { count: number; startedAt: number }>,
  max: number,
): boolean {
  const now = Date.now();
  for (const [key, value] of limits) {
    if (now - value.startedAt >= 60_000) limits.delete(key);
  }
  let window = limits.get(address);
  if (!window || now - window.startedAt >= 60_000) {
    if (limits.size >= 4096 && !window) return true;
    window = { count: 0, startedAt: now };
    limits.set(address, window);
  }
  window.count++;
  return window.count > max;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}
