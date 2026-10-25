import { request } from 'node:http';
import { once } from 'node:events';
import { createConnection, createServer as createTcpServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelayServer, startRelayServer } from '../src/index.js';

describe('HTTPS CONNECT relay', () => {
  let server: ReturnType<typeof startRelayServer> | undefined;
  let upstreamServer: NetServer | undefined;
  let port: number;

  async function startDefaultRelay() {
    server = startRelayServer();
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('relay did not bind a TCP port');
    port = address.port;
  }

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
      server = undefined;
    }
    if (upstreamServer) {
      await new Promise<void>((resolve, reject) => upstreamServer!.close((err) => err ? reject(err) : resolve()));
      upstreamServer = undefined;
    }
  });

  it('rejects ordinary HTTP requests', async () => {
    await startDefaultRelay();
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
    await startDefaultRelay();
    expect(await connectStatus(port, 'example.com:80')).toBe(400);
  });

  it('rejects loopback and IPv4-mapped loopback destinations', async () => {
    await startDefaultRelay();
    expect(await connectStatus(port, '127.0.0.1:443')).toBe(403);
    expect(await connectStatus(port, '[::ffff:127.0.0.1]:443')).toBe(403);
  });

  it('forwards a TLS CONNECT tunnel to the validated upstream', async () => {
    upstreamServer = createTcpServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind a TCP port');

    server = createRelayServer({}, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => createConnection({ host: '127.0.0.1', port: upstreamAddress.port }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const relayAddress = server.address();
    if (!relayAddress || typeof relayAddress === 'string') throw new Error('relay did not bind a TCP port');

    const clientHello = validClientHello();
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: relayAddress.port, method: 'CONNECT', path: 'example.com:443' });
      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(200);
        socket.once('data', (chunk) => {
          socket.destroy();
          resolve(chunk);
        });
        socket.write(clientHello);
      });
      req.on('error', reject);
      req.end();
    });
    expect(echoed).toEqual(clientHello);
  });

  it('closes a CONNECT tunnel that does not start with a TLS ClientHello', async () => {
    let upstreamReceivedData = false;
    upstreamServer = createTcpServer((socket) => {
      socket.on('data', () => { upstreamReceivedData = true; });
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind a TCP port');

    server = createRelayServer({}, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => createConnection({ host: '127.0.0.1', port: upstreamAddress.port }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const relayAddress = server.address();
    if (!relayAddress || typeof relayAddress === 'string') throw new Error('relay did not bind a TCP port');

    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: relayAddress.port, method: 'CONNECT', path: 'example.com:443' });
      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(200);
        socket.once('close', resolve);
        socket.write('GET /plain-http HTTP/1.1\r\n\r\n');
      });
      req.on('error', reject);
      req.end();
    });
    expect(upstreamReceivedData).toBe(false);
  });

  it('rejects a forged short TLS header before forwarding any data', async () => {
    let upstreamReceivedData = false;
    upstreamServer = createTcpServer((socket) => socket.on('data', () => { upstreamReceivedData = true; }));
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind a TCP port');
    server = createRelayServer({}, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => createConnection({ host: '127.0.0.1', port: upstreamAddress.port }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('relay did not bind a TCP port');
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, method: 'CONNECT', path: 'example.com:443' });
      req.on('connect', (_res, socket) => {
        socket.once('close', resolve);
        socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00]));
      });
      req.on('error', reject);
      req.end();
    });
    expect(upstreamReceivedData).toBe(false);
  });

  it('rejects IPv6 documentation and transition ranges', async () => {
    await startDefaultRelay();
    expect(await connectStatus(port, '[2001:db8::1]:443')).toBe(403);
    expect(await connectStatus(port, '[2001::1]:443')).toBe(403);
    expect(await connectStatus(port, '[3fff::1]:443')).toBe(403);
    expect(await connectStatus(port, '[2002::1]:443')).toBe(403);
  });
});

function validClientHello(): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), Buffer.alloc(32),
    Buffer.from([0x00, 0x00, 0x02, 0x13, 0x01, 0x01, 0x00]),
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 0x01;
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record[0] = 0x16; record[1] = 0x03; record[2] = 0x01;
  record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}

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
