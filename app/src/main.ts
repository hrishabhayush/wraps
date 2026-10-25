import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/geist-mono/500.css';
import './styles.css';
import logo from './assets/logo.svg?raw';
import globe from './assets/globe.svg?raw';
import { MockBackend, type Attestation, type Flag, type VpnNode, type Wallet } from './backend.ts';
import { tick, tokensFor, clock, type Meter } from './meter.ts';

const api = new MockBackend();
const inTauri = '__TAURI_INTERNALS__' in window;

type Screen = 'onboarding' | 'home' | 'nodes' | 'wallet';
type Verified = Extract<Attestation, { ok: true }>;
type Conn =
  | { kind: 'off' }
  | { kind: 'verifying' }
  | { kind: 'connected'; since: number; meter: Meter; att: Verified; up: number; down: number }
  | { kind: 'refused'; reason: string };

const s = {
  screen: (localStorage.getItem('wraps.onboarded') ? 'home' : 'onboarding') as Screen,
  conn: { kind: 'off' } as Conn,
  nodes: [] as VpnNode[],
  nodeId: localStorage.getItem('wraps.node') ?? 'zrh',
  pick: '', // selection on the nodes screen
  sort: 'price' as 'price' | 'latency',
  wallet: { usd: 0, history: [] } as Wallet,
  amount: 10,
  busy: false,
  rechecking: false,
  trust: {} as Record<string, 'ok' | 'bad'>, // attestation results this session
  toast: '',
};

const node = (id = s.nodeId) => s.nodes.find(n => n.id === id)!;
const usd = (n: number) => `$${n.toFixed(2)}`;
const esc = (t: string) => t.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---------- small views ----------
const ICONS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5', down: 'm6 9 6 6 6-6', left: 'm15 18-6-6 6-6', power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12', download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  wallet: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
  quit: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', sort: 'm3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4',
  plus: 'M12 5v14M5 12h14', lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
};
const ic = (k: string, size = 16, sw = 2) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[k]}"/></svg>`;

function flag(f: Flag, size: number) {
  const L: string[] = [];
  const bar = (c: string, pos: string, sz: string) => `linear-gradient(${c},${c}) ${pos}/${sz} no-repeat`;
  if (f.h) L.push(`linear-gradient(${f.h.map((c, i, a) => `${c} ${(i * 100) / a.length}% ${((i + 1) * 100) / a.length}%`).join(',')})`);
  if (f.cross) L.push(bar(f.cross, 'center', '18% 58%'), bar(f.cross, 'center', '58% 18%'));
  if (f.nordic) {
    const [a, b] = f.nordic;
    if (b) L.push(bar(b, '37.6% 0', '11% 100%'), bar(b, '0 50%', '100% 11%'));
    L.push(bar(a, '35.9% 0', '22% 100%'), bar(a, '0 50%', '100% 22%'));
  }
  if (f.dot) L.push(`radial-gradient(circle, ${f.dot} 0 23%, transparent 24%)`);
  if (f.bg) L.push(f.bg);
  return `<span class="flag" style="width:${size}px;height:${size}px;background:${L.join(',')}"></span>`;
}

function bars(ms: number) {
  const [n, c] = ms < 30 ? [3, '#2F7BF6'] : ms < 60 ? [2, '#F29A2E'] : [1, '#E5484D'];
  return `<svg width="16" height="16" viewBox="0 0 24 24">${[0, 1, 2]
    .map(i => `<rect x="${2 + i * 7}" y="${14 - i * 5}" width="4" height="${6 + i * 5}" rx="1" fill="${i < n ? c : '#D9D9DE'}"/>`)
    .join('')}</svg>`;
}

// Green once this node's enclave verified, red if it was refused, grey until checked.
const badge = (id: string, size = 12) =>
  s.trust[id] === 'ok' ? `<span class="g">${ic('shield', size, 2.2)}</span>`
  : s.trust[id] === 'bad' ? `<span class="r">${ic('alert', size, 2.2)}</span>`
  : `<span class="q">${ic('shield', size, 2.2)}</span>`;

