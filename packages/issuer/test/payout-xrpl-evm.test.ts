// ISS-06: RLUSD merchant payouts on XRPL EVM, against a fake node at the JSON-RPC transport level.
// Real signed transactions are parsed and their sender recovered. See payout-anvil.test.ts for
// the same flow against a local EVM (anvil) with a deployed ERC-20.
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction } from 'viem';
import { MockAttestationProvider, b64u, fromB64u } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken } from '@wraps/tokens';
import {
  IssuerCore,
  MerchantRegistry,
  MockTopUpRail,
  MockTopUpWallet,
  PayoutLine,
  PayoutScheduler,
  XrplEvmPayoutRail,
  XrplEvmPayoutRailOptions,
  payoutConfigFromEnv,
  startIssuer,
  toUnits,
  verifyPayoutRecord,
} from '../src/index';
import { FakeEvm } from './helpers/fake-evm';

const TOKEN = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3';
const PAY_A = '0x34a7142038cdd6946ecc8a231e49c45e62a7f562';
const PAY_B = '0x00000000000000000000000000000000000000b2';
const RLUSD = (s: string) => toUnits(s, 18);
const wallet = new MockTopUpWallet();

function setup(o: Partial<XrplEvmPayoutRailOptions> & { fund?: string } = {}) {
  const key = generatePrivateKey();
  const issuer = privateKeyToAccount(key).address;
  const chain = new FakeEvm(TOKEN);
  chain.fund(issuer, RLUSD(o.fund ?? '1000'));
  const logs: string[] = [];
  const rail = new XrplEvmPayoutRail({
    token: TOKEN,
    payoutAddresses: { 'm-a': PAY_A, 'm-b': PAY_B },
    privateKey: key,
    fetch: chain.fetch,
    receiptTimeoutMs: 50,
    pollMs: 5,
    log: (m) => logs.push(m),
    ...o,
  });
  return { key, issuer, chain, rail, logs };
}

const line = (merchantId: string, rlusd: string): PayoutLine => ({ merchantId, amountTokens: Math.round(Number(rlusd) * 10), amountRlusd: rlusd });

async function coreWithTabs(tabs: Record<string, number>) {
  const core = await IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: new MockTopUpRail() });
  for (const [m, n] of Object.entries(tabs)) await settle(core, m, n);
  return core;
}

async function settle(core: IssuerCore, merchantId: string, n: number) {
  const pending = await blindTokens(core.publicKeys.token, n, core.name);
  const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(n)));
  const tokens = (await finalizeTokens(pending, responses.map(fromB64u))).map(serializeToken);
  return core.settle(merchantId, tokens);
}

const unpaid = (core: IssuerCore, m: string) => core.pendingPayouts().find((l) => l.merchantId === m)?.amountTokens ?? 0;

describe('XrplEvmPayoutRail: signing and sending', () => {
  it('sends plain RLUSD transfers to the registered addresses, with consecutive nonces on chain 1449000', async () => {
    const { chain, rail, issuer } = setup();
    const out = await rail.payout([line('m-a', '1.50'), line('m-b', '2.00')]);
    expect(out.map((r) => r.merchantId)).toEqual(['m-a', 'm-b']);
    expect(out.every((r) => /^0x[0-9a-f]{64}$/.test(r.txRef))).toBe(true);
    const txs = chain.sends.map((raw) => parseTransaction(raw));
    expect(txs.map((t) => t.to?.toLowerCase())).toEqual([TOKEN, TOKEN]);
    expect(txs.map((t) => t.value ?? 0n)).toEqual([0n, 0n]);
    expect(txs.map((t) => t.chainId)).toEqual([1449000, 1449000]);
    expect(txs.map((t) => t.nonce ?? 0)).toEqual([0, 1]);
    expect(txs[0].data).toBe('0xa9059cbb' + PAY_A.slice(2).padStart(64, '0') + RLUSD('1.5').toString(16).padStart(64, '0'));
    expect(chain.bal(PAY_A)).toBe(RLUSD('1.5'));
    expect(chain.bal(PAY_B)).toBe(RLUSD('2'));
    expect(chain.bal(issuer)).toBe(RLUSD('996.5'));
    expect(out[0]).toMatchObject({ amountTokens: 15, payTo: PAY_A, token: TOKEN, chainId: 1449000 });
  });

  it('refuses an RPC on another chain, and sends nothing', async () => {
    const { chain, rail } = setup();
    chain.chainId = 1;
    await expect(rail.payout([line('m-a', '1.00')])).rejects.toThrow(/chain 1/);
    expect(chain.sends).toHaveLength(0);
  });

  it('never puts the private key in logs, errors or the rail object', async () => {
    const { key, rail, logs, chain } = setup();
    chain.sendPlan = ['reject'];
    await rail.payout([line('m-a', '1.00'), line('nobody', '1.00')]).catch(() => {});
    const bare = key.slice(2);
    expect(logs.join('\n')).not.toContain(bare);
    expect(JSON.stringify(rail)).not.toContain(bare);
    expect(() => new XrplEvmPayoutRail({ token: TOKEN, payoutAddresses: {}, privateKey: key.slice(0, 40) })).toThrow(/^payout private key must be/);
    try {
      new XrplEvmPayoutRail({ token: TOKEN, payoutAddresses: {}, privateKey: key + 'zz' });
    } catch (e) {
      expect((e as Error).message).not.toContain(bare);
    }
  });
});

