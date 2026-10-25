// User's own wallet, paying the issuer on XRPL EVM testnet. Two ways in:
//  - browser: the wallet extension in their normal browser, via the local bridge (src-tauri/src/bridge.rs)
//  - WalletConnect: QR / link for phone or desktop wallets
// Pays native XRP unless VITE_RLUSD_ADDRESS is set, then RLUSD (ERC-20).
import { EthereumProvider } from '@walletconnect/ethereum-provider';
import { XRPL_EVM_TESTNET as NET, erc20Transfer, erc20BalanceOf, ERC20_DECIMALS, toUnits, fromUnits } from './chain.ts';

const env = import.meta.env;
export const cfg = {
  projectId: (env.VITE_REOWN_PROJECT_ID as string) || '',
  payout: (env.VITE_ISSUER_PAYOUT as string) || '',
  token: (env.VITE_RLUSD_ADDRESS as string) || '',
  xrpUsd: Number(env.VITE_XRP_USD) || 2.4,
};
export const asset = cfg.token ? 'RLUSD' : 'XRP';

type Provider = Awaited<ReturnType<typeof EthereumProvider.init>>;
let p: Provider | null = null;
let decimals: number | null = cfg.token ? null : NET.native.decimals;
let browserAcct = localStorage.getItem('wraps.browserAcct') ?? undefined;

type BridgeResult = { id: string; ok: boolean; error?: string; account?: string; hash?: string };

// One request to the browser wallet: the app opens a local page, the extension answers it.
async function bridge(req: Record<string, unknown>): Promise<BridgeResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let un = () => {};
    const timer = setTimeout(() => { un(); reject(new Error('Browser wallet timed out')); }, 180_000);
    listen<BridgeResult>('wallet-result', e => {
      if (e.payload.id !== id) return;
      clearTimeout(timer); un();
      e.payload.ok ? resolve(e.payload) : reject(new Error(e.payload.error ?? 'Wallet request failed'));
    }).then(f => { un = f; return invoke('browser_wallet', { request: { ...req, id } }); })
      .catch(err => { clearTimeout(timer); un(); reject(new Error(String(err))); });
  });
}

async function rpc<T = string>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(NET.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function tokenDecimals() {
  decimals ??= Number(BigInt(await rpc('eth_call', [{ to: cfg.token, data: ERC20_DECIMALS }, 'latest'])));
  return decimals;
}

// Restores an existing session if there is one. onChange fires on account/chain/disconnect events.
export async function init(onChange: () => void) {
  if (!cfg.projectId || p) return;
  p = await EthereumProvider.init({
    projectId: cfg.projectId,
    optionalChains: [NET.id],
    rpcMap: { [NET.id]: NET.rpc },
    showQrModal: false,
    metadata: { name: 'Wraps', description: 'Pay-as-you-go VPN with verifiable no-log nodes', url: 'https://wraps.xyz', icons: ['https://wraps.xyz/icon.png'] },
  });
  p.on('accountsChanged', onChange);
  p.on('chainChanged', onChange);
  p.on('disconnect', onChange);
}

export const account = () => (p?.session ? p.accounts[0] : browserAcct);
export const via = () => (p?.session ? 'walletconnect' : browserAcct ? 'browser' : undefined);

export async function connectBrowser() {
  const r = await bridge({ kind: 'connect' });
  browserAcct = r.account;
  localStorage.setItem('wraps.browserAcct', browserAcct!);
  return browserAcct;
}

// Shows the pairing URI through onUri (render it as a QR), resolves once the wallet approves.
export async function connect(onUri: (uri: string) => void) {
  if (!p) throw new Error('Add VITE_REOWN_PROJECT_ID to app/.env');
  p.once('display_uri', onUri);
  await p.connect();
  return account();
}

export async function disconnect() {
  browserAcct = undefined;
  localStorage.removeItem('wraps.browserAcct');
  if (p?.session) await p.disconnect();
}

export async function balance(addr: string) {
  if (!cfg.token) return fromUnits(BigInt(await rpc('eth_getBalance', [addr, 'latest'])), NET.native.decimals);
  return fromUnits(BigInt(await rpc('eth_call', [{ to: cfg.token, data: erc20BalanceOf(addr) }, 'latest'])), await tokenDecimals());
}

// How much of the pay asset a USD top-up costs.
export const priceIn = (usd: number) => (cfg.token ? usd : usd / cfg.xrpUsd);

async function ensureChain() {
  try {
    await p!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NET.hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902 && !String(e).includes('Unrecognized')) throw e;
    await p!.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: NET.hex, chainName: NET.name, nativeCurrency: NET.native, rpcUrls: [NET.rpc], blockExplorerUrls: [NET.explorer] }],
    });
  }
}

export type PayStage = 'approve' | 'confirming';

// Sends the top-up and waits for it to land. Returns the tx hash; throws if it reverts.
export async function pay(usd: number, onStage: (s: PayStage) => void) {
  const from = account();
  if (!from) throw new Error('Connect a wallet first');
  if (!cfg.payout) throw new Error('Set VITE_ISSUER_PAYOUT in app/.env');
  const amount = toUnits(priceIn(usd).toFixed(6), cfg.token ? await tokenDecimals() : NET.native.decimals);
  const tx = cfg.token
    ? { from, to: cfg.token, data: erc20Transfer(cfg.payout, amount) }
    : { from, to: cfg.payout, value: '0x' + amount.toString(16) };
  onStage('approve');
  let hash: string;
  if (p?.session) {
    await ensureChain();
    hash = (await p.request({ method: 'eth_sendTransaction', params: [tx] })) as string;
  } else {
    const label = cfg.token ? `Send $${usd} RLUSD to the Wraps issuer` : `Send ${priceIn(usd).toFixed(2)} XRP to the Wraps issuer`;
    hash = (await bridge({ kind: 'send', tx, net: NET, label })).hash!;
  }
  onStage('confirming');
  for (let i = 0; i < 80; i++) {
    const r = await rpc<{ status: string } | null>('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status !== '0x1') throw new Error('Top-up transaction reverted');
      return hash;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error('Timed out waiting for XRPL EVM');
}

export const txUrl = (hash: string) => `${NET.explorer}/tx/${hash}`;
