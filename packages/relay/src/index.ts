import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIP, createConnection, type Socket } from 'node:net';
import { Transform, type Duplex } from 'node:stream';
import type { AttestationProvider } from '@wraps/attestation';
import { parseAuthorization, serializeToken, tokenId } from '@wraps/tokens';
import { BandwidthMeter, HttpRelayIssuer, MAX_TOKENS_PER_TUNNEL, type RelayIssuer } from './meter.js';
import { startRelayAttestationServer, type RelayAttestationListenOptions } from './attestation.js';
export type { RelayIssuer } from './meter.js';
export * from './attestation.js';
export * from './tls-identity.js';

const MAX_HEADER_SIZE = 16 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface RelayServerOptions {
  connectTimeoutMs?: number;
  /** Required to open a valid tunnel. The relay otherwise fails closed with 503. */
  issuerUrl?: string;
  /** Test or embedded issuer adapter; takes precedence over issuerUrl. */
  issuer?: RelayIssuer;
  /** The relay's fixed merchant account at the issuer. Defaults to `relay`. */
  merchantId?: string;
  issuerFetch?: typeof fetch;
}

/** Network seams let tests exercise the tunnel without relying on public DNS. */
export interface RelayDependencies {
  resolve: (host: string) => Promise<LookupAddress[]>;
  connect: (host: string, family: 4 | 6, port: number) => Socket;
}

export interface RelayListenOptions extends RelayServerOptions {
  /** Defaults to loopback because CONNECT destinations have no user authentication. */
  host?: string;
  port?: number;
}

export interface SecureRelayListenOptions extends RelayServerOptions {
  /** Self-signed certificate generated inside the Confidential Space workload. */
  tlsCertificate: string | Buffer;
  /** The private key matching `tlsCertificate`, generated inside the workload. */
  tlsPrivateKey: string | Buffer;
  /** Defaults to loopback; use an explicit workload interface when exposing the proxy. */
  host?: string;
  /** Defaults to 8443. */
  port?: number;
}

export interface ConfidentialRelayOptions extends RelayServerOptions {
  tlsCertificate: string | Buffer;
  tlsPrivateKey: string | Buffer;
  attestationProvider: AttestationProvider;
  proxyHost?: string;
  proxyPort?: number;
  attestationHost?: string;
  attestationPort?: number;
  attestationRequestsPerMinute?: number;
}

interface Authority {
  host: string;
  port: 443;
}

/** Create a raw TCP CONNECT proxy for HTTPS on port 443. TLS remains end-to-end. */
export function createRelayServer(
  options: RelayServerOptions = {},
  dependencies: Partial<RelayDependencies> = {},
): Server {
  const issuer = options.issuer ?? (options.issuerUrl ? new HttpRelayIssuer(options.issuerUrl, options.issuerFetch) : undefined);
  const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, rejectHttpRequest);
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  const resolve = dependencies.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? ((host, family, port) => createConnection({ host, family, port }));

  server.on('connect', (req, client, head) => {
    void handleConnect(
      req,
      client,
      head,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      resolve,
      connect,
      issuer,
      options.merchantId ?? 'relay',
    );
  });

  return server;
}

/** Create and listen on loopback by default. Expose remotely only behind access controls. */
export function startRelayServer(options: RelayListenOptions = {}): Server {
  const server = createRelayServer(options);
  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
}

/** Create an HTTPS CONNECT listener; origin TLS remains end-to-end through the tunnel. */
export function createSecureRelayServer(
  options: SecureRelayListenOptions,
  dependencies: Partial<RelayDependencies> = {},
): HttpsServer {
  const issuer = options.issuer ?? (options.issuerUrl ? new HttpRelayIssuer(options.issuerUrl, options.issuerFetch) : undefined);
  const server = createHttpsServer({
    key: options.tlsPrivateKey,
    cert: options.tlsCertificate,
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['http/1.1'],
    maxHeaderSize: MAX_HEADER_SIZE,
  }, rejectHttpRequest);
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  const resolve = dependencies.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? ((host: string, family: 4 | 6, port: number) => createConnection({ host, family, port }));

  server.on('connect', (req, client, head) => {
    void handleConnect(
      req,
      client,
      head,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      resolve,
      connect,
      issuer,
      options.merchantId ?? 'relay',
    );
  });
  return server;
}

