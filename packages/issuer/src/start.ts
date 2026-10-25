import type { Server } from 'node:http';
import { MockAttestationProvider } from '@wraps/attestation';
import { IssuerCore } from './core';
import { listenUrl } from './http';
import { MockPayoutRail, PayoutScheduler } from './payout';
import { MockTopUpRail, TopUpRail, VoucherRedeemedEvent } from './rail';
import { createIssuerServer } from './server';

export interface StartIssuerOptions {
  port?: number;
  /** Mock build name. 'issuer' matches the expected PCRs; anything else simulates a modified issuer. */
  buildName?: string;
  debugMode?: boolean;
  payoutIntervalMs?: number;
  log?: (msg: string) => void;
  /** Defaults to the mock AP4M rail. */
  rail?: TopUpRail;
  corsOrigins?: string[];
}

export interface RunningIssuer {
  core: IssuerCore;
  server: Server;
  url: string;
  payouts: PayoutScheduler;
  close(): Promise<void>;
}

/** Starts an issuer with the mock attestation, the given (default mock AP4M) rail and mock payouts. */
export async function startIssuer(opts: StartIssuerOptions = {}): Promise<RunningIssuer> {
  const log = opts.log ?? ((m: string) => console.log(`[issuer] ${m}`));
  const rail = opts.rail ?? new MockTopUpRail();
  rail.on('VoucherRedeemed', (e: VoucherRedeemedEvent) =>
    log(`VoucherRedeemed (mock) tx=${e.txHash.slice(0, 18)}… ${e.amountRlusd} RLUSD → ${e.payee}`),
  );
  const core = await IssuerCore.create({
    provider: new MockAttestationProvider({ buildName: opts.buildName ?? 'issuer', debug: opts.debugMode }),
    rail,
    log,
  });
  const server = createIssuerServer(core, { corsOrigins: opts.corsOrigins });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const payouts = new PayoutScheduler(core, new MockPayoutRail(log), opts.payoutIntervalMs ?? 30_000);
  payouts.start();
  return {
    core,
    server,
    url: listenUrl(server),
    payouts,
    close: () =>
      new Promise((r) => {
        payouts.stop();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
