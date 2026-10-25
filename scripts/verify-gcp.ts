// npm run verify:gcp [-- https://<VM IP>]
// Fetches GET /attestation?nonce=<fresh> from a Confidential Space issuer, prints the
// token's claims, and runs ConfidentialSpaceVerifier (Google JWKS + expected.json policy)
// on it. Exit code 0 only if every check passes. Works on the debug VM too: it shows the
// claims and the refusal.
import { existsSync, readFileSync } from 'node:fs';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { AttestationError, verifierFromEnv } from '@wraps/attestation';
import { fetchAttestedIssuer } from '@wraps/issuer';

const arg = process.argv[2];
const url =
  arg ?? process.env.ISSUER_URL ?? (existsSync('infra/gcp/.state/issuer.ip') ? `https://${readFileSync('infra/gcp/.state/issuer.ip', 'utf8').trim()}` : undefined);
if (!url) throw new Error('usage: npm run verify:gcp -- https://<VM IP>');

const verifier = verifierFromEnv('issuer', { ...process.env, ATTESTATION: 'confidential-space' });

// Record the raw token on the way through so we can show its claims either way.
let raw: string | undefined;
const recording = {
  format: verifier.format,
  verify: (att: string, expect: Parameters<typeof verifier.verify>[1]) => {
    raw = att;
    return verifier.verify(att, expect);
  },
};

try {
  const issuer = await fetchAttestedIssuer(url, recording);
  show();
  console.log('\nRESULT: VERIFIED');
  console.log(`  issuer ${url}, image ${issuer.attestation.measurement}`);
  console.log(`  TLS key pinned: ${issuer.tlsKey ? Buffer.from(issuer.tlsKey).toString('base64url').slice(0, 32) + '…' : 'no'}`);
} catch (e) {
  show();
  if (e instanceof AttestationError) {
    console.log(`\nRESULT: REFUSED (${e.code})\n  ${e.message}`);
    process.exit(2);
  }
  throw e;
}

function show() {
  if (!raw) return;
  const h = decodeProtectedHeader(raw);
  const c = decodeJwt(raw) as Record<string, any>;
  console.log(`token header: alg=${h.alg} kid=${h.kid}`);
  const pick = {
    iss: c.iss,
    aud: c.aud,
    iat: c.iat && new Date(c.iat * 1000).toISOString(),
    exp: c.exp && new Date(c.exp * 1000).toISOString(),
    hwmodel: c.hwmodel,
    swname: c.swname,
    swversion: c.swversion,
    dbgstat: c.dbgstat,
    secboot: c.secboot,
    oemid: c.oemid,
    eat_nonce: c.eat_nonce,
    'submods.container.image_digest': c.submods?.container?.image_digest,
    'submods.container.image_reference': c.submods?.container?.image_reference,
    'submods.confidential_space.support_attributes': c.submods?.confidential_space?.support_attributes,
    'submods.gce': c.submods?.gce,
    google_service_accounts: c.google_service_accounts,
  };
  console.log('token claims:');
  for (const [k, v] of Object.entries(pick)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}
