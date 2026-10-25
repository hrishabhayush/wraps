import { payoutConfigFromEnv } from './payout-config';
import { XrplEvmTransferRail } from './rail-xrpl-evm';
import { MockTopUpRail } from './rail';
import { FileIssuerStateStore } from './state-store';
import { merchantAuthConfigFromEnv } from './merchant-auth';
import { AttestationMode, startIssuer } from './start';

const attestation = (process.env.ATTESTATION ?? 'mock') as AttestationMode;
if (attestation !== 'mock' && attestation !== 'confidential-space') {
  throw new Error(`ATTESTATION must be mock or confidential-space, got ${attestation}`);
}
const tls = process.env.ISSUER_TLS === '1';
const host = process.env.ISSUER_HOST ?? '0.0.0.0';

// ISSUER_RAIL: top-up rails, the first is the default. `mock` (default), `xrpl-evm` (users pay
// RLUSD on XRPL EVM from their own wallet; needs ISSUER_PAYOUT, RLUSD_ADDRESS), or both: `mock,xrpl-evm`.
const railNames = (process.env.ISSUER_RAIL || 'mock').split(',').map((r) => r.trim());
for (const r of railNames) if (r !== 'mock' && r !== 'xrpl-evm') throw new Error(`ISSUER_RAIL must list mock and/or xrpl-evm, got ${r}`);
const evm = railNames.includes('xrpl-evm');
const evmRail = evm
  ? new XrplEvmTransferRail(process.env.ISSUER_PAYOUT ?? '', { token: process.env.RLUSD_ADDRESS ?? '', rpc: process.env.XRPL_EVM_RPC })
  : undefined;
evmRail?.on('PaymentVerified', (e: { txHash: string; amountRlusd: string }) => console.log(`[issuer] RLUSD top-up verified on XRPL EVM: ${e.amountRlusd} RLUSD tx=${e.txHash.slice(0, 18)}…`));
const rails = railNames.map((r) => (r === 'xrpl-evm' ? evmRail! : new MockTopUpRail()));
const [rail, ...extraRails] = rails;

// PAYOUT_RAIL=xrpl-evm: merchant payouts in RLUSD on XRPL EVM (needs ISSUER_PAYOUT_PRIVATE_KEY,
// RLUSD_ADDRESS, MERCHANT_PAYOUT_ADDRESSES). Default mock. See packages/issuer/README.md.
const payout = payoutConfigFromEnv(process.env);
// The key now lives only inside the rail. Drop it from the environment so nothing else can read it.
delete process.env.ISSUER_PAYOUT_PRIVATE_KEY;

const issuer = await startIssuer({
  host,
  port: Number(process.env.ISSUER_PORT ?? 4001),
  attestation,
  audience: process.env.ATTESTATION_AUDIENCE,
  tls,
  buildName: process.env.ISSUER_BUILD ?? 'issuer',
  debugMode: process.env.ISSUER_DEBUG_MODE === '1',
  payoutIntervalMs: Number(process.env.PAYOUT_INTERVAL_MS ?? 30_000),
  rail,
  extraRails,
  payoutRail: payout.rail,
  payoutCaps: payout.caps,
  adminToken: process.env.ISSUER_ADMIN_TOKEN || undefined,
  merchantAuth: merchantAuthConfigFromEnv(process.env, host, attestation),
  // The current Confidential Space image does not configure this variable and stays in-memory.
  // Set it only for local/non-enclave runs whose filesystem survives process restarts.
  stateStore: process.env.ISSUER_STATE_FILE ? new FileIssuerStateStore(process.env.ISSUER_STATE_FILE) : undefined,
  corsOrigins: (process.env.ISSUER_CORS_ORIGINS ?? 'http://localhost:1420,tauri://localhost').split(','),
});
const addr = issuer.server.address();
const port = addr && typeof addr === 'object' ? addr.port : '?';
console.log(
  `[issuer] listening on ${tls ? 'https' : 'http'}://${process.env.ISSUER_HOST ?? '0.0.0.0'}:${port} ` +
    `(attestation: ${attestation}${attestation === 'mock' ? ', MOCK' : ''}; top-ups: ${railNames.map((r) => (r === 'xrpl-evm' ? 'XRPL EVM RLUSD' : 'MOCK AP4M')).join(' + ')}; ` +
    `${payout.name === 'xrpl-evm' ? `RLUSD payouts on XRPL EVM from ${payout.address} to ${payout.registry.size} merchants` : 'MOCK payouts'})`,
);
