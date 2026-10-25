// Batched merchant payouts at fixed times (SPEC §4 step 7).
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { IssuerCore, PaidLine, PayoutLine } from './core';
import { MerchantRegistry } from './merchant-registry';
import { tokensToRlusd } from './protocol';
import { XRPL_EVM_TESTNET_RPC, toUnits } from './rail-xrpl-evm';

/** One confirmed payout. */
export interface PayoutResult {
  merchantId: string;
  txRef: string;
  /** Tokens this transfer paid. Omitted means the whole line. Set when a transfer from an earlier batch confirms. */
  amountTokens?: number;
  payTo?: string;
  token?: string;
  chainId?: number;
}

export interface PayoutRail {
  /** Short name for logs and the admin API, e.g. "mock" or "xrpl-evm". */
  readonly name?: string;
  /**
   * Sends one batch. Resolves with one result per confirmed transfer. A line missing from the
   * result was not paid: it stays unpaid and is retried in the next batch.
   */
  payout(lines: PayoutLine[]): Promise<PayoutResult[]>;
  /** Fee the issuer would pay to send this batch, in RLUSD. Optional: rails without fees omit it. */
  estimateFeeRlusd?(lines: PayoutLine[]): Promise<number>;
  /** The transfers a batch would send, without sending. Optional. */
  preview?(lines: PayoutLine[]): PayoutPreview;
}

export interface PayoutPreview {
  transfers: (PayoutTx & { payTo: string; amountRlusd: string; amountTokens: number })[];
  /** Lines that would not be sent, and why. */
  skipped: { merchantId: string; reason: string }[];
}

/** MOCK: logs the batch instead of sending RLUSD. */
export class MockPayoutRail implements PayoutRail {
  readonly name = 'mock';
  constructor(private readonly log: (msg: string) => void = console.log) {}
  async payout(lines: PayoutLine[]): Promise<PayoutResult[]> {
    return lines.map((l) => {
      const txRef = `mock-payout-${Date.now()}-${l.merchantId}`;
      this.log(`[payout] ${l.amountRlusd} RLUSD → ${l.merchantId} (${l.amountTokens} tokens) ${txRef}`);
      return { merchantId: l.merchantId, txRef };
    });
  }
}

/** One outbound payout transaction: a call to the RLUSD contract with no native value. */
export interface PayoutTx {
  merchantId: string;
  to: string;
  data: string;
  value: '0x0';
}

const TRANSFER_SELECTOR = 'a9059cbb';
const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * SR8 equivalent: the only on-chain action the issuer signs for a payout is a plain
 * ERC-20 transfer(registeredAddress, amount) on the RLUSD contract. No approve, no
 * transferFrom, no extra calldata, no native value. Anything else is refused.
 */
export function isPlainRlusdTransfer(tx: PayoutTx, token: string, allowedPayTo: Iterable<string>): boolean {
  if (tx.to.toLowerCase() !== token.toLowerCase() || tx.value !== '0x0') return false;
  const data = tx.data.toLowerCase().replace(/^0x/, '');
  if (data.length !== 8 + 64 + 64 || !data.startsWith(TRANSFER_SELECTOR)) return false;
  const allowed = new Set([...allowedPayTo].map((a) => word(a)));
  return allowed.has(data.slice(8, 72)) && BigInt('0x' + data.slice(72)) > 0n;
}

/** XRPL EVM sidechain testnet chain ID (0x161c28). Same value as app/src/chain.ts. */
export const XRPL_EVM_TESTNET_CHAIN_ID = 1449000;
export const XRPL_EVM_TESTNET_EXPLORER = 'https://explorer.testnet.xrplevm.org';

export interface XrplEvmPayoutRailOptions {
  /** RLUSD ERC-20 contract on the sidechain. */
  token: string;
  /** merchantId → registered payout address. Merchants not listed are never paid on-chain. */
  payoutAddresses: Record<string, string> | MerchantRegistry;
  /** RLUSD decimals. Read from the contract when omitted and a signer is set; 18 otherwise. */
  decimals?: number;
  /**
   * Legacy hook: signs and sends one tx, resolves with its hash once confirmed. Used only when no
   * `privateKey` is set. Kept for tests and custom signers.
   */
  send?: (tx: PayoutTx) => Promise<string>;