const mark = (size: number) => `<span class="mark" style="width:${size}px;height:${size}px">${logo}</span>`;
const ago = (t: number) => `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;

// ---------- screens ----------
function onboarding() {
  return `<div class="panel dark onboarding">
    <div class="globe">${globe}</div>
    <h1>Privacy you<br/>can verify.</h1>
    <p class="sub">Servers prove they don’t log. Pay by the minute with tokens no one can trace to you.</p>
    <button class="start" data-act="start">
      <span class="dot">${ic('shield', 17, 2.2)}</span><span>Get Started</span><svg class="chev" width="26" height="24" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6 6 6-6 6"/><path d="m11 6 6 6-6 6" opacity=".45"/><path d="m19 6 6 6-6 6" opacity=".18"/></svg>
    </button>
  </div>`;
}

function home() {
  const c = s.conn, n = node();
  const on = c.kind === 'connected';
  const secs = on ? (Date.now() - c.since) / 1000 : 0;
  const pill = {
    off: `<span class="pill off">DISCONNECTED</span>`,
    verifying: `<span class="pill wait"><span class="spin"></span>VERIFYING</span>`,
    connected: `<span class="pill ok">${ic('check', 11, 2.8)}CONNECTED</span>`,
    refused: `<span class="pill bad">${ic('alert', 11, 2.6)}REFUSED</span>`,
  }[c.kind];
  const line = {
    off: `${ic('shield', 12, 2.2)}Every node is attested before you connect`,
    verifying: `${ic('shield', 12, 2.2)}Checking ${esc(n.city)}’s enclave…`,
    connected: on ? `<span class="g">${ic('shield', 12, 2.2)}</span>TEE attested · ${ago(c.att.checkedAt)}` : '',
    refused: c.kind === 'refused' ? `<span class="r">${ic('alert', 12, 2.2)}</span>${esc(c.reason)}` : '',
  }[c.kind];
  const m = on ? c.meter : { mb: 0, cost: 0 };
  return `<div class="panel">
    <header class="row between">
      <div class="row brand">${mark(20)}<span>wraps</span></div>
      <button class="chip" data-act="go" data-arg="wallet">${usd(s.wallet.usd)}</button>
    </header>
    <section class="card status row between">
      <div class="col">
        <div class="timer ${on ? '' : 'idle'}">${clock(secs)}</div>
        ${pill}
        <div class="att">${line}</div>
      </div>
      <button class="power ${c.kind}" data-act="power" ${c.kind === 'verifying' ? 'disabled' : ''} aria-label="${on ? 'Disconnect' : 'Connect'}">
        <span>${ic('power', 24, 2.4)}</span>
      </button>
    </section>
    <section class="card nodecard">
      <div class="row nodeRow">
        ${flag(n.flag, 32)}
        <div class="col grow"><div class="row gap5"><b>${esc(n.city)}</b>${badge(n.id)}</div><span class="mono muted">IP ${n.ip}</span></div>
        <button class="link row gap5" data-act="go" data-arg="nodes">${bars(n.latencyMs)}Change${ic('down', 14)}</button>
      </div>
      <div class="row gap8">
        <div class="tile"><span class="circ">${ic('upload', 14)}</span><div class="col"><small>Upload</small><b>${on ? `${c.up} Mbps` : '—'}</b></div></div>
        <div class="tile"><span class="circ">${ic('download', 14)}</span><div class="col"><small>Download</small><b>${on ? `${c.down} Mbps` : '—'}</b></div></div>
      </div>
      <div class="meter row between">
        <div class="col"><span class="row gap6 live"><i class="${on ? 'on' : ''}"></i>${on ? 'Metered · this session' : `Billed only while connected`}</span>
          <span class="mono">${m.mb.toFixed(1)} MB × $${n.pricePerMB}</span></div>
        <span class="cost mono">$${m.cost.toFixed(m.cost < 1 ? 3 : 2)}</span>
      </div>
    </section>
    <footer class="row gap6">
      <button class="ghost" data-act="go" data-arg="nodes">${ic('globe', 14)}Nodes</button>
      <button class="ghost" data-act="go" data-arg="wallet">${ic('wallet', 14)}Wallet</button>
      <button class="ghost" data-act="quit">${ic('quit', 14)}Quit</button>
    </footer>
  </div>`;
}

function nodes() {
  const list = [...s.nodes].sort((a, b) => (s.sort === 'price' ? a.pricePerMB - b.pricePerMB : a.latencyMs - b.latencyMs));
  const pick = node(s.pick || s.nodeId);
  return `<div class="panel">
    <header class="row between">
      <div class="row gap8"><button class="back" data-act="go" data-arg="home">${ic('left', 16)}</button><h2>Choose Node</h2></div>
      <button class="sort row gap5" data-act="sort">${ic('sort', 12)}${s.sort === 'price' ? 'Price' : 'Latency'}${ic('down', 11)}</button>
    </header>
    <div class="att pad4"><span class="g">${ic('shield', 12, 2.2)}</span>Every node is re-attested before you connect</div>
    <div class="grid">${list
      .map(n => `<button class="ncard ${n.id === pick.id ? 'sel' : ''}" data-act="pick" data-arg="${n.id}">
        <div class="row between">${flag(n.flag, 30)}${bars(n.latencyMs)}</div>
        <div class="row gap4 name"><b>${esc(n.country)}</b>${badge(n.id, 11)}</div>
        <span class="mono muted">IP ${n.ip}</span>
        <div class="row between"><span class="mono">$${n.pricePerMB}/MB</span><span class="mono muted">${n.latencyMs} ms</span></div>
      </button>`)
      .join('')}</div>
    <button class="cta" data-act="connectPick">${s.conn.kind === 'connected' && pick.id === s.nodeId ? 'Connected' : `Connect to ${esc(pick.country)}`} · $${pick.pricePerMB}/MB</button>
  </div>`;
}

function wallet() {
  const w = s.wallet;
  const hrs = w.usd / (0.08 * 3600 * node().pricePerMB);
  return `<div class="panel">
    <header class="row gap8"><button class="back" data-act="go" data-arg="home">${ic('left', 16)}</button><h2>Wallet</h2></header>
    <section class="balance">
      <small>Private balance</small>
      <div class="big">${usd(w.usd)}</div>
      <small>≈ ${(w.usd / node().pricePerMB / 1000).toFixed(1)} GB, or about ${Math.floor(hrs)}h ${Math.round((hrs % 1) * 60)}m in ${esc(node().country)}</small>
      <div class="row gap8"><span class="tchip mono">${tokensFor(w.usd).toLocaleString()} tokens</span><span class="tchip green mono">${ic('shield', 12, 2.2)}unlinkable</span></div>
    </section>
    <div class="col gap8">
      <b class="label">Top up</b>
      <div class="row gap6">${[5, 10, 25, 50]
        .map(a => `<button class="amt mono ${a === s.amount ? 'on' : ''}" data-act="amount" data-arg="${a}">$${a}</button>`)
        .join('')}</div>
      <div class="rlusd row gap10"><span class="coin"></span><div class="col"><b>RLUSD</b><small>Ripple USD · XRP Ledger</small></div></div>
      <button class="cta" data-act="topup" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Minting tokens…' : `Top up $${s.amount} RLUSD → mint ${tokensFor(s.amount).toLocaleString()} tokens`}</button>
    </div>
    <section class="activity">${w.history
      .slice(0, 3)
      .map(a => `<div class="row gap10 act"><span class="circ grey">${ic(a.usd > 0 ? 'plus' : 'globe', 14)}</span>
        <div class="col grow"><b>${esc(a.title)}</b><span class="mono muted">${esc(a.detail)}</span></div>
        <span class="mono ${a.usd > 0 ? 'pos' : ''}">${a.usd > 0 ? '+' : '−'}${usd(Math.abs(a.usd))}</span></div>`)
      .join('') || '<div class="muted empty">No activity yet</div>'}</section>
    <p class="note row gap6">${ic('lock', 12)}Tokens are blind-signed. Nodes can’t tie them to you or your wallet.</p>
  </div>`;
}

// ---------- render ----------
const root = document.getElementById('app')!;
function render() {
  root.innerHTML = { onboarding, home, nodes, wallet }[s.screen]() + (s.toast ? `<div class="toast">${esc(s.toast)}</div>` : '');
  if (inTauri) requestAnimationFrame(fitWindow);
}

async function fitWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const { LogicalSize } = await import('@tauri-apps/api/dpi');
  const panel = root.querySelector('.panel') as HTMLElement;
  await getCurrentWindow().setSize(new LogicalSize(360, Math.ceil(panel.offsetHeight)));
}

function toast(msg: string) {
  s.toast = msg;
  render();
  setTimeout(() => { if (s.toast === msg) { s.toast = ''; render(); } }, 3000);
}

// ---------- actions ----------
async function connect(id: string) {
  if (s.wallet.usd <= 0) { s.screen = 'wallet'; return toast('Top up to connect'); }
  s.nodeId = id;
  localStorage.setItem('wraps.node', id);
  s.screen = 'home';
  s.conn = { kind: 'verifying' };
  render();
  const att = await api.attest(id);
  s.trust[id] = att.ok ? 'ok' : 'bad';
  if (!att.ok) { s.conn = { kind: 'refused', reason: att.reason }; return render(); }
  await api.connect(id);
  s.conn = { kind: 'connected', since: Date.now(), meter: { mb: 0, cost: 0 }, att, up: 30, down: 40 };
  render();
}

async function disconnect(reason?: string) {
  const c = s.conn;
  if (c.kind !== 'connected') return;
  s.conn = { kind: 'off' };
  await api.disconnect();
  const mins = Math.max(1, Math.round((Date.now() - c.since) / 60000));
  s.wallet = await api.record({ title: `Session · ${node().country}`, detail: `${c.meter.mb.toFixed(0)} MB · ${mins} min`, usd: -c.meter.cost, at: Date.now() });
  reason ? toast(reason) : render();
}

const actions: Record<string, (arg: string) => unknown> = {
  start: () => { localStorage.setItem('wraps.onboarded', '1'); s.screen = 'home'; render(); },
  go: arg => { s.screen = arg as Screen; s.pick = ''; render(); },
  power: () => (s.conn.kind === 'connected' ? disconnect() : connect(s.nodeId)),
  pick: arg => { s.pick = arg; render(); },
  sort: () => { s.sort = s.sort === 'price' ? 'latency' : 'price'; render(); },
  connectPick: async () => {
    const id = s.pick || s.nodeId;
    if (s.conn.kind === 'connected' && id === s.nodeId) { s.screen = 'home'; return render(); }
    await disconnect();
    await connect(id);
  },
  amount: arg => { s.amount = Number(arg); render(); },
  topup: async () => {
    s.busy = true; render();
    s.wallet = { ...(await api.topUp(s.amount)) };
    s.busy = false;
    toast(`Minted ${tokensFor(s.amount).toLocaleString()} tokens`);
  },
  quit: async () => {
    await disconnect();
    if (inTauri) (await import('@tauri-apps/api/core')).invoke('quit');
  },
};

root.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (el && !el.hasAttribute('disabled')) actions[el.dataset.act!]?.(el.dataset.arg ?? '');
});

// Meter and periodic re-attestation while connected.
setInterval(async () => {
  const c = s.conn;
  if (c.kind !== 'connected') return;
  const r = tick(c.meter, 1, 0.08 + Math.random() * 0.06, node().pricePerMB, s.wallet.usd);
  c.meter = r.meter;
  s.wallet = { ...api.charge(r.charge) };
  c.up = 28 + Math.round(Math.random() * 6);
  c.down = 36 + Math.round(Math.random() * 8);
  if (r.exhausted) return disconnect('Balance ran out, so you were disconnected');
  if (Date.now() - c.att.checkedAt > 60_000 && !s.rechecking) {
    s.rechecking = true;
    const att = await api.attest(s.nodeId);
    s.rechecking = false;
    if (s.conn !== c) return;
    s.trust[s.nodeId] = att.ok ? 'ok' : 'bad';
    if (att.ok) c.att = att;
    else { await disconnect(); s.conn = { kind: 'refused', reason: att.reason }; }
  }
  if (s.screen === 'home' || s.screen === 'wallet') render();
}, 1000);

// ---------- boot ----------
(async () => {
  s.nodes = await api.listNodes();
  s.wallet = { ...(await api.wallet()) };
  // Dev preview without Tauri: ?state=onboarding|home|verifying|connected|refused|nodes|wallet
  const p = import.meta.env.DEV ? new URLSearchParams(location.search).get('state') : null;
  if (p) {
    s.screen = p === 'onboarding' || p === 'nodes' || p === 'wallet' ? p : 'home';
    if (p === 'verifying') s.conn = { kind: 'verifying' };
    if (p === 'refused') { s.nodeId = 'tyo'; s.trust.tyo = 'bad'; s.conn = { kind: 'refused', reason: 'Enclave build doesn’t match the audited code' }; }
    if (p === 'connected') s.trust.zrh = 'ok';
    if (p === 'connected')
      s.conn = { kind: 'connected', since: Date.now() - 2511e3, meter: { mb: 214, cost: 0.43 }, att: { ok: true, tee: 'tdx', build: 'a41f…9c', checkedAt: Date.now() - 2000 }, up: 30, down: 40 };
  }
  render();
})();