describe('XrplEvmPayoutRail: caps (SR6)', () => {
  it('a gas price above the cap sends nothing', async () => {
    const { chain, rail } = setup({ maxGasPriceWei: 10n ** 9n });
    chain.gasPrice = 2n * 10n ** 9n;
    await expect(rail.payout([line('m-a', '1.00')])).rejects.toThrow(/gas price .* above the cap/);
    expect(chain.sends).toHaveLength(0);
  });

  it('a transfer needing more gas than the cap is not sent', async () => {
    const { chain, rail } = setup({ maxGasPerTransfer: 40_000n });
    expect(await rail.payout([line('m-a', '1.00')])).toEqual([]);
    expect(chain.sends).toHaveLength(0);
  });

  it('every signed tx carries a gas limit at or below the cap', async () => {
    const { chain, rail } = setup({ maxGasPerTransfer: 55_000n });
    await rail.payout([line('m-a', '1.00')]);
    expect(parseTransaction(chain.sends[0]).gas).toBe(55_000n); // 50,000 × 1.2 capped at 55,000
  });

  it('the batch fee cap stops the batch; the rest waits', async () => {
    // 60,000 gas × 1 gwei = 0.00006 XRP per transfer; cap fits one.
    const { chain, rail } = setup({ maxBatchFeeWei: 70_000n * 10n ** 9n });
    const out = await rail.payout([line('m-a', '1.00'), line('m-b', '1.00')]);
    expect(out.map((r) => r.merchantId)).toEqual(['m-a']);
    expect(chain.sends).toHaveLength(1);
  });

  it('the scheduler refuses a batch whose fee estimate is above maxFeeRlusd; nothing is sent or marked paid', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { chain, rail } = setup({ maxGasPriceWei: 10n ** 15n });
    chain.gasPrice = 10n ** 13n; // 100k gas × 1e13 = 1 XRP ≈ 5 RLUSD at the price bound
    const job = new PayoutScheduler(core, rail, 1e9, { maxFeeRlusd: 1 });
    await expect(job.runOnce()).rejects.toThrow(/above the cap/);
    expect(chain.sends).toHaveLength(0);
    expect(unpaid(core, 'm-a')).toBe(1);
  });

  it('the scheduler caps line count and total before the rail sees the batch', async () => {
    const core = await coreWithTabs({ 'm-a': 3, 'm-b': 3 });
    const { chain, rail } = setup();
    const job = new PayoutScheduler(core, rail, 1e9, { maxLines: 1, maxBatchTokens: 2 });
    const paid = await job.runOnce();
    expect(paid.map((p) => [p.merchantId, p.amountTokens])).toEqual([['m-a', 2]]);
    expect(chain.paid().map((p) => p.amount)).toEqual([RLUSD('0.2')]);
  });
});

