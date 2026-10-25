import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, parseUnits } from 'ethers';
import {
  buildX402PaymentRequired, decodeX402PaymentSignature, derivePaymentClaimId, encodePaymentVoucherRedemption,
  encodeX402PaymentRequired, encodeX402PaymentResponse, hashPaymentVoucher, PARTICIPANT_LEDGER_INTERFACE,
  recoverPaymentVoucherSigner, recoverX402ResourceBindingSigner,
} from '@ap4m/sdk';
// @ts-expect-error Official AP4M toolkit has no TypeScript declarations.
import { buyResource } from '../vendor/ap4m/x402.mjs';
import { AP4M_TASK_RESOURCES } from '../src/ap4m-task';

// Only chain reads are simulated. Voucher signing, headers, calldata and receipt checks use the official code.
const chain = vi.hoisted(() => ({
  agent: '', redeemed: '0', claims: new Map<string, { channelId: string; amount: string }>(),
  channelId: '0x' + 'ab'.repeat(32), ledger: '0x' + '11'.repeat(20), payout: '0x' + '22'.repeat(20),
  blockHash: '0x' + 'cd'.repeat(32),
}));
// The agent half never opens SQLite; Vitest 2 predates this Node builtin.
vi.mock('node:sqlite', () => ({ DatabaseSync: vi.fn() }));
vi.mock('@ap4m/sdk', async original => ({ ...await original<typeof import('@ap4m/sdk')>(), requireCanonicalBlock: vi.fn(async () => {}) }));
vi.mock('@ap4m/sdk/participant-requests', async original => ({
  ...await original<typeof import('@ap4m/sdk/participant-requests')>(),
  readParticipantFinalizedBlock: async () => ({ number: 100, hash: chain.blockHash, timestamp: 1000 }),
  readParticipantPaymentChannel: async () => ({ agent: chain.agent, payout: chain.payout, status: 1,
    redeemed: chain.redeemed, cap: '1000000000000000000', validAfter: 0, validBefore: 2000 }),
  readParticipantClaim: async (_provider: unknown, _context: unknown, claimId: string) => chain.claims.get(claimId),
}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ap4m-flow-'));
  chain.redeemed = '0'; chain.claims.clear();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function merchantFixture() {
  const wallet = Wallet.createRandom();
  chain.agent = wallet.address;
  const amount = parseUnits('0.05', 18).toString();
  const requestContext = { chainId: 1449000n, ledger: chain.ledger as `0x${string}` };
  const context = { network: 'eip155:1449000', participantRequest: requestContext,
    x402: { token: '0x' + '33'.repeat(20), merchant: { environmentManifestDigest: '0x' + '44'.repeat(32) } } };
  const transactions = new Map<string, { to: string; data: string; value: bigint }>();
  const receipts = new Map<string, { status: number; blockNumber: number; blockHash: string; logs: { address: string; topics: string[]; data: string }[] }>();
  const payments = new Map<string, string>();
  const cumulative: string[] = [];
  const provider = { getTransaction: async (hash: string) => transactions.get(hash), getTransactionReceipt: async (hash: string) => receipts.get(hash) };
  let loseResponse = false;
  const requestFetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    expect(headers.get('X-AP4M-CHANNEL-ID')).toBe(chain.channelId);
    const signature = headers.get('PAYMENT-SIGNATURE');
    if (!signature) {
      const required = buildX402PaymentRequired({ url }, [{ scheme: 'batch-settlement', network: 'eip155:1449000',
        amount, asset: context.x402.token, payTo: chain.payout as `0x${string}`, maxTimeoutSeconds: 60,
        extra: { bindingVersion: '1', ledger: requestContext.ledger, pricingMode: 'fixed', channelId: chain.channelId as `0x${string}`, acceptedCumulativeAmount: chain.redeemed } }]);
      return Response.json({ x402Version: 2 }, { status: 402, headers: { 'PAYMENT-REQUIRED': encodeX402PaymentRequired(required) } });
    }
    const service = AP4M_TASK_RESOURCES.find(resource => resource.url === url)!;
    const saved = JSON.parse(await readFile(join(directory, service.id, 'purchase.json'), 'utf8'));
    expect(saved.header).toBe(signature); // Durable intent must exist before the merchant sees it.
    const payload = decodeX402PaymentSignature(signature);
    if (!('cumulativeAmount' in payload.payload.voucher)) throw new Error('Expected fixed pricing');
    const voucher = { channelId: payload.payload.voucher.channelId, cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount) };
    const voucherDigest = hashPaymentVoucher(requestContext, voucher);
    expect(recoverPaymentVoucherSigner(requestContext, voucher, payload.payload.agentSignature)).toBe(wallet.address);
    expect(recoverX402ResourceBindingSigner(requestContext, { resourceDigest: payload.payload.resourceDigest, voucherDigest }, payload.payload.resourceSignature)).toBe(wallet.address);
    let transactionHash = payments.get(signature);
    if (!transactionHash) {
      const claimId = derivePaymentClaimId(requestContext, voucher, chain.redeemed);
      expect(voucher.cumulativeAmount - BigInt(chain.redeemed)).toBe(BigInt(amount));
      transactionHash = '0x' + (payments.size + 1).toString(16).padStart(64, '0');
      transactions.set(transactionHash, { ...encodePaymentVoucherRedemption(requestContext, voucher, payload.payload.agentSignature), value: 0n });
      const event = PARTICIPANT_LEDGER_INTERFACE.encodeEventLog(PARTICIPANT_LEDGER_INTERFACE.getEvent('VoucherRedeemed')!, [
        chain.channelId, claimId, voucherDigest, '0x' + '55'.repeat(32), wallet.address, '0x' + '66'.repeat(32),
        chain.payout, wallet.address, chain.redeemed, voucher.cumulativeAmount, amount,
      ]);
      receipts.set(transactionHash, { status: 1, blockNumber: 99, blockHash: chain.blockHash, logs: [{ address: chain.ledger, ...event }] });
      chain.claims.set(claimId, { channelId: chain.channelId, amount });
      chain.redeemed = voucher.cumulativeAmount.toString(); cumulative.push(chain.redeemed);
      payments.set(signature, transactionHash);
    }
    if (loseResponse) { loseResponse = false; throw new Error('Simulated lost merchant response'); }
    return Response.json({ resource: { service: service.id } }, { headers: { 'PAYMENT-RESPONSE': encodeX402PaymentResponse({
      success: true, payer: wallet.address as `0x${string}`, amount, transaction: transactionHash, network: 'eip155:1449000',
      extensions: { ap4m: { bindingVersion: '1', pricingMode: 'fixed', channelId: voucher.channelId, voucherDigest,
        channelPayout: chain.payout as `0x${string}`, maximumAmount: amount, actualAmount: amount,
        acceptedCumulativeAmount: voucher.cumulativeAmount.toString(), claimStatus: 'confirmed', statusReference: transactionHash, reconciled: true } },
    }) } });
  });
  const buy = (index: number, maximum = '0.15', operation = AP4M_TASK_RESOURCES[index].id) => buyResource({ context, provider, wallet,
    stateDirectory: join(directory, AP4M_TASK_RESOURCES[index].id), resourceUrl: AP4M_TASK_RESOURCES[index].url,
    channelId: chain.channelId, maximumAmount: parseUnits(maximum, 18).toString(), operation, requestFetch });
  return { buy, wallet, provider, payments, cumulative, requestFetch, loseNextResponse: () => { loseResponse = true; } };
}

