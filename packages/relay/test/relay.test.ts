import { request } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRelayServer } from '../src/index.js';

describe('HTTPS CONNECT relay', () => {
  let server: ReturnType<typeof startRelayServer>;
  let port: number;

  beforeEach(async () => {
    server = startRelayServer();
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('relay did not bind a TCP port');
    port = address.port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  it('rejects ordinary HTTP requests', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });

  it('rejects CONNECT to ports other than 443', async () => {
    expect(await connectStatus(port, 'example.com:80')).toBe(400);
  });

  it('rejects loopback and IPv4-mapped loopback destinations', async () => {
    expect(await connectStatus(port, '127.0.0.1:443')).toBe(403);
    expect(await connectStatus(port, '[::ffff:127.0.0.1]:443')).toBe(403);
  });
});

function connectStatus(proxyPort: number, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}
