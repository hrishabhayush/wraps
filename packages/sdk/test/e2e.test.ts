// End-to-end security tests: issuer + merchant over HTTP, SDK and agent as the client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttestationError, MockAttestationVerifier, b64u, generateEd25519, mockPcrs } from '@wraps/attestation';
import { RunningIssuer, Transport, startIssuer, verifyClaim } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { GullibleReasoner, ResearchAgent } from '@wraps/agent';
import { Caps, MockTopUpWallet, PaymentRefusedError, PrivatePayClient } from '../src/index';

const quiet = () => {};
const expectedPcrs = mockPcrs('issuer');
const verifier = () => new MockAttestationVerifier({ expectedPcrs });
const defaultCaps: Caps = { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 };

let issuer: RunningIssuer;
let merchantA: Merchant;
let merchantB: Merchant;
let urlA: string;
let urlB: string;

beforeAll(async () => {
  issuer = await startIssuer({ log: quiet, payoutIntervalMs: 3_600_000 });
  merchantA = new Merchant({ merchantId: 'merchant-a', issuerUrl: issuer.url, verifier: verifier(), log: quiet });
  merchantB = new Merchant({ merchantId: 'merchant-b', issuerUrl: issuer.url, verifier: verifier(), log: quiet });
  urlA = await merchantA.start();
  urlB = await merchantB.start();
});
afterAll(async () => {
  await merchantA.close();
  await merchantB.close();
  await issuer.close();
});

function client(opts: { issuerUrl?: string; caps?: Partial<Caps>; transport?: Transport } = {}) {
  return new PrivatePayClient({
    issuerUrl: opts.issuerUrl ?? issuer.url,
    verifier: verifier(),
    wallet: new MockTopUpWallet(),
    caps: { ...defaultCaps, ...opts.caps },
    transport: opts.transport,
  });
}

