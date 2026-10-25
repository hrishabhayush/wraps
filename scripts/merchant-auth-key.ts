import { generateEd25519, b64u } from '@wraps/attestation';

const merchantId = process.argv[2] ?? 'merchant-research-data';
if (!/^[A-Za-z0-9._-]{1,128}$/.test(merchantId)) throw new Error('merchant ID must be 1-128 letters, digits, dot, underscore or hyphen');

const key = generateEd25519();
const privateDer = key.privateKey.export({ format: 'der', type: 'pkcs8' });
const privateB64u = b64u(privateDer);
const publicB64u = b64u(key.publicKeyBytes);
console.log(`# Keep the private value secret; configure the public key on the issuer.`);
console.log(`MERCHANT_ID=${merchantId}`);
console.log(`MERCHANT_AUTH_PRIVATE_KEY=${privateB64u}`);
console.log(`ISSUER_MERCHANT_AUTH_KEYS='{"${merchantId}":"${publicB64u}"}'`);
