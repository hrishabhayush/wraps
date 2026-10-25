import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createConnection, createServer as createTcpServer, type Server as NetServer } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPublicKeys, type AttestationProvider } from '@wraps/attestation';
import { blindTokens, encodeAuthorization, finalizeTokens, generateIssuerKeys, TokenIssuer } from '@wraps/tokens';
import { createRelayAttestationResponse, createRelayAttestationServer } from '../src/attestation.js';
import { createSecureRelayServer } from '../src/index.js';
import type { RelayIssuer } from '../src/index.js';

const generated: string[] = [];
let proxyAuthorization: string;

beforeAll(async () => {
  const keys = await generateIssuerKeys();
  const pending = await blindTokens(keys.publicKeyBytes, 1);
  const responses = await new TokenIssuer(keys).issue(pending.map((token) => token.request));
  proxyAuthorization = encodeAuthorization(await finalizeTokens(pending, responses));
});

async function selfSignedCertificate(): Promise<{ certificate: string; privateKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wraps-relay-cert-'));
  generated.push(dir);
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-subj', '/CN=relay.test', '-addext', 'subjectAltName=DNS:relay.test',
    '-days', '1', '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  const [certificate, privateKey] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
  return { certificate, privateKey };
}

afterEach(async () => {
  await Promise.all(generated.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('relay attestation', () => {
  it('binds the TLS certificate key and request nonce into the provider receipt', async () => {
    const { certificate: tlsCertificate } = await selfSignedCertificate();
    const nonce = Buffer.alloc(32, 7);
    const certificate = new X509Certificate(tlsCertificate);
    const tunnelKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const attest = vi.fn(async (receivedNonce: Uint8Array, keyHash: Uint8Array) => {
      expect(Buffer.from(receivedNonce)).toEqual(nonce);
      expect(Buffer.from(keyHash)).toEqual(Buffer.from(hashPublicKeys({ tunnel: new Uint8Array(tunnelKey) })));
      return 'signed-attestation';
    });
    const provider: AttestationProvider = { format: 'google-confidential-space-v1', attest };

    await expect(createRelayAttestationResponse(nonce, { tlsCertificate, provider })).resolves.toEqual({
      format: 'google-confidential-space-v1',
      publicKeys: { tunnel: Buffer.from(tunnelKey).toString('base64url') },
      tlsCertificate,
      attestation: 'signed-attestation',
    });
    expect(attest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed nonces before asking the provider to attest', async () => {
    const provider: AttestationProvider = { format: 'test', attest: vi.fn() };
    const response = await createRelayAttestationResponse(Buffer.alloc(31), {
      tlsCertificate: 'invalid certificate',
      provider,
    }).catch((error: unknown) => error);
    expect(response).toBeInstanceOf(TypeError);
    expect(provider.attest).not.toHaveBeenCalled();
  });

  it('serves a non-cacheable nonce-bound JSON response at the attestation endpoint', async () => {
    const { certificate: tlsCertificate } = await selfSignedCertificate();
    const provider: AttestationProvider = {
      format: 'test-format',
      attest: vi.fn(async () => 'receipt'),
    };
    const server = createRelayAttestationServer({ tlsCertificate, provider });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
      const nonce = Buffer.alloc(32, 9).toString('hex');
      const res = await fetch(`http://127.0.0.1:${address.port}/attestation?nonce=${nonce}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ format: 'test-format', attestation: 'receipt' });

      const badNonce = await fetch(`http://127.0.0.1:${address.port}/attestation?nonce=abc`);
      expect(badNonce.status).toBe(400);
      expect(provider.attest).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rate limits receipts per client IP', async () => {
    const { certificate: tlsCertificate } = await selfSignedCertificate();
    const provider: AttestationProvider = { format: 'test', attest: vi.fn(async () => 'receipt') };
    const server = createRelayAttestationServer({ tlsCertificate, provider, requestsPerMinute: 1 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
      const nonce = Buffer.alloc(32, 3).toString('hex');
      const url = `http://127.0.0.1:${address.port}/attestation?nonce=${nonce}`;
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(url)).status).toBe(429);
      expect(provider.attest).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('serves the CONNECT proxy over TLS', async () => {
    const { certificate, privateKey } = await selfSignedCertificate();
    const server = createSecureRelayServer({ tlsCertificate: certificate, tlsPrivateKey: privateKey });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({
          host: '127.0.0.1',
          port: address.port,
          method: 'GET',
          rejectUnauthorized: false,
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(405);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('forwards a TLS CONNECT tunnel through the secure listener', async () => {
    const { certificate, privateKey } = await selfSignedCertificate();
    let upstreamServer: NetServer | undefined;
    upstreamServer = createTcpServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind a TCP address');

    const issuer: RelayIssuer = { verify: async () => true, settle: async () => {} };
    const server = createSecureRelayServer({ tlsCertificate: certificate, tlsPrivateKey: privateKey, issuer }, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => createConnection({ host: '127.0.0.1', port: upstreamAddress.port }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const relayAddress = server.address();
      if (!relayAddress || typeof relayAddress === 'string') throw new Error('relay did not bind a TCP address');
      const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]);
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const req = httpsRequest({
          host: '127.0.0.1',
          port: relayAddress.port,
          method: 'CONNECT',
          path: 'example.com:443',
          headers: { 'proxy-authorization': proxyAuthorization },
          rejectUnauthorized: false,
        });
        req.on('connect', (res, socket) => {
          expect(res.statusCode).toBe(200);
          socket.once('data', (chunk) => {
            socket.destroy();
            resolve(chunk);
          });
          socket.write(hello);
        });
        req.on('error', reject);
        req.end();
      });
      expect(echoed).toEqual(hello);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      await new Promise<void>((resolve, reject) => upstreamServer!.close((err) => err ? reject(err) : resolve()));
    }
  });
});