  // --- live sending (ISS-06) ---------------------------------------------
  /** Issuer payout key (32 bytes hex). From ISSUER_PAYOUT_PRIVATE_KEY. Never logged. */
  privateKey?: string;
  /** JSON-RPC endpoint. Default: XRPL EVM testnet. */
  rpc?: string;
  /** Chain the RPC must report. Default 1449000 (XRPL EVM testnet). */
  chainId?: number;
  fetch?: typeof fetch;
  /** Abort one RPC call after this long. Default 15 s. */
  rpcTimeoutMs?: number;
  /** Wait this long for receipts before leaving a tx for the next batch. Default 60 s. */
  receiptTimeoutMs?: number;
  pollMs?: number;
  /** Hard cap on gas for one transfer. A line needing more is not sent. Default 100,000. */
  maxGasPerTransfer?: bigint;
  /** Hard cap on gas price. Above it, nothing is sent. Default 100 gwei. */
  maxGasPriceWei?: bigint;
  /** Hard cap on gas fee for one batch, in wei of XRP. Lines past it wait. Default 0.5 XRP. */
  maxBatchFeeWei?: bigint;
  /** Upper bound on the XRP price in RLUSD, to turn the gas fee into RLUSD for the SR6 fee cap. Default 5. */
  xrpPriceRlusd?: number;
  log?: (msg: string) => void;
}

interface InFlight {
  merchantId: string;
  hash: Hex;
  raw: Hex;
  nonce: number;
  amountTokens: number;
  payTo: string;
}

interface RpcReceipt {
  status: string;
  transactionHash: string;
}

/** A JSON-RPC error answer: the node got the request and said no. */
class RpcError extends Error {}

const GWEI = 10n ** 9n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hexQty = (n: bigint | number) => '0x' + n.toString(16);

/**
 * RLUSD ERC-20 transfers on the XRPL EVM sidechain from the issuer's payout address,
 * one per merchant, mixed across all customers.
 *
 * Safety rules:
 * - Only plain transfer(registeredAddress, amount) on the RLUSD contract is ever signed (SR8).
 * - Gas per transfer, gas price and fee per batch have hard caps (SR6).
 * - A line counts as paid only once its receipt says success.
 * - A tx whose send timed out, or whose receipt has not come yet, stays "in flight". The next
 *   batch checks its receipt by hash first and rebroadcasts the same signed bytes. It never signs
 *   a new transfer for that merchant while one is in flight, so a merchant is never paid twice.
 * Outbound calls go through the enclave's egress proxy in production (INF-11).
 */
export class XrplEvmPayoutRail implements PayoutRail {
  readonly name = 'xrpl-evm';
  private readonly opts?: Omit<XrplEvmPayoutRailOptions, 'privateKey'>;
  private readonly registry?: MerchantRegistry;
  /** Addresses as registered when the rail was made. A later change is refused. */
  private readonly pinned = new Map<string, string>();
  private readonly account?: PrivateKeyAccount;
  private readonly inFlight = new Map<string, InFlight>();
  private decimals?: number;
  private chainChecked = false;
  private busy = false;

