// Real blind tokens (RFC 9578, type 0x0002) from the Wraps issuer (packages/issuer).
// Buy: blind N requests → /issue says 402 with a quote → pay it on-chain → retry with proof →
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
const KEY = 'wraps.tokens.v1';
type Store = { tokens: string[]; history: Activity[] };
const store: Store = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { tokens: [], history: [] };
const save = () => localStorage.setItem(KEY, JSON.stringify(store));

export const count = () => store.tokens.length;
export const usd = () => count() * USD_PER_TOKEN;
export const history = () => store.history;
export function record(a: Activity) {
  store.history.unshift(a);
  store.history.length = Math.min(store.history.length, 20);
  save();
}

// ---------- issuer API ----------
async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  let r: Response;
  try {
    r = await fetch(ISSUER_URL + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
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

  const first = await call('/issue', { requests });
  if (first.status !== 402) throw new Error(first.body.error ?? `issuer answered ${first.status}, expected 402`);
  const quote = (first.body.accepts as Quote[]).find(a => a.scheme === WALLET_SCHEME);
  if (!quote) throw new Error('Issuer doesn’t accept wallet payments (start it with ISSUER_RAIL=xrpl-evm)');
  if (quote.tokens !== n) throw new Error(`Issuer quoted ${quote.tokens} tokens, expected ${n}`);

  const txHash = await pay(quote);
  const proof = b64u(new TextEncoder().encode(JSON.stringify({ quoteId: quote.quoteId, txHash })));
  const paid = await call('/issue', { requests }, { 'x-payment': proof });
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