/** Start the HTTPS CONNECT proxy on loopback by default. */
export function startSecureRelayServer(options: SecureRelayListenOptions): HttpsServer {
  const server = createSecureRelayServer(options);
  server.listen(options.port ?? 8443, options.host ?? '127.0.0.1');
  return server;
}

/** Start the TLS-pinned proxy and its separate nonce-bound HTTP receipt listener. */
export function startConfidentialRelay(options: ConfidentialRelayOptions): {
  proxyServer: HttpsServer;
  attestationServer: Server;
} {
  const proxyServer = startSecureRelayServer({
    ...options,
    host: options.proxyHost ?? '127.0.0.1',
    port: options.proxyPort ?? 8443,
  });
  const attestationServer = startRelayAttestationServer({
    tlsCertificate: typeof options.tlsCertificate === 'string' ? options.tlsCertificate : options.tlsCertificate.toString(),
    provider: options.attestationProvider,
    host: options.attestationHost ?? '127.0.0.1',
    port: options.attestationPort ?? 8080,
    requestsPerMinute: options.attestationRequestsPerMinute,
  } satisfies RelayAttestationListenOptions);
  return { proxyServer, attestationServer };
}

function rejectHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(405, { connection: 'close', 'content-type': 'text/plain' });
  res.end('CONNECT required\n');
}

function parseAuthority(value: string | undefined): Authority | null {
  if (!value || value.length > 512 || /[\s/@?#\\]/.test(value)) return null;
  let host: string;
  let portText: string;

  if (value.startsWith('[')) {
    const match = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(value);
    if (!match || isIP(match[1]) !== 6) return null;
    host = match[1];
    portText = match[2];
  } else {
    const match = /^([^:[\]]+):(\d{1,5})$/.exec(value);
    if (!match) return null;
    host = match[1];
    portText = match[2];
    if (isIP(host) !== 4 && !isDnsName(host)) return null;
  }

  if (Number(portText) !== 443) return null;
  return { host, port: 443 };
}

function isDnsName(host: string): boolean {
  if (host.length > 253 || host.endsWith('.')) return false;
  return host.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

async function handleConnect(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  timeoutMs: number,
  resolve: RelayDependencies['resolve'],
  connect: RelayDependencies['connect'],
  issuer: RelayIssuer | undefined,
  merchantId: string,
): Promise<void> {
  client.pause();
  const authority = parseAuthority(req.url);
  if (!authority) {
    respondAndClose(client, 400, 'Invalid CONNECT authority; HTTPS on port 443 only');
    return;
  }

  let tokens: ReturnType<typeof parseAuthorization> = [];
  let serializedTokens: string[] = [];
  if (issuer) {
    const authorization = req.headers['proxy-authorization'];
    tokens = parseAuthorization(typeof authorization === 'string' ? authorization : undefined);
    if (tokens.length === 0 || tokens.length > MAX_TOKENS_PER_TUNNEL) {
      respondAndClose(client, 407, 'A bounded batch of blind tokens is required');
      return;
    }
    const ids = tokens.map(tokenId);
    if (new Set(ids).size !== ids.length) {
      respondAndClose(client, 407, 'Duplicate tokens are not accepted');
      return;
    }

    serializedTokens = tokens.map(serializeToken);
    try {
      if (!(await issuer.verify(serializedTokens))) {
        respondAndClose(client, 407, 'Blind tokens are invalid or already spent');
        return;
      }
    } catch {
      respondAndClose(client, 502, 'Issuer verification failed');
      return;
    }
  }

  let addresses: LookupAddress[];
  try {
    addresses = isIP(authority.host)
      ? [{ address: authority.host, family: isIP(authority.host) as 4 | 6 }]
      : await resolve(authority.host);
  } catch {
    respondAndClose(client, 502, 'Destination lookup failed');
    return;
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    respondAndClose(client, 403, 'Destination is not publicly routable');
    return;
  }
  if (!issuer) {
    respondAndClose(client, 503, 'Relay metering is not configured');
    return;
  }

  // Connect to the exact address that passed validation; do not resolve the hostname again.
  const destination = addresses[0];
  const meter = new BandwidthMeter(merchantId, serializedTokens, issuer);
  const upstream = connect(destination.address, destination.family as 4 | 6, authority.port);
  let established = false;
  const timer = setTimeout(() => upstream.destroy(new Error('connect timeout')), timeoutMs);
  timer.unref();

  const closeBoth = () => {
    upstream.destroy();
    client.destroy();
  };
  client.once('error', closeBoth);
  client.once('close', () => upstream.destroy());
  upstream.once('error', () => {
    clearTimeout(timer);
    if (!established) respondAndClose(client, 502, 'Destination connection failed');
    else client.destroy();
  });
  upstream.once('connect', () => {
    established = true;
    clearTimeout(timer);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    void readTLSClientHello(client, head, timeoutMs)
      .then((prefix) => {
        const clientToUpstream = meteredTransform(meter, closeBoth);
        const upstreamToClient = meteredTransform(meter, closeBoth);
        clientToUpstream.once('error', closeBoth);
        upstreamToClient.once('error', closeBoth);
        clientToUpstream.pipe(upstream);
        upstreamToClient.pipe(client);
        if (prefix.length > 0) clientToUpstream.write(prefix);
        client.pipe(clientToUpstream);
        upstream.pipe(upstreamToClient);
      })
      .catch(closeBoth);
  });
}

function meteredTransform(meter: BandwidthMeter, closeTunnel: () => void): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const stream = this;
      void meter.forward(Buffer.from(chunk)).then(({ bytes, exhausted }) => {
        if (bytes.length > 0) stream.push(bytes);
        callback();
        if (exhausted) setImmediate(closeTunnel);
      }, () => callback(new Error('bandwidth settlement failed')));
    },
  });
}

