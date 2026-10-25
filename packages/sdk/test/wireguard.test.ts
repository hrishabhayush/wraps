import { createHash } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { MockTopUpWallet, PrivatePayClient } from '../src/index.js';
import { createRelayTlsIdentity } from '../../relay/src/tls-identity.js';
import { deriveWireGuardPublicKey } from '../src/wireguard.js';
import { fetchVerifiedWireGuardReceipt, WireGuardRegistrationError, createWireGuardClientProfile, type VerifiedWireGuardReceipt } from '../src/wireguard.js';

const clientPrivateKey = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
const clientPublicKey = deriveWireGuardPublicKey(clientPrivateKey);
const serverPublicKey = Buffer.alloc(32, 7).toString('base64');
const clientAddress = '10.77.0.2/32';
const endpoint = '127.0.0.1';

function verifier(options: { wrongNonce?: boolean } = {}) {
  return {
    format: 'sdk07-test',
    verify: vi.fn(async (_attestation: string, expectations: { nonce: Uint8Array; publicKeysHash: Uint8Array }) => ({
      format: 'sdk07-test',
      moduleId: 'sdk07-test',
      timestamp: Date.now(),
      pcrs: {},
      measurement: 'sdk07-test',
      publicKeysHash: Buffer.from(expectations.publicKeysHash).toString('hex'),
      nonce: options.wrongNonce ? '00'.repeat(32) : Buffer.from(expectations.nonce).toString('hex'),
    })),
  };
}

function makeDocument(spki: Uint8Array, overrides: Record<string, unknown> = {}) {
  const networkPolicy = {
    endpoint,
    listenPort: 51820,
    interfaceAddress: '10.77.0.1/24',
    egressInterface: 'ens4',
    peers: [{ publicKey: clientPublicKey, allowedAddress: clientAddress }],
    clientAllowedIPs: '0.0.0.0/0',
    ipv6Forwarding: false,
    bytesPerToken: 10_000_000,
    metering: 'bidirectional-inner-ipv4',
  };
  const policyHash = createHash('sha256').update(JSON.stringify(networkPolicy)).digest('hex');
  return {
    format: 'sdk07-test',
    publicKeys: { tunnel: Buffer.from(spki).toString('base64url'), wireguard: serverPublicKey, policy: policyHash },
    endpoint,
    listenPort: 51820,
    interfaceAddress: '10.77.0.1/24',
    clientAllowedIPs: '0.0.0.0/0',
    networkPolicy,
    attestation: 'opaque-test-attestation',
    ...overrides,
  };
}

function receiptFetch(document: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function makeVerifiedReceipt(spki: Uint8Array): Promise<VerifiedWireGuardReceipt> {
  return fetchVerifiedWireGuardReceipt('https://127.0.0.1', verifier(), receiptFetch(makeDocument(spki)));
}

async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS server did not bind a TCP port');
  return address.port;
}

async function close(server: HttpsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

let issuer: Awaited<ReturnType<typeof import('@wraps/issuer').startIssuer>>;
beforeAll(async () => {
  const { startIssuer } = await import('@wraps/issuer');
  issuer = await startIssuer({ merchantAuth: { developmentMode: true }, log: () => {}, payoutIntervalMs: 3_600_000 });
});
afterAll(async () => issuer?.close());
afterEach(() => vi.useRealTimers());

async function fundedClient(): Promise<PrivatePayClient> {
  const sdk = new PrivatePayClient({
    issuerUrl: issuer.url,
    verifier: new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }),
    wallet: new MockTopUpWallet(),
    caps: { perCallTokens: 5, dailyTokens: 50, maxTopUpTokens: 20 },
  });
  await sdk.connect();
  await sdk.topUp(1);
  return sdk;
}

describe('WireGuard key handling', () => {
  it('derives the RFC 7748 X25519 public key from a private key', () => {
    const privateKey = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
    expect(Buffer.from(deriveWireGuardPublicKey(privateKey), 'base64').toString('hex'))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });

  it('rejects noncanonical private keys', () => {
    expect(() => deriveWireGuardPublicKey('not-a-key')).toThrow('standard base64');
  });
});