describe('XrplEvmPayoutRail: merchant registry', () => {
  it('an unregistered merchant is not paid; registered ones in the same batch are', async () => {
    const { chain, rail } = setup();
    const out = await rail.payout([line('m-unknown', '1.00'), line('m-a', '1.00')]);
    expect(out.map((r) => r.merchantId)).toEqual(['m-a']);
    expect(chain.paid().map((p) => p.to)).toEqual([PAY_A]);
  });

  it('a batch with only unregistered merchants is refused with nothing sent', async () => {
    const { chain, rail } = setup();
    await expect(rail.payout([line('m-unknown', '1.00')])).rejects.toThrow(/no registered payout address/);
    expect(chain.sends).toHaveLength(0);
  });

  it('a registered address cannot be changed', () => {
    const r = new MerchantRegistry({ 'm-a': PAY_A });
    expect(() => r.register('m-a', PAY_B)).toThrow(/changing it is refused/);
    r.register('m-a', PAY_A.toUpperCase().replace('0X', '0x')); // same address again is fine
    expect(r.get('m-a')).toBe(PAY_A);
    expect(() => MerchantRegistry.parse(`m-a=${PAY_A},m-a=${PAY_B}`)).toThrow(/changing it is refused/);
    expect(() => r.register('m-z', '0x' + '0'.repeat(40))).toThrow(/zero address/);
  });

  it('an address changed behind the rail after start-up is refused', async () => {
    const reg = new MerchantRegistry({ 'm-a': PAY_A });
    const { chain, rail } = setup({ payoutAddresses: reg });
    (reg as unknown as { map: Map<string, string> }).map.set('m-a', PAY_B); // tamper past register()
    await expect(rail.payout([line('m-a', '1.00')])).rejects.toThrow(/changed since start-up/);
    expect(chain.sends).toHaveLength(0);
  });

  it('parses MERCHANT_PAYOUT_ADDRESSES as a list or JSON', () => {
    expect(MerchantRegistry.parse(`m-a=${PAY_A}, m-b=${PAY_B}`).toRecord()).toEqual({ 'm-a': PAY_A, 'm-b': PAY_B });
    expect(MerchantRegistry.parse(JSON.stringify({ 'm-a': PAY_A })).toRecord()).toEqual({ 'm-a': PAY_A });
    expect(() => MerchantRegistry.parse('m-a=0x1234')).toThrow(/bad payout address/);
  });
});

