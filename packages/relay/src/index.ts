import { lookup, type LookupAddress } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, createConnection } from 'node:net';
import type { Duplex } from 'node:stream';

const MAX_HEADER_SIZE = 16 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface RelayServerOptions {
  connectTimeoutMs?: number;
}

export interface RelayListenOptions extends RelayServerOptions {
  /** Defaults to loopback because CONNECT destinations have no user authentication. */
  host?: string;
  port?: number;
}

interface Authority {
  host: string;
  port: 443;
}

/** Create a raw TCP CONNECT proxy for HTTPS on port 443. TLS remains end-to-end. */
export function createRelayServer(options: RelayServerOptions = {}): Server {
  const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, rejectHttpRequest);
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  server.on('connect', (req, client, head) => {
    void handleConnect(req, client, head, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  });

  return server;
}

/** Create and listen on loopback by default. Expose remotely only behind access controls. */
export function startRelayServer(options: RelayListenOptions = {}): Server {
  const server = createRelayServer(options);
  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
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

async function handleConnect(req: IncomingMessage, client: Duplex, head: Buffer, timeoutMs: number): Promise<void> {
  const authority = parseAuthority(req.url);
  if (!authority) {
    respondAndClose(client, 400, 'Invalid CONNECT authority; HTTPS on port 443 only');
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = isIP(authority.host)
      ? [{ address: authority.host, family: isIP(authority.host) as 4 | 6 }]
      : await lookup(authority.host, { all: true, verbatim: true });
  } catch {
    respondAndClose(client, 502, 'Destination lookup failed');
    return;
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    respondAndClose(client, 403, 'Destination is not publicly routable');
    return;
  }

  // Connect to the exact address that passed validation; do not resolve the hostname again.
  const destination = addresses[0];
  const upstream = createConnection({ host: destination.address, family: destination.family, port: authority.port });
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
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

function respondAndClose(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
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
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || isIP(address) !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Global unicast is 2000::/3. Exclude documentation and IPv4-mapped addresses.
  return (value >> 125n) === 1n && (value >> 32n) !== 0x20010db8n && (value >> 32n) !== 0x0000000000000000n;
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
