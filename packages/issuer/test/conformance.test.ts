// x402 facilitator conformance: our issuer is the facilitator for the "blindtoken" scheme.
// /verify is read-only; /settle marks tokens spent and adds them to the merchant's tab.
//
// Rules come from three papers. These are our own tests against their rules, not an audit.
//   [USENIX'26] Wang, Yang, Chen, Ji, Payer. "When HTTP 402 Meets the Blockchain: Risks on
//               Emerging x402 Payments." USENIX Security 2026. arXiv 2607.19545. Rules SR1-SR8.
//   [Five]      Li, Wang, Wang. "Five Attacks on x402 Agentic Payment Protocol."
//               arXiv 2605.11781. Mitigations M1, M3, M5.
//   [FreeRide]  Ling et al. "Free-Riding the Agentic Web: A Systematic Security Analysis of
//               x402 Payments." arXiv 2605.30998. Flaw classes.
//
// Merchant-side rules (quote binding, cache headers, relay) live in
// packages/merchant/test/conformance.test.ts. docs/SECURITY-CONFORMANCE.md has the full table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAttestationProvider, b64u, fromB64u } from '@wraps/attestation';
import {
  TokenIssuer,
  blindTokens,
  finalizeTokens,
  generateIssuerKeys,
  serializeToken,
} from '@wraps/tokens';
import {
  IssuerCore,
  IssuerError,
  MockPayoutRail,
  MockTopUpRail,
  MockTopUpWallet,
  PayoutLine,
  PayoutRail,
  PayoutScheduler,
  RunningIssuer,
  TopUpRail,
  XrplEvmPayoutRail,
  capPayoutLines,
  isPlainRlusdTransfer,
  startIssuer,
  verifyTokenKeys,
} from '../src/index';

const DAY = 24 * 3600_000;
const wallet = new MockTopUpWallet();

/** A clock tests can move. */
function clock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function makeCore(opts: { now?: () => number; rail?: TopUpRail; tokenKeyLifetimeMs?: number; minTokenLifetimeMs?: number; maxBatch?: number } = {}) {
  return IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: opts.rail ?? new MockTopUpRail(), ...opts });
}

/** Pays a top-up quote with the mock wallet and returns n serialized tokens. */
async function mint(core: IssuerCore, n: number): Promise<string[]> {
  const pending = await blindTokens(core.publicKeys.token, n, core.name);
  const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(n)));
  return (await finalizeTokens(pending, responses.map(fromB64u))).map(serializeToken);
}

const reasons = async (core: IssuerCore, tokens: string[]) => (await core.verify(tokens)).results.map((r) => r.reason);

describe('SR1: proof must match the server-declared requirements [USENIX\'26]', () => {
  it('SR1: top-up payment for fewer tokens than requested is refused', async () => {
    const core = await makeCore();
    const pending = await blindTokens(core.publicKeys.token, 4, core.name);
    const payment = await wallet.pay(core.quote(2));
    await expect(core.issuePaid(pending.map((p) => b64u(p.request)), payment)).rejects.toThrow(/beyond funds/);
  });

  it('SR1: top-up payment to a different payee or for another quote is refused', async () => {
    const core = await makeCore();
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    const requests = pending.map((p) => b64u(p.request));
    const q = core.quote(1);
    const otherPayee = await wallet.pay({ ...q, payTo: 'mock:attacker' });
    await expect(core.issuePaid(requests, otherPayee)).rejects.toThrow(/different address/);
    const forOther = JSON.parse(Buffer.from(await wallet.pay(core.quote(1)), 'base64url').toString());
    const swapped = Buffer.from(JSON.stringify({ ...forOther, quoteId: q.quoteId })).toString('base64url');
    await expect(core.issuePaid(requests, swapped)).rejects.toThrow(/signature/);
  });
});

describe('SR2: authorization must be authentic under the intended signature model [USENIX\'26]', () => {
  it('SR2: a token with a forged (bit-flipped) RSA signature is refused', async () => {
    const core = await makeCore();
    const [t] = await mint(core, 1);
    const bytes = fromB64u(t);
    bytes[bytes.length - 5] ^= 1;
    expect(await reasons(core, [b64u(bytes)])).toEqual(['bad signature']);
    await expect(core.settle('m', [b64u(bytes)])).rejects.toMatchObject({ status: 409 });
  });

  it('SR2: a token signed by a key outside the attested key set is refused', async () => {
    const core = await makeCore();
    const sideKeys = await generateIssuerKeys();
    const pending = await blindTokens(sideKeys.publicKeyBytes, 1, core.name);
    const [t] = await finalizeTokens(pending, await new TokenIssuer(sideKeys, core.name).issue(pending.map((p) => p.request)));
    expect(await reasons(core, [serializeToken(t)])).toEqual(['bad signature']);
  });

  it('SR2: a top-up voucher with a bad payer signature is refused', async () => {
    const core = await makeCore();
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    const v = JSON.parse(Buffer.from(await wallet.pay(core.quote(1)), 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...v, amountTokens: 1000 })).toString('base64url');
    await expect(core.issuePaid(pending.map((p) => b64u(p.request)), forged)).rejects.toThrow(/bad voucher signature/);
  });
});

