import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSponsoredGateway } from '../src/sponsored-gateway';
import { SponsoredQuota } from '../src/sponsored-quota';

it('isolates activity and images, serializes runs, prevents cross-session stops and retains the allowance', async () => {
  let running = false, runId = 0, starts = 0, stops = 0;
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('retry: 3000\n\n'); return;
    }
    if (url.pathname === '/api/status') return res.end(JSON.stringify({ shareProtocol: 1, running, runId,
      payments: true, modelReady: true, maximum: '0.05', network: { ip: '136.80.57.82' }, expectedIp: '136.80.57.82' }));
    if (url.pathname === '/api/run') {
      let body=''; for await (const chunk of req) body+=chunk;
      expect(JSON.parse(body).shared).toBe(true);
      running = true; starts++; runId++;
      res.statusCode = 202; return res.end(JSON.stringify({ running, runId }));
    }
    if (url.pathname === '/api/stop') { stops++; running = false; return res.end('{}'); }
    if (url.pathname === '/api/activity') return res.end(JSON.stringify({ running, runId, events: [
      { id: 1, runId: 0, type: 'task', message: 'private operator task' },
      { id: runId + 1, runId, type: 'observation', message: 'visitor ' + runId },
    ] }));
    if (url.pathname === '/frame.jpg') {
      if (Number(url.searchParams.get('runId')) !== runId) { res.statusCode = 204; return res.end(); }
      return res.end('image ' + runId);
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'wraps-public-test-'));
  const origin = 'https://demo.test';
  const gateway = createSponsoredGateway({ origin, backend: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, quota: new SponsoredQuota(directory, 2) });
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  const cookie = async () => (await fetch(url)).headers.get('set-cookie')!.split(';')[0];
  const start = (cookie: string, requestOrigin = origin) => fetch(url + '/api/run', { method: 'POST', headers: {
    cookie, origin: requestOrigin, 'content-type': 'application/json',
  }, body: JSON.stringify({ task: 'Research public documentation', budget: '0.05', mode: 'agent' }) });
  try {
    const a = await cookie(), b = await cookie(), c = await cookie();
    expect((await start(a, 'https://evil.test')).status).toBe(403);
    expect((await start(a + 'tampered')).status).toBe(401);
    expect((await start(a)).status).toBe(202);
    expect((await start(b)).status).toBe(409);
    await gateway.poll();
    expect(await (await fetch(url + '/api/activity', { headers: { cookie: a } })).text()).toContain('visitor 1');
    expect(await (await fetch(url + '/api/activity', { headers: { cookie: a } })).text()).not.toContain('private operator');
    expect(await (await fetch(url + '/api/activity', { headers: { cookie: b } })).json()).toEqual({ events: [] });
    expect((await fetch(url + '/frame.jpg', { headers: { cookie: b } })).status).toBe(204);
    await fetch(url + '/api/stop', { method: 'POST', headers: { cookie: b, origin } });
    expect(stops).toBe(0);
    running = false; await gateway.poll();
    expect((await start(a)).status).toBe(429);
    expect((await start(b)).status).toBe(202);
    await gateway.poll();
    expect(await (await fetch(url + '/frame.jpg', { headers: { cookie: a } })).text()).toBe('image 1');
    expect(await (await fetch(url + '/frame.jpg', { headers: { cookie: b } })).text()).toBe('image 2');
    running = false; await gateway.poll();
    expect((await start(c)).status).toBe(429);
    expect(starts).toBe(2);
    expect((await fetch(url + '/events')).status).toBe(404);
    backend.closeAllConnections();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await fetch(url + '/api/status')).status).toBe(503);
  } finally {
    await gateway.close(); backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
