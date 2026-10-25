import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAttestationVerifier, b64u, mockPcrs } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken } from '@wraps/tokens';
import {
  IssuerError,
  MockPayoutRail,
  MockTopUpWallet,
  PAYMENT_HEADER,
  PaymentRequiredBody,
  RunningIssuer,
  fetchAttestedIssuer,
  startIssuer,
  verifyClaim,
  verifyReserves,
  PayoutScheduler,
} from '../src/index';

let issuer: RunningIssuer;
const wallet = new MockTopUpWallet();
const quiet = () => {};

beforeAll(async () => {
  issuer = await startIssuer({ log: quiet, payoutIntervalMs: 3_600_000 });
});
afterAll(() => issuer.close());

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${issuer.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Full top-up over HTTP: 402, pay, retry, finalize. */
async function buyTokens(n: number) {
  const pending = await blindTokens(issuer.core.publicKeys.token, n, issuer.core.name);
  const requests = pending.map((p) => b64u(p.request));
  const first = await post('/issue', { requests });
  expect(first.status).toBe(402);
  const payment = await wallet.pay((first.body as PaymentRequiredBody).accepts[0]);
  const paid = await post('/issue', { requests }, { [PAYMENT_HEADER]: payment });
  expect(paid.status).toBe(200);
  const tokens = await finalizeTokens(
    pending,
    paid.body.responses.map((r: string) => new Uint8Array(Buffer.from(r, 'base64url'))),
  );
  return tokens.map(serializeToken);
}

describe('issuer', () => {
  it('sells tokens without x402: /quote, pay, then /issue with the payment in the body', async () => {
    const q = await post('/quote', { tokens: 2 });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ tokens: 2, amountRlusd: '0.20' });
    const pending = await blindTokens(issuer.core.publicKeys.token, 2, issuer.core.name);
    const requests = pending.map((p) => b64u(p.request));
    const payment = JSON.parse(Buffer.from(await wallet.pay(q.body), 'base64url').toString());
    const paid = await post('/issue', { requests, payment });
    expect(paid.status).toBe(200);
    expect(paid.body.responses).toHaveLength(2);
    expect((await post('/issue', { requests, payment })).status).toBe(402); // quote used up
  });

  it('refuses to quote more than one /issue call can sign', async () => {
    expect((await post('/quote', { tokens: 201 })).status).toBe(400);
    expect((await post('/quote', { tokens: 0 })).status).toBe(400);
  });

  it('answers /issue with a 402 that names the price', async () => {
    const pending = await blindTokens(issuer.core.publicKeys.token, 3, issuer.core.name);
    const r = await post('/issue', { requests: pending.map((p) => b64u(p.request)) });
    expect(r.status).toBe(402);
    expect(r.body.accepts[0]).toMatchObject({ tokens: 3, amountRlusd: '0.30', asset: 'RLUSD' });
  });

  it('refuses to issue more tokens than the payment covers', async () => {
    const pending = await blindTokens(issuer.core.publicKeys.token, 4, issuer.core.name);
    const requests = pending.map((p) => b64u(p.request));
    const quote = (await post('/issue', { requests: requests.slice(0, 2) })).body.accepts[0];
    const payment = await wallet.pay(quote);
    const r = await post('/issue', { requests }, { [PAYMENT_HEADER]: payment });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/beyond funds/);
  });

  it('refuses to sign beyond funds held, even when called directly', async () => {
    const pending = await blindTokens(issuer.core.publicKeys.token, 1, issuer.core.name);
    const before = issuer.core.reserves().reserves;
    const headroom = before.fundsHeldTokens - before.outstandingTokens;
    const many = Array.from({ length: headroom + 1 }, () => b64u(pending[0].request));
    await expect(issuer.core.signBlinded(many)).rejects.toBeInstanceOf(IssuerError);
    expect(issuer.core.reserves().reserves.solvent).toBe(true);
  });

  it('refuses a replayed voucher', async () => {
    const pending = await blindTokens(issuer.core.publicKeys.token, 1, issuer.core.name);
    const requests = pending.map((p) => b64u(p.request));
    const quote = (await post('/issue', { requests })).body.accepts[0];
    const payment = await wallet.pay(quote);
    expect((await post('/issue', { requests }, { [PAYMENT_HEADER]: payment })).status).toBe(200);
    expect((await post('/issue', { requests }, { [PAYMENT_HEADER]: payment })).status).toBe(402);
  });

  it('verify is read-only, settle spends once across all merchants', async () => {
    const [t1, t2] = await buyTokens(2);
    expect((await post('/verify', { tokens: [t1] })).body.valid).toBe(true);
    expect((await post('/verify', { tokens: [t1] })).body.valid).toBe(true);

    expect((await post('/settle', { merchantId: 'm-a', tokens: [t1] })).status).toBe(200);
    // Same merchant again.
    const again = await post('/settle', { merchantId: 'm-a', tokens: [t1] });
    expect(again.status).toBe(409);
    // A different merchant.
    expect((await post('/settle', { merchantId: 'm-b', tokens: [t1] })).status).toBe(409);
    expect((await post('/verify', { tokens: [t1] })).body.results[0].reason).toBe('already spent');
    // The same token twice in one request.
    expect((await post('/settle', { merchantId: 'm-b', tokens: [t2, t2] })).status).toBe(409);
    expect((await post('/settle', { merchantId: 'm-b', tokens: [t2] })).status).toBe(200);
  });

  it('concurrent settles of one token: exactly one wins', async () => {
    const [t] = await buyTokens(1);
    const results = await Promise.all([
      post('/settle', { merchantId: 'm-a', tokens: [t] }),
      post('/settle', { merchantId: 'm-b', tokens: [t] }),
      post('/settle', { merchantId: 'm-c', tokens: [t] }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('claims are running totals that verify against the attested claim key', async () => {
    const attested = await fetchAttestedIssuer(issuer.url, new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }));
    const tokens = await buyTokens(3);
    const c1 = (await post('/settle', { merchantId: 'm-claims', tokens: tokens.slice(0, 1) })).body;
    const c2 = (await post('/settle', { merchantId: 'm-claims', tokens: tokens.slice(1) })).body;
    expect(c1.claim.totalTokens).toBe(1);
    expect(c2.claim.totalTokens).toBe(3);
    expect(c2.claim.seq).toBe(2);
    expect(verifyClaim(c2, attested.claimKey)).toBe(true);
    expect(verifyClaim({ ...c2, claim: { ...c2.claim, totalTokens: 300 } }, attested.claimKey)).toBe(false);

    const res = await fetch(`${issuer.url}/reserves`).then((r) => r.json());
    expect(verifyReserves(res, attested.claimKey)).toBe(true);
    expect(res.reserves.outstandingTokens).toBeLessThanOrEqual(res.reserves.fundsHeldTokens);
  });

  it('payout batch pays unpaid tabs and keeps reserves solvent', async () => {
    const logs: string[] = [];
    const job = new PayoutScheduler(issuer.core, new MockPayoutRail((m) => logs.push(m)), 1_000_000);
    const before = issuer.core.reserves().reserves;
    const lines = await job.runOnce();
    expect(lines.length).toBeGreaterThan(0);
    const after = issuer.core.reserves().reserves;
    expect(after.unpaidTabsTokens).toBe(0);
    expect(after.fundsHeldTokens).toBe(before.fundsHeldTokens - before.unpaidTabsTokens);
    expect(after.solvent).toBe(true);
    expect(logs.join('\n')).toMatch(/RLUSD → m-claims/);
  });
});
