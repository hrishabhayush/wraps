// npm run demo:gcp [-- --gullible]
// The issuer runs in a Google Cloud Confidential Space VM. The merchant and the agent run
// here, and both verify the issuer's token against Google's attestation service, then pin
// its TLS key, before they send anything.
//
//   ISSUER_URL     https://<VM IP>   (default: read from infra/gcp/.state/issuer.ip)
//   EXPECTED_JSON  infra/gcp/expected.json (image digest and policy)
//   ATTESTATION=mock  rehearsal mode: starts a local https issuer with MOCK attestation instead.
import { existsSync, readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import {
  AttestationError,
  ConfidentialSpaceDetails,
  MockAttestationVerifier,
  b64u,
  generateEd25519,
  mockPcrs,
  verifierFromEnv,
} from '@wraps/attestation';
import { issuerTransport, merchantPrivateKeyFromB64u, startIssuer, verifyClaim, verifyReserves } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { GullibleReasoner, ResearchAgent } from '@wraps/agent';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const rehearsal = process.env.ATTESTATION === 'mock';
const merchantId = process.env.MERCHANT_ID ?? 'merchant-research-data';
let merchantPrivateKey: KeyObject;
let merchantPublicKey: string | undefined;
if (rehearsal) {
  const pair = generateEd25519();
  merchantPrivateKey = pair.privateKey;
  merchantPublicKey = b64u(pair.publicKeyBytes);
} else {
  if (!process.env.MERCHANT_AUTH_PRIVATE_KEY) throw new Error('set MERCHANT_AUTH_PRIVATE_KEY for a deployed issuer; the matching public key must be in ISSUER_MERCHANT_AUTH_KEYS');
  merchantPrivateKey = merchantPrivateKeyFromB64u(process.env.MERCHANT_AUTH_PRIVATE_KEY);
}
let local: Awaited<ReturnType<typeof startIssuer>> | undefined;
let issuerUrl = process.env.ISSUER_URL;
if (rehearsal) {
  local = await startIssuer({
    tls: true,
    log: (m) => console.log(dim(`[local issuer] ${m}`)),
    payoutIntervalMs: 3_600_000,
    merchantAuth: { publicKeys: { [merchantId]: merchantPublicKey! } },
  });
  issuerUrl = local.url;
} else if (!issuerUrl && existsSync('infra/gcp/.state/issuer.ip')) {
  issuerUrl = `https://${readFileSync('infra/gcp/.state/issuer.ip', 'utf8').trim()}`;
}
if (!issuerUrl) throw new Error('set ISSUER_URL=https://<issuer VM IP> or run infra/gcp/deploy.sh issuer');

const verifier = () => (rehearsal ? new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }) : verifierFromEnv('issuer', { ...process.env, ATTESTATION: 'confidential-space' }));
console.log(bold('Confidential Space demo') + dim(rehearsal ? ' (REHEARSAL: local issuer, MOCK attestation)' : ` (issuer ${issuerUrl}; MOCK AP4M rail, MOCK payouts)`));

let merchant: Merchant | undefined;
let exitCode = 0;
try {
  console.log(bold('\nMerchant: checking the issuer'));
  merchant = new Merchant({ merchantId, issuerUrl, verifier: verifier(), authPrivateKey: merchantPrivateKey, log: (m) => console.log(dim(`[merchant] ${m}`)) });
  const merchantUrl = await merchant.start();

  const sdk = new PrivatePayClient({
    issuerUrl,
    verifier: verifier(),
    wallet: new MockTopUpWallet(),
    caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
    onEvent: (e) => {
      if (e.type === 'topup-402') console.log(dim(`  [sdk] issuer 402: ${e.amountRlusd} RLUSD for ${e.tokens} tokens via ${e.scheme}. Agent signs the voucher.`));
    },
  });

  console.log(bold('\nAgent: checking the issuer'));
  const attested = await sdk.connect();
  const d = (attested.attestation as { details?: ConfidentialSpaceDetails }).details;
  if (d) {
    console.log(green('  Token verified against Google Cloud Attestation (RS256, Google JWKS).'));
    console.log(`  hwmodel ${d.hwmodel} · swname ${d.swname} ${d.swversion.join(',')} · dbgstat ${d.dbgstat} · support [${d.supportAttributes.join(', ')}]`);
    console.log(`  image ${d.imageDigest}`);
    console.log(`  instance ${d.instance ?? '?'} · token expires ${new Date(d.expiresAt).toISOString()}`);
  } else {
    console.log(green(`  Attestation verified (${attested.attestation.format}).`));
  }
  console.log(green(`  Nonce and key hash match. TLS key ${attested.tlsKey ? 'pinned' : 'NOT pinned'}.`));

  await new ResearchAgent({
    sdk,
    merchantUrl,
    reasoner: process.argv.includes('--gullible') ? new GullibleReasoner() : undefined,
    print: (l) => console.log(l.startsWith('\n') ? bold(l) : l),
  }).run();

  console.log(bold('\nMerchant side'));
  const claim = merchant.latestClaim;
  if (claim) {
    const ok = verifyClaim(claim, attested.claimKey);
    console.log(`  Latest claim: issuer owes ${claim.claim.merchantId} ${claim.claim.totalTokens} tokens (${claim.claim.totalRlusd} RLUSD), #${claim.claim.seq}. Signature vs attested key: ${ok ? green('valid') : red('INVALID')}`);
  }
  const reserves = await issuerTransport(attested)(`${issuerUrl}/reserves`).then((r) => r.json());
  const r = reserves.reserves;
  console.log(`  Reserves: outstanding ${r.outstandingTokens} ≤ funds held ${r.fundsHeldTokens} tokens: ${r.solvent ? green('solvent') : red('INSOLVENT')} (signed: ${verifyReserves(reserves, attested.claimKey) ? 'valid' : 'INVALID'})`);
} catch (e) {
  if (e instanceof AttestationError) {
    console.log(red(`  REFUSED: ${e.message}`));
    console.log('  Nothing was sent. No top-up, no payment.');
    exitCode = 2;
  } else {
    console.error(e);
    exitCode = 1;
  }
} finally {
  await merchant?.close();
  await local?.close();
}
process.exit(exitCode);
