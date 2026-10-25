import type { Server } from 'node:http';
import { AttestationProvider, ConfidentialSpaceProvider, MockAttestationProvider } from '@wraps/attestation';
import { IssuerCore } from './core';
import { listenUrl } from './http';
import { MockPayoutRail, PayoutCaps, PayoutScheduler } from './payout';
import { MockTopUpRail, TopUpRail, VoucherRedeemedEvent } from './rail';
import { createIssuerServer } from './server';
import { createTlsIdentity } from './tls';

export type AttestationMode = 'mock' | 'confidential-space';

export interface StartIssuerOptions {
  port?: number;
  /** Bind address. Default 127.0.0.1. The container uses 0.0.0.0. */
  host?: string;
  /** mock (default) or confidential-space (inside a Confidential Space VM only). */
  attestation?: AttestationMode;
  /** Custom audience for Confidential Space tokens. */
  audience?: string;
  /** Serve https with a key made here at start-up. The key joins the attestation. */
  tls?: boolean;
  /** Mock build name. 'issuer' matches the expected PCRs; anything else simulates a modified issuer. */
  buildName?: string;
  debugMode?: boolean;
  payoutIntervalMs?: number;
  log?: (msg: string) => void;
  /** Defaults to the mock AP4M rail. */
  rail?: TopUpRail;
  corsOrigins?: string[];
  /** SR6: caps on one payout batch. */
  payoutCaps?: PayoutCaps;
  /** SR3: token key lifetime and the least life a newly signed token gets. */
  tokenKeyLifetimeMs?: number;
  minTokenLifetimeMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface RunningIssuer {
  core: IssuerCore;
  server: Server;
  url: string;
  payouts: PayoutScheduler;
  close(): Promise<void>;
}

function provider(opts: StartIssuerOptions): AttestationProvider {
  if (opts.attestation === 'confidential-space') return new ConfidentialSpaceProvider({ audience: opts.audience });
  return new MockAttestationProvider({ buildName: opts.buildName ?? 'issuer', debug: opts.debugMode });
}

/** Starts an issuer with the chosen attestation, the mock AP4M rail and mock payouts. */
export async function startIssuer(opts: StartIssuerOptions = {}): Promise<RunningIssuer> {
  const log = opts.log ?? ((m: string) => console.log(`[issuer] ${m}`));
  const rail = opts.rail ?? new MockTopUpRail();
  rail.on('VoucherRedeemed', (e: VoucherRedeemedEvent) =>
    log(`VoucherRedeemed (mock) tx=${e.txHash.slice(0, 18)}… ${e.amountRlusd} RLUSD → ${e.payee}`),
  );
  // All keys are made here, in memory, at start-up. They die with the process.
  const tls = opts.tls ? await createTlsIdentity() : undefined;
  const core = await IssuerCore.create({
    provider: provider(opts),
    rail,
    log,
    tlsPublicKey: tls?.spki,
    tokenKeyLifetimeMs: opts.tokenKeyLifetimeMs,
    minTokenLifetimeMs: opts.minTokenLifetimeMs,
    now: opts.now,
  });
  const server = createIssuerServer(core, { tls, corsOrigins: opts.corsOrigins });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const payouts = new PayoutScheduler(core, new MockPayoutRail(log), opts.payoutIntervalMs ?? 30_000, opts.payoutCaps);
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