describe('SR3: expired authorization is invalid [USENIX\'26]', () => {
  it('SR3: expired token is refused', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY });
    const [t] = await mint(core, 1);
    expect(await reasons(core, [t])).toEqual([undefined]);
    c.advance(10 * DAY + 1);
    expect(await reasons(core, [t])).toEqual(['expired']);
    await expect(core.settle('m', [t])).rejects.toThrow(/expired/);
  });

  it('SR3: after key rotation the old key stays verifiable until its not-after', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY });
    const [old] = await mint(core, 1);
    const oldKey = core.publicKeys.token;
    c.advance(DAY);
    await core.rotateTokenKey();
    expect(core.publicKeys.token).not.toEqual(oldKey);
    const [fresh] = await mint(core, 1);
    expect(await reasons(core, [old, fresh])).toEqual([undefined, undefined]);
    c.advance(9 * DAY + 1); // old key past not-after, new key still valid
    expect(await reasons(core, [old, fresh])).toEqual(['expired', undefined]);
  });

  it('SR3: the issuer rotates when a client fetches keys and the current key is near its end', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY, minTokenLifetimeMs: 5 * DAY });
    const first = core.publicKeys.token;
    c.advance(6 * DAY);
    await core.attestation(new Uint8Array(32));
    expect(core.publicKeys.token).not.toEqual(first);
    const [t] = await mint(core, 1);
    c.advance(9 * DAY); // still inside the new key's 10-day window
    expect(await reasons(core, [t])).toEqual([undefined]);
  });

  it('SR3: requests blinded for a retired key are refused before the payment is redeemed', async () => {
    const core = await makeCore();
    const stale = await blindTokens(core.publicKeys.token, 1, core.name);
    await core.rotateTokenKey();
    const q = core.quote(1);
    const payment = await wallet.pay(q);
    await expect(core.issuePaid(stale.map((p) => b64u(p.request)), payment)).rejects.toMatchObject({ status: 409 });
    // The same payment still buys tokens once the client blinds for the current key.
    const fresh = await blindTokens(core.publicKeys.token, 1, core.name);
    expect(await core.issuePaid(fresh.map((p) => b64u(p.request)), payment)).toHaveLength(1);
  });

  it('SR3: attestation exposes the key id and not-after; the key list is signed by the attested claim key', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY });
    await core.rotateTokenKey();
    const att = await core.attestation(new Uint8Array(32));
    expect(att.tokenKeyNotAfter).toBe(c.now() + 10 * DAY);
    expect(att.publicKeys.token).toBe(b64u(core.publicKeys.token)); // old field unchanged in shape
    const keys = att.tokenKeys!;
    expect(keys.statement.keys).toHaveLength(2);
    expect(keys.statement.keys.find((k) => k.current)?.keyId).toBe(att.tokenKeyId);
    expect(verifyTokenKeys(keys, core.publicKeys.claim)).toBe(true);
    const tampered = { ...keys, statement: { ...keys.statement, keys: keys.statement.keys.map((k) => ({ ...k, notAfter: k.notAfter + DAY })) } };
    expect(verifyTokenKeys(tampered, core.publicKeys.claim)).toBe(false);
  });
});

describe('SR4: valid only when settled [USENIX\'26]', () => {
  it('SR4: /verify is read-only and does not settle; only /settle moves the tab', async () => {
    const core = await makeCore();
    const [t] = await mint(core, 1);
    expect((await core.verify([t])).valid).toBe(true);
    expect((await core.verify([t])).valid).toBe(true);
    expect(core.pendingPayouts()).toEqual([]);
    const claim = await core.settle('m-sr4', [t]);
    expect(claim.claim.totalTokens).toBe(1);
    expect((await core.verify([t])).valid).toBe(false);
  });

  it('SR4: the issuer signs tokens only after the top-up rail confirms the payment', async () => {
    const failing = new MockTopUpRail();
    let calls = 0;
    failing.redeem = async () => {
      calls++;
      throw new Error('transaction not found or not confirmed yet');
    };
    const core = await makeCore({ rail: failing });
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    const q = core.quote(1);
    await expect(core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(q))).rejects.toThrow(/not confirmed/);
    expect(calls).toBe(1);
    expect(core.reserves().reserves).toMatchObject({ fundsHeldTokens: 0, unspentIssuedTokens: 0 });
  });
});