  constructor(opts?: XrplEvmPayoutRailOptions) {
    if (opts) {
      if (!EVM_ADDRESS.test(opts.token)) throw new Error(`bad address: ${opts.token}`);
      this.registry = opts.payoutAddresses instanceof MerchantRegistry ? opts.payoutAddresses : new MerchantRegistry(opts.payoutAddresses);
      for (const [id, a] of Object.entries(this.registry.toRecord())) this.pinned.set(id, a);
      if (opts.privateKey !== undefined) {
        // Never echo the key, not even in an error.
        if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) throw new Error('payout private key must be 0x + 64 hex characters');
        this.account = privateKeyToAccount(opts.privateKey as Hex);
      }
      this.decimals = opts.decimals;
      // Keep only the account. The key string is not stored on the rail.
      const { privateKey: _key, ...rest } = opts;
      this.opts = rest;
    }
  }

  /** The issuer's payout address (sender), when a key is set. */
  get address(): string | undefined {
    return this.account?.address;
  }

  /** True when this rail can sign and send. */
  get canSend(): boolean {
    return !!this.account || !!this.opts?.send;
  }

  /** Merchants with a transfer sent but not yet confirmed. */
  pendingMerchants(): string[] {
    return [...this.inFlight.keys()];
  }

  private get chainId(): number {
    return this.opts?.chainId ?? XRPL_EVM_TESTNET_CHAIN_ID;
  }

  private log(msg: string) {
    this.opts?.log?.(`[payout] ${msg}`);
  }

  /** Registered and unchanged payout address, or a reason it is refused. */
  private payToFor(merchantId: string): { payTo?: string; refused?: string } {
    const now = this.registry?.get(merchantId);
    const pinned = this.pinned.get(merchantId);
    if (!now || !pinned) return { refused: `no registered payout address for ${merchantId}` };
    if (now !== pinned) return { refused: `payout address for ${merchantId} changed since start-up; refusing` };
    return { payTo: pinned };
  }

  private buildTx(merchantId: string, payTo: string, amountRlusd: string): PayoutTx {
    const o = this.opts!;
    const amount = toUnits(amountRlusd, this.decimals ?? 18);
    if (amount <= 0n) throw new Error(`refusing a zero payout to ${merchantId}`);
    const tx: PayoutTx = {
      merchantId,
      to: o.token,
      data: '0x' + TRANSFER_SELECTOR + word(payTo) + word(amount.toString(16)),
      value: '0x0',
    };
    if (!isPlainRlusdTransfer(tx, o.token, [...this.pinned.values()])) throw new Error('payout is not a plain RLUSD transfer');
    return tx;
  }

  /** Builds the batch as plain RLUSD transfers to registered addresses. Throws on anything else. */
  plan(lines: PayoutLine[]): PayoutTx[] {
    if (!this.opts) throw new Error('XrplEvmPayoutRail needs a token and payout addresses');
    return lines.map((l) => {
      const { payTo, refused } = this.payToFor(l.merchantId);
      if (!payTo) throw new Error(refused);
      return this.buildTx(l.merchantId, payTo, l.amountRlusd);
    });
  }

  /** Like plan(), but lists refused and in-flight lines instead of throwing. Sends nothing. */
  preview(lines: PayoutLine[]): PayoutPreview {
    if (!this.opts) throw new Error('XrplEvmPayoutRail needs a token and payout addresses');
    const out: PayoutPreview = { transfers: [], skipped: [] };
    for (const l of lines) {
      if (this.inFlight.has(l.merchantId)) {
        out.skipped.push({ merchantId: l.merchantId, reason: `transfer ${this.inFlight.get(l.merchantId)!.hash} still in flight` });
        continue;
      }
      const { payTo, refused } = this.payToFor(l.merchantId);
      if (!payTo) {
        out.skipped.push({ merchantId: l.merchantId, reason: refused! });
        continue;
      }
      try {
        out.transfers.push({ ...this.buildTx(l.merchantId, payTo, l.amountRlusd), payTo, amountRlusd: l.amountRlusd, amountTokens: l.amountTokens });
      } catch (e) {
        out.skipped.push({ merchantId: l.merchantId, reason: (e as Error).message });
      }
    }
    return out;
  }

  // --- JSON-RPC -----------------------------------------------------------

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const f = this.opts?.fetch ?? fetch;
    const r = await f(this.opts?.rpc ?? XRPL_EVM_TESTNET_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.opts?.rpcTimeoutMs ?? 15_000),
    });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new RpcError(`rpc ${method}: ${j.error.message}`);
    return j.result as T;
  }

  private async receipt(hash: string): Promise<RpcReceipt | null> {
    return this.rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash]);
  }

  private async nonce(tag: 'latest' | 'pending'): Promise<number> {
    return Number(BigInt(await this.rpc<string>('eth_getTransactionCount', [this.account!.address, tag])));
  }

  private async prepare() {
    if (!this.chainChecked) {
      const id = Number(BigInt(await this.rpc<string>('eth_chainId', [])));
      if (id !== this.chainId) throw new Error(`RPC is on chain ${id}, payouts are configured for chain ${this.chainId}`);
      this.chainChecked = true;
    }
    if (this.decimals === undefined) {
      this.decimals = Number(BigInt(await this.rpc<string>('eth_call', [{ to: this.opts!.token, data: '0x313ce567' }, 'latest'])));
    }
  }

  private async gasPrice(): Promise<bigint> {
    const price = BigInt(await this.rpc<string>('eth_gasPrice', []));
    const cap = this.opts?.maxGasPriceWei ?? 100n * GWEI;
    if (price > cap) throw new Error(`gas price ${price} wei is above the cap of ${cap} wei; nothing sent`);
    return price;
  }

  /** Upper bound: every line at the gas cap and the current gas price, at the XRP price bound. */
  async estimateFeeRlusd(lines: PayoutLine[]): Promise<number> {
    if (!this.account) return 0; // legacy `send` hook: fees are the caller's business
    const wei = (await this.gasPrice()) * (this.opts?.maxGasPerTransfer ?? 100_000n) * BigInt(lines.length);
    return (Number(wei) / 1e18) * (this.opts?.xrpPriceRlusd ?? 5);
  }

  // --- sending ------------------------------------------------------------

  async payout(lines: PayoutLine[]): Promise<PayoutResult[]> {
    if (!this.opts) throw new Error('XrplEvmPayoutRail needs a token and payout addresses');
    if (!this.account) return this.payoutLegacy(lines);
    if (this.busy) return [];
    this.busy = true;
    try {
      return await this.payoutSigned(lines);
    } finally {
      this.busy = false;
    }
  }

  private async payoutLegacy(lines: PayoutLine[]): Promise<PayoutResult[]> {
    const txs = this.plan(lines);
    if (!this.opts?.send) throw new Error('XrplEvmPayoutRail has no signer: set ISSUER_PAYOUT_PRIVATE_KEY (privateKey)');
    const out: PayoutResult[] = [];
    for (const tx of txs) out.push({ merchantId: tx.merchantId, txRef: await this.opts.send(tx) });
    return out;
  }

  private result(f: InFlight): PayoutResult {
    return { merchantId: f.merchantId, txRef: f.hash, amountTokens: f.amountTokens, payTo: f.payTo, token: this.opts!.token.toLowerCase(), chainId: this.chainId };
  }

  /** Checks transfers left from earlier batches. Confirmed ones are returned; dropped ones are forgotten. */
  private async settleInFlight(): Promise<{ done: PayoutResult[]; touched: Set<string>; rebroadcast: InFlight[] }> {
    const done: PayoutResult[] = [];
    const touched = new Set<string>();
    const rebroadcast: InFlight[] = [];
    if (this.inFlight.size === 0) return { done, touched, rebroadcast };
    let latest: number | undefined;
    for (const f of [...this.inFlight.values()]) {
      touched.add(f.merchantId);
      const rc = await this.receipt(f.hash);
      if (rc) {
        this.inFlight.delete(f.merchantId);
        if (rc.status === '0x1') {
          this.log(`earlier transfer confirmed: ${f.merchantId} ${f.hash}`);
          done.push(this.result(f));
        } else this.log(`earlier transfer reverted: ${f.merchantId} ${f.hash}; the line stays unpaid`);
        continue;
      }
      latest ??= await this.nonce('latest');
      if (latest > f.nonce) {
        // Its nonce was used by another tx, so this one can never be mined. Check once more (race).
        if (!(await this.receipt(f.hash))) {
          this.inFlight.delete(f.merchantId);
          this.log(`transfer ${f.hash} for ${f.merchantId} was dropped (nonce ${f.nonce} used); the line stays unpaid`);
        }
        continue;
      }
      // Not mined and its nonce is still free: rebroadcast the same signed bytes (same hash).
      try {
        await this.rpc('eth_sendRawTransaction', [f.raw]);
      } catch {
        /* "already known" or a flaky RPC: either way, its receipt is checked below and next batch */
      }
      rebroadcast.push(f);
    }
    return { done, touched, rebroadcast };
  }

  private async payoutSigned(lines: PayoutLine[]): Promise<PayoutResult[]> {
    await this.prepare();
    const results: PayoutResult[] = [];

    // 1. Transfers from earlier batches come first. Their merchants get no new transfer this batch.
    const { done, touched, rebroadcast } = await this.settleInFlight();
    results.push(...done);

    // 2. Plan the new lines: registered, unchanged addresses only.
    const refused: string[] = [];
    const planned: { line: PayoutLine; tx: PayoutTx; payTo: string }[] = [];
    for (const l of lines) {
      if (touched.has(l.merchantId) || this.inFlight.has(l.merchantId)) continue;
      const { payTo, refused: why } = this.payToFor(l.merchantId);
      if (!payTo) {
        refused.push(why!);
        this.log(`${why}; line not sent`);
        continue;
      }
      planned.push({ line: l, tx: this.buildTx(l.merchantId, payTo, l.amountRlusd), payTo });
    }
    if (planned.length === 0 && refused.length && results.length === 0 && rebroadcast.length === 0) throw new Error(refused.join('; '));

    // 3. Gas: hard caps per transfer, on price, and per batch.
    const gasPrice = planned.length ? await this.gasPrice() : 0n;
    const maxGas = this.opts!.maxGasPerTransfer ?? 100_000n;
    const maxBatchFee = this.opts!.maxBatchFeeWei ?? 5n * 10n ** 17n;
    const from = this.account!.address;
    const ready: { line: PayoutLine; tx: PayoutTx; payTo: string; gas: bigint }[] = [];
    let fee = 0n;
    for (const p of planned) {
      let est: bigint;
      try {
        est = BigInt(await this.rpc<string>('eth_estimateGas', [{ from, to: p.tx.to, data: p.tx.data, value: '0x0' }]));
      } catch (e) {
        this.log(`cannot send to ${p.line.merchantId}: ${(e as Error).message}; the line stays unpaid`);
        continue;
      }
      if (est > maxGas) {
        this.log(`transfer to ${p.line.merchantId} needs ${est} gas, above the cap of ${maxGas}; not sent`);
        continue;
      }
      const gas = (est * 12n) / 10n > maxGas ? maxGas : (est * 12n) / 10n;
      if (fee + gas * gasPrice > maxBatchFee) {
        this.log(`batch fee cap of ${maxBatchFee} wei reached; the rest waits for the next batch`);
        break;
      }
      fee += gas * gasPrice;
      ready.push({ ...p, gas });
    }

    // 4. Sign with consecutive nonces and send in order. Record each tx as in flight before sending.
    let nonce = ready.length ? await this.nonce('pending') : 0;
    const sent: InFlight[] = [...rebroadcast];
    for (const r of ready) {
      const raw = await this.account!.signTransaction({
        type: 'legacy',
        chainId: this.chainId,
        nonce,
        to: r.tx.to as Hex,
        data: r.tx.data as Hex,
        value: 0n,
        gas: r.gas,
        gasPrice,
      });
      const f: InFlight = { merchantId: r.line.merchantId, hash: keccak256(raw), raw, nonce, amountTokens: r.line.amountTokens, payTo: r.payTo };
      this.inFlight.set(f.merchantId, f);
      try {
        const h = await this.rpc<string>('eth_sendRawTransaction', [raw]);
        if (typeof h === 'string' && h.toLowerCase() !== f.hash) throw new Error(`RPC returned hash ${h}, expected ${f.hash}`);
        sent.push(f);
        nonce++;
        this.log(`sent ${r.line.amountRlusd} RLUSD → ${f.merchantId} (${f.payTo}) nonce ${f.nonce} tx ${f.hash}`);
      } catch (e) {
        if (e instanceof RpcError && !/already known|known transaction/i.test(e.message)) {
          // The node refused it, so the nonce is still free. The line stays unpaid.
          this.inFlight.delete(f.merchantId);
          this.log(`send to ${f.merchantId} refused: ${e.message}; the rest of the batch waits`);
        } else if (e instanceof RpcError) {
          sent.push(f);
          nonce++;
          continue;
        } else {
          // Timeout or network error after sending: the tx may be out. Keep it in flight and
          // check its receipt by hash before anything is resent.
          sent.push(f);
          this.log(`send to ${f.merchantId} did not answer (${(e as Error).message}); checking tx ${f.hash} by hash`);
        }
        break; // never leave a nonce gap behind a tx that may not exist
      }
    }

    // 5. Wait for receipts. Only a success receipt counts as paid.
    const deadline = Date.now() + (this.opts!.receiptTimeoutMs ?? 60_000);
    const waiting = new Set(sent);
    while (waiting.size) {
      for (const f of [...waiting]) {
        let rc: RpcReceipt | null = null;
        try {
          rc = await this.receipt(f.hash);
        } catch {
          continue;
        }
        if (!rc) continue;
        waiting.delete(f);
        this.inFlight.delete(f.merchantId);
        if (rc.status === '0x1') results.push(this.result(f));
        else this.log(`transfer to ${f.merchantId} reverted (${f.hash}); the line stays unpaid`);
      }
      if (!waiting.size || Date.now() >= deadline) break;
      await sleep(this.opts!.pollMs ?? 1_000);
    }
    for (const f of waiting) this.log(`no receipt yet for ${f.merchantId} (${f.hash}); it stays in flight for the next batch`);
    return results;
  }
}