describe('WireGuard attestation receipt safety', () => {
  const spki = Uint8Array.from(Buffer.alloc(91, 3));

  it('times out and aborts a stalled receipt request after 10 seconds', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const transport: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
    const pending = fetchVerifiedWireGuardReceipt('https://relay.test', verifier(), transport);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('times out while a response body is stalled and cancels its reader', async () => {
    vi.useFakeTimers();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { canceled = true; } });
    const transport: typeof fetch = async () => new Response(body, { status: 200 });
    const pending = fetchVerifiedWireGuardReceipt('https://relay.test', verifier(), transport);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(canceled).toBe(true);
  });

  it('rejects an oversized receipt body even when Content-Length is absent', async () => {
    const transport: typeof fetch = async () => new Response(' '.repeat(65 * 1024), { status: 200 });
    await expect(fetchVerifiedWireGuardReceipt('https://relay.test', verifier(), transport)).rejects.toThrow('too large');
  });

  it('rejects a receipt whose declared body exceeds the limit before reading it', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('body should not be read'); } });
    const transport: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-length': '65537' } });
    await expect(fetchVerifiedWireGuardReceipt('https://relay.test', verifier(), transport)).rejects.toThrow('too large');
  });

  it('rejects malformed JSON receipts', async () => {
    const transport: typeof fetch = async () => new Response('{bad json', { status: 200 });
    await expect(fetchVerifiedWireGuardReceipt('https://relay.test', verifier(), transport)).rejects.toThrow();
  });

  it('rejects policy changes before asking the attestation verifier', async () => {
    const doc = makeDocument(spki);
    (doc.networkPolicy as { egressInterface: string }).egressInterface = 'eth0';
    const check = verifier();
    await expect(fetchVerifiedWireGuardReceipt('https://relay.test', check, receiptFetch(doc))).rejects.toThrow('policy hash');
    expect(check.verify).not.toHaveBeenCalled();
  });

  it('rejects a verifier result with a nonce other than the fresh request nonce', async () => {
    await expect(fetchVerifiedWireGuardReceipt(
      'https://relay.test', verifier({ wrongNonce: true }), receiptFetch(makeDocument(spki)),
    )).rejects.toThrow('wrong nonce');
  });

  it('creates a full tunnel profile with IPv4 and IPv6 output kill-switch rules', async () => {
    const receipt = await makeVerifiedReceipt(spki);
    const profile = createWireGuardClientProfile(receipt, clientPrivateKey, clientAddress);
    expect(profile).toContain('AllowedIPs = 0.0.0.0/0');
    expect(profile).toContain('PostUp = iptables -I OUTPUT');
    expect(profile).toContain('PostDown = iptables -D OUTPUT');
    expect(profile).toContain('PostUp = ip6tables -I OUTPUT');
    expect(profile).toContain('PostDown = ip6tables -D OUTPUT');
  });
});

describe('WireGuard registration token outcomes', () => {
  it('checks the attested TLS pin before sending a blind token, then restores the token', async () => {
    const attestedIdentity = await createRelayTlsIdentity(endpoint);
    const actualIdentity = await createRelayTlsIdentity(endpoint);
    const receipt = await makeVerifiedReceipt(attestedIdentity.spki);
    let receivedBody = 0;
    const server = createHttpsServer({ key: actualIdentity.keyPem, cert: actualIdentity.certPem }, (req, res) => {
      req.on('data', (chunk: Buffer) => { receivedBody += chunk.length; });
      req.on('end', () => { res.writeHead(201); res.end(); });
    });
    const port = await listen(server);
    try {
      const sdk = await fundedClient();
      await expect(sdk.registerWireGuardPeer(receipt, clientPrivateKey, port)).rejects.toMatchObject({
        name: 'WireGuardRegistrationError', outcome: 'rejected',
      });
      expect(receivedBody).toBe(0);
      expect(sdk.balance).toBe(1);
      expect(sdk.spentToday).toBe(0);
    } finally {
      await close(server);
    }
  });

  it('restores tokens after definite rejection and keeps tokens spent after an ambiguous response', async () => {
    const identity = await createRelayTlsIdentity(endpoint);
    const receipt = await makeVerifiedReceipt(identity.spki);
    const outcomes = [
      { status: 401, expected: 'rejected' as const, balance: 1, spent: 0 },
      { status: 503, expected: 'unknown' as const, balance: 0, spent: 1 },
    ];
    for (const outcome of outcomes) {
      const server = createHttpsServer({ key: identity.keyPem, cert: identity.certPem }, (_req, res) => {
        res.writeHead(outcome.status);
        res.end();
      });
      const port = await listen(server);
      try {
        const sdk = await fundedClient();
        const failure = await sdk.registerWireGuardPeer(receipt, clientPrivateKey, port).catch((error) => error);
        expect(failure).toBeInstanceOf(WireGuardRegistrationError);
        expect(failure.outcome).toBe(outcome.expected);
        expect(sdk.balance).toBe(outcome.balance);
        expect(sdk.spentToday).toBe(outcome.spent);
      } finally {
        await close(server);
      }
    }
  });
});
