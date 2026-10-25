import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SpyBot } from '@agent-pay/spybot';
import { runPrivateAgent } from './agent-run';
import type { PrivateCacheDir } from './cache';
import { checkControl, type ControlPolicy } from './control';
import { loadSpyInputs } from './spy-inputs';

export const WATCHED_MERCHANT = 'ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3';
const MAX_HISTORY = 500;
const pagePath = fileURLToPath(new URL('./index.html', import.meta.url));

export interface DemoEvent {
  id: number;
  at: string;
  panel: 'spy' | 'agent' | 'system';
  type: string;
  data: unknown;
}

export type PublishFn = (panel: DemoEvent['panel'], type: string, data?: unknown) => void;

/** Starts and stops the two feeds. Tests replace it with a fake. */
export type DemoMode = 'normal' | 'tamper';

export interface DemoController {
  readonly running: boolean;
  readonly mode: DemoMode | null;
  start(mode?: DemoMode): boolean;
  stop(): Promise<void>;
}

export interface LiveControllerOptions {
  cache: PrivateCacheDir;
  quicknodeUrl?: string;
}

export class LiveDemoController implements DemoController {
  running = false;
  mode: DemoMode | null = null;
  private spy?: SpyBot;
  private spyRun?: Promise<unknown>;
  private agentRun?: Promise<void>;

  constructor(private publish: PublishFn, private opts: LiveControllerOptions) {}

  start(mode: DemoMode = 'normal'): boolean {
    if (this.running) return false;
    this.running = true;
    this.mode = mode;
    this.publish('system', 'status', { running: true, mode, message: mode === 'tamper' ? 'Tamper test started.' : 'Live demo started.' });
    this.spyRun = this.runSpy().catch((err: unknown) => {
      this.publish('spy', 'error', { message: err instanceof Error ? err.message : String(err) });
    });
    const agentRun = runPrivateAgent((type, data = null) => this.publish('agent', type, data), { tamper: mode === 'tamper' });
    this.agentRun = agentRun;
    void agentRun.finally(() => {
      if (this.agentRun === agentRun) this.agentRun = undefined;
      if (this.running) this.publish('agent', 'status', { message: 'The private-payment run has ended. The spy bot is still watching.' });
    });
    return true;
  }

  private async runSpy(): Promise<void> {
    const inputs = await loadSpyInputs(this.opts.cache, [WATCHED_MERCHANT]);
    if (!this.running) return;
    const { directory } = inputs;
    this.publish('spy', 'directory', { count: directory.entries.length, fromCache: directory.fromCache, fetchedAt: directory.fetchedAt });
    const bot = new SpyBot({
      merchants: [WATCHED_MERCHANT],
      limit: 15,
      follow: true,
      pollMs: 6_000,
      quicknodeUrl: this.opts.quicknodeUrl,
      directory: directory.entries,
      // A fresh catalog cache in the private directory. Without one, skip the catalog so the
      // spy bot never writes a cache file itself.
      catalog: inputs.catalogCachePath !== undefined,
      catalogCachePath: inputs.catalogCachePath,
    });
    this.spy = bot;
    bot.on('catalog', (data) => this.publish('spy', 'catalog', data));
    bot.on('payment', (data) => this.publish('spy', 'payment', data));
    bot.on('funder', (data) => this.publish('spy', 'funder', data));
    bot.on('progress', (data) => this.publish('spy', 'progress', data));
    bot.on('cluster', (data) => this.publish('spy', 'cluster', data));
    bot.on('retry', (data) => this.publish('spy', 'retry', data));
    bot.on('warning', (err) => this.publish('spy', 'warning', { message: err.message }));
    bot.on('done', () => this.publish('spy', 'done'));
    await bot.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.spy?.stop();
    await Promise.allSettled([this.spyRun, this.agentRun].filter((task): task is Promise<unknown> => Boolean(task)));
    this.spy = undefined;
    this.spyRun = undefined;
    this.agentRun = undefined;
    this.mode = null;
    this.publish('system', 'status', { running: false, mode: null, message: 'Live demo stopped.' });
  }
}

export interface DemoApp {
  server: Server;
  controller: DemoController;
  publish: PublishFn;
  history: DemoEvent[];
  /** Stops the run and ends every event stream. Does not close the listener. */
  shutdown(): Promise<void>;
}

export interface DemoAppOptions {
  policy: ControlPolicy;
  controller: (publish: PublishFn) => DemoController;
}

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function allowControl(req: IncomingMessage, res: ServerResponse, policy: ControlPolicy): boolean {
  const decision = checkControl(req, policy);
  if (!decision.ok) json(res, decision.status, { error: decision.error });
  return decision.ok;
}

export function createDemoApp(opts: DemoAppOptions): DemoApp {
  const history: DemoEvent[] = [];
  const clients = new Set<ServerResponse>();
  let nextEventId = 1;

  const publish: PublishFn = (panel, type, data = null) => {
    const event: DemoEvent = { id: nextEventId++, at: new Date().toISOString(), panel, type, data };
    history.push(event);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  const controller = opts.controller(publish);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://demo.local');
    if (req.method === 'GET' && url.pathname === '/') {
      try {
        const html = await readFile(pagePath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.byteLength });
        res.end(html);
      } catch {
        json(res, 500, { error: 'demo page is unavailable' });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, { running: controller.running, mode: controller.mode, tokenRequired: opts.policy.token !== undefined });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      for (const event of history) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      heartbeat.unref();
      res.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (!allowControl(req, res, opts.policy)) return;
      const tamper = url.searchParams.get('tamper') === '1';
      const started = controller.start(tamper ? 'tamper' : 'normal');
      json(res, started ? 202 : 409, {
        running: controller.running,
        mode: controller.mode,
        message: started ? (tamper ? 'Tamper test started.' : 'Live demo started.') : 'A demo run is already active.',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!allowControl(req, res, opts.policy)) return;
      await controller.stop();
      json(res, 200, { running: controller.running });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  async function shutdown() {
    await controller.stop();
    for (const client of clients) client.end();
    clients.clear();
  }

  return { server, controller, publish, history, shutdown };
}
