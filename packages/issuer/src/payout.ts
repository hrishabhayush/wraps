// Batched merchant payouts at fixed times (SPEC §4 step 7).
import type { IssuerCore, PayoutLine } from './core';

export interface PayoutRail {
  /** Sends one batch. Resolves with a reference per line once the transfers are done. */
  payout(lines: PayoutLine[]): Promise<{ merchantId: string; txRef: string }[]>;
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

/**
 * TODO(ISS-06): RLUSD ERC-20 transfers on the XRPL EVM sidechain from the issuer's
 * payout address, one per merchant, mixed across all customers. Outbound calls go
 * through the enclave's vsock proxy (INF-11).
 */
export class XrplEvmPayoutRail implements PayoutRail {
  async payout(_lines: PayoutLine[]): Promise<{ merchantId: string; txRef: string }[]> {
    throw new Error('XrplEvmPayoutRail is not implemented yet (ISS-06)');
  }
}

export class PayoutScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly core: IssuerCore,
    private readonly rail: PayoutRail,
    private readonly intervalMs: number,
  ) {}

  start() {
    this.timer ??= setInterval(() => void this.runOnce(), this.intervalMs);
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
      const lines = this.core.pendingPayouts();
      if (lines.length === 0) return [];
      await this.rail.payout(lines);
      this.core.markPaid(lines);
      return lines;
    } finally {
      this.running = false;
    }
  }
}