describe('XrplEvmPayoutRail: partial failure, timeouts, never paying twice', () => {
  it('partial failure: a reverted line stays unpaid and is paid once in the next batch', async () => {
    const core = await coreWithTabs({ 'm-a': 1, 'm-b': 2 });
    const { chain, rail, issuer } = setup({ fund: '0.25' }); // enough for each line alone, not both
    const job = new PayoutScheduler(core, rail, 1e9);
    const first = await job.runOnce();
    expect(first.map((p) => p.merchantId)).toEqual(['m-a']);
    expect(unpaid(core, 'm-a')).toBe(0);
    expect(unpaid(core, 'm-b')).toBe(2);
    chain.fund(issuer, RLUSD('10'));
    const second = await job.runOnce();
    expect(second.map((p) => p.merchantId)).toEqual(['m-b']);
    expect(chain.bal(PAY_A)).toBe(RLUSD('0.1')); // m-a was not paid again
    expect(chain.bal(PAY_B)).toBe(RLUSD('0.2'));
    expect(core.pendingPayouts()).toEqual([]);
  });

  it('a refused send ends the batch (no nonce gap); the rest is paid next batch', async () => {
    const core = await coreWithTabs({ 'm-a': 1, 'm-b': 2 });
    const { chain, rail } = setup();
    chain.sendPlan = ['reject'];
    const job = new PayoutScheduler(core, rail, 1e9);
    expect(await job.runOnce()).toEqual([]);
    expect(chain.sends).toHaveLength(1);
    const second = await job.runOnce();
    expect(second.map((p) => p.merchantId)).toEqual(['m-a', 'm-b']);
    expect(chain.sends.slice(1).map((r) => parseTransaction(r).nonce ?? 0)).toEqual([0, 1]);
  });

  it('an RPC that times out after accepting the tx: the receipt is found by hash, nothing is resent', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { chain, rail } = setup();
    chain.sendPlan = ['timeout-after-accept'];
    const paid = await new PayoutScheduler(core, rail, 1e9).runOnce();
    expect(paid).toHaveLength(1);
    expect(chain.sends).toHaveLength(1);
    expect(chain.paid()).toHaveLength(1);
    expect(paid[0].txRef).toBe(chain.paid()[0].hash);
    expect(unpaid(core, 'm-a')).toBe(0);
  });

  it('an RPC that times out before accepting: the same signed tx is rebroadcast next batch, never a new one', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { chain, rail } = setup();
    chain.sendPlan = ['timeout-before-accept'];
    const job = new PayoutScheduler(core, rail, 1e9);
    expect(await job.runOnce()).toEqual([]);
    expect(rail.pendingMerchants()).toEqual(['m-a']);
    expect(unpaid(core, 'm-a')).toBe(1);
    const paid = await job.runOnce();
    expect(paid.map((p) => p.merchantId)).toEqual(['m-a']);
    expect(chain.sends).toHaveLength(2);
    expect(chain.sends[1]).toBe(chain.sends[0]); // byte-identical rebroadcast
    expect(chain.bal(PAY_A)).toBe(RLUSD('0.1'));
  });

  it('tabs are marked paid only after a success receipt; a pending line is never resent (finding 4)', async () => {
    const core = await coreWithTabs({ 'm-a': 1, 'm-b': 2 });
    const { chain, rail } = setup();
    chain.automine = false;
    const job = new PayoutScheduler(core, rail, 1e9);
    expect(await job.runOnce()).toEqual([]); // both sent, no receipt yet
    expect(chain.sends).toHaveLength(2);
    expect(unpaid(core, 'm-a')).toBe(1);
    expect(core.payoutHistory('m-a')).toEqual([]);

    // The tab grows while the transfer is pending. A retry must not resend or top up the line.
    await settle(core, 'm-a', 1);
    expect(await job.runOnce()).toEqual([]);
    const fresh = chain.sends.slice(2).filter((r) => !chain.sends.slice(0, 2).includes(r));
    expect(fresh).toHaveLength(0); // only byte-identical rebroadcasts

    chain.mine();
    const paid = await job.runOnce();
    expect(paid.map((p) => [p.merchantId, p.amountTokens])).toEqual([['m-a', 1], ['m-b', 2]]);
    expect(unpaid(core, 'm-a')).toBe(1); // the later token wait for the next batch
    chain.automine = true;
    const rest = await job.runOnce();
    expect(rest.map((p) => [p.merchantId, p.amountTokens])).toEqual([['m-a', 1]]);
    expect(chain.bal(PAY_A)).toBe(RLUSD('0.2'));
    expect(chain.bal(PAY_B)).toBe(RLUSD('0.2'));
  });

  it('a pending tx whose nonce was used elsewhere is dropped and the line is retried once', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { chain, rail, issuer } = setup();
    chain.sendPlan = ['timeout-before-accept'];
    const job = new PayoutScheduler(core, rail, 1e9);
    await job.runOnce();
    chain.burnNonce(issuer); // nonce 0 now used by another tx: the pending one can never mine
    const paid = await job.runOnce();
    expect(paid).toEqual([]); // dropped this batch, nothing paid yet
    expect(rail.pendingMerchants()).toEqual([]);
    const again = await job.runOnce();
    expect(again.map((p) => p.merchantId)).toEqual(['m-a']);
    expect(parseTransaction(chain.sends.at(-1)!).nonce ?? 0).toBe(1);
    expect(chain.paid()).toHaveLength(1);
  });

  it('a reverted pending tx frees the line for the next batch', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { chain, rail, issuer } = setup();
    chain.automine = false;
    const job = new PayoutScheduler(core, rail, 1e9);
    await job.runOnce();
    chain.balances.set(issuer.toLowerCase(), 0n); // funds gone before it mines: it reverts
    chain.mine();
    expect(await job.runOnce()).toEqual([]);
    expect(unpaid(core, 'm-a')).toBe(1);
    expect(rail.pendingMerchants()).toEqual([]);
  });
});

