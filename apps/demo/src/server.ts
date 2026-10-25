import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { ResearchAgent, DEMO_TASKS } from '@wraps/agent';
import { startIssuer } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { SpyBot, XrplRpc } from '@agent-pay/spybot';
import { x402Fetch } from 'x402-xrpl';
import { Wallet } from 'xrpl';

const PORT = Number(process.env.DEMO_PORT ?? 4174);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
const MAX_HISTORY = 500;
const pagePath = fileURLToPath(new URL('./index.html', import.meta.url));

interface DemoEvent {
  id: number;
  at: string;
  panel: 'spy' | 'agent' | 'system';
  type: string;
  data: unknown;
}

const history: DemoEvent[] = [];
const clients = new Set<ServerResponse>();
let nextEventId = 1;
let running = false;
let spy: SpyBot | undefined;
let spyRun: Promise<unknown> | undefined;
let agentRun: Promise<void> | undefined;

function publish(panel: DemoEvent['panel'], type: string, data: unknown = null) {
  const event: DemoEvent = { id: nextEventId++, at: new Date().toISOString(), panel, type, data };
  history.push(event);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
}

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function startSpy() {
  const testnetMerchant = process.env.XRPL_TESTNET_MERCHANT_ADDRESS;
  if (!testnetMerchant) throw new Error('XRPL_TESTNET_MERCHANT_ADDRESS is required to start the testnet observer.');
  const bot = new SpyBot({
    merchants: [testnetMerchant],
    limit: 15,
    follow: true,
    cluster: false,
    catalog: false,
    directory: [],
    rpc: XrplRpc.testnet(),
    pollMs: 6_000,
  });
  spy = bot;
  bot.on('directory', (data) => publish('spy', 'directory', data));
  bot.on('catalog', (data) => publish('spy', 'catalog', data));
  bot.on('payment', (data) => publish('spy', 'payment', data));
  bot.on('funder', (data) => publish('spy', 'funder', data));
  bot.on('progress', (data) => publish('spy', 'progress', data));
  bot.on('cluster', (data) => publish('spy', 'cluster', data));
  bot.on('retry', (data) => publish('spy', 'retry', data));
  bot.on('warning', (err) => publish('spy', 'warning', { message: err.message }));
  bot.on('done', () => publish('spy', 'done'));
  spyRun = bot.run().catch((err: unknown) => {
    publish('spy', 'error', { message: err instanceof Error ? err.message : String(err) });
  });
}

async function runTestnetAgent() {
  const seed = process.env.XRPL_TESTNET_BUYER_SEED;
  const resourceUrl = process.env.XRPL_TESTNET_RESOURCE_URL;
  if (!seed || !resourceUrl) {
    publish('spy', 'status', { message: 'Testnet buyer is idle. Set XRPL_TESTNET_BUYER_SEED and XRPL_TESTNET_RESOURCE_URL to enable it.' });
    return;
  }
  try {
    const buyer = Wallet.fromSeed(seed);
    publish('spy', 'status', { message: 'Testnet agent is requesting the paid resource.' });
    const paidFetch = x402Fetch({ wallet: buyer, network: 'xrpl:1' });
    const response = await paidFetch(resourceUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      publish('spy', 'error', { message: `Testnet x402 request returned HTTP ${response.status}.` });
      return;
    }
    publish('spy', 'status', { message: `Testnet x402 resource paid; response HTTP ${response.status}. Waiting for the bot to observe the validated payment.` });
  } catch (err) {
    publish('spy', 'error', { message: err instanceof Error ? err.message : String(err) });
  }
}

async function runPrivateAgent() {
  let issuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
  let merchant: Merchant | undefined;
  try {
    publish('agent', 'status', { message: 'Starting local mock issuer and merchant.' });
    const expectedPcrs = mockPcrs('issuer');
    issuer = await startIssuer({
      payoutIntervalMs: 3_600_000,
      log: (message) => publish('agent', 'issuer', { message }),
    });
    merchant = new Merchant({
      issuerUrl: issuer.url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      log: (message) => publish('agent', 'merchant', { message }),
    });
    const merchantUrl = await merchant.start();
    const sdk = new PrivatePayClient({
      issuerUrl: issuer.url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      wallet: new MockTopUpWallet(),
      caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
      onEvent: (event) => publish('agent', `sdk:${event.type}`, event),
    });
    await sdk.connect();
    publish('agent', 'status', { message: 'Issuer attestation verified. Running a research task.' });
    await new ResearchAgent({
      sdk,
      merchantUrl,
      print: (message) => publish('agent', 'reasoning', { message }),
    }).run([DEMO_TASKS[0]]);
    publish('agent', 'complete', { message: 'The local private-payment task finished.' });
  } catch (err) {
    publish('agent', 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    await merchant?.close();
    await issuer?.close();
  }
}

function startDemo() {
  if (running) return false;
  running = true;
  publish('system', 'status', { running, message: 'Live demo started.' });
  const missingTestnetConfig = ['XRPL_TESTNET_BUYER_SEED', 'XRPL_TESTNET_RESOURCE_URL', 'XRPL_TESTNET_MERCHANT_ADDRESS']
    .filter((name) => !process.env[name]);
  if (missingTestnetConfig.length === 0) {
    startSpy();
    void runTestnetAgent();
  } else {
    publish('spy', 'status', { message: `Testnet x402 buyer is idle. Configure ${missingTestnetConfig.join(', ')} to enable it.` });
  }
  agentRun = runPrivateAgent();
  void agentRun.finally(() => {
    agentRun = undefined;
    if (running) publish('agent', 'status', { message: 'The private-payment run has ended. The spy bot is still watching.' });
  });
  return true;
}

async function stopDemo() {
  if (!running) return;
  running = false;
  spy?.stop();
  await Promise.allSettled([spyRun, agentRun].filter((task): task is Promise<unknown> => Boolean(task)));
  spy = undefined;
  spyRun = undefined;
  agentRun = undefined;
  publish('system', 'status', { running, message: 'Live demo stopped.' });
}

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
    json(res, 200, { running });
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
    json(res, startDemo() ? 202 : 409, { running, message: running ? 'Demo is running.' : 'Demo is already running.' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    await stopDemo();
    json(res, 200, { running });
    return;
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  publish('system', 'ready', { url: `http://${HOST}:${PORT}`, message: 'Split-screen demo server ready.' });
  console.log(`Demo ready at http://${HOST}:${PORT}`);
});

async function shutdown() {
  await stopDemo();
  for (const client of clients) client.end();
  clients.clear();
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
