// HTTPS with a self-signed key made at start-up. The key is in the attested key hash,
// and every later call is pinned to it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpsServer } from 'node:https';
import { AttestationError, MockAttestationProvider, MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import {
  IssuerCore,
  MockTopUpRail,
  RunningIssuer,
  TlsPinError,
  createIssuerServer,
  createTlsIdentity,
  fetchAttestedIssuer,
  fetchRecordingPeer,
  issuerTransport,
  listenUrl,
  pinnedTransport,
  startIssuer,
} from '../src/index';

const quiet = () => {};
const verifier = () => new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') });
let a: RunningIssuer;
let b: RunningIssuer;
let bRequests = 0;

beforeAll(async () => {
  a = await startIssuer({ tls: true, log: quiet, payoutIntervalMs: 3_600_000 });
  b = await startIssuer({ tls: true, log: quiet, payoutIntervalMs: 3_600_000 });
  b.server.prependListener('request', () => (bRequests += 1));
});
afterAll(async () => {
  await a.close();
  await b.close();
});

describe('issuer over https', () => {
  it('serves https and puts the TLS key in the attested keys', async () => {
    expect(a.url.startsWith('https://')).toBe(true);
    const att = await fetchAttestedIssuer(a.url, verifier());
    expect(att.tlsKey).toBeDefined();
    expect(Buffer.from(att.tlsKey!).equals(Buffer.from(a.core.publicKeys.tls!))).toBe(true);
    const res = await issuerTransport(att)(`${a.url}/health`);
    expect(res.status).toBe(200);
  });

  it('uses the configured peer-aware transport for HTTPS attestation', async () => {
    let peerCalls = 0;
    let pinnedCalls = 0;
    const routed = Object.assign(
      async () => { throw new Error('ordinary transport must not be used for peer-bound TLS'); },
      {
        fetchWithPeer: async (url: string, init?: RequestInit) => { peerCalls++; return fetchRecordingPeer(url, init); },
        fetchPinned: async (url: string, spki: Uint8Array, init?: RequestInit) => {
          pinnedCalls++;
          return pinnedTransport(a.url, spki)(url, init);
        },
      },
    );
    const att = await fetchAttestedIssuer(a.url, verifier(), routed);
    expect(att.tlsKey).toBeDefined();
    expect(peerCalls).toBe(1);
    expect((await issuerTransport(att, routed)(`${a.url}/health`)).status).toBe(200);
    expect(pinnedCalls).toBe(1);
  });

  it('fails closed instead of bypassing a custom HTTPS transport', async () => {
    let calls = 0;
    const custom = async () => { calls++; return new Response('{}'); };
    await expect(fetchAttestedIssuer(a.url, verifier(), custom)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    expect(calls).toBe(0);
  });

  it('requires custom transports to enforce the pin before issuer requests', async () => {
    const custom = Object.assign(
      async () => new Response('{}'),
      { fetchWithPeer: fetchRecordingPeer },
    );
    const att = await fetchAttestedIssuer(a.url, verifier(), custom);
    await expect(issuerTransport(att, custom)(`${a.url}/health`)).rejects.toBeInstanceOf(TlsPinError);
  });

  it('refuses a server whose TLS key differs from the pinned one, before sending the request', async () => {
    const attA = await fetchAttestedIssuer(a.url, verifier());
    const before = bRequests;
    // Pretend B sits where A was (a man in the middle with its own key).
    const call = issuerTransport({ ...attA, url: b.url });
    await expect(call(`${b.url}/settle`, { method: 'POST', body: '{"tokens":["x"]}' })).rejects.toBeInstanceOf(TlsPinError);
    expect(bRequests).toBe(before);
  });

  it('refuses an attestation whose TLS key is not the key on the connection', async () => {
    // The attestation (validly) names key Y, but the server terminates TLS with key X.
    const x = await createTlsIdentity();
    const y = await createTlsIdentity();
    const core = await IssuerCore.create({
      provider: new MockAttestationProvider({ buildName: 'issuer' }),
      rail: new MockTopUpRail(),
      tlsPublicKey: y.spki,
    });
    const server = createIssuerServer(core, { tls: x });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await expect(fetchAttestedIssuer(listenUrl(server), verifier())).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    } finally {
      server.close();
    }
  });

  it('refuses an https issuer that names no TLS key', async () => {
    await expect(
      Promise.resolve().then(() => issuerTransport({ url: 'https://127.0.0.1:1', issuerName: 'x', tokenKey: new Uint8Array(), claimKey: new Uint8Array(), attestation: {} as any })),
    ).rejects.toBeInstanceOf(AttestationError);
  });

  it('bounds the body size of an untrusted first-contact TLS response', async () => {
    const identity = await createTlsIdentity();
    const server = createHttpsServer({ key: identity.keyPem, cert: identity.certPem }, (_req, res) => {
      res.end(Buffer.alloc(1024 * 1024 + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await expect(fetchRecordingPeer(listenUrl(server))).rejects.toThrow('response exceeds 1048576 bytes');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
