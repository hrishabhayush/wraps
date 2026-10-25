import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/geist-mono/500.css';
import './styles.css';
import logo from './assets/logo.svg?raw';
import globe from './assets/globe.svg?raw';
import { MockBackend, TauriBackend, type Attestation, type Flag, type VpnNode } from './backend.ts';
import * as tk from './tokens.ts';
import { tick, tokensFor, clock, USD_PER_TOKEN, type Meter } from './meter.ts';
import * as wc from './wallet.ts';
import { short } from './chain.ts';
import QRCode from 'qrcode';

const inTauri = '__TAURI_INTERNALS__' in window;
// In the desktop app the VPN is real: the relay meters bandwidth and is paid by the connect helper.
const api = inTauri ? new TauriBackend() : new MockBackend();
const realVpn = inTauri;
const tauri = api as TauriBackend;
// One connect pays the relay this many kept tokens (10 MB each). An empty wallet buys them first.
const VPN_TOKENS = 10;

type Screen = 'onboarding' | 'home' | 'nodes' | 'wallet';
type Verified = Extract<Attestation, { ok: true }>;
type Conn =
  | { kind: 'off' }
  | { kind: 'verifying' }
  | { kind: 'connected'; since: number; meter: Meter; att: Verified; up: number; down: number; spent: number; spending: boolean }
  | { kind: 'refused'; reason: string };