describe('SR5: reject meaningless proofs; idempotency; freshness [USENIX\'26] + M1 [Five]', () => {
  it('SR5: zero, negative and fractional top-up quotes are refused', async () => {
    const core = await makeCore();
    for (const n of [0, -1, 1.5, NaN]) expect(() => core.quote(n)).toThrow(IssuerError);
  });

  it('SR5: empty and oversized token batches are refused', async () => {
    const core = await makeCore({ maxBatch: 3 });
    await expect(core.verify([])).rejects.toMatchObject({ status: 400 });
    await expect(core.settle('m', [])).rejects.toMatchObject({ status: 400 });
    await expect(core.verify(['a', 'b', 'c', 'd'])).rejects.toMatchObject({ status: 400 });
  });

  it('M1: malformed and non-canonical token encodings are refused', async () => {
    const core = await makeCore();
    const [t] = await mint(core, 1);
    const bytes = fromB64u(t);
    const trailing = b64u(new Uint8Array([...bytes, 0]));
    const truncated = b64u(bytes.slice(0, bytes.length - 1));
    const padded = Buffer.from(bytes).toString('base64'); // not base64url
    expect(await reasons(core, [trailing, truncated, padded, 'not-a-token', 42 as unknown as string])).toEqual(
      Array(5).fill('malformed'),
    );
    expect(await reasons(core, [t])).toEqual([undefined]); // the canonical form still works
  });

  it('SR5/M1: a duplicate payment ID is refused, in one batch and on replay (idempotent settle)', async () => {
    const core = await makeCore();
    const [a, b] = await mint(core, 2);
    expect(await reasons(core, [a, a])).toEqual([undefined, 'duplicate in request']);
    await core.settle('m-idem', [b]);
    await expect(core.settle('m-idem', [b])).rejects.toMatchObject({ status: 409 });
    expect(core.pendingPayouts().find((l) => l.merchantId === 'm-idem')?.amountTokens).toBe(1);
  });

  it('SR5: a stale top-up quote is refused', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now });
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    const payment = await wallet.pay(core.quote(1));
    c.advance(5 * 60_000 + 1);
    await expect(core.issuePaid(pending.map((p) => b64u(p.request)), payment)).rejects.toThrow(/expired/);
  });
});

describe('SR6: sponsored execution bounded by configurable caps [USENIX\'26]', () => {
  // Not applicable as written: the issuer sponsors no payer transactions. Payers pay their own
  // top-up gas. The closest equivalent is what the issuer itself spends: payout batches and fees.
  const lines: PayoutLine[] = [
    { merchantId: 'a', amountTokens: 30, amountRlusd: '3.00' },
    { merchantId: 'b', amountTokens: 30, amountRlusd: '3.00' },
    { merchantId: 'c', amountTokens: 30, amountRlusd: '3.00' },
  ];

  it('SR6: payout batch is capped by line count and total', () => {
    expect(capPayoutLines(lines, { maxLines: 2 }).map((l) => l.merchantId)).toEqual(['a', 'b']);
    const capped = capPayoutLines(lines, { maxBatchTokens: 45 });
    expect(capped.map((l) => [l.merchantId, l.amountTokens, l.amountRlusd])).toEqual([['a', 30, '3.00'], ['b', 15, '1.50']]);
  });

  it('SR6: the scheduler pays only up to the cap; the rest waits for the next batch', async () => {
    const core = await makeCore();
    const tokens = await mint(core, 6);
    await core.settle('m-cap-1', tokens.slice(0, 3));
    await core.settle('m-cap-2', tokens.slice(3));
    const job = new PayoutScheduler(core, new MockPayoutRail(() => {}), 1_000_000, { maxBatchTokens: 4 });
    expect((await job.runOnce()).reduce((s, l) => s + l.amountTokens, 0)).toBe(4);
    expect(core.reserves().reserves.unpaidTabsTokens).toBe(2);
    await job.runOnce();
    expect(core.reserves().reserves.unpaidTabsTokens).toBe(0);
  });

  it('SR6: a batch whose fee is above the cap is not sent and nothing is marked paid', async () => {
    const core = await makeCore();
    await core.settle('m-fee', await mint(core, 2));
    let sent = 0;
    const pricey: PayoutRail = { estimateFeeRlusd: async () => 5, payout: async (l) => (sent++, l.map((x) => ({ merchantId: x.merchantId, txRef: 'x' }))) };
    const job = new PayoutScheduler(core, pricey, 1_000_000, { maxFeeRlusd: 1 });
    await expect(job.runOnce()).rejects.toThrow(/above the cap/);
    expect(sent).toBe(0);
    expect(core.reserves().reserves.unpaidTabsTokens).toBe(2);
  });

  it('SR6: one /issue call is capped (maxBatch), so one request cannot cause unbounded work', async () => {
    const core = await makeCore({ maxBatch: 5 });
    expect(() => core.quote(6)).toThrow(/too many/);
    await expect(core.signBlinded(Array(6).fill('x'))).rejects.toThrow(/batch too large/);
  });
});

