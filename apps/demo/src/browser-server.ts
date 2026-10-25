// npm run demo:browser — local dashboard, isolated Playwright browser, explicit AP4M opt-in.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { checkControl, controlPolicy } from './control';
import { paymentConfig, purchase } from './browser-payment';
import { parseAgentRequest, runGeneralAgent, openaiModel, type AgentRequest, type ResearchTools } from './general-agent';
import { browserEnvironment, checkBrowserUrl } from './browser-safety';
import { SponsoredQuota } from './sponsored-quota';
import { publicBrowserFetch } from './public-browser-fetch';
import { AP4M_TASK, runPaymentTask } from './ap4m-task';

const port = Number(process.env.BROWSER_DEMO_PORT ?? 4176);
const base = `http://127.0.0.1:${port}`;
const expectedIp = process.env.DEMO_EXIT_IP ?? '136.80.57.82';
const config = paymentConfig(process.env);
const sponsored = process.env.WRAPS_SPONSORED === '1';
if (sponsored && (!config.ready || !process.env.OPENAI_API_KEY || Number(config.maximum) > 0.05)) {
  throw new Error('Sponsored mode requires both keys, a configured channel, and a maximum price of 0.05 RLUSD.');
}
const quota = sponsored ? new SponsoredQuota(join(process.env.AP4M_STATE_DIR!, 'sponsored-runs')) : undefined;
const policy = controlPolicy('127.0.0.1');
const website = fileURLToPath(new URL('../../../website/', import.meta.url));
const clients = new Set<ServerResponse>();
const history: { id: number; runId: number; type: string; message: string; at: string }[] = [];
let eventId = 0, runId = 0, pageRunId = 0, frameRunId = 0;
let browser: Browser | undefined, page: Page | undefined, frame: Buffer | undefined;
let running = false, capturing = false;
let activeRun: AbortController | undefined;
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
let network: { ip?: string; checkedAt?: string; error?: string } = {};
let checking: Promise<typeof network> | undefined;

function publish(type: string, message: string) {
  const event = { id: ++eventId, runId, type, message, at: new Date().toISOString() };
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
  const capturedPage = page, capturedRun = pageRunId;
  try {
    const next = await capturedPage.screenshot({ type: 'jpeg', quality: 70, timeout: 2500 });
    if (page === capturedPage && runId === capturedRun) { frame = next; frameRunId = capturedRun; }
  } catch { /* Window may be navigating or closing. */ }
  finally { capturing = false; }
}
async function runDemo(request: AgentRequest, signal: AbortSignal) {
    if (config.resources.length > 1) {
      publish('task', 'Scripted task: buy each configured research service with a separate AP4M voucher.');
      await browser?.close();
      browser = await chromium.launch({ headless: process.env.BROWSER_DEMO_HEADLESS === '1', env: browserEnvironment(process.env) });
      page = await browser.newPage({ viewport: { width: 1100, height: 740 }, serviceWorkers: 'block' });
      pageRunId = runId;
      await page.goto(`${base}/research`);
      const completed: { service: string; result: unknown }[] = [];
      const results = await runPaymentTask({ resources: config.resources, budget: request.budget, signal, publish,
        buy: async (id, budget) => {
          const net = await checkNetwork();
          signal.throwIfAborted();
          const result = await purchase(process.env, net.ip ?? '', expectedIp, publish, budget, id);
          completed.push({ service: id, result: result.resource });
          await page!.locator('#result').evaluate((element, content) => { element.textContent = JSON.stringify(content, null, 2); }, completed);
          await capture();
          return result;
        },
      });
      await page.locator('#result').evaluate((element, content) => { element.textContent = JSON.stringify(content, null, 2); }, results);
      await capture();
      publish('answer', JSON.stringify(results.map(result => ({ service: result.id, result: result.resource })), null, 2));
      publish('complete', `${results.length} paid service results received. Each new purchase has a confirmed AP4M voucher redemption.`);
      return;
    }
    publish('task', `Scripted task: research XRP transaction fees, then evaluate the paid report within a ${request.budget} RLUSD ceiling.`);
    publish('mode', config.ready ? 'AP4M live payment enabled. One retained purchase operation.' : 'Preview: browser actions are real; sample payment challenge only. No vouchers signed or money spent.');
    await browser?.close();
    browser = await chromium.launch({ headless: process.env.BROWSER_DEMO_HEADLESS === '1', slowMo: 250, env: browserEnvironment(process.env) });
    page = await browser.newPage({ viewport: { width: 1100, height: 740 }, serviceWorkers: 'block' });
    pageRunId = runId;
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
    signal.throwIfAborted();
    publish('decision', `Accept only a valid AP4M channel challenge costing at most ${request.budget} RLUSD. The SDK checks this before signing.`);
    const result = await purchase(process.env, net.ip ?? '', expectedIp, publish, request.budget, config.resources[0].id);
    publish('transaction', result.transactionHash);
    publish('complete', `Voucher redemption confirmed on-chain. Paid resource received. Operation: ${result.operation}.`);
    await page.goto(`${base}/research`);
    await page.locator('#result').evaluate((element, content) => { element.textContent = JSON.stringify(content, null, 2); }, result.resource);
    await capture();
}