const s = {
  // ponytail: onboarding shows on every launch for the demo; switch to localStorage for first-run only.
  screen: (sessionStorage.getItem('wraps.onboarded') ? 'home' : 'onboarding') as Screen,
  conn: { kind: 'off' } as Conn,
  nodes: [] as VpnNode[],
  nodeId: localStorage.getItem('wraps.node') ?? 'zrh',
  pick: '', // selection on the nodes screen
  sort: 'price' as 'price' | 'latency',
  amount: 5,
  busy: false,
  acct: undefined as string | undefined, // connected wallet address
  bal: undefined as number | undefined, // its balance in the pay asset
  qr: '', // pairing QR (svg) while connecting
  uri: '',
  stage: '' as '' | wc.PayStage | 'minting' | 'paying' | 'linking' | 'quoting',
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
    verifying: `${ic('shield', 12, 2.2)}${
      s.stage === 'approve' ? `Approve ${usd(VPN_TOKENS * USD_PER_TOKEN)} RLUSD in your wallet…`
      : s.stage === 'confirming' ? 'Confirming on XRPL EVM…'
      : s.stage === 'minting' ? 'Minting blind tokens…'
      : s.stage === 'paying' ? `Paying the relay ${VPN_TOKENS} tokens…`
      : `Checking ${esc(n.city)}’s enclave…`}`,
    connected: on ? `<span class="g">${ic('shield', 12, 2.2)}</span>TEE attested · ${ago(c.att.checkedAt)}` : '',
    refused: c.kind === 'refused' ? `<span class="r">${ic('alert', 12, 2.2)}</span>${esc(c.reason)}` : '',
  }[c.kind];
  // The real VPN is prepaid: the relay was paid `spent` tokens at connect. The preview meters a fake session.
  const m = !on ? { mb: 0, cost: 0 } : realVpn ? { mb: c.spent * 10, cost: c.spent * USD_PER_TOKEN } : c.meter;
  return `<div class="panel">
    <header class="row between">
      <div class="row brand">${mark(20)}<span>wraps</span></div>
      <button class="chip" data-act="go" data-arg="wallet">${usd(tk.usd())}</button>
    </header>
    <section class="card status row between">
      <div class="col">
        <div class="timer ${on ? '' : 'idle'}">${clock(secs)}</div>
        ${pill}
        <div class="att">${line}</div>
        ${on && lastTx() ? `<button class="link small txlink" data-act="openTx" data-arg="${lastTx()}">Top-up paid in RLUSD · ${short(lastTx()!)} ↗</button>` : ''}
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
        <div class="col"><span class="row gap6 live"><i class="${on ? 'on' : ''}"></i>${on ? (realVpn ? 'Prepaid · this session' : 'Metered · this session') : `Billed only while connected`}</span>
          <span class="mono">${on && realVpn ? `${c.spent} tokens = ${m.mb} MB` : `${m.mb.toFixed(1)} MB × $${n.pricePerMB}`}</span></div>
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
  const bal = tk.usd();
  const hrs = bal / (0.08 * 3600 * node().pricePerMB);
  return `<div class="panel">
    <header class="row gap8"><button class="back" data-act="go" data-arg="home">${ic('left', 16)}</button><h2>Wallet</h2></header>
    <section class="balance">
      <small>Private balance</small>
      <div class="big">${usd(bal)}</div>
      <small>≈ ${(bal / node().pricePerMB / 1000).toFixed(1)} GB, or about ${Math.floor(hrs)}h ${Math.round((hrs % 1) * 60)}m in ${esc(node().country)}</small>
      <div class="row gap8"><span class="tchip mono">${tk.count().toLocaleString()} tokens</span><span class="tchip green mono">${ic('shield', 12, 2.2)}unlinkable</span></div>
    </section>
    <div class="col gap8">
      <b class="label">Top up</b>
      <div class="row gap6">${[1, 5, 10, 20]
        .map(a => `<button class="amt mono ${a === s.amount ? 'on' : ''}" data-act="amount" data-arg="${a}">$${a}</button>`)
        .join('')}</div>
      ${payFrom()}
      ${topupCta()}
    </div>
    <section class="activity">${tk.history()
      .slice(0, 3)
      .map(a => `<div class="row gap10 act"><span class="circ grey">${ic(a.usd > 0 ? 'plus' : 'globe', 14)}</span>
        <div class="col grow"><b>${esc(a.title)}</b>${a.tx ? `<button class="link small mono" data-act="openTx" data-arg="${a.tx}">${esc(a.detail)} ↗</button>` : `<span class="mono muted">${esc(a.detail)}</span>`}</div>
        <span class="mono ${a.usd > 0 ? 'pos' : ''}">${a.usd > 0 ? '+' : '−'}${usd(Math.abs(a.usd))}</span></div>`)
      .join('') || '<div class="muted empty">No activity yet</div>'}</section>
    <p class="note row gap6">${ic('lock', 12)}Tokens are blind-signed. Nodes can’t tie them to you or your wallet.</p>
  </div>`;
}


// The user's wallet: connect via WalletConnect QR, then pay the issuer on XRPL EVM testnet.
function payFrom() {
  if (s.qr) return `<div class="wcard col qrbox">
      <div class="qr">${s.qr}</div>
      <small>Scan with MetaMask, Rabby or any WalletConnect wallet</small>
      <div class="row gap6"><button class="ghost2" data-act="copyUri">Copy link</button><button class="ghost2" data-act="cancelWc">Cancel</button></div>
    </div>`;
  if (!s.acct) return `<button class="wcard row gap10" data-act="connectBrowser" ${s.stage ? 'disabled' : ''}>
      <span class="wcicon">${ic('wallet', 16)}</span>
      <div class="col grow"><b>${s.stage === 'linking' ? 'Waiting for your browser…' : 'Use my browser wallet'}</b><small>MetaMask, Rabby or Brave · on this laptop</small></div>
      ${ic('down', 14)}
    </button>
    <button class="link small qrlink" data-act="connectWallet" ${wc.cfg.projectId ? '' : 'disabled'}>or scan a QR with a phone wallet</button>`;
  return `<div class="wcard row gap10 on">
      <span class="coin ${wc.asset === 'XRP' ? 'xrp' : 'rl'}"></span>
      <div class="col grow"><b class="mono acct">${short(s.acct)}</b><small>${wc.via() === 'browser' ? 'Browser wallet' : 'WalletConnect'} · XRPL EVM testnet · ${s.bal === undefined ? '…' : `${s.bal.toFixed(2)} ${wc.asset}`}</small></div>
      <button class="link small" data-act="disconnectWallet">Disconnect</button>
    </div>`;
}

function topupCta() {
  const label =
    s.stage === 'quoting' ? 'Verifying issuer…'
    : s.stage === 'approve' ? (wc.via() === 'browser' ? 'Approve in your browser…' : 'Approve in your wallet…')
    : s.stage === 'linking' ? 'Connecting…'
    : s.stage === 'confirming' ? 'Confirming on XRPL EVM…'
    : s.stage === 'minting' ? 'Minting tokens…'
    : !s.acct && inTauri ? `Top up $${s.amount} on the mock rail → ${tokensFor(s.amount).toLocaleString()} tokens`
    : !s.acct ? 'Connect a wallet to top up'
    : !wc.cfg.token ? 'Set VITE_RLUSD_ADDRESS in app/.env'
    : `Pay $${s.amount} RLUSD → ${tokensFor(s.amount).toLocaleString()} blind tokens`;
  const off = !!s.stage || (!s.acct && !inTauri) || (!!s.acct && !wc.cfg.token);
  return `<button class="cta" data-act="topup" ${off ? 'disabled' : ''}>${label}</button>`;
}

async function refreshBalance() {
  s.acct = wc.account();
  s.bal = s.acct ? await wc.balance(s.acct).catch(() => undefined) : undefined;
  render();
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
  if (!realVpn && tk.count() === 0) { s.screen = 'wallet'; return toast('Top up to connect'); }
  s.nodeId = id;
  localStorage.setItem('wraps.node', id);
  s.screen = 'home';
  s.conn = { kind: 'verifying' };
  render();
  const att = await api.attest(id);
  s.trust[id] = att.ok ? 'ok' : 'bad';
  if (!att.ok) { s.conn = { kind: 'refused', reason: att.reason }; return render(); }
  let spent = 1;
  if (realVpn) {
    // One click: pay the relay with kept tokens and bring WireGuard up (macOS asks for the admin password).
    // An empty wallet buys VPN_TOKENS first (RLUSD with a wallet connected, otherwise the mock rail).
    try {
      if (tk.count() === 0) await topUp(VPN_TOKENS);
      spent = await spendAtRelay(VPN_TOKENS);
    } catch (e) {
      s.stage = '';
      s.conn = { kind: 'off' };
      return toast(errorText(e).slice(0, 90));
    }
  } else {
    // Pay for the first chunk up front with one real token.
    try { await tk.spend(1, id); } catch (e) { s.conn = { kind: 'off' }; return toast((e as Error).message.slice(0, 90)); }
    await (api as MockBackend).connect(id);
  }
  s.conn = { kind: 'connected', since: Date.now(), meter: { mb: 0, cost: 0 }, att, up: 30, down: 40, spent, spending: false };
  render();
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lastTx = () => tk.history().find(a => a.tx)?.tx;

/**
 * Buys `n` tokens into the wallet from the live attested issuer. With a wallet connected the
 * issuer's quote is paid in RLUSD on XRPL EVM (visible on the explorer); otherwise on the mock rail.
 */
async function topUp(n: number) {
  try {
    if (s.acct && wc.cfg.token) {
      const q = await tauri.topUpQuote(n);
      let tx: string;
      try {
        tx = await wc.payQuote(q, st => { s.stage = st; render(); });
      } catch (e) {
        await tauri.topUpCancel();
        throw e;
      }
      s.stage = 'minting'; render();
      try {
        tk.keep(await tauri.topUpPaid(tx));
      } catch (e) {
        // Paid on-chain but no tokens came back: keep the receipt so it can be chased.
        tk.record({ title: 'Top up paid, not minted', detail: `${n} tokens · ${short(tx)}`, usd: 0, at: Date.now(), tx });
        throw e;
      }
      tk.record({ title: 'Top up · RLUSD', detail: `${n} tokens · ${short(tx)}`, usd: Number(q.amountRlusd), at: Date.now(), tx });
    } else {
      s.stage = 'minting'; render();
      tk.keep(await tauri.topUpMock(n));
      tk.record({ title: 'Top up · mock rail', detail: `${n} tokens`, usd: n * USD_PER_TOKEN, at: Date.now() });
    }
  } finally {
    s.stage = '';
  }
}

/** Hands up to `n` kept tokens to the relay and brings the tunnel up. Unspent tokens go back to the wallet. */
async function spendAtRelay(n: number): Promise<number> {
  const batch = tk.take(n);
  s.stage = 'paying'; render();
  try {
    const r = await tauri.connectWith(batch);
    tk.record({ title: `VPN · ${node().city}`, detail: `${r.tokens} tokens = ${r.megabytes} MB`, usd: -r.tokens * USD_PER_TOKEN, at: Date.now() });
    return r.tokens;
  } catch (e) {
    // The helper says which tokens the relay did not take (spent ones are dropped). A plain error means none were handed over.
    const failed = (() => { try { return JSON.parse(String(e)) as { error: string; unspent: string[] }; } catch { return undefined; } })();
    tk.putBack(failed?.unspent ?? batch);
    const used = batch.length - (failed?.unspent ?? batch).length;
    if (used > 0) tk.record({ title: `VPN · ${node().city} (failed)`, detail: `${used} tokens spent`, usd: -used * USD_PER_TOKEN, at: Date.now() });
    throw new Error(failed?.error ?? errorText(e));
  } finally {
    s.stage = '';
  }
}

async function disconnect(reason?: string) {
  const c = s.conn;
  if (c.kind !== 'connected') return;
  s.conn = { kind: 'off' };
  await api.disconnect();
  const mins = Math.max(1, Math.round((Date.now() - c.since) / 60000));
  if (realVpn) return reason ? toast(reason) : render(); // prepaid at connect, recorded there
  tk.record({ title: `Session · ${node().country}`, detail: `${c.meter.mb.toFixed(0)} MB · ${mins} min · ${c.spent} token${c.spent === 1 ? '' : 's'}`, usd: -c.spent * USD_PER_TOKEN, at: Date.now() });
  reason ? toast(reason) : render();
}

const actions: Record<string, (arg: string) => unknown> = {
  start: () => { sessionStorage.setItem('wraps.onboarded', '1'); s.screen = 'home'; render(); },
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
    if (s.stage) return;
    s.stage = 'quoting'; render();
    try {
      const n = tokensFor(s.amount);
      if (inTauri) {
        await topUp(n);
        return toast(`Minted ${n} blind tokens`);
      }
      await tk.buy(n, async q => {
        const tx = await wc.payQuote(q, st => { s.stage = st; render(); });
        s.stage = 'minting'; render();
        return tx;
      });
      toast(`Minted ${n} blind tokens`);
    } catch (e) {
      const message = errorText(e);
      toast(message.includes('IMAGE_MISMATCH')
        ? 'Top up blocked: the server version differs from the one this app trusts. Update the app.'
        : message.slice(0, 90));
    } finally {
      s.stage = '';
      refreshBalance();
    }
  },
  connectWallet: async () => {
    try {
      await wc.connect(async uri => { s.uri = uri; s.qr = await QRCode.toString(uri, { type: 'svg', margin: 0, color: { dark: '#0a0a0a', light: '#ffffff' } }); render(); });
    } catch (e) {
      if (s.qr) toast((e as Error).message.slice(0, 90));
    }
    s.qr = s.uri = '';
    refreshBalance();
  },
  connectBrowser: async () => {
    s.stage = 'linking'; render();
    try { await wc.connectBrowser(); } catch (e) { toast((e as Error).message.slice(0, 90)); }
    s.stage = '';
    refreshBalance();
  },
  openTx: arg => tauri.openTx(arg).catch(e => toast(String(e).slice(0, 90))),
  copyUri: async () => { await navigator.clipboard.writeText(s.uri); toast('Link copied'); },
  cancelWc: () => { s.qr = s.uri = ''; render(); },
  disconnectWallet: async () => { await wc.disconnect(); refreshBalance(); },
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
  // Prepaid (spent tokens not yet used up) plus what's left in the wallet.
  const r = tick(c.meter, 1, 0.08 + Math.random() * 0.06, node().pricePerMB, c.spent * USD_PER_TOKEN - c.meter.cost + tk.usd());
  c.meter = r.meter;
  if (!realVpn && c.meter.cost > c.spent * USD_PER_TOKEN && !c.spending && tk.count() > 0) {
    c.spending = true;
    tk.spend(1, s.nodeId).then(() => { c.spent++; }, e => disconnect((e as Error).message)).finally(() => { c.spending = false; });
  }
  c.up = 28 + Math.round(Math.random() * 6);
  c.down = 36 + Math.round(Math.random() * 8);
  if (!realVpn && r.exhausted) return disconnect('Out of tokens, so you were disconnected');
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
  // The saved node may not exist in this node list (e.g. a mock node in the real app).
  if (!s.nodes.some(n => n.id === s.nodeId)) s.nodeId = s.nodes[0].id;
  // Dev preview without Tauri: ?state=onboarding|home|verifying|connected|refused|nodes|wallet
  const p = import.meta.env.DEV ? new URLSearchParams(location.search).get('state') : null;
  if (p) {
    s.screen = p === 'onboarding' || p === 'nodes' || p === 'wallet' ? p : 'home';
    if (p.startsWith('wallet')) s.screen = 'wallet';
    if (p === 'wallet-qr') s.qr = await QRCode.toString('wc:preview@2?relay-protocol=irn&symKey=00', { type: 'svg', margin: 0 });
    if (p === 'wallet-connected' || p === 'wallet-paying') { s.acct = '0x1234567890abcdef1234567890abcdef12345678'; s.bal = 41.2; }
    if (p === 'wallet-paying') s.stage = 'confirming';
    if (p === 'verifying') s.conn = { kind: 'verifying' };
    if (p === 'refused') { s.nodeId = 'tyo'; s.trust.tyo = 'bad'; s.conn = { kind: 'refused', reason: 'Enclave build doesn’t match the audited code' }; }
    if (p === 'connected') s.trust.zrh = 'ok';
    if (p === 'connected')
      s.conn = { kind: 'connected', since: Date.now() - 2511e3, meter: { mb: 214, cost: 0.43 }, att: { ok: true, tee: 'tdx', build: 'a41f…9c', checkedAt: Date.now() - 2000 }, up: 30, down: 40, spent: 5, spending: false };
  }
  if (!p) wc.init(refreshBalance).then(refreshBalance).catch(e => console.error('wallet init', e));
  render();
})();
