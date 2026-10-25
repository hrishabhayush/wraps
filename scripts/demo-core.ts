// npm run demo:core [-- --tamper | --debug-mode | --gullible]
// Starts the issuer and the merchant, then runs the agent end to end. All in one terminal.
//   --tamper      the issuer runs a modified build (different PCR0). The agent must refuse it.
//   --debug-mode  the issuer runs in debug mode (all-zero PCRs). The agent must refuse it.
//   --gullible    the agent's reasoning obeys "buy 500 more" text in merchant data. The caps must hold.
import { AttestationError, MockAttestationVerifier, b64u, generateEd25519, mockPcrs } from '@wraps/attestation';
import { startIssuer, verifyClaim, verifyReserves } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { GullibleReasoner, ResearchAgent } from '@wraps/agent';

const args = new Set(process.argv.slice(2));
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const expectedPcrs = mockPcrs('issuer');
console.log(bold('Core payment flow demo') + dim(' (MOCK attestation, MOCK AP4M rail, MOCK payouts)\n'));
const merchantId = 'merchant-research-data';
const merchantAuthKey = generateEd25519();

// The merchant must trust the real issuer, so it starts against an honest one. A tampered issuer
// is started separately for the agent to probe.
const issuer = await startIssuer({
  log: (m) => console.log(dim(`[issuer] ${m}`)),
  payoutIntervalMs: 3_600_000,
  merchantAuth: { publicKeys: { [merchantId]: b64u(merchantAuthKey.publicKeyBytes) } },
});
const merchant = new Merchant({
  merchantId,
  issuerUrl: issuer.url,
  verifier: new MockAttestationVerifier({ expectedPcrs }),
  authPrivateKey: merchantAuthKey.privateKey,
  log: (m) => console.log(dim(`[merchant] ${m}`)),
});
const merchantUrl = await merchant.start();

let agentIssuerUrl = issuer.url;
let badIssuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
if (args.has('--tamper') || args.has('--debug-mode')) {
  badIssuer = await startIssuer({
    buildName: args.has('--tamper') ? 'issuer-tampered' : 'issuer',
    debugMode: args.has('--debug-mode'),
    log: (m) => console.log(dim(`[bad issuer] ${m}`)),
  });
  agentIssuerUrl = badIssuer.url;
  console.log(red(`Agent is pointed at a ${args.has('--tamper') ? 'MODIFIED' : 'DEBUG-MODE'} issuer.`));
}

const sdk = new PrivatePayClient({
  issuerUrl: agentIssuerUrl,
  verifier: new MockAttestationVerifier({ expectedPcrs }),
  wallet: new MockTopUpWallet(),
  caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
  onEvent: (e) => {
    if (e.type === 'topup-402') console.log(dim(`  [sdk] issuer 402: ${e.amountRlusd} RLUSD for ${e.tokens} tokens via ${e.scheme}. Agent signs the voucher.`));
  },
});

let exitCode = 0;
try {
  console.log(bold('\nAgent: checking the issuer enclave'));
  const attested = await sdk.connect();
  console.log(green(`  Attestation verified. PCR0 ${attested.attestation.measurement.slice(0, 16)}… keys match, nonce fresh. Merchant auth reported ${attested.merchantAuth}.`));

  await new ResearchAgent({
    sdk,
    merchantUrl,
    reasoner: args.has('--gullible') ? new GullibleReasoner() : undefined,
    print: (l) => console.log(l.startsWith('\n') ? bold(l) : l),
  }).run();

  console.log(bold('\nMerchant side'));
  const claim = merchant.latestClaim;
  if (claim) {
    const ok = verifyClaim(claim, attested.claimKey);
    console.log(`  Latest claim: issuer owes ${claim.claim.merchantId} ${claim.claim.totalTokens} tokens (${claim.claim.totalRlusd} RLUSD), #${claim.claim.seq}. Signature vs attested key: ${ok ? green('valid') : red('INVALID')}`);
  }
  const reserves = await fetch(`${issuer.url}/reserves`).then((r) => r.json());
  const r = reserves.reserves;
  console.log(`  Reserves: outstanding ${r.outstandingTokens} ≤ funds held ${r.fundsHeldTokens} tokens: ${r.solvent ? green('solvent') : red('INSOLVENT')} (signed: ${verifyReserves(reserves, attested.claimKey) ? 'valid' : 'INVALID'})`);
  console.log(bold('\nPayout batch'));
  const lines = await issuer.payouts.runOnce();
  if (lines.length === 0) console.log('  Nothing to pay.');
} catch (e) {
  if (e instanceof AttestationError) {
    console.log(red(`  REFUSED: ${e.message}`));
    console.log('  The agent stops. No top-up, no payment.');
  } else {
    console.error(e);
    exitCode = 1;
  }
} finally {
  await merchant.close();
  await issuer.close();
  await badIssuer?.close();
}
process.exit(exitCode);