/** SR6: caps that bound what one payout run can move or spend. Set in config, outside any model. */
export interface PayoutCaps {
  /** Most merchants paid in one batch. Default 50. */
  maxLines?: number;
  /** Most tokens paid out in one batch, across all lines. Default 100,000 (10,000 RLUSD). */
  maxBatchTokens?: number;
  /** Most fee, in RLUSD, the issuer pays for one batch. Default 1 RLUSD. */
  maxFeeRlusd?: number;
}

export const DEFAULT_PAYOUT_CAPS: Required<PayoutCaps> = { maxLines: 50, maxBatchTokens: 100_000, maxFeeRlusd: 1 };

/** Cuts unpaid tabs down to the caps. A line above the total cap is paid in part; the rest waits. */
export function capPayoutLines(lines: PayoutLine[], caps: PayoutCaps = {}): PayoutLine[] {
  const c = { ...DEFAULT_PAYOUT_CAPS, ...caps };
  const out: PayoutLine[] = [];
  let left = c.maxBatchTokens;
  for (const l of lines) {
    if (out.length >= c.maxLines || left <= 0) break;
    const amountTokens = Math.min(l.amountTokens, left);
    if (amountTokens <= 0) continue;
    out.push({ ...l, amountTokens, amountRlusd: tokensToRlusd(amountTokens) });
    left -= amountTokens;
  }
  return out;
}