describe('SR7: verification is redone before settling [USENIX\'26]', () => {
  it('SR7: a token that passed /verify but was spent since is refused at /settle', async () => {
    const core = await makeCore();
    const [t] = await mint(core, 1);
    expect((await core.verify([t])).valid).toBe(true);
    await core.settle('m-other', [t]);
    await expect(core.settle('m-sr7', [t])).rejects.toThrow(/already spent/);
  });

  it('SR7: a token that passed /verify but expired since is refused at /settle', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: DAY });
    const [t] = await mint(core, 1);
    expect((await core.verify([t])).valid).toBe(true);
    c.advance(DAY + 1);
    await expect(core.settle('m-sr7', [t])).rejects.toThrow(/expired/);
  });
});

describe('SR8: settle only explicitly allowed, unambiguous on-chain semantics [USENIX\'26]', () => {
  // Not applicable as written: settling a blind token is a ledger update inside the issuer,
  // with no on-chain call. The closest equivalent is the issuer's own on-chain action, payouts:
  // only plain RLUSD transfer(address, amount) calls to registered merchant payout addresses.
  const TOKEN = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3';
  const PAY_A = '0x34a7142038cdd6946ecc8a231e49c45e62a7f562';
  const OTHER = '0x00000000000000000000000000000000000000aa';
  const rail = (send?: (tx: { data: string }) => Promise<string>) =>
    new XrplEvmPayoutRail({ token: TOKEN, payoutAddresses: { 'm-a': PAY_A }, send });

  it('SR8: payouts are plain RLUSD transfers to the registered address only', async () => {
    const sent: string[] = [];
    const out = await rail(async (tx) => (sent.push(tx.data), '0xhash')).payout([{ merchantId: 'm-a', amountTokens: 10, amountRlusd: '1.00' }]);
    expect(out).toEqual([{ merchantId: 'm-a', txRef: '0xhash' }]);
    expect(sent[0]).toBe('0xa9059cbb' + PAY_A.slice(2).padStart(64, '0') + (10n ** 18n).toString(16).padStart(64, '0'));
  });

  it('SR8: a merchant without a registered payout address is never paid on-chain', async () => {
    let sent = 0;
    await expect(rail(async () => (sent++, '0x')).payout([{ merchantId: 'm-unknown', amountTokens: 1, amountRlusd: '0.10' }])).rejects.toThrow(/no registered payout address/);
    expect(sent).toBe(0);
  });

  it('SR8: approve, transferFrom, extra calldata, native value, other contracts and other payees are refused', () => {
    const transfer = '0xa9059cbb' + PAY_A.slice(2).padStart(64, '0') + '1'.padStart(64, '0');
    const ok = { merchantId: 'm-a', to: TOKEN, data: transfer, value: '0x0' as const };
    expect(isPlainRlusdTransfer(ok, TOKEN, [PAY_A])).toBe(true);
    expect(isPlainRlusdTransfer({ ...ok, data: '0x095ea7b3' + transfer.slice(10) }, TOKEN, [PAY_A])).toBe(false); // approve
    expect(isPlainRlusdTransfer({ ...ok, data: '0x23b872dd' + transfer.slice(10) + '0'.repeat(64) }, TOKEN, [PAY_A])).toBe(false); // transferFrom
    expect(isPlainRlusdTransfer({ ...ok, data: transfer + 'deadbeef' }, TOKEN, [PAY_A])).toBe(false);
    expect(isPlainRlusdTransfer({ ...ok, value: '0x1' as '0x0' }, TOKEN, [PAY_A])).toBe(false);
    expect(isPlainRlusdTransfer({ ...ok, to: OTHER }, TOKEN, [PAY_A])).toBe(false);
    expect(isPlainRlusdTransfer(ok, TOKEN, [OTHER])).toBe(false);
    expect(isPlainRlusdTransfer({ ...ok, data: transfer.slice(0, -1) + '0' }, TOKEN, [PAY_A])).toBe(false); // zero amount
  });
});

