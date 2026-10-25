// SEC-02: the SDK reserves tokens for a payment instead of deleting them. A definite refusal
// restores them; an ambiguous outcome keeps them reserved until resolved. A token is never
// spent twice and never silently lost.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { RunningIssuer, Transport, startIssuer } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { InsufficientTokensError, MockTopUpWallet, PaymentPendingError, PrivatePayClient, SdkEvent } from '../src/index';

const quiet = () => {};
const verifier = () => new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') });

let issuer: RunningIssuer;
let merchant: Merchant;
let url: string;
const clock = { t: Date.now() };

beforeAll(async () => {
  issuer = await startIssuer({ merchantAuth: { developmentMode: true }, log: quiet, payoutIntervalMs: 3_600_000 });
  merchant = new Merchant({ merchantId: 'm-sdk-res', issuerUrl: issuer.url, verifier: verifier(), log: quiet, now: () => clock.t, quoteTtlMs: 60_000 });
  url = await merchant.start();
});
afterAll(async () => {
  await merchant.close();
  await issuer.close();
});

const isPaid = (init?: RequestInit) => new Headers(init?.headers).has('authorization');

async function client(transport: Transport, events: SdkEvent[] = []) {
  const sdk = new PrivatePayClient({
    issuerUrl: issuer.url,
    verifier: verifier(),
    wallet: new MockTopUpWallet(),
    caps: { perCallTokens: 5, dailyTokens: 50, maxTopUpTokens: 20 },
    transport,
    pendingRetry: { retries: 1, delayMs: 0 },
    onEvent: (e) => events.push(e),
  });
  await sdk.connect();
  await sdk.topUp(2);
  return sdk;
}

describe('SDK token reservation', () => {
  it('SEC-02: a quote that expires before payment gets a 402; the tokens are restored and spend again', async () => {
    let expire = true;
    const slow: Transport = async (u, init) => {
      if (isPaid(init) && expire) {
        expire = false;
        clock.t += 60_001; // the quote expires while the payment is on its way
      }
      return fetch(u, init);
    };
    const events: SdkEvent[] = [];
    const sdk = await client(slow, events);
    const r1 = await sdk.fetch(`${url}/analytics`);
    expect(r1.status).toBe(402);
    expect((await r1.json()).error).toMatch(/quote expired/);
    expect(sdk.balance).toBe(2);
    expect(sdk.reservedTokens).toBe(0);
    expect(sdk.spentToday).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'restored', tokens: 2 }));

    const r2 = await sdk.fetch(`${url}/analytics`);
    expect(r2.status).toBe(200);
    expect(sdk.balance).toBe(0);
    expect(sdk.spentToday).toBe(2);
  });

  it('SEC-02: a network error keeps the tokens reserved, not reusable, until resolvePending settles them', async () => {
    let down = true;
    const flaky: Transport = async (u, init) => {
      if (isPaid(init) && down) throw new Error('ECONNRESET');
      return fetch(u, init);
    };
    const sdk = await client(flaky);
    const err = await sdk.fetch(`${url}/analytics`).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentPendingError);
    expect(sdk.balance).toBe(0);
    expect(sdk.reservedTokens).toBe(2);
    expect(sdk.pendingPayments).toEqual([{ reservationId: err.reservationId, url: `${url}/analytics`, tokens: 2 }]);

    // Reserved tokens are not handed to another call.
    await expect(sdk.fetch(`${url}/analytics`)).rejects.toBeInstanceOf(InsufficientTokensError);

    down = false;
    const res = await sdk.resolvePending(err.reservationId);
    expect(res.status).toBe(200);
    expect(sdk.reservedTokens).toBe(0);
    expect(sdk.balance).toBe(0);
    expect(sdk.spentToday).toBe(2);
  });

  it('SEC-02: the merchant served but the answer was lost; the retry is refused and the spent tokens are reported, not restored', async () => {
    let lose = true;
    const lossy: Transport = async (u, init) => {
      const r = await fetch(u, init);
      if (isPaid(init) && lose) {
        lose = false;
        throw new Error('socket hang up'); // the merchant served, the agent never saw it
      }
      return r;
    };
    const events: SdkEvent[] = [];
    const sdk = await client(lossy, events);
    const res = await sdk.fetch(`${url}/analytics`);
    expect(res.status).toBe(402); // the automatic retry hits a used quote
    expect(sdk.balance).toBe(0); // spent tokens are never put back for reuse
    expect(sdk.reservedTokens).toBe(0);
    expect(sdk.spentToday).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'spent-unserved', tokens: 2, status: 402 }));
    expect(events.some((e) => e.type === 'restored')).toBe(false);
  });

  it('SEC-02: a merchant whose settle was ambiguous answers 503 pending; the SDK retries with the same tokens and is served once', async () => {
    let first = true;
    const merchantTransport: Transport = async (u, init) => {
      if (u.endsWith('/settle') && first) {
        first = false;
        throw new Error('request timed out');
      }
      return fetch(u, init);
    };
    const m = new Merchant({ merchantId: 'm-sdk-amb', issuerUrl: issuer.url, verifier: verifier(), log: quiet, transport: merchantTransport });
    const base = await m.start();
    try {
      const statuses: number[] = [];
      const sdk = await client(async (u, init) => {
        const r = await fetch(u, init);
        if (isPaid(init)) statuses.push(r.status);
        return r;
      });
      const res = await sdk.fetch(`${base}/analytics`);
      expect(res.status).toBe(200);
      expect(statuses).toEqual([503, 200]);
      expect(sdk.balance).toBe(0);
      expect(sdk.reservedTokens).toBe(0);
      expect(sdk.spentToday).toBe(2);
      expect(m.latestClaim?.claim.totalTokens).toBe(2);
    } finally {
      await m.close();
    }
  });

  it('SEC-02: concurrent resolvePending calls for one payment send it once at a time', async () => {
    let down = true;
    const flaky: Transport = async (u, init) => {
      if (isPaid(init) && down) throw new Error('ECONNRESET');
      return fetch(u, init);
    };
    const sdk = await client(flaky);
    const err = await sdk.fetch(`${url}/analytics`).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentPendingError);
    down = false;
    const results = await Promise.allSettled([sdk.resolvePending(err.reservationId), sdk.resolvePending(err.reservationId)]);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(sdk.reservedTokens).toBe(0);
    expect(sdk.balance).toBe(0);
  });
});