describe('official AP4M voucher flow (simulated chain)', () => {
  it('creates three cumulative vouchers, verifies exact redemptions, and retrieves three services', async () => {
    const s = merchantFixture();
    for (let i = 0; i < 3; i++) {
      expect(await s.buy(i)).toMatchObject({ redemption: 'Confirmed', resource: { service: AP4M_TASK_RESOURCES[i].id } });
    }
    expect(s.cumulative).toEqual(['50000000000000000', '100000000000000000', '150000000000000000']);
    expect(s.requestFetch).toHaveBeenCalledTimes(6);
  });
  it('resumes the exact saved voucher after a lost response without a second charge', async () => {
    const s = merchantFixture();
    s.loseNextResponse();
    await expect(s.buy(0)).rejects.toThrow('lost merchant response');
    expect(await s.buy(0)).toMatchObject({ redemption: 'Confirmed' });
    expect(s.payments.size).toBe(1);
    expect(s.cumulative).toEqual(['50000000000000000']);
    expect(s.requestFetch).toHaveBeenCalledTimes(3);
  });
  it('pays again for the same service with a new operation and safely retries that payment', async () => {
    const s = merchantFixture();
    const first = await s.buy(0);
    s.loseNextResponse();
    await expect(s.buy(0, '0.15', 'purchase-second-run')).rejects.toThrow('lost merchant response');
    const second = await s.buy(0, '0.15', 'purchase-second-run');
    expect(second.transactionHash).not.toBe(first.transactionHash);
    expect(s.payments.size).toBe(2);
    expect(s.cumulative).toEqual(['50000000000000000', '100000000000000000']);
    const archived = JSON.parse(await readFile(join(directory, AP4M_TASK_RESOURCES[0].id, 'purchase-xrp-research-1.json'), 'utf8'));
    expect(archived.complete).toBe(true);
  });
  it('refuses an over-budget quote before signing', async () => {
    const s = merchantFixture();
    const sign = vi.spyOn(s.wallet, 'signTypedData');
    await expect(s.buy(0, '0.04')).rejects.toThrow('purchase authority');
    expect(sign).not.toHaveBeenCalled();
    expect(s.payments.size).toBe(0);
  });
  it('does not report success from HTTP 200 when the redemption transaction is wrong', async () => {
    const s = merchantFixture();
    s.provider.getTransaction = async () => ({ to: chain.ledger, data: '0x', value: 0n });
    await expect(s.buy(0)).rejects.toThrow('confirmed exact redemption');
    const saved = JSON.parse(await readFile(join(directory, AP4M_TASK_RESOURCES[0].id, 'purchase.json'), 'utf8'));
    expect(saved.complete).toBe(false);
  });
});