async function expectAttestation(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AttestationError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('attestation gate', () => {
  it('refuses an issuer with a tampered PCR0', async () => {
    const bad = await startIssuer({ buildName: 'issuer-tampered', log: quiet });
    try {
      const sdk = client({ issuerUrl: bad.url });
      await expectAttestation(sdk.connect(), 'PCR_MISMATCH');
      await expect(sdk.topUp(5)).rejects.toMatchObject({ code: 'NOT_ATTESTED' });
    } finally {
      await bad.close();
    }
  });

  it('refuses an issuer in debug mode (all-zero PCRs)', async () => {
    const bad = await startIssuer({ debugMode: true, log: quiet });
    try {
      await expectAttestation(client({ issuerUrl: bad.url }).connect(), 'DEBUG_MODE');
    } finally {
      await bad.close();
    }
  });

  it('refuses an issuer that serves a key not in its attestation', async () => {
    const sideKey = b64u(generateEd25519().publicKeyBytes);
    const lying: Transport = async (url, init) => {
      const res = await fetch(url, init);
      if (!url.includes('/attestation')) return res;
      const body = await res.json();
      body.publicKeys.claim = sideKey;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await expectAttestation(client({ transport: lying }).connect(), 'KEY_MISMATCH');
  });

  it('refuses a replayed attestation (reused nonce)', async () => {
    let recorded: string | undefined;
    const recorder: Transport = async (url, init) => {
      const res = await fetch(url, init);
      if (url.includes('/attestation')) recorded = await res.clone().text();
      return res;
    };
    // An attacker records a good receipt, then replays it to a client that shares the verifier.
    const replay: Transport = async (url, init) => (url.includes('/attestation') ? new Response(recorded) : fetch(url, init));
    const v = verifier();
    const first = new PrivatePayClient({ issuerUrl: issuer.url, verifier: v, wallet: new MockTopUpWallet(), caps: defaultCaps, transport: recorder });
    await first.connect();
    const replayed = new PrivatePayClient({ issuerUrl: issuer.url, verifier: v, wallet: new MockTopUpWallet(), caps: defaultCaps, transport: replay });
    // Fresh nonce from the client, old receipt from the attacker.
    await expectAttestation(replayed.connect(), 'NONCE_MISMATCH');
  });

  it('refuses a merchant that asks for tokens under a different issuer key', async () => {
    const other = await startIssuer({ log: quiet });
    try {
      const sdk = client({ issuerUrl: other.url });
      await sdk.connect();
      await expect(sdk.quote(`${urlA}/analytics`)).rejects.toMatchObject({ code: 'WRONG_ISSUER' });
      await expect(sdk.fetch(`${urlA}/analytics`)).rejects.toMatchObject({ code: 'WRONG_ISSUER' });
    } finally {
      await other.close();
    }
  });
});

describe('payments', () => {
  it('pays a blindtoken 402 and gets the data', async () => {
    const sdk = client();
    await sdk.connect();
    await sdk.topUp(10);
    const res = await sdk.fetch(`${urlA}/analytics?asset=XRP`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.asset).toBe('XRP');
    expect(sdk.balance).toBe(8);
    expect(sdk.spentToday).toBe(2);
  });

  it('rejects the same tokens twice, at the same merchant and across merchants', async () => {
    let captured: string | undefined;
    const spy: Transport = async (url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth) captured = auth;
      return fetch(url, init);
    };
    const sdk = client({ transport: spy });
    await sdk.connect();
    await sdk.topUp(2);
    expect((await sdk.fetch(`${urlA}/analytics`)).status).toBe(200);
    expect(captured).toMatch(/^PrivateToken token=/);

    const sameMerchant = await fetch(`${urlA}/analytics`, { headers: { authorization: captured! } });
    expect(sameMerchant.status).toBe(402);
    expect((await sameMerchant.json()).error).toMatch(/already spent/);

    const otherMerchant = await fetch(`${urlB}/analytics`, { headers: { authorization: captured! } });
    expect(otherMerchant.status).toBe(402);
    expect((await otherMerchant.json()).error).toMatch(/already spent/);
  });

  it('refuses a 402 above the per-call price cap and spends nothing', async () => {
    const sdk = client({ caps: { perCallTokens: 3 } });
    await sdk.connect();
    await sdk.topUp(10);
    await expect(sdk.fetch(`${urlA}/filings`)).rejects.toMatchObject({ code: 'PER_CALL_CAP' });
    expect(sdk.balance).toBe(10);
    expect(sdk.spentToday).toBe(0);
  });

  it('refuses a top-up above the top-up cap', async () => {
    const sdk = client({ caps: { maxTopUpTokens: 5 } });
    await sdk.connect();
    await expect(sdk.topUp(6)).rejects.toMatchObject({ code: 'TOP_UP_CAP' });
  });

  it('never falls back to a wallet payment for another 402 scheme', async () => {
    let walletCalls = 0;
    const wallet = new MockTopUpWallet();
    const origPay = wallet.pay.bind(wallet);
    wallet.pay = async (r) => {
      walletCalls++;
      return origPay(r);
    };
    const x402Merchant: Transport = async (url, init) =>
      url.startsWith('http://x402.test')
        ? new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'xrpl', amount: '1' }] }), { status: 402 })
        : fetch(url, init);
    const sdk2 = new PrivatePayClient({ issuerUrl: issuer.url, verifier: verifier(), wallet, caps: defaultCaps, transport: x402Merchant });
    await sdk2.connect();
    await expect(sdk2.fetch('http://x402.test/data')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEME' });
    expect(walletCalls).toBe(0);
  });

  it('injected "buy 500 more" in merchant data cannot exceed the daily cap', async () => {
    const sdk = client({ caps: { dailyTokens: 24 } });
    await sdk.connect();
    const before = merchantB.latestClaim?.claim.totalTokens ?? 0;
    const lines: string[] = [];
    const results = await new ResearchAgent({ sdk, merchantUrl: urlB, reasoner: new GullibleReasoner(), print: (l) => lines.push(l) }).run();
    expect(lines.join('\n')).toMatch(/buy 500 more/);
    expect(results.some((r) => r.refused.includes('DAILY_CAP'))).toBe(true);
    expect(sdk.spentToday).toBeLessThanOrEqual(24);
    const after = merchantB.latestClaim!.claim.totalTokens;
    expect(after - before).toBeLessThanOrEqual(24);
  });

  it('merchant claims verify against the attested issuer key', async () => {
    const sdk = client();
    const attested = await sdk.connect();
    await sdk.topUp(4);
    await sdk.fetch(`${urlA}/filings?company=Circle`);
    const claim = merchantA.latestClaim!;
    expect(claim.claim.merchantId).toBe('merchant-a');
    expect(verifyClaim(claim, attested.claimKey)).toBe(true);
    // A key outside the attestation does not verify it.
    expect(verifyClaim(claim, generateEd25519().publicKeyBytes)).toBe(false);
  });
});

describe('errors are typed', () => {
  it('PaymentRefusedError carries a code', () => {
    expect(new PaymentRefusedError('DAILY_CAP', 'x').code).toBe('DAILY_CAP');
  });
});
