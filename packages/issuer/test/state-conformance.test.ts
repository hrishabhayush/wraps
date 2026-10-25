import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAttestationProvider, b64u, fromB64u } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken } from '@wraps/tokens';
import { IssuerCore, FileIssuerStateStore, MemoryIssuerStateStore, MockTopUpRail, MockTopUpWallet, PayoutScheduler, XrplEvmPayoutRail, toUnits, type XrplEvmPayoutRailOptions } from '../src/index';
import { FakeEvm } from './helpers/fake-evm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const TOKEN = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3';
const PAY_TO = '0x34a7142038cdd6946ecc8a231e49c45e62a7f562';
const quiet = () => {};
const wallet = new MockTopUpWallet();

async function mint(core: IssuerCore, count: number): Promise<string[]> {
  const pending = await blindTokens(core.publicKeys.token, count, core.name);
  const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(count)));
  return (await finalizeTokens(pending, responses.map(fromB64u))).map(serializeToken);
}

async function newCore(stateStore: MemoryIssuerStateStore | FileIssuerStateStore) {
  return IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: new MockTopUpRail(), stateStore, log: quiet });
}

describe('SEC-06 issuer state persistence', () => {
  it('SEC-06: restores spent tokens, settlements, tabs and funds after restart; old keys are not restored', async () => {
    const store = new MemoryIssuerStateStore();
    const before = await newCore(store);
    const tokens = await mint(before, 3);
    const spentTokens = tokens.slice(0, 2);
    const claim = await before.settle('merchant-a', spentTokens, 'restart-quote');
    expect(before.reserves().reserves).toMatchObject({ fundsHeldTokens: 3, unspentIssuedTokens: 1, unpaidTabsTokens: 2 });

    const after = await newCore(store);
    expect(after.reserves().reserves).toMatchObject({ fundsHeldTokens: 3, unspentIssuedTokens: 1, unpaidTabsTokens: 2 });
    expect(await after.settleStatus('merchant-a', 'restart-quote', spentTokens)).toBe('settled-by-you');
    expect(await after.settle('merchant-a', spentTokens, 'restart-quote')).toEqual(claim); // replay does not count twice
    expect(after.pendingPayouts()).toEqual([{ merchantId: 'merchant-a', amountTokens: 2, amountRlusd: '0.20' }]);
    expect((await after.verify(spentTokens)).results[0].reason).toBe('bad signature'); // ephemeral token key was replaced
    await expect(after.settle('merchant-b', spentTokens)).rejects.toMatchObject({ status: 409 });
    expect(after.pendingPayouts()[0].amountTokens).toBe(2);

    const firstPayout = await new PayoutScheduler(after, { payout: async (lines) => lines.map((l) => ({ merchantId: l.merchantId, txRef: 'local-once' })) }, 1_000_000).runOnce();
    expect(firstPayout).toHaveLength(1);
    const secondPayout = await new PayoutScheduler(after, { payout: async (lines) => lines.map((l) => ({ merchantId: l.merchantId, txRef: 'should-not-run' })) }, 1_000_000).runOnce();
    expect(secondPayout).toEqual([]);
    expect(after.pendingPayouts()).toEqual([]);
  });

  it('SEC-06: resumes the same in-flight signed payout after restart and does not broadcast a second transfer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wraps-payout-state-'));
    try {
      const store = new FileIssuerStateStore(join(dir, 'issuer-state.jsonl'));
      const core1 = await newCore(store);
      await core1.settle('merchant-a', await mint(core1, 1));

      const privateKey = generatePrivateKey();
      const sender = privateKeyToAccount(privateKey).address;
      const chain = new FakeEvm(TOKEN);
      chain.fund(sender, toUnits('10', 18));
      chain.automine = false;
      const rail = (options: Partial<XrplEvmPayoutRailOptions> = {}) => new XrplEvmPayoutRail({
        token: TOKEN,
        payoutAddresses: { 'merchant-a': PAY_TO },
        privateKey,
        fetch: chain.fetch,
        receiptTimeoutMs: 20,
        pollMs: 1,
        log: quiet,
        ...options,
      });
      const firstRail = rail();
      const firstJob = new PayoutScheduler(core1, firstRail, 1_000_000);
      expect(await firstJob.runOnce()).toEqual([]);
      expect(firstRail.pendingMerchants()).toEqual(['merchant-a']);
      expect(core1.inFlightPayouts()).toHaveLength(1);
      const originalHash = core1.inFlightPayouts()[0].hash;

      const core2 = await newCore(store); // new issuer/claim/token keys, durable account state restored
      const secondRail = rail();
      const secondJob = new PayoutScheduler(core2, secondRail, 1_000_000);
      expect(secondRail.pendingMerchants()).toEqual(['merchant-a']);
      chain.mine();
      const paid = await secondJob.runOnce();
      expect(paid).toMatchObject([{ merchantId: 'merchant-a', txRef: originalHash, amountTokens: 1 }]);
      expect(chain.sends).toHaveLength(1);
      expect(chain.paid()).toHaveLength(1);
      expect(await secondJob.runOnce()).toEqual([]);
      expect(chain.sends).toHaveLength(1);
      expect(core2.pendingPayouts()).toEqual([]);
      expect(core2.inFlightPayouts()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('SEC-06: detects journal tampering, partial truncation and rollback to an older valid record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wraps-state-'));
    try {
      const path = join(dir, 'issuer-state.jsonl');
      const core = await newCore(new FileIssuerStateStore(path));
      const tokens = await mint(core, 1);
      const result = await core.settle('merchant-a', tokens, 'file-quote');
      const loaded = await new FileIssuerStateStore(path).load();
      expect(loaded?.settlements).toMatchObject([{ merchantId: 'merchant-a', quoteId: 'file-quote', tokens, result }]);
      const journal = await readFile(path);
      const head = `${path}.head`;

      const tampered = join(dir, 'tampered.jsonl');
      const changed = journal.toString('utf8').replace(/("hash":")([0-9a-f])/, (_match, prefix: string, first: string) => `${prefix}${first === '0' ? '1' : '0'}`);
      expect(changed).not.toBe(journal.toString('utf8'));
      await writeFile(tampered, changed);
      await copyFile(head, `${tampered}.head`);
      await expect(new FileIssuerStateStore(tampered).load()).rejects.toThrow(/hash mismatch|chain is invalid/);

      const truncated = join(dir, 'truncated.jsonl');
      await writeFile(truncated, journal.subarray(0, journal.length - 5));
      await copyFile(head, `${truncated}.head`);
      await expect(new FileIssuerStateStore(truncated).load()).rejects.toThrow(/truncated|rollback|head mismatch/);

      const rollback = join(dir, 'rollback.jsonl');
      const records = journal.toString('utf8').trimEnd().split('\n');
      expect(records.length).toBeGreaterThan(1);
      await writeFile(rollback, `${records[0]}\n`);
      await copyFile(head, `${rollback}.head`);
      await expect(new FileIssuerStateStore(rollback).load()).rejects.toThrow(/rollback|head mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