describe('Flaw classes [FreeRide] at the issuer', () => {
  let issuer: RunningIssuer;
  beforeAll(async () => {
    issuer = await startIssuer({ merchantAuth: { developmentMode: true }, log: () => {}, payoutIntervalMs: 3_600_000 });
  });
  afterAll(() => issuer.close());

  it('FreeRide duplicate-settlement race: concurrent /settle of one token, exactly one wins', async () => {
    const [t] = await mint(issuer.core, 1);
    const post = (merchantId: string) =>
      fetch(`${issuer.url}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merchantId, tokens: [t] }) });
    const statuses = (await Promise.all(['a', 'b', 'c', 'd', 'e'].map(post))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });

  it('FreeRide allowance overdraft: the issuer never signs beyond funds held', async () => {
    const core = await makeCore();
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    await expect(core.signBlinded([b64u(pending[0].request)])).rejects.toThrow(/beyond funds/);
    expect(core.reserves().reserves.solvent).toBe(true);
  });

  it('SR3: GET /keys and /attestation responses expose key epochs over HTTP', async () => {
    const keys = await (await fetch(`${issuer.url}/keys`)).json();
    expect(keys.statement.keys[0]).toMatchObject({ current: true, notAfter: expect.any(Number) });
    const att = await (await fetch(`${issuer.url}/attestation?nonce=${'00'.repeat(32)}`)).json();
    expect(att.tokenKeyNotAfter).toBe(keys.statement.keys[0].notAfter);
  });
});

describe('SEC-03: idempotent settle and merchant-scoped status (cross-merchant double-serve)', () => {
  const Q1 = 'a'.repeat(32);
  const Q2 = 'b'.repeat(32);

  it('SEC-03: a repeat settle with the same merchant, quote and tokens returns the original claim and counts once', async () => {
    const core = await makeCore();
    const tokens = await mint(core, 2);
    const first = await core.settle('m-a', tokens, Q1);
    expect(await core.settle('m-a', tokens, Q1)).toEqual(first);
    expect(await core.settle('m-a', [...tokens].reverse(), Q1)).toEqual(first); // order does not matter
    expect(core.pendingPayouts()).toEqual([{ merchantId: 'm-a', amountTokens: 2, amountRlusd: '0.20' }]);
    expect(core.reserves().reserves.unspentIssuedTokens).toBe(0);
  });

  it('SEC-03: concurrent identical settles for one quote all return the one original claim', async () => {
    const core = await makeCore();
    const tokens = await mint(core, 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => core.settle('m-a', tokens, Q1)));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(core.pendingPayouts()[0].amountTokens).toBe(2);
  });

  it('SEC-03: a repeat settle on the same quote with different tokens is refused, and those tokens stay unspent', async () => {
    const core = await makeCore();
    const [a, b] = await mint(core, 2);
    await core.settle('m-a', [a], Q1);
    await expect(core.settle('m-a', [b], Q1)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already settled with other tokens/) });
    await expect(core.settle('m-a', [a, b], Q1)).rejects.toMatchObject({ status: 409 });
    expect(await reasons(core, [b])).toEqual([undefined]);
    // The same tokens on a new quote are a new payment, so they are refused as spent.
    await expect(core.settle('m-a', [a], Q2)).rejects.toThrow(/already spent/);
    expect(core.pendingPayouts()[0].amountTokens).toBe(1);
  });

  it('SEC-03: /settle/status answers settled-by-you, settled-by-other, unspent and expired', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY });
    const [mine, theirs, fresh, old] = await mint(core, 4);
    await core.settle('m-a', [mine], Q1);
    await core.settle('m-b', [theirs], Q1); // same quote ID string, other merchant
    expect(await core.settleStatus('m-a', Q1, [mine])).toBe('settled-by-you');
    expect(await core.settleStatus('m-a', Q1, [theirs])).toBe('settled-by-other');
    expect(await core.settleStatus('m-a', Q2, [mine])).toBe('settled-by-other'); // ours, but another quote
    expect(await core.settleStatus('m-b', Q1, [mine])).toBe('settled-by-other');
    expect(await core.settleStatus('m-a', Q1, [mine, fresh])).toBe('settled-by-other'); // not the settled set
    expect(await core.settleStatus('m-a', Q2, [fresh])).toBe('unspent');
    c.advance(10 * DAY + 1);
    expect(await core.settleStatus('m-a', Q2, [old])).toBe('expired');
    // Status is read-only: nothing moved.
    expect(await reasons(core, [fresh])).toEqual(['expired']);
    expect(core.pendingPayouts().map((l) => l.amountTokens)).toEqual([1, 1]);
  });

  it('SEC-03: a token settled and then expired still reports settled, and a repeat settle still returns the original claim', async () => {
    const c = clock();
    const core = await makeCore({ now: c.now, tokenKeyLifetimeMs: 10 * DAY });
    const [a, b] = await mint(core, 2);
    const claim = await core.settle('m-a', [a], Q1);
    await core.settle('m-b', [b], Q1);
    c.advance(10 * DAY + 1);
    expect(await reasons(core, [a])).toEqual(['expired']);
    expect(await core.settleStatus('m-a', Q1, [a])).toBe('settled-by-you');
    expect(await core.settleStatus('m-a', Q1, [b])).toBe('settled-by-other'); // spent before expired
    expect(await core.settle('m-a', [a], Q1)).toEqual(claim);
    expect(core.pendingPayouts().find((l) => l.merchantId === 'm-a')?.amountTokens).toBe(1);
  });

  it('SEC-03: /settle/status refuses malformed input and forged tokens instead of guessing', async () => {
    const core = await makeCore();
    const [t] = await mint(core, 1);
    const bytes = fromB64u(t);
    bytes[bytes.length - 1] ^= 1;
    await expect(core.settleStatus('m-a', Q1, [b64u(bytes)])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/bad signature/) });
    await expect(core.settleStatus('m-a', Q1, ['!!'])).rejects.toMatchObject({ status: 400 });
    await expect(core.settleStatus('m-a', Q1, [t, t])).rejects.toMatchObject({ status: 400 });
    await expect(core.settleStatus('m-a', '', [t])).rejects.toMatchObject({ status: 400 });
    await expect(core.settleStatus('', Q1, [t])).rejects.toMatchObject({ status: 400 });
    await expect(core.settle('m-a', [t], 'not a quote id!')).rejects.toMatchObject({ status: 400 });
  });

  it('SEC-03: /settle/status over HTTP never reveals the other merchant, its quote or its claim', async () => {
    const issuer = await startIssuer({ merchantAuth: { developmentMode: true }, log: () => {}, payoutIntervalMs: 3_600_000 });
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const [t] = await mint(issuer.core, 1);
      const quoteB = 'c0ffee'.repeat(5) + '00';
      const settled = await post('/settle', { merchantId: 'merchant-bravo', quoteId: quoteB, tokens: [t] });
      expect(settled.status).toBe(200);
      const repeat = await post('/settle', { merchantId: 'merchant-bravo', quoteId: quoteB, tokens: [t] });
      expect(await repeat.json()).toEqual(await settled.json()); // idempotent over HTTP too

      const asked = await post('/settle/status', { merchantId: 'merchant-alpha', quoteId: Q1, tokens: [t] });
      expect(asked.status).toBe(200);
      expect(asked.headers.get('cache-control')).toMatch(/no-store/);
      const text = await asked.text();
      expect(JSON.parse(text)).toEqual({ status: 'settled-by-other' });
      for (const secret of ['merchant-bravo', 'bravo', quoteB, 'claim', 'seq', 'total']) expect(text).not.toContain(secret);
      // The same answer whether the spender was another merchant or our own other quote.
      const own = await post('/settle/status', { merchantId: 'merchant-bravo', quoteId: Q1, tokens: [t] });
      expect(await own.json()).toEqual({ status: 'settled-by-other' });
      const ok = await post('/settle/status', { merchantId: 'merchant-bravo', quoteId: quoteB, tokens: [t] });
      expect(await ok.json()).toEqual({ status: 'settled-by-you' });
      // A different-token repeat on a settled quote is refused over HTTP.
      const [u] = await mint(issuer.core, 1);
      expect((await post('/settle', { merchantId: 'merchant-bravo', quoteId: quoteB, tokens: [u] })).status).toBe(409);
    } finally {
      await issuer.close();
    }
  });
});
