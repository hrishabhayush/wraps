import { payoutConfigFromEnv } from './payout-config';
import { XrplEvmTransferRail } from './rail-xrpl-evm';
import { FileIssuerStateStore, type IssuerStateStore } from './state-store';
import { GcsIssuerStateStore } from './gcs-state-store';
import { createConfidentialSpaceAccessTokenProvider } from './confidential-secret';
import { assertConfidentialSpaceMerchantAuth, merchantAuthConfigFromEnv } from './merchant-auth';
import { readConfidentialSecret } from './confidential-secret';
import { AttestationMode, startIssuer } from './start';

const attestation = (process.env.ATTESTATION ?? 'mock') as AttestationMode;
if (attestation !== 'mock' && attestation !== 'confidential-space') {
  throw new Error(`ATTESTATION must be mock or confidential-space, got ${attestation}`);
}
const tls = process.env.ISSUER_TLS === '1';
const host = process.env.ISSUER_HOST ?? '0.0.0.0';

// ISSUER_RAIL=xrpl-evm: users pay RLUSD on XRPL EVM from their own wallet (needs ISSUER_PAYOUT, RLUSD_ADDRESS).
const evm = process.env.ISSUER_RAIL === 'xrpl-evm';
const rail = evm
  ? new XrplEvmTransferRail(process.env.ISSUER_PAYOUT ?? '', { token: process.env.RLUSD_ADDRESS ?? '', rpc: process.env.XRPL_EVM_RPC })
  : undefined;
rail?.on('PaymentVerified', (e: { txHash: string; amountRlusd: string }) => console.log(`[issuer] RLUSD top-up verified on XRPL EVM: ${e.amountRlusd} RLUSD tx=${e.txHash.slice(0, 18)}…`));

// PAYOUT_RAIL=xrpl-evm: merchant payouts in RLUSD on XRPL EVM (needs ISSUER_PAYOUT_PRIVATE_KEY,
// RLUSD_ADDRESS, MERCHANT_PAYOUT_ADDRESSES). Default mock. See packages/issuer/README.md.
const payout = payoutConfigFromEnv(process.env);
// The key now lives only inside the rail. Drop it from the environment so nothing else can read it.
delete process.env.ISSUER_PAYOUT_PRIVATE_KEY;

const merchantAuthEnv = { ...process.env };
const relaySecretVersion = process.env.ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION;
if (relaySecretVersion) {
  if (attestation !== 'confidential-space') {
    throw new Error('ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION requires ATTESTATION=confidential-space');
  }
  if (process.env.ISSUER_RELAY_SETTLE_KEY !== undefined) {
    throw new Error('Set the relay credential in Secret Manager, not ISSUER_RELAY_SETTLE_KEY');
  }
  merchantAuthEnv.ISSUER_RELAY_SETTLE_KEY = await readConfidentialSecret(relaySecretVersion, process.env.GCP_WIF_PROVIDER ?? '');
} else if (attestation === 'confidential-space' && process.env.ISSUER_RELAY_SETTLE_KEY !== undefined) {
  throw new Error('Confidential Space must load ISSUER_RELAY_SETTLE_KEY from Secret Manager');
}
const merchantAuth = merchantAuthConfigFromEnv(merchantAuthEnv, host, attestation);
if (attestation === 'confidential-space') assertConfidentialSpaceMerchantAuth(merchantAuth);

let stateStore: IssuerStateStore | undefined;
if (attestation === 'confidential-space') {
  if (process.env.ISSUER_STATE_FILE !== undefined) {
    throw new Error('ISSUER_STATE_FILE is local-only; Confidential Space requires encrypted Cloud Storage state');
  }
  const bucket = process.env.ISSUER_STATE_GCS_BUCKET?.trim();
  const kmsKey = process.env.ISSUER_STATE_KMS_KEY?.trim();
  const workloadIdentityProvider = process.env.GCP_WIF_PROVIDER?.trim();
  if (!bucket || !kmsKey || !workloadIdentityProvider) {
    throw new Error('Confidential Space requires ISSUER_STATE_GCS_BUCKET, ISSUER_STATE_KMS_KEY, and GCP_WIF_PROVIDER');
  }
  const getAccessToken = createConfidentialSpaceAccessTokenProvider(workloadIdentityProvider);
  stateStore = new GcsIssuerStateStore({
    bucket,
    kmsKey,
    getAccessToken,
    objectPrefix: process.env.ISSUER_STATE_GCS_PREFIX,
  });
} else {
  stateStore = process.env.ISSUER_STATE_FILE ? new FileIssuerStateStore(process.env.ISSUER_STATE_FILE) : undefined;
}

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
  payoutRail: payout.rail,
  payoutCaps: payout.caps,
  adminToken: process.env.ISSUER_ADMIN_TOKEN || undefined,
  merchantAuth,
  stateStore,
  corsOrigins: (process.env.ISSUER_CORS_ORIGINS ?? 'http://localhost:1420,tauri://localhost').split(','),
});
const addr = issuer.server.address();
const port = addr && typeof addr === 'object' ? addr.port : '?';
console.log(
  `[issuer] listening on ${tls ? 'https' : 'http'}://${process.env.ISSUER_HOST ?? '0.0.0.0'}:${port} ` +
    `(attestation: ${attestation}${attestation === 'mock' ? ', MOCK' : ''}; ${evm ? 'XRPL EVM RLUSD top-ups' : 'MOCK AP4M rail'}; ` +
    `${payout.name === 'xrpl-evm' ? `RLUSD payouts on XRPL EVM from ${payout.address} to ${payout.registry.size} merchants` : 'MOCK payouts'})`,
);
