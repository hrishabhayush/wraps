import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { AttestationError, ConfidentialSpaceProvider, CONFIDENTIAL_SPACE_SOCKET, CONFIDENTIAL_SPACE_TOKEN_PATH } from '../src/index';

const tempDirs: string[] = [];
const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wraps-cs-provider-'));
  tempDirs.push(dir);
  const socketPath = join(dir, 'tee.sock');
  const server = createServer(handler);
  servers.push(server);
  server.listen(socketPath);
  await once(server, 'listening');
  return socketPath;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ConfidentialSpaceProvider', () => {
  it('requests an OIDC token over the launcher socket with both bound nonces', async () => {
    const nonce = new Uint8Array(32).fill(7);
    const publicKeysHash = new Uint8Array(32).fill(9);
    const jwt = 'header.payload.signature';
    let requestBody = '';
    const socketPath = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe(CONFIDENTIAL_SPACE_TOKEN_PATH);
      expect(req.headers['content-type']).toBe('application/json');
      req.setEncoding('utf8');
      req.on('data', (chunk) => (requestBody += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${jwt}\n`);
      });
    });

    const provider = new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid', socketPath });
    await expect(provider.attest(nonce, publicKeysHash)).resolves.toBe(jwt);
    expect(provider.format).toBe('gcp-confidential-space-v1');
    expect(JSON.parse(requestBody)).toEqual({
      audience: 'https://wraps.invalid',
      token_type: 'OIDC',
      nonces: [Buffer.from(nonce).toString('hex'), Buffer.from(publicKeysHash).toString('hex')],
    });
  });

  it('uses the Confidential Space launcher socket by default', () => {
    const provider = new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid' });
    expect(provider).toBeInstanceOf(ConfidentialSpaceProvider);
    expect(CONFIDENTIAL_SPACE_SOCKET).toBe('/run/container_launcher/teeserver.sock');
  });

  it('rejects nonce values outside the launcher limits and non-SHA256 key hashes', async () => {
    const provider = new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid', socketPath: '/missing.sock' });
    await expect(provider.attest(new Uint8Array(4), new Uint8Array(32))).rejects.toThrow(/client nonce/);
    await expect(provider.attest(new Uint8Array(32), new Uint8Array(31))).rejects.toThrow(/public key hash/);
    await expect(provider.attest(new Uint8Array(38), new Uint8Array(32))).rejects.toThrow(/client nonce/);
  });

  it('rejects launcher errors and malformed token responses', async () => {
    const errorSocket = await listen((_req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    const failed = new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid', socketPath: errorSocket });
    await expect(failed.attest(new Uint8Array(32), new Uint8Array(32))).rejects.toMatchObject({
      name: 'AttestationError',
      code: 'MALFORMED',
    });

    const malformedSocket = await listen((_req, res) => {
      res.writeHead(200);
      res.end('not-a-jwt');
    });
    const malformed = new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid', socketPath: malformedSocket });
    await expect(malformed.attest(new Uint8Array(32), new Uint8Array(32))).rejects.toBeInstanceOf(AttestationError);
  });

  it('rejects invalid audiences and timeouts', () => {
    expect(() => new ConfidentialSpaceProvider({ audience: '' })).toThrow(/audience/);
    expect(() => new ConfidentialSpaceProvider({ audience: 'x'.repeat(513) })).toThrow(/audience/);
    expect(() => new ConfidentialSpaceProvider({ audience: 'https://wraps.invalid', timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