async function requireExit() {
  if (!config.ready) return;
  const net = await checkNetwork();
  if (net.ip !== expectedIp) throw new Error(`Connect Wraps first: agent IP ${net.ip ?? 'unavailable'} does not match ${expectedIp}.`);
}

async function runAgent(request: AgentRequest, signal: AbortSignal, shared = false) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in the terminal and restart this demo.');
  await requireExit();
  await browser?.close();
  browser = await chromium.launch({ headless: shared || process.env.BROWSER_DEMO_HEADLESS === '1', slowMo: 200, env: browserEnvironment(process.env) });
  const context = await browser.newContext({ viewport: { width: 1100, height: 740 }, serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: !shared });
  let sharedRequests = 0, sharedBytes = 0;
  await context.route('**/*', async route => {
    try {
      if (!['GET', 'HEAD'].includes(route.request().method())) return await route.abort();
      await checkBrowserUrl(route.request().url());
      if (shared) {
        if (!['document', 'stylesheet', 'image', 'font'].includes(route.request().resourceType())) return await route.abort();
        if (++sharedRequests > 60) return await route.abort();
        const response = await publicBrowserFetch(route.request().url());
        sharedBytes += response.body.length;
        if (sharedBytes > 20 * 1024 * 1024) return await route.abort();
        await route.fulfill(response);
      } else await route.continue();
    } catch { await route.abort().catch(() => {}); }
  });
  page = await context.newPage(); pageRunId = runId;
  context.on('page', extra => { if (extra !== page) void extra.close(); });
  page.setDefaultTimeout(12000);
  await page.setContent('<!doctype html><html><body style="background:#0a0a0a;color:white;font:24px system-ui;padding:60px"><h1>wraps / Agent browser</h1><p>Preparing your research task…</p></body></html>');
  let links: { index: number; text: string; url: string }[] = [];
  const read = async () => {
    const current = page!;
    const title = await current.title();
    const text = (await current.locator('body').innerText()).slice(0, 14000);
    links = await current.locator('a[href]').evaluateAll(elements => elements
      .filter(e => e.getClientRects().length && (e.textContent ?? '').trim())
      .slice(0, 60).map((e, index) => ({ index, text: (e.textContent ?? '').trim().slice(0, 140), url: (e as HTMLAnchorElement).href })));
    await capture();
    publish('observation', `${title.slice(0, 140)} · ${current.url()}`);
    return { url: current.url(), title, text, links };
  };
  const open = async (url: string) => {
    signal.throwIfAborted();
    const safe = await checkBrowserUrl(url);
    await page!.goto(safe, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return read();
  };
  const tools: ResearchTools = {
    search: query => open(`https://www.google.com/search?q=${encodeURIComponent(query)}`),
    open, read,
    follow: index => {
      const link = links.find(link => link.index === index);
      if (!link) throw new Error('Link index is no longer available');
      return open(link.url);
    },
    buy: async (resourceId, budget) => {
      await requireExit();
      const net = await checkNetwork();
      signal.throwIfAborted();
      return purchase(process.env, net.ip ?? '', expectedIp, publish, budget, resourceId);
    },
  };
  await runGeneralAgent({ ...request, model, call: openaiModel(process.env.OPENAI_API_KEY), tools,
    publish, checkNetwork: requireExit, signal,
    resources: config.ready ? config.resources : [],
  });
}