/** Buffer and validate the first TLS record before forwarding any tunnel data. */
function readTLSClientHello(client: Duplex, head: Buffer, timeoutMs: number): Promise<Buffer> {
  if (head.length >= 6) {
    return isTLSClientHello(head.subarray(0, 6))
      ? Promise.resolve(head)
      : Promise.reject(new Error('CONNECT tunnel did not start with a TLS ClientHello'));
  }

  return new Promise((resolve, reject) => {
    const chunks = head.length > 0 ? [head] : [];
    let length = head.length;
    const cleanup = () => {
      clearTimeout(timer);
      client.off('data', onData);
      client.off('error', onError);
      client.off('close', onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      client.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length < 6) return;
      cleanup();
      client.pause();
      const prefix = Buffer.concat(chunks, length);
      if (!isTLSClientHello(prefix.subarray(0, 6))) {
        reject(new Error('CONNECT tunnel did not start with a TLS ClientHello'));
        return;
      }
      resolve(prefix);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error('CONNECT client closed before sending a TLS ClientHello'));
    const timer = setTimeout(() => fail(new Error('Timed out waiting for a TLS ClientHello')), timeoutMs);
    timer.unref();
    client.on('data', onData);
    client.once('error', onError);
    client.once('close', onClose);
    client.resume();
  });
}

function isTLSClientHello(prefix: Buffer): boolean {
  if (prefix.length < 6 || prefix[0] !== 0x16 || prefix[1] !== 0x03) return false;
  if (prefix[2] < 0x01 || prefix[2] > 0x04 || prefix[5] !== 0x01) return false;
  const recordLength = (prefix[3] << 8) | prefix[4];
  return recordLength > 0 && recordLength <= 18_432;
}

function respondAndClose(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const reason = status === 400 ? 'Bad Request'
    : status === 403 ? 'Forbidden'
      : status === 407 ? 'Proxy Authentication Required'
        : status === 503 ? 'Service Unavailable'
          : 'Bad Gateway';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return false;
    const [a, b, c] = parts;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Embedded IPv4 forms need their own IPv4 range check; reject them here so
  // they cannot bypass the IPv6 global-unicast test or trigger parser errors.
  if (family !== 6 || isIP(address) !== 6 || address.includes('.')) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Global unicast is 2000::/3. Exclude special-use, documentation, and
  // 6to4 ranges because their embedded IPv4 addresses can target private hosts.
  const in2001SpecialUse = (value >> 105n) === 0x100080n; // 2001::/23
  const is6to4 = (value >> 112n) === 0x2002n; // 2002::/16
  return (value >> 125n) === 1n && !in2001SpecialUse && !is6to4 && (value >> 32n) !== 0x20010db8n;
}

function ipv6ToBigInt(address: string): bigint | null {
  // Node's isIP validates syntax. Expand compressed groups for range checks.
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
