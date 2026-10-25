import { XrplEvmTransferRail } from './rail-xrpl-evm';
import { startIssuer } from './start';

// ISSUER_RAIL=xrpl-evm: users pay RLUSD on XRPL EVM from their own wallet (needs ISSUER_PAYOUT, RLUSD_ADDRESS).
const evm = process.env.ISSUER_RAIL === 'xrpl-evm';
const rail = evm
  ? new XrplEvmTransferRail(process.env.ISSUER_PAYOUT ?? '', { token: process.env.RLUSD_ADDRESS ?? '', rpc: process.env.XRPL_EVM_RPC })
  : undefined;
rail?.on('PaymentVerified', (e: { txHash: string; amountRlusd: string }) => console.log(`[issuer] RLUSD top-up verified on XRPL EVM: ${e.amountRlusd} RLUSD tx=${e.txHash.slice(0, 18)}…`));

const issuer = await startIssuer({
  port: Number(process.env.ISSUER_PORT ?? 4001),
  buildName: process.env.ISSUER_BUILD ?? 'issuer',
  debugMode: process.env.ISSUER_DEBUG_MODE === '1',
  payoutIntervalMs: Number(process.env.PAYOUT_INTERVAL_MS ?? 30_000),
  rail,
  corsOrigins: (process.env.ISSUER_CORS_ORIGINS ?? 'http://localhost:1420,tauri://localhost').split(','),
});
console.log(`[issuer] listening on ${issuer.url} (MOCK attestation, ${evm ? 'XRPL EVM RLUSD' : 'MOCK AP4M'} rail, MOCK payouts)`);
