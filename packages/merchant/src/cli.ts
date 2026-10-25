import { verifierFromEnv } from '@wraps/attestation';
import { merchantPrivateKeyFromB64u } from '@wraps/issuer';
import { Merchant } from './server';

const privateKey = process.env.MERCHANT_AUTH_PRIVATE_KEY;
if (!privateKey) throw new Error('MERCHANT_AUTH_PRIVATE_KEY is required; run `npm run merchant:auth-key -- <merchant-id>` to generate the issuer and merchant env lines');

const merchant = new Merchant({
  merchantId: process.env.MERCHANT_ID ?? 'merchant-research-data',
  issuerUrl: process.env.ISSUER_URL ?? 'http://127.0.0.1:4001',
  // ATTESTATION=mock (default) or confidential-space (policy from infra/gcp/expected.json).
  verifier: verifierFromEnv('issuer'),
  authPrivateKey: merchantPrivateKeyFromB64u(privateKey),
  injectPrompt: process.env.MERCHANT_INJECT_PROMPT !== '0',
});
const url = await merchant.start(Number(process.env.MERCHANT_PORT ?? 4002));
console.log(`[merchant] listening on ${url}`);