describe('payout records and the admin API', () => {
  it('a confirmed payout adds a signed record with the tx hash to the merchant history', async () => {
    const core = await coreWithTabs({ 'm-a': 1 });
    const { rail, chain } = setup();
    await new PayoutScheduler(core, rail, 1e9).runOnce();
    const [rec] = core.payoutHistory('m-a');
    expect(verifyPayoutRecord(rec, core.publicKeys.claim)).toBe(true);
    expect(rec.payout).toMatchObject({
      merchantId: 'm-a', amountTokens: 1, amountRlusd: '0.10', txRef: chain.paid()[0].hash,
      payTo: PAY_A, token: TOKEN, chainId: 1449000, paidTotalTokens: 1, claimSeq: 1, claimTotalTokens: 1,
    });
    expect(verifyPayoutRecord({ ...rec, payout: { ...rec.payout, txRef: '0x' + '00'.repeat(32) } }, core.publicKeys.claim)).toBe(false);
  });

  it('GET /payouts serves the history; admin routes need the token', async () => {
    const { rail } = setup();
    const issuer = await startIssuer({ merchantAuth: { developmentMode: true }, log: () => {}, payoutIntervalMs: 3_600_000, payoutRail: rail, adminToken: 'secret' });
    try {
      await settle(issuer.core, 'm-a', 1);
      expect((await fetch(`${issuer.url}/payouts/pending`)).status).toBe(403);
      const auth = { authorization: 'Bearer secret' };
      const pending = await (await fetch(`${issuer.url}/payouts/pending`, { headers: auth })).json();
      expect(pending.rail).toBe('xrpl-evm');
      expect(pending.preview.transfers[0]).toMatchObject({ merchantId: 'm-a', payTo: PAY_A, to: TOKEN });
      expect(issuer.core.payoutHistory('m-a')).toEqual([]); // preview sent nothing
      const run = await (await fetch(`${issuer.url}/payouts/run`, { method: 'POST', headers: auth })).json();
      expect(run.paid.map((p: PayoutLine) => p.merchantId)).toEqual(['m-a']);
      const hist = await (await fetch(`${issuer.url}/payouts?merchantId=m-a`)).json();
      expect(hist.payouts[0].payout.txRef).toBe(run.paid[0].txRef);
    } finally {
      await issuer.close();
    }
  });
});

describe('PAYOUT_RAIL config', () => {
  const key = generatePrivateKey();
  const addr = privateKeyToAccount(key).address;
  const base = { PAYOUT_RAIL: 'xrpl-evm', RLUSD_ADDRESS: TOKEN, MERCHANT_PAYOUT_ADDRESSES: `m-a=${PAY_A}`, ISSUER_PAYOUT_PRIVATE_KEY: key };

  it('defaults to mock, so tests and the demo need no key', () => {
    expect(payoutConfigFromEnv({}, { log: () => {} }).name).toBe('mock');
  });
  it('xrpl-evm needs a key, a token and merchants', () => {
    expect(() => payoutConfigFromEnv({ ...base, ISSUER_PAYOUT_PRIVATE_KEY: '' })).toThrow(/ISSUER_PAYOUT_PRIVATE_KEY/);
    expect(() => payoutConfigFromEnv({ ...base, RLUSD_ADDRESS: '' })).toThrow(/RLUSD_ADDRESS/);
    expect(() => payoutConfigFromEnv({ ...base, MERCHANT_PAYOUT_ADDRESSES: '' })).toThrow(/MERCHANT_PAYOUT_ADDRESSES/);
    expect(() => payoutConfigFromEnv({ ...base, PAYOUT_RAIL: 'other' })).toThrow(/mock or xrpl-evm/);
  });
  it('the key must match ISSUER_PAYOUT, where top-ups arrive', () => {
    expect(payoutConfigFromEnv({ ...base, ISSUER_PAYOUT: addr }).address).toBe(addr);
    expect(() => payoutConfigFromEnv({ ...base, ISSUER_PAYOUT: PAY_A })).toThrow(/ISSUER_PAYOUT is/);
  });
  it('reads caps from env', () => {
    expect(payoutConfigFromEnv({ ...base, PAYOUT_MAX_LINES: '3', PAYOUT_MAX_FEE_RLUSD: '0.5' }).caps).toEqual({ maxLines: 3, maxFeeRlusd: 0.5 });
  });
});
