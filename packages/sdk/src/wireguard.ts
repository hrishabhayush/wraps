import { randomBytes } from 'node:crypto';
import type { AttestationVerifier } from '@wraps/attestation';
import { hashPublicKeys } from '@wraps/attestation';

export interface VerifiedWireGuardReceipt {
  endpoint: string;
  listenPort: number;
  interfaceAddress: string;
  clientAllowedIPs: '0.0.0.0/0';
  serverPublicKey: string;
}

/** Fetch and verify a fresh WireGuard identity receipt before creating a client profile. */
export async function fetchVerifiedWireGuardReceipt(
  attestationUrl: string,
  verifier: AttestationVerifier,
  transport: typeof fetch = fetch,
): Promise<VerifiedWireGuardReceipt> {
  const url = new URL(attestationUrl);
  if (url.protocol !== 'https:') throw new TypeError('WireGuard attestation URL must use HTTPS');
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
    attestation?: string;
  };
  const { tunnel, wireguard, policy } = receipt.publicKeys ?? {};
  if (receipt.format !== verifier.format || !tunnel || !wireguard || !policy || !receipt.attestation) {
    throw new TypeError('malformed WireGuard attestation receipt');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(tunnel) || !/^[A-Za-z0-9+/]{43}=$/.test(wireguard) || !/^[0-9a-f]{64}$/.test(policy)) {
    throw new TypeError('malformed WireGuard attestation keys');
  }
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
  return {
    endpoint: receipt.endpoint,
    listenPort: receipt.listenPort!,
    interfaceAddress: receipt.interfaceAddress,
    clientAllowedIPs: '0.0.0.0/0',
    serverPublicKey: wireguard,
  };
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
  if (!/^[A-Za-z0-9+/]{43}=$/.test(clientPrivateKey) || !/^[A-Za-z0-9+/]{43}=$/.test(receipt.serverPublicKey)) {
    throw new TypeError('WireGuard keys must be standard base64 32-byte keys');
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