async function run(request: AgentRequest, shared = false) {
  const control = new AbortController(); activeRun = control;
  publish('task', request.task);
  publish('mode', request.mode === 'agent' ? `Model agent · ${model} · task budget ${request.budget} RLUSD` : 'Scripted demonstration');
  try {
    if (request.mode === 'agent') await runAgent(request, control.signal, shared);
    else { await requireExit(); control.signal.throwIfAborted(); await runDemo(request, control.signal); }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [process.env.AGENT_PRIVATE_KEY, process.env.OPENAI_API_KEY]) if (secret) message = message.split(secret).join('[redacted]');
    publish('error', control.signal.aborted ? 'Run stopped. Any already submitted payment may still complete; retry using the same retained state.' : message.replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]').slice(0, 300));
  } finally {
    if (shared) { await capture(); await browser?.close().catch(() => {}); }
    running = false; activeRun = undefined; publish('status', shared ? 'Run finished. The final browser image is available below.' : 'Run finished. The browser stays open for inspection.');
  }
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
    try {
      let body = '';
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 8192) return json(res, 413, { error: 'Task request too large' }); }
      const parsed = JSON.parse(body);
      const request = parseAgentRequest(parsed, config.maximum);
      const shared = parsed.shared === true;
      if (shared && request.mode !== 'agent') return json(res, 400, { error: 'Shared sessions require agent mode.' });
      if (sponsored && request.mode !== 'agent') return json(res, 400, { error: 'Sponsored mode supports general research tasks only.' });
      if (request.mode === 'agent' && !process.env.OPENAI_API_KEY) return json(res, 409, { error: 'Set OPENAI_API_KEY in the terminal and restart the demo.' });
      // Re-check after reading the body so concurrent requests cannot start two agents.
      if (running) return json(res, 409, { error: 'A run is already active' });
      running = true;
      if (quota) {
        try { await quota.reserve(); }
        catch { running = false; return json(res, 429, { error: 'Sponsored allowance unavailable or exhausted. No run was started.' }); }
      }
      runId++; frame = undefined;
      void run(request, shared); return json(res, 202, { running, runId });
    } catch { return json(res, 400, { error: `Enter a task, mode, and budget between 0 and ${config.maximum} RLUSD.` }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') { activeRun?.abort(); publish('status', 'Stop requested. Already submitted payments cannot be cancelled.'); return json(res, 202, { stopping: running }); }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/status') return json(res, 200, { shareProtocol: 1, runId, running, payments: config.ready, missing: config.missing, maximum: config.maximum, modelReady: Boolean(process.env.OPENAI_API_KEY), model, network, expectedIp,
    paymentTask: process.env.AP4M_DEMO_TASK === '1' ? AP4M_TASK : undefined,
  });
  if (url.pathname === '/api/activity') return json(res, 200, { running, runId, events: history.filter(e => e.id > Number(url.searchParams.get('after') ?? 0)) });
  if (url.pathname === '/frame.jpg') {
    if (!frame || (url.searchParams.has('runId') && Number(url.searchParams.get('runId')) !== frameRunId)) { res.writeHead(204); return res.end(); }
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
  activeRun?.abort(); clearInterval(snapshots); clearInterval(checks);
  await browser?.close();
  for (const client of clients) client.end();
  server.close();
});
