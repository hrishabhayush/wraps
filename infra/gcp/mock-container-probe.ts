import dns from 'node:dns';
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { fetchWithPeer, pinnedTransport, type PeerResponse } from '@wraps/issuer';
import { createPinnedRelayTransport, MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';

const originalLookup = dns.lookup;
dns.lookup = ((hostname: string, options: unknown, callback?: (...args: unknown[]) => void) => {
  if (hostname === 'relay.local') {
    const cb = typeof options === 'function' ? options as (...args: unknown[]) => void : callback;
    if (!cb) throw new TypeError('relay.local DNS lookup requires a callback');
    if (typeof options === 'object' && options !== null && 'all' in options && options.all) {
      queueMicrotask(() => cb(null, [{ address: '127.0.0.1', family: 4 }]));
    } else {
      queueMicrotask(() => cb(null, '127.0.0.1', 4));
    }
    return undefined as unknown as ReturnType<typeof dns.lookup>;
  }
  return (originalLookup as (...args: unknown[]) => unknown).call(dns, hostname, options, callback);
}) as typeof dns.lookup;

function issuerAtLocalPort(url: string): string {
  const mapped = new URL(url);
  if (mapped.origin !== 'https://issuer') throw new Error('mock probe expected the issuer container origin');
  mapped.hostname = '127.0.0.1';
  mapped.port = process.env.WRAPS_MOCK_ISSUER_PORT ?? '4401';
  return mapped.toString();
}

function directIssuerPeer(url: string, init?: RequestInit): Promise<PeerResponse> {
  return fetchWithPeer(issuerAtLocalPort(url), init);
}

function directIssuerPinned(url: string, expectedSpki: Uint8Array, init?: RequestInit): Promise<Response> {
  const mapped = issuerAtLocalPort(url);
  return pinnedTransport(new URL(mapped).origin, expectedSpki)(mapped, init);
}

const issuerUrl = 'https://issuer';
const relayPort = process.env.WRAPS_MOCK_RELAY_PORT ?? '4443';
const attestationPort = process.env.WRAPS_MOCK_ATTESTATION_PORT ?? '48080';

const relay = await createPinnedRelayTransport({
  relayUrl: `https://relay.local:${relayPort}`,
  issuerUrl,
  attestationUrl: `http://127.0.0.1:${attestationPort}/attestation`,
  verifier: new MockAttestationVerifier({ expectedPcrs: mockPcrs('relay') }),
});

// Issuer bootstrap and top-up use the local issuer container directly. Merchant HTTPS
// goes through the real relay container and spends the blind meter token as usual.
const relayWithLocalIssuer = {
  ...relay,
  fetchIssuerWithPeer: directIssuerPeer,
  fetchIssuer: (url: string, init: RequestInit | undefined, expectedSpki: Uint8Array) =>
    directIssuerPinned(url, expectedSpki, init),
};

const client = new PrivatePayClient({
  issuerUrl,
  verifier: new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }),
  wallet: new MockTopUpWallet(),
  caps: { perCallTokens: 2, dailyTokens: 24, maxTopUpTokens: 20 },
  relayTransport: relayWithLocalIssuer,
});

try {
  const issuer = await client.connect();
  await client.topUp(2);
  const response = await client.fetch('https://example.com');
  const page = await response.text();
  if (!response.ok || client.balance !== 1 || client.spentToday !== 1 || page.length === 0) {
    throw new Error('container fallback did not return a paid HTTPS response through the relay');
  }
  console.log(JSON.stringify({
    rehearsal: 'local-containers-with-mock-attestation',
    issuerFormat: issuer.attestation.format,
    relayFormat: relay.relay.attestation.format,
    issuerTlsPinned: Boolean(issuer.tlsKey),
    merchantStatus: response.status,
    meterTokensSpent: 1,
    remainingTokens: client.balance,
    responseBytes: page.length,
  }));
} finally {
  await relay.close();
}
