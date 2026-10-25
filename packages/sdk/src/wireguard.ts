import { createHash, createPrivateKey, createPublicKey, diffieHellman, randomBytes, X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { AttestationVerifier } from '@wraps/attestation';
import { hashPublicKeys } from '@wraps/attestation';
import { encodeAuthorization, type Token } from '@wraps/tokens';

const verifiedReceiptBrand: unique symbol = Symbol('verified WireGuard receipt');
const verifiedReceipts = new WeakSet<object>();

export interface VerifiedWireGuardReceipt {
  readonly endpoint: string;
  readonly listenPort: number;
  readonly interfaceAddress: string;
  readonly clientAllowedIPs: '0.0.0.0/0';
  readonly serverPublicKey: string;
  /** DER SubjectPublicKeyInfo of the TLS key bound by the verified receipt. */
  readonly tunnelSpki: string;
  readonly peers: ReadonlyArray<Readonly<{ publicKey: string; allowedAddress: string }>>;
  readonly [verifiedReceiptBrand]: true;
}

export function isVerifiedWireGuardReceipt(value: unknown): value is VerifiedWireGuardReceipt {
  return typeof value === 'object' && value !== null && verifiedReceipts.has(value) && Reflect.get(value, verifiedReceiptBrand) === true &&
    Object.isFrozen(value) && Array.isArray(Reflect.get(value, 'peers')) && Object.isFrozen(Reflect.get(value, 'peers')) &&
    (Reflect.get(value, 'peers') as unknown[]).every(Object.isFrozen);
}

export class WireGuardRegistrationError extends Error {
  constructor(readonly outcome: 'rejected' | 'unknown', message: string) {
    super(message);
    this.name = 'WireGuardRegistrationError';
  }
}

const privateDerPrefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const basePublicDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from([9, ...new Array(31).fill(0)])]);
export function deriveWireGuardPublicKey(privateKey: string): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(privateKey)) throw new TypeError('WireGuard keys must be standard base64 32-byte keys');
  const raw = Buffer.from(privateKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== privateKey) throw new TypeError('invalid WireGuard private key');
  const priv = createPrivateKey({ key: Buffer.concat([privateDerPrefix, raw]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey({ key: basePublicDer, format: 'der', type: 'spki' });
  return diffieHellman({ privateKey: priv, publicKey: pub }).toString('base64');
}

function validateEndpoint(value: string): void {
  if (isIP(value)) return;
  if (value.length > 253 || value.endsWith('.') || !value.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    throw new TypeError('invalid WireGuard endpoint host');
  }
}

/** Fetch and verify a fresh WireGuard identity receipt before creating a client profile. */
export async function fetchVerifiedWireGuardReceipt(
  attestationUrl: string,
  verifier: AttestationVerifier,
  transport: typeof fetch = fetch,
): Promise<VerifiedWireGuardReceipt> {
  const url = new URL(attestationUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('WireGuard attestation URL must use HTTP or HTTPS');
  if (!url.pathname.endsWith('/wireguard-attestation')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/wireguard-attestation`;
  }
  const nonce = randomBytes(32);
  url.searchParams.set('nonce', nonce.toString('hex'));
  const response = await transport(url);
  if (!response.ok) throw new Error(`WireGuard attestation failed (${response.status})`);
  const receipt = await response.json() as {
    format?: string;
    publicKeys?: { tunnel?: string; wireguard?: string; policy?: string };
    endpoint?: string;
    listenPort?: number;
    interfaceAddress?: string;
    clientAllowedIPs?: string;
    networkPolicy?: {
      endpoint?: string;
      listenPort?: number;
      interfaceAddress?: string;
      egressInterface?: string;
      peers?: Array<{ publicKey?: string; allowedAddress?: string }>;
      clientAllowedIPs?: string;
      ipv6Forwarding?: boolean;
      bytesPerToken?: number;
      metering?: string;
    };
    attestation?: string;
  };
  const { tunnel, wireguard, policy } = receipt.publicKeys ?? {};
  if (receipt.format !== verifier.format || !tunnel || !wireguard || !policy || !receipt.attestation) {
    throw new TypeError('malformed WireGuard attestation receipt');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(tunnel) || !/^[A-Za-z0-9+/]{43}=$/.test(wireguard) || !/^[0-9a-f]{64}$/.test(policy)) {
    throw new TypeError('malformed WireGuard attestation keys');
  }
  const networkPolicy = receipt.networkPolicy;
  if (!networkPolicy || networkPolicy.endpoint !== receipt.endpoint || networkPolicy.listenPort !== receipt.listenPort ||
      networkPolicy.interfaceAddress !== receipt.interfaceAddress || networkPolicy.clientAllowedIPs !== '0.0.0.0/0' ||
      networkPolicy.ipv6Forwarding !== false || networkPolicy.bytesPerToken !== 10_000_000 ||
      networkPolicy.metering !== 'bidirectional-inner-ipv4' || !networkPolicy.egressInterface || !Array.isArray(networkPolicy.peers)) {
    throw new TypeError('malformed WireGuard network policy');
  }
  const peers = networkPolicy.peers.map((peer) => {
    if (typeof peer.publicKey !== 'string' || typeof peer.allowedAddress !== 'string') throw new TypeError('malformed WireGuard peer policy');
    return { publicKey: peer.publicKey, allowedAddress: peer.allowedAddress };
  }).sort((a, b) => a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0);
  const policyHash = createHash('sha256').update(JSON.stringify({
    endpoint: networkPolicy.endpoint,
    listenPort: networkPolicy.listenPort,
    interfaceAddress: networkPolicy.interfaceAddress,
    egressInterface: networkPolicy.egressInterface,
    peers,
    clientAllowedIPs: '0.0.0.0/0',
    ipv6Forwarding: false,
    bytesPerToken: 10_000_000,
    metering: 'bidirectional-inner-ipv4',
  })).digest('hex');
  if (policyHash !== policy) throw new Error('WireGuard policy is not bound to the attested policy hash');
  const verified = await verifier.verify(receipt.attestation, {
    nonce,
    publicKeysHash: hashPublicKeys({
      tunnel: Buffer.from(tunnel, 'base64url'),
      wireguard: Buffer.from(wireguard, 'base64'),
      policy: Buffer.from(policy, 'hex'),
    }),
  });
  if (verified.nonce !== nonce.toString('hex')) throw new Error('attestation verifier returned the wrong nonce');
  if (receipt.clientAllowedIPs !== '0.0.0.0/0' || !Number.isInteger(receipt.listenPort) ||
      receipt.listenPort! < 1 || receipt.listenPort! > 65535 || !receipt.endpoint || !receipt.interfaceAddress) {
    throw new TypeError('unsupported WireGuard routing policy');
  }
  const frozenPeers = Object.freeze(peers.map((peer) => Object.freeze({ ...peer })));
  const frozen = Object.freeze({
    endpoint: receipt.endpoint,
    listenPort: receipt.listenPort!,
    interfaceAddress: receipt.interfaceAddress,
    clientAllowedIPs: '0.0.0.0/0',
    serverPublicKey: wireguard,
    tunnelSpki: tunnel,
    peers: frozenPeers,
    [verifiedReceiptBrand]: true as const,
  });
  verifiedReceipts.add(frozen);
  return frozen;
}

/**
 * Format a Linux wg-quick profile with an output kill switch. Generate and retain
 * the private key on the client device. Other platforms must use their native
 * app's "block untunneled traffic" option instead of importing this profile.
 */
export function createWireGuardClientProfile(
  receipt: VerifiedWireGuardReceipt,
  clientPrivateKey: string,
  clientAddress: string,
  dns = '1.1.1.1',
): string {
  if (!isVerifiedWireGuardReceipt(receipt)) throw new TypeError('a verified WireGuard attestation receipt is required');
  validateEndpoint(receipt.endpoint);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(clientPrivateKey) || !/^[A-Za-z0-9+/]{43}=$/.test(receipt.serverPublicKey)) {
    throw new TypeError('WireGuard keys must be standard base64 32-byte keys');
  }
  const clientPublicKey = deriveWireGuardPublicKey(clientPrivateKey);
  if (!receipt.peers.some((peer) => peer.publicKey === clientPublicKey && peer.allowedAddress === clientAddress)) {
    throw new TypeError('peer key and address are not in the verified WireGuard policy');
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(clientAddress) ||
      clientAddress.split('/')[0].split('.').some((part) => Number(part) > 255)) {
    throw new TypeError('clientAddress must be an IPv4 /32 assigned to this peer');
  }
  const endpoint = new URL(`udp://${receipt.endpoint}:${receipt.listenPort}`);
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new TypeError('invalid WireGuard endpoint');
  if (!/^[0-9a-fA-F:.]+$/.test(dns)) throw new TypeError('DNS must be an IPv4 or IPv6 literal');
  return [
    '[Interface]',
    `PrivateKey = ${clientPrivateKey}`,
    `Address = ${clientAddress}`,
    `DNS = ${dns}`,
    // wg-quick assigns a fwmark for the default route; only marked WireGuard
    // transport packets and local traffic may leave through the physical NIC.
    'PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT',
    'PostDown = iptables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT',
    // The server deliberately does not forward IPv6. Block client IPv6 egress
    // while this full-tunnel profile is active, including if the peer drops.
    'PostUp = ip6tables -I OUTPUT ! -o %i -m addrtype ! --dst-type LOCAL -j REJECT',
    'PostDown = ip6tables -D OUTPUT ! -o %i -m addrtype ! --dst-type LOCAL -j REJECT',
    '',
    '[Peer]',
    `PublicKey = ${receipt.serverPublicKey}`,
    `Endpoint = ${receipt.endpoint}:${receipt.listenPort}`,
    `AllowedIPs = ${receipt.clientAllowedIPs}`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}

/** Register a configured peer over the relay's HTTPS control route using blind tokens. */
export async function registerWireGuardPeer(
  receipt: VerifiedWireGuardReceipt,
  clientPrivateKey: string,
  tokens: Token[],
  tlsPort = 443,
): Promise<void> {
  if (!isVerifiedWireGuardReceipt(receipt)) throw new TypeError('a verified WireGuard attestation receipt is required');
  validateEndpoint(receipt.endpoint);
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535) throw new RangeError('invalid relay TLS port');
  const url = new URL(`https://${receipt.endpoint}:${tlsPort}/wireguard/register`);
  if (tokens.length !== 1) throw new RangeError('register exactly one blind token at a time');
  const publicKey = deriveWireGuardPublicKey(clientPrivateKey);
  if (!receipt.peers.some((peer) => peer.publicKey === publicKey)) throw new TypeError('client private key does not match a configured peer');
  const expectedSpki = Buffer.from(receipt.tunnelSpki, 'base64url');
  if (!expectedSpki.length) throw new TypeError('missing attested relay TLS key');
  const body = JSON.stringify({ publicKey, authorization: encodeAuthorization(tokens) });
  await new Promise<void>((resolve, reject) => {
    let bodySent = false;
    const timer = setTimeout(() => req.destroy(new Error('WireGuard registration timed out')), 10_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(new WireGuardRegistrationError(bodySent ? 'unknown' : 'rejected', error.message));
    };
    const req = httpsRequest(url, {
      method: 'POST',
      agent: false,
      rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) req.destroy(new Error('relay registration response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 201) {
          const definitelyRejected = [400, 401, 404, 409, 413, 415, 429].includes(res.statusCode ?? 0);
          reject(new WireGuardRegistrationError(definitelyRejected ? 'rejected' : 'unknown', `WireGuard peer registration failed (${res.statusCode ?? 'no status'})`));
        } else resolve();
      });
    });
    req.once('socket', (socket) => {
      const tlsSocket = socket as TLSSocket;
      tlsSocket.once('secureConnect', () => {
        try {
          const cert = tlsSocket.getPeerCertificate(true);
          if (!cert.raw) throw new Error('relay did not present a certificate');
          const actualSpki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
          if (!Buffer.from(actualSpki).equals(expectedSpki)) throw new Error('relay TLS key does not match verified attestation');
          bodySent = true;
          req.end(body);
        } catch (error) {
          req.destroy(error as Error);
        }
      });
    });
    req.once('error', fail);
  });
}
