import { createServer, get } from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseAgentRequest } from './general-agent';
import { SponsoredQuota } from './sponsored-quota';

type Activity = { id: number; runId: number; type: string; message: string; at: string };
type Session = { runId?: number; events: Activity[]; frame?: Buffer; running: boolean; started: number; stopping?: boolean };
const website = fileURLToPath(new URL('../../../website/', import.meta.url));

/** Serializes the private engine and exposes only each visitor's own run. */
export function createSponsoredGateway(options: { origin: string; backend: string; quota: SponsoredQuota }) {
  const origin = new URL(options.origin).origin;
  const sessions = new Map<string, Session>();
  const signingKey = randomBytes(32);
  let active: Session | undefined, checking = false;
  // A private-server restart resets its run IDs. Invalidate sharing instead of reusing them.
  let backendLost = false;
  let connected!: (value: boolean) => void;
  const connection = new Promise<boolean>(resolve => { connected = resolve; });
  const watcher = get(options.backend + '/events', response => {
    clearTimeout(connectionTimeout);
    connected(response.statusCode === 200);
    response.resume();
    response.once('close', () => { backendLost = true; });
  });
  const connectionTimeout = setTimeout(() => watcher.destroy(new Error('Private server unavailable')), 5000);
  watcher.on('error', () => { clearTimeout(connectionTimeout); backendLost = true; connected(false); });
  const mac = (value: string) => createHmac('sha256', signingKey).update(value).digest('base64url');
  function identity(cookie = '') {
    const value = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('wraps_session='))?.slice(14);
    if (!value || !/^[\w-]{32}\.[\w-]{43}$/.test(value)) return;
    const [id, signature] = value.split('.');
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(mac(id)))) return id;
  }
  async function backend(path: string, init?: RequestInit) {
    return fetch(options.backend + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) });
  }
  async function status() {
    if (!await connection || backendLost) throw new Error('Private demo restarted; restart sharing before continuing.');
    const res = await backend('/api/status');
    if (!res.ok) throw new Error('Local demo unavailable');
    const value = await res.json();
    if (value.shareProtocol !== 1) throw new Error('Restart npm run ap4m:demo to load sharing support');
    return value;
  }
  async function poll() {
    if (!active || active.runId === undefined || checking || backendLost) return;
    checking = true;
    const current = active;
    try {
      const response = await backend('/api/activity');
      if (!response.ok) throw Error('Local activity unavailable');
      const data = await response.json();
      if (backendLost) return;
      const lastId = current.events.at(-1)?.id ?? 0;
      current.events.push(...data.events.filter((e: Activity) => e.runId === current.runId && e.id > lastId).map((e: Activity) =>
        e.type === 'error' && e.message.startsWith('Connect Wraps first:') ? { ...e, message: 'Host VPN became unavailable; the run stopped.' } : e));
      current.events = current.events.slice(-100);
      // The private server checks frame ownership atomically, including across new runs.
      const frame = await backend(`/frame.jpg?runId=${current.runId}`);
      if (frame.status === 200) {
        const image = Buffer.from(await frame.arrayBuffer());
        if (!backendLost) current.frame = image;
      }
      if (data.runId !== current.runId || !data.running) { current.running = false; active = undefined; }
      else if (Date.now() - current.started > 180000 && !current.stopping) {
        current.stopping = true;
        await backend('/api/stop', { method: 'POST' });
      }
    } catch { /* Keep the slot busy when the outcome is unknown; never start a second purchase. */ }
    finally { checking = false; }
  }
  const timer = setInterval(() => void poll(), 1000);
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'no-referrer');
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { error: 'Open the demo page to start a run.' });
      if (!['GET', 'POST'].includes(req.method ?? '')) return json(405, { error: 'Method not allowed' });
      let id = identity(req.headers.cookie);
      if (req.method === 'GET' && url.pathname === '/' && !id) {
        id = randomBytes(24).toString('base64url');
        res.setHeader('set-cookie', `wraps_session=${id}.${mac(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
      }
      const session = id ? sessions.get(id) : undefined;
      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (!id) return json(401, { error: 'Refresh the demo page before starting.' });
        if (session) return json(429, { error: 'This visitor session has used its sponsored run.' });
        if (active) return json(409, { error: 'Another visitor is running a task. Try again shortly.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Expected a JSON task.' });
        let body = '';
        for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 8192) return json(413, { error: 'Task too large.' }); }
        let request;
        try { request = parseAgentRequest(JSON.parse(body), '0.05'); }
        catch { return json(400, { error: 'Enter a task and a budget between 0 and 0.05 RLUSD.' }); }
        if (request.mode !== 'agent') return json(400, { error: 'Choose General research agent.' });
        // Reserve the in-memory slot before any awaited preflight or disk operation.
        if (active || sessions.has(id)) return json(409, { error: 'A run is already active.' });
        const job: Session = { events: [], running: true, started: Date.now() }; active = job;
        try {
          const state = await status();
          if (state.running || !state.payments || !state.modelReady || state.network.ip !== state.expectedIp || Number(state.maximum) > 0.05) {
            active = undefined; return json(503, { error: 'The host is busy or its VPN/payment service is unavailable. Try later.' });
          }
          await options.quota.reserve();
        } catch {
          active = undefined; return json(429, { error: 'Sponsored allowance or local service unavailable. No run was started.' });
        }
        sessions.set(id, job);
        try {
          const response = await backend('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, shared: true }) });
          const result = await response.json();
          if (!response.ok) { job.running = false; active = undefined; return json(response.status, { error: 'Local demo could not start the run.' }); }
          job.runId = result.runId;
          return json(202, { running: true });
        } catch {
          // A timed-out start might already be spending. Fail closed until the host restarts sharing.
          return json(503, { error: 'Run startup is uncertain. The host must inspect it before further runs.' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (session && active === session && session.runId !== undefined) {
          const state = await status();
          if (state.runId === session.runId && state.running) await backend('/api/stop', { method: 'POST' });
        }
        return json(202, { stopping: Boolean(session?.running) });
      }
      if (req.method !== 'GET') return json(404, { error: 'Not found' });
      if (url.pathname === '/api/status') {
        const state = await status();
        return json(200, { running: session?.running ?? false, payments: state.payments, modelReady: state.modelReady,
          model: state.model, maximum: '0.05', expectedIp: state.expectedIp,
          network: state.network.ip === state.expectedIp ? state.network : { error: 'Host VPN exit unavailable; runs are paused.' },
          sponsored: true, vpnReady: state.network.ip === state.expectedIp, remaining: await options.quota.remaining(), used: Boolean(session), busy: Boolean(active && active !== session) });
      }
      if (url.pathname === '/api/activity') return json(200, { events: (session?.events ?? []).filter(e => e.id > Number(url.searchParams.get('after') ?? 0)) });
      if (url.pathname === '/frame.jpg') {
        if (!session?.frame) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(session.frame);
      }
      let path: string, type: string;
      if (url.pathname === '/') { path = fileURLToPath(new URL('./browser.html', import.meta.url)); type = 'text/html'; }
      else if (url.pathname === '/ip-check/') { path = website + 'ip-check/index.html'; type = 'text/html'; }
      else if (/^\/assets\/(logo\.svg|fonts\/[a-z0-9-]+\.woff2)$/.test(url.pathname)) { path = website + url.pathname.slice(1); type = url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2'; }
      else return json(404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': type }); res.end(await readFile(path));
    } catch { if (!res.headersSent) json(503, { error: 'The host demo is unavailable. Try again later.' }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, poll, async close() {
    clearInterval(timer);
    if (active?.runId !== undefined) {
      const state = await status().catch(() => undefined);
      if (state?.running && state.runId === active.runId) await backend('/api/stop', { method: 'POST' }).catch(() => {});
    }
    watcher.destroy(); clearTimeout(connectionTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
