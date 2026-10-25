import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoApp, type DemoApp, type DemoController, type DemoMode } from '../src/app';
import { checkControl, controlPolicy, isLoopbackHost, TOKEN_HEADER, type ControlPolicy } from '../src/control';

class FakeController implements DemoController {
  running = false;
  mode: DemoMode | null = null;
  starts = 0;
  start(mode: DemoMode = 'normal') {
    if (this.running) return false;
    this.running = true;
    this.mode = mode;
    this.starts++;
    return true;
  }
  async stop() {
    this.running = false;
    this.mode = null;
  }
}

let app: DemoApp | undefined;
let fake: FakeController;

async function serve(policy: ControlPolicy): Promise<string> {
  fake = new FakeController();
  app = createDemoApp({ policy, controller: () => fake });
  await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  await new Promise((resolve) => app!.server.close(resolve));
  app = undefined;
});

const post = (url: string, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers });

describe('control policy', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', '']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('makes a random token only for a non-loopback host', () => {
    expect(controlPolicy('127.0.0.1').token).toBeUndefined();
    const a = controlPolicy('0.0.0.0');
    const b = controlPolicy('0.0.0.0');
    expect(a.loopbackOnly).toBe(false);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('refuses a non-loopback client in loopback mode', () => {
    const req = { headers: { host: '127.0.0.1:4174' }, socket: { remoteAddress: '10.0.0.5' } } as unknown as IncomingMessage;
    expect(checkControl(req, controlPolicy('127.0.0.1'))).toMatchObject({ ok: false, status: 403 });
  });
});

describe('control endpoints, loopback host', () => {
  it('lets a loopback client start and stop', async () => {
    const base = await serve(controlPolicy('127.0.0.1'));
    expect((await post(`${base}/api/start`)).status).toBe(202);
    expect(fake.running).toBe(true);
    expect((await post(`${base}/api/stop`)).status).toBe(200);
    expect(fake.running).toBe(false);
  });

  it('refuses a cross-origin browser request', async () => {
    const base = await serve(controlPolicy('127.0.0.1'));
    const res = await post(`${base}/api/start`, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(fake.starts).toBe(0);
  });

  it('allows a same-origin browser request', async () => {
    const base = await serve(controlPolicy('127.0.0.1'));
    expect((await post(`${base}/api/start`, { origin: base })).status).toBe(202);
  });

  it('refuses a non-loopback Host header (DNS rebinding)', async () => {
    const base = await serve(controlPolicy('127.0.0.1'));
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/start`, { method: 'POST', headers: { host: 'rebind.example:4174' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(fake.starts).toBe(0);
  });
});

describe('control endpoints, non-loopback host', () => {
  it('needs the start-up token on start and stop', async () => {
    const policy = controlPolicy('0.0.0.0');
    const base = await serve(policy);
    expect((await post(`${base}/api/start`)).status).toBe(403);
    expect((await post(`${base}/api/start`, { [TOKEN_HEADER]: 'wrong' })).status).toBe(403);
    expect((await post(`${base}/api/start`, { [TOKEN_HEADER]: `${policy.token}x` })).status).toBe(403);
    expect(fake.starts).toBe(0);

    expect((await post(`${base}/api/start`, { [TOKEN_HEADER]: policy.token! })).status).toBe(202);
    expect((await post(`${base}/api/stop`)).status).toBe(403);
    expect(fake.running).toBe(true);
    expect((await post(`${base}/api/stop`, { [TOKEN_HEADER]: policy.token! })).status).toBe(200);
    expect(fake.running).toBe(false);
  });

  it('keeps the page and status readable without the token', async () => {
    const base = await serve(controlPolicy('0.0.0.0'));
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ running: false, mode: null, tokenRequired: true });
  });
});
