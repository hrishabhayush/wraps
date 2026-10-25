// Runs the demo agent against an issuer and merchant that are already up.
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { ResearchAgent } from './agent';
import { GullibleReasoner } from './reasoner';

const sdk = new PrivatePayClient({
  issuerUrl: process.env.ISSUER_URL ?? 'http://127.0.0.1:4001',
  // MOCK verifier, expecting the mock 'issuer' build. Swap for NitroAttestationVerifier (SDK-01).
  verifier: new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }),
  wallet: new MockTopUpWallet(),
  caps: {
    perCallTokens: Number(process.env.CAP_PER_CALL ?? 5),
    dailyTokens: Number(process.env.CAP_DAILY ?? 24),
    maxTopUpTokens: Number(process.env.CAP_TOP_UP ?? 20),
  },
});

const issuer = await sdk.connect();
console.log(`Issuer attestation verified. PCR0 ${issuer.attestation.pcrs['0'].slice(0, 16)}…`);
await new ResearchAgent({
  sdk,
  merchantUrl: process.env.MERCHANT_URL ?? 'http://127.0.0.1:4002',
  reasoner: process.argv.includes('--gullible') ? new GullibleReasoner() : undefined,
}).run();
