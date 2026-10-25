// Runs the demo agent against an issuer and merchant that are already up.
import { verifierFromEnv } from '@wraps/attestation';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { ResearchAgent } from './agent';
import { GullibleReasoner } from './reasoner';

const sdk = new PrivatePayClient({
  issuerUrl: process.env.ISSUER_URL ?? 'http://127.0.0.1:4001',
  // ATTESTATION=mock (default) or confidential-space (policy from infra/gcp/expected.json).
  verifier: verifierFromEnv('issuer'),
  wallet: new MockTopUpWallet(),
  caps: {
    perCallTokens: Number(process.env.CAP_PER_CALL ?? 5),
    dailyTokens: Number(process.env.CAP_DAILY ?? 24),
    maxTopUpTokens: Number(process.env.CAP_TOP_UP ?? 20),
  },
});

const issuer = await sdk.connect();
console.log(`Issuer attestation verified (${issuer.attestation.format}). Measurement ${issuer.attestation.measurement.slice(0, 23)}…${issuer.tlsKey ? ' TLS key pinned.' : ''}`);
await new ResearchAgent({
  sdk,
  merchantUrl: process.env.MERCHANT_URL ?? 'http://127.0.0.1:4002',
  reasoner: process.argv.includes('--gullible') ? new GullibleReasoner() : undefined,
}).run();
