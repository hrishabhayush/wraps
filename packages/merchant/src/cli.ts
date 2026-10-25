import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { Merchant } from './server';

const merchant = new Merchant({
  issuerUrl: process.env.ISSUER_URL ?? 'http://127.0.0.1:4001',
  // MOCK verifier: expected PCRs of the mock 'issuer' build. Swap for NitroAttestationVerifier
  // with loadExpectedPcrs('infra/pcrs.json', 'issuer') once INF-12 lands.
  verifier: new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }),
  injectPrompt: process.env.MERCHANT_INJECT_PROMPT !== '0',
});
const url = await merchant.start(Number(process.env.MERCHANT_PORT ?? 4002));
console.log(`[merchant] listening on ${url}`);
