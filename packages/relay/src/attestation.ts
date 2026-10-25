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
  /** Optional WireGuard identity for the separate /wireguard-attestation receipt. */
  wireGuard?: {
    publicKey: string;
    policyHash: string;
    endpoint: string;
    listenPort: number;
    interfaceAddress: string;
    egressInterface: string;
    peers: Array<{ publicKey: string; allowedAddress: string }>;
    clientAllowedIPs: '0.0.0.0/0';
  };
}

export interface WireGuardAttestationResponse {
  format: string;
  publicKeys: { tunnel: string; wireguard: string; policy: string };
  endpoint: string;
  listenPort: number;
  interfaceAddress: string;
  clientAllowedIPs: '0.0.0.0/0';
  networkPolicy: {
    endpoint: string;
    listenPort: number;
    interfaceAddress: string;
    egressInterface: string;
    peers: Array<{ publicKey: string; allowedAddress: string }>;
    clientAllowedIPs: '0.0.0.0/0';
    ipv6Forwarding: false;
  };
  attestation: string;
}

export interface RelayAttestationListenOptions extends RelayAttestationOptions {
  /** Defaults to 127.0.0.1; set explicitly when exposed through the workload. */
  host?: string;
  /** Defaults to 8080. The SDK must be configured with this HTTP URL. */
  port?: number;
  /** Maximum receipts per client IP in one minute. Defaults to 60. */
  requestsPerMinute?: number;
  /** Maximum receipts across all clients in one minute. Defaults to 120. */
  globalRequestsPerMinute?: number;
  /** Maximum provider calls in flight. Defaults to 4. Timed-out calls keep their slot until settled. */
  maxConcurrentAttestations?: number;
  /** Maximum time to wait for the provider before returning 503. Defaults to 5 seconds. */
  providerTimeoutMs?: number;
}

const DEFAULT_GLOBAL_REQUESTS_PER_MINUTE = 120;
const DEFAULT_MAX_CONCURRENT_ATTESTATIONS = 4;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;

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

/** Bind the WireGuard endpoint key and the configured peer/routing policy to a fresh receipt. */
export async function createWireGuardAttestationResponse(
  nonce: Uint8Array,
  options: RelayAttestationOptions,
): Promise<WireGuardAttestationResponse> {
  if (!options.wireGuard) throw new TypeError('WireGuard is not configured');
  if (nonce.byteLength !== 32) throw new TypeError('attestation nonce must be 32 bytes');
  if (!/^[A-Za-z0-9+/]{42}=$/.test(options.wireGuard.publicKey)) throw new TypeError('invalid WireGuard public key');
  if (Buffer.from(options.wireGuard.publicKey, 'base64').byteLength !== 32 || Buffer.from(options.wireGuard.publicKey, 'base64').toString('base64') !== options.wireGuard.publicKey) throw new TypeError('invalid WireGuard public key');
  if (!/^[0-9a-f]{64}$/.test(options.wireGuard.policyHash)) throw new TypeError('invalid WireGuard policy hash');

  const certificate = new X509Certificate(options.tlsCertificate);
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
    throw new TypeError('relay TLS certificate must be self-signed');
  }
  const publicKeys = {
    tunnel: new Uint8Array(certificate.publicKey.export({ type: 'spki', format: 'der' })),
    wireguard: new Uint8Array(Buffer.from(options.wireGuard.publicKey, 'base64')),
    policy: new Uint8Array(Buffer.from(options.wireGuard.policyHash, 'hex')),
  };
  const attestation = await options.provider.attest(nonce, hashPublicKeys(publicKeys));
  return {
    format: options.provider.format,
    publicKeys: {
      tunnel: Buffer.from(publicKeys.tunnel).toString('base64url'),
      wireguard: options.wireGuard.publicKey,
      policy: options.wireGuard.policyHash,
    },
    endpoint: options.wireGuard.endpoint,
    listenPort: options.wireGuard.listenPort,
    interfaceAddress: options.wireGuard.interfaceAddress,
    clientAllowedIPs: options.wireGuard.clientAllowedIPs,
    networkPolicy: {
      endpoint: options.wireGuard.endpoint,
      listenPort: options.wireGuard.listenPort,
      interfaceAddress: options.wireGuard.interfaceAddress,
      egressInterface: options.wireGuard.egressInterface,
      peers: [...options.wireGuard.peers].sort((a, b) => a.publicKey.localeCompare(b.publicKey)),
      clientAllowedIPs: options.wireGuard.clientAllowedIPs,
      ipv6Forwarding: false,
    },
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
  const wireGuardRequest = url.pathname === '/wireguard-attestation';
  if (url.pathname !== '/attestation' && !wireGuardRequest) return false;

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
    const receipt = wireGuardRequest
      ? await createWireGuardAttestationResponse(Buffer.from(nonces[0], 'hex'), options)
      : await createRelayAttestationResponse(Buffer.from(nonces[0], 'hex'), options);
    sendJson(res, 200, receipt);
  } catch {
    // Do not expose provider details or certificate material on failure.
    sendJson(res, 503, { error: 'attestation unavailable' });
  }
  return true;
}

