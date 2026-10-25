// TLS without a certificate authority.
//
// Server: the workload makes a P-256 key and a self-signed certificate at start-up, in
// memory. The key's SPKI goes into hashPublicKeys() as "tls", so the attestation covers it.
//
// Client: the first connection accepts any certificate but records the peer's SPKI. The
// client then checks that SPKI against the attested "tls" key. After that, every request
// opens a fresh TLS connection, checks the SPKI on the handshake, and only then writes
// the HTTP request. A mismatch destroys the socket before any byte of the request is sent.
import * as x509 from '@peculiar/x509';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { webcrypto } from 'node:crypto';
import type { Transport } from './client';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface TlsIdentity {
  keyPem: string;
  certPem: string;
  /** SPKI DER of the TLS public key. This is what clients pin. */
  spki: Uint8Array;
}

export async function createTlsIdentity(commonName = 'issuer.wraps.invalid', validDays = 30): Promise<TlsIdentity> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const now = Date.now();
  const serial = webcrypto.getRandomValues(new Uint8Array(12));
  serial[0] &= 0x7f;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(serial).toString('hex'),
    name: `CN=${commonName}`,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + validDays * 86400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: commonName }]),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  return { keyPem: toPem(pkcs8, 'PRIVATE KEY'), certPem: cert.toString('pem'), spki };
}

function toPem(der: Buffer, label: string): string {
  return `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END ${label}-----\n`;
}

export class TlsPinError extends Error {
  constructor(message: string) {
    super(`TLS pin refused: ${message}`);
    this.name = 'TlsPinError';
  }
}

/** Opens a TLS connection and resolves once the handshake is done, with the peer's SPKI. */
function openTls(url: URL): Promise<{ socket: TLSSocket; peerSpki: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = tlsConnect({
      host,
      port: Number(url.port || 443),
      servername: isIP(host) ? undefined : host,
      // No CA: the certificate is self-signed. Trust comes from the pin, checked below.
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    socket.setTimeout(20_000, () => socket.destroy(new Error('TLS connect timed out')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      const cert = socket.getPeerX509Certificate();
      if (!cert) {
        socket.destroy();
        return reject(new TlsPinError('server sent no certificate'));
      }
      const peerSpki = new Uint8Array(cert.publicKey.export({ type: 'spki', format: 'der' }));
      resolve({ socket, peerSpki });
    });
  });
}

/** Sends one HTTP/1.1 request over an already verified TLS socket. */
function sendOver(socket: TLSSocket, url: URL, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    headers.connection = 'close';
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        createConnection: () => socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          const status = res.statusCode ?? 0;
          const nullBody = status === 204 || status === 304;
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers: h }));
          socket.destroy();
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** First contact: any certificate, but report its SPKI so the caller can match it to the attestation. */
export async function fetchRecordingPeer(url: string, init?: RequestInit): Promise<{ response: Response; peerSpki: Uint8Array }> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('fetchRecordingPeer needs an https URL');
  const { socket, peerSpki } = await openTls(u);
  return { response: await sendOver(socket, u, init), peerSpki };
}

/**
 * Transport pinned to one origin's attested TLS key. Requests to that origin fail before
 * anything is sent if the server's key differs. Requests to other origins use `fallback`.
 */
export function pinnedTransport(origin: string, spki: Uint8Array, fallback: Transport = fetch): Transport {
  const pinOrigin = new URL(origin).origin;
  const pin = Buffer.from(spki);
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin !== pinOrigin) return fallback(url, init);
    const { socket, peerSpki } = await openTls(u);
    if (!pin.equals(Buffer.from(peerSpki))) {
      socket.destroy();
      throw new TlsPinError(`${pinOrigin} presented a TLS key that is not the attested key`);
    }
    return sendOver(socket, u, init);
  };
}
