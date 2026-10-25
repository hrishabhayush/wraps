// npm run demo:browser — local dashboard, isolated Playwright browser, explicit AP4M opt-in.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { checkControl, controlPolicy } from './control';
import { paymentConfig, purchase } from './browser-payment';

const port = Number(process.env.BROWSER_DEMO_PORT ?? 4176);
const base = `http://127.0.0.1:${port}`;
const expectedIp = process.env.DEMO_EXIT_IP ?? '136.80.57.82';
const config = paymentConfig(process.env);
const policy = controlPolicy('127.0.0.1');
const website = fileURLToPath(new URL('../../../website/', import.meta.url));
const clients = new Set<ServerResponse>();
const history: { type: string; message: string; at: string }[] = [];
let browser: Browser | undefined, page: Page | undefined, frame: Buffer | undefined;
let running = false, capturing = false;
let network: { ip?: string; checkedAt?: string; error?: string } = {};
let checking: Promise<typeof network> | undefined;

function publish(type: string, message: string) {
  const event = { type, message, at: new Date().toISOString() };
  history.push(event);
  if (history.length > 100) history.shift();
  for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
}
function checkNetwork() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!response.ok) throw new Error('IP service unavailable');
      const data = await response.json() as { ip: string };
      if (!data.ip || typeof data.ip !== 'string') throw new Error('IP service returned no address');
      network = { ip: data.ip, checkedAt: new Date().toISOString() };
    } catch { network = { error: 'Agent IP check failed; previous result is not treated as current.' }; }
    return network;
  })().finally(() => { checking = undefined; });
  return checking;
}
async function capture() {
  if (!page || page.isClosed() || capturing) return;
  capturing = true;
  try { frame = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 2500 }); } catch { /* Window may be navigating or closing. */ }
  finally { capturing = false; }
}
async function run() {
  try {
    publish('task', 'Research XRP transaction fees. Open the reference, then evaluate the paid report within a 1 RLUSD ceiling.');
    publish('mode', config.ready ? 'AP4M live payment enabled. One retained purchase operation.' : 'Preview: browser actions are real; sample payment challenge only. No vouchers signed or money spent.');
    await browser?.close();
    const { AGENT_PRIVATE_KEY: _key, ...browserEnv } = process.env;
    browser = await chromium.launch({ headless: process.env.BROWSER_DEMO_HEADLESS === '1', slowMo: 250, env: browserEnv });
    page = await browser.newPage({ viewport: { width: 1100, height: 740 }, serviceWorkers: 'block' });
    await page.goto(`${base}/research`);
    await page.getByLabel('Research topic').fill('XRP transaction fees');
    await page.getByRole('button', { name: 'Find sources' }).click();
    await capture();
    publish('decision', 'Rule-based planner: read the free XRPL reference before considering the paid report.');
    await page.getByRole('link', { name: 'Read XRPL transaction-cost reference' }).click();
    await page.waitForLoadState('domcontentloaded');
    publish('browser', `Opened ${page.url()}`);
    await capture();
    const heading = await page.locator('h1').first().innerText({ timeout: 15000 });
    publish('observation', `Reference heading: ${heading.slice(0, 120)}`);
    await page.goto(`${base}/research`);
    await page.getByLabel('Research topic').fill('XRP transaction fees');
    await page.getByRole('button', { name: 'Find sources' }).click();
    if (config.ready) await page.setExtraHTTPHeaders({ 'X-AP4M-CHANNEL-ID': process.env.AP4M_CHANNEL_ID! });
    await page.getByRole('link', { name: 'Request paid XRP report' }).click();
    await capture();
    if (!config.ready) {
      publish('http', 'Sample merchant returned HTTP 402. This is a preview challenge, not an AP4M voucher.');
      publish('blocked', `No payment attempted. ${config.missing.length ? `Configure ${config.missing.join(', ')}. ` : ''}Real purchases require AP4M_ENABLE_PAYMENTS=1 and an approved budget.`);
      return;
    }
    const net = await checkNetwork();
    publish('network', net.ip ? `Agent egress: ${net.ip}; expected exit: ${expectedIp}.` : net.error!);
    publish('decision', `Accept only a valid AP4M channel challenge costing at most ${config.maximum} RLUSD. The SDK checks this before signing.`);
    const result = await purchase(process.env, net.ip ?? '', expectedIp, publish);
    publish('transaction', result.transactionHash);
    publish('complete', `Voucher redemption confirmed on-chain. Paid resource received. Operation: ${result.operation}.`);
    await page.goto(`${base}/research`);
    await page.locator('#result').evaluate((element, content) => { element.textContent = JSON.stringify(content, null, 2); }, result.resource);
    await capture();
  } catch (error) {
    // SDK errors may contain merchant bodies; keep payment headers and private data out of the UI.
    const message = error instanceof Error ? error.message : String(error);
    publish('error', message.replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]').slice(0, 240));
  } finally { running = false; publish('status', 'Run finished. The browser stays open for inspection.'); }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
}
const server = createServer(async (req, res) => {
  const allowed = checkControl(req, policy);
  if (!allowed.ok) return json(res, allowed.status, { error: allowed.error });
  const url = new URL(req.url ?? '/', base);
  if (req.method === 'POST' && url.pathname === '/api/run') {
    if (running) return json(res, 409, { error: 'A run is already active' });
    running = true; void run(); return json(res, 202, { running });
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/status') return json(res, 200, { running, payments: config.ready, missing: config.missing, maximum: config.maximum, network, expectedIp });
  if (url.pathname === '/frame.jpg') {
    if (!frame) { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(frame);
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
    clients.add(res); res.on('close', () => clients.delete(res)); return;
  }
  if (url.pathname === '/sample-resource') {
    res.writeHead(402, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Sample report · Payment required</title><style>body{margin:70px;background:#0a0a0a;color:white;font:22px system-ui;line-height:1.6}small{color:#39c989}p{color:#b4b4c0}h1{font-size:48px}</style><small>PREVIEW · HTTP 402</small><h1>XRP research report</h1><h2>1 RLUSD</h2><p>The agent has reached the payment step.</p><p>No voucher was signed. No funds were spent.<br>Connect an AP4M merchant and channel to run a real purchase.</p></html>');
  }
  if (url.pathname === '/research') {
    const target = config.ready ? config.resourceUrl! : `${base}/sample-resource`;
    const escaped = target.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Wraps · Research desk</title><style>body{background:#0a0a0a;color:#fff;font:20px system-ui;margin:65px;line-height:1.7}input,button{font:inherit;padding:12px;border-radius:12px}a{display:block;color:#9de8c3;margin:30px 0}small{color:#aaa}pre{white-space:pre-wrap}</style><h1>wraps / Research desk</h1><small>${config.ready ? 'Live AP4M merchant configured' : 'Preview · sample paid report · no funds spent'}</small><p><label>Research topic <input aria-label="Research topic"></label> <button onclick="document.querySelector('#sources').hidden=false">Find sources</button></p><section id="sources" hidden><a href="https://xrpl.org/docs/concepts/transactions/transaction-cost">Read XRPL transaction-cost reference</a><a href="${escaped}">Request paid XRP report</a><small>Maximum purchase: ${config.maximum} RLUSD. Rule-based planner.</small></section><pre id="result"></pre></html>`);
  }
  try {
    let path: string, type: string;
    if (url.pathname === '/') { path = fileURLToPath(new URL('./browser.html', import.meta.url)); type = 'text/html'; }
    else if (url.pathname === '/ip-check/') { path = website + 'ip-check/index.html'; type = 'text/html'; }
    else if (/^\/assets\/(logo\.svg|fonts\/[a-z0-9-]+\.woff2)$/.test(url.pathname)) { path = website + url.pathname.slice(1); type = url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2'; }
    else return json(res, 404, { error: 'Not found' });
    const data = await readFile(path); res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(data);
  } catch { json(res, 500, { error: 'Page unavailable' }); }
});
const snapshots = setInterval(() => void capture(), 1000);
const checks = setInterval(() => void checkNetwork(), 15000);
void checkNetwork();
server.listen(port, '127.0.0.1', () => console.log(`Browser agent demo: ${base} (${config.ready ? 'LIVE AP4M' : 'preview; payments disabled'})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  clearInterval(snapshots); clearInterval(checks);
  await browser?.close();
  for (const client of clients) client.end();
  server.close();
});
