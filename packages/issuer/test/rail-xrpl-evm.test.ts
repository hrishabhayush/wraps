import { describe, expect, it } from 'vitest';
import { PaymentRequirement, XrplEvmTransferRail, XRPL_EVM_SCHEME, quotePaymentCalldata, toUnits } from '../src/index';

const TOKEN = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3';
const PAYOUT = '0x34A7142038CDd6946ecc8a231e49c45E62A7F562';
const OTHER = '0x00000000000000000000000000000000000000aa';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (h: string) => '0x' + h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const req: PaymentRequirement = {
  scheme: XRPL_EVM_SCHEME, network: 'xrpl-evm-testnet', asset: 'RLUSD', amountRlusd: '5.00', tokens: 50,
  payTo: PAYOUT, quoteId: '0123456789abcdef0123456789abcdef', expiresAt: Date.now() + 60_000, description: '',
};
const FIVE = toUnits('5', 18);

type Chain = { to?: string; input?: string; status?: string; logTo?: string; logAmount?: bigint; missing?: boolean };
function rail(c: Chain = {}) {
  const input = c.input ?? quotePaymentCalldata(req, FIVE);
  const fake = (async (_url: string, init: RequestInit) => {
    const { method } = JSON.parse(init.body as string);
    const result =
      method === 'eth_call' ? '0x12'
      : c.missing ? null
      : method === 'eth_getTransactionByHash' ? { to: c.to ?? TOKEN, input }
      : { status: c.status ?? '0x1', logs: [{ address: TOKEN, topics: [TOPIC, pad(OTHER), pad(c.logTo ?? PAYOUT)], data: pad((c.logAmount ?? FIVE).toString(16)) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  return new XrplEvmTransferRail(PAYOUT, { token: TOKEN, fetch: fake });
}
const header = (quoteId = req.quoteId, txHash = '0x' + 'ab'.repeat(32)) => Buffer.from(JSON.stringify({ quoteId, txHash })).toString('base64url');

describe('XrplEvmTransferRail', () => {
  it('accepts a confirmed RLUSD transfer made for this quote', async () => {
    expect(await rail().redeem(header(), req)).toEqual({ amountTokens: 50, txRef: '0x' + 'ab'.repeat(32) });
  });
  it('refuses the same tx twice', async () => {
    const r = rail();
    await r.redeem(header(), req);
    await expect(r.redeem(header(), req)).rejects.toThrow('already used');
  });
  it('refuses a tx made for another quote (stolen public tx hash)', async () => {
    const input = quotePaymentCalldata({ ...req, quoteId: 'ffffffffffffffffffffffffffffffff' }, FIVE);
    await expect(rail({ input }).redeem(header(), req)).rejects.toThrow('not made for this quote');
  });
  it('refuses a tx with no quote attached', async () => {
    const input = quotePaymentCalldata(req, FIVE).slice(0, -32);
    await expect(rail({ input }).redeem(header(), req)).rejects.toThrow('not made for this quote');
  });
  it('refuses transfers to someone else', async () => {
    const input = quotePaymentCalldata({ ...req, payTo: OTHER }, FIVE);
    await expect(rail({ input }).redeem(header(), req)).rejects.toThrow('payout address');
  });
  it('refuses underpayment', async () => {
    const input = quotePaymentCalldata(req, FIVE - 1n);
    await expect(rail({ input }).redeem(header(), req)).rejects.toThrow('below the quoted price');
  });
  it('refuses reverted, unconfirmed, wrong-token, and event-less payments', async () => {
    await expect(rail({ status: '0x0' }).redeem(header(), req)).rejects.toThrow('reverted');
    await expect(rail({ missing: true }).redeem(header(), req)).rejects.toThrow('not found');
    await expect(rail({ to: OTHER }).redeem(header(), req)).rejects.toThrow('not an RLUSD transfer');
    await expect(rail({ logTo: OTHER }).redeem(header(), req)).rejects.toThrow('Transfer event');
  });
  it('frees the tx hash again after a failed check', async () => {
    const r = rail({ status: '0x0' });
    await expect(r.redeem(header(), req)).rejects.toThrow('reverted');
    await expect(r.redeem(header(), req)).rejects.toThrow('reverted'); // not "already used"
  });
});
