// Batched merchant payouts at fixed times (SPEC §4 step 7).
import type { IssuerCore, PayoutLine } from './core';
import { tokensToRlusd } from './protocol';
import { toUnits } from './rail-xrpl-evm';

export interface PayoutRail {
  /** Sends one batch. Resolves with a reference per line once the transfers are done. */
  payout(lines: PayoutLine[]): Promise<{ merchantId: string; txRef: string }[]>;
  /** Fee the issuer would pay to send this batch, in RLUSD. Optional: rails without fees omit it. */
  estimateFeeRlusd?(lines: PayoutLine[]): Promise<number>;
}

/** MOCK: logs the batch instead of sending RLUSD. */
export class MockPayoutRail implements PayoutRail {
  constructor(private readonly log: (msg: string) => void = console.log) {}
  async payout(lines: PayoutLine[]) {
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

export interface XrplEvmPayoutRailOptions {
  /** RLUSD ERC-20 contract on the sidechain. */
  token: string;
  /** merchantId → registered payout address. Merchants not listed are never paid on-chain. */
  payoutAddresses: Record<string, string>;
  decimals?: number;
  /** Signs and sends one tx, resolves with its hash. Without it, payout() throws (ISS-06). */
  send?: (tx: PayoutTx) => Promise<string>;
}

/**
 * RLUSD ERC-20 transfers on the XRPL EVM sidechain from the issuer's payout address,
 * one per merchant, mixed across all customers.
 * TODO(ISS-06): signing and sending. Outbound calls go through the enclave's vsock proxy (INF-11).
 */
export class XrplEvmPayoutRail implements PayoutRail {
  private readonly opts?: XrplEvmPayoutRailOptions;

  constructor(opts?: XrplEvmPayoutRailOptions) {
    if (opts) {
      for (const a of [opts.token, ...Object.values(opts.payoutAddresses)]) {
        if (!EVM_ADDRESS.test(a)) throw new Error(`bad address: ${a}`);
      }
    }
    this.opts = opts;
  }

  /** Builds the batch as plain RLUSD transfers to registered addresses. Throws on anything else. */
  plan(lines: PayoutLine[]): PayoutTx[] {
    const o = this.opts;
    if (!o) throw new Error('XrplEvmPayoutRail needs a token and payout addresses');
    const decimals = o.decimals ?? 18;
    return lines.map((l) => {
      const payTo = o.payoutAddresses[l.merchantId];
      if (!payTo) throw new Error(`no registered payout address for ${l.merchantId}`);
      const amount = toUnits(l.amountRlusd, decimals);
      if (amount <= 0n) throw new Error(`refusing a zero payout to ${l.merchantId}`);
      const tx: PayoutTx = {
        merchantId: l.merchantId,
        to: o.token,
        data: '0x' + TRANSFER_SELECTOR + word(payTo) + word(amount.toString(16)),
        value: '0x0',
      };
      if (!isPlainRlusdTransfer(tx, o.token, Object.values(o.payoutAddresses))) throw new Error('payout is not a plain RLUSD transfer');
      return tx;
    });
  }

  async payout(lines: PayoutLine[]): Promise<{ merchantId: string; txRef: string }[]> {
    const txs = this.plan(lines);
    if (!this.opts?.send) throw new Error('XrplEvmPayoutRail sending is not implemented yet (ISS-06)');
    const out: { merchantId: string; txRef: string }[] = [];
    for (const tx of txs) out.push({ merchantId: tx.merchantId, txRef: await this.opts.send(tx) });
    return out;
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
    private readonly rail: PayoutRail,
    private readonly intervalMs: number,
    caps: PayoutCaps = {},
  ) {
    this.caps = { ...DEFAULT_PAYOUT_CAPS, ...caps };
  }

  start() {
    this.timer ??= setInterval(() => void this.runOnce().catch(() => {}), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<PayoutLine[]> {
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
      await this.rail.payout(lines);
      this.core.markPaid(lines);
      return lines;
    } finally {
      this.running = false;
    }
  }
}