/** Create the separate HTTP listener used for nonce-bound receipts. */
export function createRelayAttestationServer(options: RelayAttestationListenOptions): Server {
  const limits = new Map<string, { count: number; startedAt: number }>();
  const maxPerIp = options.requestsPerMinute ?? 60;
  const maxGlobal = options.globalRequestsPerMinute ?? DEFAULT_GLOBAL_REQUESTS_PER_MINUTE;
  const maxConcurrent = options.maxConcurrentAttestations ?? DEFAULT_MAX_CONCURRENT_ATTESTATIONS;
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  for (const [name, value] of Object.entries({
    requestsPerMinute: maxPerIp,
    globalRequestsPerMinute: maxGlobal,
    maxConcurrentAttestations: maxConcurrent,
    providerTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  let globalWindow = { count: 0, startedAt: Date.now() };
  let inFlightAttestations = 0;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://relay.invalid');
      if (url.pathname !== '/attestation') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET required' });
        return;
      }
      const nonces = url.searchParams.getAll('nonce');
      if (nonces.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(nonces[0])) {
        sendJson(res, 400, { error: 'nonce must be 32 bytes encoded as hex' });
        return;
      }

      const address = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(address, limits, maxPerIp)) {
        sendJson(res, 429, { error: 'attestation rate limit exceeded' });
        return;
      }
      if (isGlobalRateLimited(globalWindow, maxGlobal)) {
        sendJson(res, 429, { error: 'global attestation rate limit exceeded' });
        return;
      }
      if (inFlightAttestations >= maxConcurrent) {
        sendJson(res, 503, { error: 'attestation capacity reached' });
        return;
      }

      inFlightAttestations++;
      const operation = createRelayAttestationResponse(Buffer.from(nonces[0], 'hex'), options).then(
        (receipt) => ({ kind: 'receipt' as const, receipt }),
        () => ({ kind: 'failure' as const }),
      );
      // Keep timed-out work counted until its provider promise actually settles.
      // This prevents a slow provider from escaping the concurrency bound.
      void operation.then(() => { inFlightAttestations--; });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), providerTimeoutMs);
      });
      const result = await Promise.race([operation, deadline]);
      if (timeout) clearTimeout(timeout);
      if (result.kind === 'timeout') {
        sendJson(res, 503, { error: 'attestation provider timed out' });
      } else if (result.kind === 'failure') {
        sendJson(res, 503, { error: 'attestation unavailable' });
      } else if (!res.destroyed) {
        sendJson(res, 200, result.receipt);
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

function isGlobalRateLimited(window: { count: number; startedAt: number }, max: number): boolean {
  const now = Date.now();
  if (now - window.startedAt >= 60_000) {
    window.count = 0;
    window.startedAt = now;
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