export class PayoutScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  readonly caps: Required<PayoutCaps>;

  constructor(
    private readonly core: IssuerCore,
    readonly rail: PayoutRail,
    private readonly intervalMs: number,
    caps: PayoutCaps = {},
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.caps = { ...DEFAULT_PAYOUT_CAPS, ...caps };
  }

  start() {
    this.timer ??= setInterval(
      () => void this.runOnce().catch((e) => this.log(`payout batch failed: ${(e as Error).message}`)),
      this.intervalMs,
    );
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The next batch after caps, and the transfers the rail would send. Sends nothing. */
  preview(): { lines: PayoutLine[]; preview?: PayoutPreview } {
    const lines = capPayoutLines(this.core.pendingPayouts(), this.caps);
    return { lines, preview: this.rail.preview?.(lines) };
  }

  /** Sends one batch. Returns the lines marked paid (only those with a confirmed transfer). */
  async runOnce(): Promise<PaidLine[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const lines = capPayoutLines(this.core.pendingPayouts(), this.caps);
      if (lines.length === 0) return [];
      if (this.rail.estimateFeeRlusd) {
        const fee = await this.rail.estimateFeeRlusd(lines);
        if (!(fee >= 0) || fee > this.caps.maxFeeRlusd) {
          throw new Error(`payout fee ${fee} RLUSD is above the cap of ${this.caps.maxFeeRlusd} RLUSD`);
        }
      }
      const results = await this.rail.payout(lines);
      const paid: PaidLine[] = [];
      for (const r of results) {
        const line = lines.find((l) => l.merchantId === r.merchantId);
        const amountTokens = r.amountTokens ?? line?.amountTokens;
        if (amountTokens === undefined) continue;
        paid.push({
          merchantId: r.merchantId,
          amountTokens,
          amountRlusd: tokensToRlusd(amountTokens),
          txRef: r.txRef,
          ...(r.payTo ? { payTo: r.payTo } : {}),
          ...(r.token ? { token: r.token } : {}),
          ...(r.chainId !== undefined ? { chainId: r.chainId } : {}),
        });
      }
      this.core.markPaid(paid);
      return paid;
    } finally {
      this.running = false;
    }
  }
}
