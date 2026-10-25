// Real blind tokens (RFC 9578, type 0x0002) from the Wraps issuer (packages/issuer).
// Buy: get a quote → pay it on-chain → send blinded requests + payment proof to /issue →
// unblind and check every token against the issuer's key. Spend: hand tokens to /settle.
// The issuer signs blinded requests, so it can't link a spent token back to the payment.
import { Token, TokenChallenge, publicVerif } from '@cloudflare/privacypass-ts';
import type { Activity } from './backend.ts';

const { Client, Origin, BlindRSAMode, TokenResponse, convertRSASSAPSSToEnc } = publicVerif;
const MODE = BlindRSAMode.PSS;
const TOKEN_TYPE = 0x0002;

/** Must match the issuer's RLUSD_PER_TOKEN (packages/issuer/src/protocol.ts). */
export const USD_PER_TOKEN = 0.1;
export const ISSUER_URL = (import.meta.env.VITE_ISSUER_URL as string) || 'http://127.0.0.1:4001';
export const WALLET_SCHEME = 'xrpl-evm-erc20-transfer';

export type Quote = { scheme: string; amountRlusd: string; tokens: number; payTo: string; quoteId: string; expiresAt: number };

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// ---------- local store: unspent tokens + activity ----------
// v2: tokens from the live attested issuer (bought through the desktop helper). v1 held local-issuer tokens.
const KEY = 'wraps.tokens.v2';
type Store = { tokens: string[]; history: Activity[] };
const store: Store = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { tokens: [], history: [] };
const save = () => { if (!previewTokens) localStorage.setItem(KEY, JSON.stringify(store)); };

// Dev-only screenshots: ?tokens=N shows a sample balance and history without touching the real store.
const previewTokens = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('tokens')) : 0;
if (previewTokens > 0) {
  store.tokens = Array(previewTokens).fill('preview');
  store.history = [
    { title: 'Session · Switzerland', detail: '214 MB · 41 min · 5 tokens', usd: -0.5, at: Date.now() - 3600e3 },
    { title: 'Top up · RLUSD', detail: '100 tokens · 0xd65a73…', usd: 10, at: Date.now() - 7200e3 },
    { title: 'Session · Iceland', detail: '38 MB · 12 min · 1 token', usd: -0.1, at: Date.now() - 86400e3 },
  ];
}

export const count = () => store.tokens.length;
export const usd = () => count() * USD_PER_TOKEN;
export const history = () => store.history;
/** Keeps freshly bought tokens. */
export function keep(tokens: string[]) {
  store.tokens.push(...tokens);
  save();
}
/** Takes up to `n` tokens out of the wallet to spend. Give back what wasn't spent with `putBack`. */
export function take(n: number) {
  const batch = store.tokens.splice(0, n);
  save();
  return batch;
}
export function putBack(tokens: string[]) {
  store.tokens.unshift(...tokens);
  save();
}
export function record(a: Activity) {
  store.history.unshift(a);
  store.history.length = Math.min(store.history.length, 20);
  save();
}

// ---------- issuer API ----------
async function call(path: string, body?: unknown) {
  let r: Response;
  try {
    r = await fetch(ISSUER_URL + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Can't reach the Wraps issuer at ${ISSUER_URL}`);
  }
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ponytail: mock attestation is fetched but not verified here; the Nitro verifier is SDK-01.
async function issuerKey() {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const r = await call(`/attestation?nonce=${nonce}`);
  if (r.status !== 200) throw new Error(r.body.error ?? 'issuer attestation failed');
  return { name: r.body.issuerName as string, key: fromB64u(r.body.publicKeys.token) };
}

/** Buys `n` tokens. `pay` settles the issuer's quote on-chain and returns the tx hash. */
export async function buy(n: number, pay: (q: Quote) => Promise<string>) {
  const { name, key } = await issuerKey();
  const challenge = new TokenChallenge(TOKEN_TYPE, name, new Uint8Array(0));
  const clients = await Promise.all(Array.from({ length: n }, async () => {
    const c = new Client(MODE);
    return { c, req: b64u((await c.createTokenRequest(challenge, key)).serialize()) };
  }));
  const requests = clients.map(x => x.req);

  const q = await call('/quote', { tokens: n });
  if (q.status !== 200) throw new Error(q.body.error ?? 'issuer refused to quote');
  const quote = q.body as Quote;
  if (quote.scheme !== WALLET_SCHEME) throw new Error('Issuer doesn’t accept wallet payments (start it with ISSUER_RAIL=xrpl-evm)');
  if (quote.tokens !== n) throw new Error(`Issuer quoted ${quote.tokens} tokens, expected ${n}`);

  const txHash = await pay(quote);
  const paid = await call('/issue', { requests, payment: { quoteId: quote.quoteId, txHash } });
  if (paid.status !== 200) throw new Error(paid.body.error ?? 'issuer refused the payment');

  // Every token must verify under the issuer's key (stops it tagging users with a side key).
  const pub = await crypto.subtle.importKey('spki', new Uint8Array(convertRSASSAPSSToEnc(key)), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  const origin = new Origin(MODE);
  const fresh: string[] = [];
  for (let i = 0; i < n; i++) {
    const t: Token = await clients[i].c.finalize(TokenResponse.deserialize(fromB64u(paid.body.responses[i])));
    if (!(await origin.verify(t, pub))) throw new Error('Issuer returned a token that doesn’t verify');
    fresh.push(b64u(t.serialize()));
  }
  store.tokens.push(...fresh);
  record({ title: 'Top up · RLUSD', detail: `${n} tokens · ${txHash.slice(0, 8)}…`, usd: n * USD_PER_TOKEN, at: Date.now() });
  return { txHash, tokens: n };
}

// ponytail: the app settles directly with the issuer; with a real relay the node would do this.
/** Spends `n` tokens at a node. Throws if there aren't enough. */
export async function spend(n: number, nodeId: string) {
  if (count() < n) throw new Error('Out of tokens');
  const batch = store.tokens.splice(0, n);
  save();
  const r = await call('/settle', { merchantId: `node:${nodeId}`, tokens: batch }).catch(e => ({ status: 0, body: { error: (e as Error).message } }));
  if (r.status === 0 || r.status >= 500) { store.tokens.unshift(...batch); save(); } // network trouble: keep them
  if (r.status !== 200) throw new Error(r.body.error ?? 'issuer refused the tokens');
}
