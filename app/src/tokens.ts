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
export const ISSUER_URL = (import.meta.env?.VITE_ISSUER_URL as string) || 'http://127.0.0.1:4001';
export const WALLET_SCHEME = 'xrpl-evm-erc20-transfer';

export type Quote = { scheme: string; amountRlusd: string; tokens: number; payTo: string; quoteId: string; expiresAt: number };

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// ---------- local store: unspent tokens + activity ----------
const KEY = 'wraps.tokens.v1';
type PendingSettle = { quoteId: string; merchantId: string; nodeId: string; tokens: string[] };
type Store = { tokens: string[]; history: Activity[]; pendingSettle?: PendingSettle };
const store: Store = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { tokens: [], history: [] };
const save = () => localStorage.setItem(KEY, JSON.stringify(store));
let settleQueue: Promise<void> = Promise.resolve();

export const count = () => store.tokens.length;
export const usd = () => count() * USD_PER_TOKEN;
export const history = () => store.history;
export function record(a: Activity) {
  store.history.unshift(a);
  store.history.length = Math.min(store.history.length, 20);
  save();
}

// ---------- issuer API ----------
async function callRaw(path: string, body?: string, extraHeaders: Record<string, string> = {}) {
  let r: Response;
  try {
    r = await fetch(ISSUER_URL + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body,
    });
  } catch {
    return { status: 0, body: { error: `Can't reach the Wraps issuer at ${ISSUER_URL}` } };
  }
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function call(path: string, body?: unknown) {
  return callRaw(path, body === undefined ? undefined : JSON.stringify(body));
}

function isLoopbackIssuer(): boolean {
  try {
    return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(new URL(ISSUER_URL).hostname);
  } catch {
    return false;
  }
}

async function merchantAuthHeaders(merchantId: string, path: string, body: string): Promise<Record<string, string>> {
  const { invoke, isTauri } = await import('@tauri-apps/api/core');
  if (!isTauri()) {
    // Browser-only local previews keep working against an intentionally legacy-open loopback issuer.
    // A remote issuer must never receive an unsigned desktop-app settlement.
    if (isLoopbackIssuer()) return {};
    throw new Error('Merchant authentication requires the Wraps desktop app');
  }
  return invoke<Record<string, string>>('merchant_auth_headers', { merchantId, method: 'POST', path, body });
}

async function callMerchant(path: '/settle' | '/settle/status', merchantId: string, body: unknown) {
  const serialized = JSON.stringify(body);
  const headers = await merchantAuthHeaders(merchantId, path, serialized);
  return callRaw(path, serialized, headers);
}

/** Public key for adding this installation's app merchant IDs to the issuer's immutable key map. */
export async function merchantAuthPublicKey(): Promise<string> {
  const { invoke, isTauri } = await import('@tauri-apps/api/core');
  if (!isTauri()) throw new Error('The merchant public key is available from the Wraps desktop app');
  return invoke<string>('merchant_auth_public_key');
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
  const job = settleQueue.then(() => spendInOrder(n, nodeId));
  settleQueue = job.then(() => undefined, () => undefined);
  return job;
}

async function spendInOrder(n: number, nodeId: string): Promise<void> {
  if (!Number.isInteger(n) || n < 1) throw new Error('Spend amount must be a positive integer');
  const merchantId = `node:${nodeId}`;

  if (store.pendingSettle) {
    const pending = store.pendingSettle;
    if (!isPendingSettle(pending)) throw new Error('Saved settlement record is invalid; refusing to reuse its tokens');
    const isRetry = pending.merchantId === merchantId && pending.nodeId === nodeId && pending.tokens.length === n;
    await submitPendingSettle(pending, true);
    if (isRetry) return;
  }

  if (count() < n) throw new Error('Out of tokens');
  const batch = store.tokens.splice(0, n);
  const quoteId = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
  const pending: PendingSettle = { quoteId, merchantId, nodeId, tokens: batch };
  store.pendingSettle = pending;
  try {
    save();
  } catch {
    store.tokens.unshift(...batch);
    delete store.pendingSettle;
    throw new Error('Could not save the pending spend; tokens remain available');
  }
  await submitPendingSettle(pending, false);
}

function isPendingSettle(value: PendingSettle): boolean {
  return typeof value.quoteId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.quoteId)
    && typeof value.nodeId === 'string'
    && value.merchantId === `node:${value.nodeId}`
    && Array.isArray(value.tokens)
    && value.tokens.length > 0
    && value.tokens.every(token => typeof token === 'string' && token.length > 0);
}

type SettlementStatus = 'settled-by-you' | 'settled-by-other' | 'unspent' | 'expired';

async function querySettleStatus(pending: PendingSettle): Promise<SettlementStatus> {
  const r = await callMerchant('/settle/status', pending.merchantId, {
    merchantId: pending.merchantId,
    quoteId: pending.quoteId,
    tokens: pending.tokens,
  });
  const status = typeof r.body === 'object' && r.body !== null
    ? (r.body as { status?: unknown }).status
    : undefined;
  if (r.status !== 200 || typeof status !== 'string' || !['settled-by-you', 'settled-by-other', 'unspent', 'expired'].includes(status)) {
    throw new Error('Settlement status is unavailable; retry this same spend to resolve it');
  }
  return status as SettlementStatus;
}

function completePendingSettle(pending: PendingSettle) {
  if (store.pendingSettle?.quoteId === pending.quoteId) {
    delete store.pendingSettle;
    try {
      save();
    } catch {
      store.pendingSettle = pending;
      throw new Error('Settlement was confirmed, but its local record could not be updated; retry the same spend');
    }
  }
}

function rejectSpentPendingSettle(pending: PendingSettle, status: 'settled-by-other' | 'expired'): never {
  completePendingSettle(pending);
  throw new Error(status === 'expired'
    ? 'The pending token batch expired and was discarded'
    : 'The pending token batch was settled elsewhere and was discarded');
}

async function submitPendingSettle(pending: PendingSettle, checkBeforeRetry: boolean): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (checkBeforeRetry && attempt === 0) {
      const current = await querySettleStatus(pending);
      if (current === 'settled-by-you') { completePendingSettle(pending); return; }
      if (current === 'settled-by-other' || current === 'expired') rejectSpentPendingSettle(pending, current);
    }

    const response = await callMerchant('/settle', pending.merchantId, {
      merchantId: pending.merchantId,
      quoteId: pending.quoteId,
      tokens: pending.tokens,
    });
    if (response.status === 200) { completePendingSettle(pending); return; }

    if (response.status === 0 || response.status >= 500 || response.status === 409) {
      let current: SettlementStatus;
      try {
        current = await querySettleStatus(pending);
      } catch {
        throw new Error('Settlement outcome is unknown; retry this same spend to resolve it');
      }
      if (current === 'settled-by-you') { completePendingSettle(pending); return; }
      if (current === 'settled-by-other' || current === 'expired') rejectSpentPendingSettle(pending, current);
      if (attempt === 0) continue; // Same persisted quote ID and token batch; issuer replay is idempotent.
      throw new Error('Settlement remains unconfirmed; retry this same spend to resolve it');
    }

    throw new Error(response.body.error ?? 'issuer refused the tokens; retry this same spend after fixing the request');
  }
}
