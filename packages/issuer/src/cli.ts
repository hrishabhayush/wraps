import { XrplEvmTransferRail } from './rail-xrpl-evm';
import { AttestationMode, startIssuer } from './start';

const attestation = (process.env.ATTESTATION ?? 'mock') as AttestationMode;
if (attestation !== 'mock' && attestation !== 'confidential-space') {
  throw new Error(`ATTESTATION must be mock or confidential-space, got ${attestation}`);
}
const tls = process.env.ISSUER_TLS === '1';

// ISSUER_RAIL=xrpl-evm: users pay RLUSD on XRPL EVM from their own wallet (needs ISSUER_PAYOUT, RLUSD_ADDRESS).
const evm = process.env.ISSUER_RAIL === 'xrpl-evm';
const rail = evm
  ? new XrplEvmTransferRail(process.env.ISSUER_PAYOUT ?? '', { token: process.env.RLUSD_ADDRESS ?? '', rpc: process.env.XRPL_EVM_RPC })
  : undefined;
rail?.on('PaymentVerified', (e: { txHash: string; amountRlusd: string }) => console.log(`[issuer] RLUSD top-up verified on XRPL EVM: ${e.amountRlusd} RLUSD tx=${e.txHash.slice(0, 18)}…`));

const issuer = await startIssuer({
  host: process.env.ISSUER_HOST ?? '0.0.0.0',
  port: Number(process.env.ISSUER_PORT ?? 4001),
  attestation,
  audience: process.env.ATTESTATION_AUDIENCE,
  tls,
  buildName: process.env.ISSUER_BUILD ?? 'issuer',
  debugMode: process.env.ISSUER_DEBUG_MODE === '1',
  payoutIntervalMs: Number(process.env.PAYOUT_INTERVAL_MS ?? 30_000),
  rail,
  corsOrigins: (process.env.ISSUER_CORS_ORIGINS ?? 'http://localhost:1420,tauri://localhost').split(','),
});
const addr = issuer.server.address();
const port = addr && typeof addr === 'object' ? addr.port : '?';
console.log(
  `[issuer] listening on ${tls ? 'https' : 'http'}://${process.env.ISSUER_HOST ?? '0.0.0.0'}:${port} ` +
    `(attestation: ${attestation}${attestation === 'mock' ? ', MOCK' : ''}; MOCK AP4M rail; MOCK payouts)`,
);
