import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64u } from '@wraps/attestation';
import { blindTokens } from '@wraps/tokens';
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { MockTopUpRail, MockTopUpWallet, PaymentRequirement, RunningIssuer, TopUpRail, fetchAttestedIssuer, startIssuer } from '../src/index';

// A second rail that records what it redeemed, standing in for XRPL EVM.
class FakeChainRail extends EventEmitter implements TopUpRail {
  readonly scheme = 'fake-chain-transfer';
  readonly network = 'fake-chain';
  readonly payTo = '0x34A7142038CDd6946ecc8a231e49c45E62A7F562';
  redeemed: string[] = [];
  async redeem(paymentHeader: string, requirement: PaymentRequirement) {
    const p = JSON.parse(Buffer.from(paymentHeader, 'base64url').toString('utf8'));
    if (p.quoteId !== requirement.quoteId || !p.txHash) throw new Error('bad payment');
    this.redeemed.push(p.txHash);
    return { amountTokens: requirement.tokens, txRef: p.txHash };
  }
}

let issuer: RunningIssuer;
const chain = new FakeChainRail();

beforeAll(async () => {
  issuer = await startIssuer({
    rail: new MockTopUpRail(),
    extraRails: [chain],
    walletAddress: chain.payTo,
    merchantAuth: { developmentMode: true },
    log: () => {},
    payoutIntervalMs: 3_600_000,
  });
});
afterAll(() => issuer.close());

async function post(path: string, body: unknown) {
  const res = await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

async function requests(n: number) {
  const pending = await blindTokens(issuer.core.publicKeys.token, n, issuer.core.name);
  return pending.map((p) => b64u(p.request));
}

describe('issuer with two top-up rails', () => {
  it('offers one quote per rail in the 402, default rail first', async () => {
    const r = await post('/issue', { requests: await requests(1) });
    expect(r.status).toBe(402);
    expect(r.body.accepts.map((a: PaymentRequirement) => a.scheme)).toEqual(['mock-ap4m-voucher', 'fake-chain-transfer']);
    expect(r.body.accepts[1].payTo).toBe(chain.payTo);
  });

  it('quotes the default rail unless a scheme is named', async () => {
    expect((await post('/quote', { tokens: 1 })).body.scheme).toBe('mock-ap4m-voucher');
    expect((await post('/quote', { tokens: 1, scheme: 'fake-chain-transfer' })).body.scheme).toBe('fake-chain-transfer');
    expect((await post('/quote', { tokens: 1, scheme: 'nope' })).status).toBe(400);
  });

  it('redeems each quote on the rail that made it', async () => {
    const q = (await post('/quote', { tokens: 2, scheme: 'fake-chain-transfer' })).body;
    const paid = await post('/issue', { requests: await requests(2), payment: { quoteId: q.quoteId, txHash: '0xabc' } });
    expect(paid.status).toBe(200);
    expect(paid.body.responses).toHaveLength(2);
    expect(chain.redeemed).toEqual(['0xabc']);

    // The mock rail still works beside it.
    const m = (await post('/quote', { tokens: 1 })).body;
    const voucher = JSON.parse(Buffer.from(await new MockTopUpWallet().pay(m), 'base64url').toString());
    expect((await post('/issue', { requests: await requests(1), payment: voucher })).status).toBe(200);
  });

  it('will not redeem a chain quote with a mock voucher', async () => {
    const q = (await post('/quote', { tokens: 1, scheme: 'fake-chain-transfer' })).body;
    // A mock voucher (no txHash) pointed at the chain quote: the chain rail must refuse it.
    const voucher = JSON.parse(Buffer.from(await new MockTopUpWallet().pay({ ...q, scheme: 'mock-ap4m-voucher' }), 'base64url').toString());
    expect((await post('/issue', { requests: await requests(1), payment: voucher })).status).toBe(402);
  });

  it('names its own wallet in the attestation', async () => {
    const attested = await fetchAttestedIssuer(issuer.url, new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') }));
    expect(attested.walletAddress).toBe(chain.payTo.toLowerCase());
  });
});
