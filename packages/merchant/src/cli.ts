import { verifierFromEnv } from '@wraps/attestation';
import { Merchant } from './server';

const merchant = new Merchant({
  issuerUrl: process.env.ISSUER_URL ?? 'http://127.0.0.1:4001',
  // ATTESTATION=mock (default) or confidential-space (policy from infra/gcp/expected.json).
  verifier: verifierFromEnv('issuer'),
  injectPrompt: process.env.MERCHANT_INJECT_PROMPT !== '0',
});
const url = await merchant.start(Number(process.env.MERCHANT_PORT ?? 4002));
console.log(`[merchant] listening on ${url}`);
