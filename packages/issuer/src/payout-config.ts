// Payout rail from environment variables. PAYOUT_RAIL=mock (default) or xrpl-evm.
// Uses the same names as the XRPL EVM top-up rail: RLUSD_ADDRESS, XRPL_EVM_RPC, ISSUER_PAYOUT.
import { MerchantRegistry } from './merchant-registry';
import { MockPayoutRail, PayoutCaps, PayoutRail, XRPL_EVM_TESTNET_CHAIN_ID, XrplEvmPayoutRail } from './payout';

export type PayoutRailName = 'mock' | 'xrpl-evm';

export interface PayoutConfig {
  name: PayoutRailName;
  rail: PayoutRail;
  caps: PayoutCaps;
  registry: MerchantRegistry;
  /** Sender address, for xrpl-evm with a key. */
  address?: string;
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
const xrpToWei = (xrp: string) => {
  const [w, f = ''] = xrp.split('.');
  return BigInt(w || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0');
};

/**
 * Reads payout settings. With `requireKey` false (dry runs), xrpl-evm works without a key and
 * can only plan. The key is read once; the caller may delete it from the environment after.
 */
export function payoutConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { requireKey?: boolean; log?: (msg: string) => void } = {},
): PayoutConfig {
  const name = (env.PAYOUT_RAIL || 'mock') as PayoutRailName;
  if (name !== 'mock' && name !== 'xrpl-evm') throw new Error(`PAYOUT_RAIL must be mock or xrpl-evm, got ${name}`);
  const registry = MerchantRegistry.parse(env.MERCHANT_PAYOUT_ADDRESSES);
  const caps: PayoutCaps = {
    maxLines: num(env.PAYOUT_MAX_LINES),
    maxBatchTokens: num(env.PAYOUT_MAX_BATCH_TOKENS),
    maxFeeRlusd: num(env.PAYOUT_MAX_FEE_RLUSD),
  };
  for (const k of Object.keys(caps) as (keyof PayoutCaps)[]) if (caps[k] === undefined) delete caps[k];
  const log = opts.log ?? ((m: string) => console.log(`[issuer] ${m}`));
  if (name === 'mock') return { name, rail: new MockPayoutRail(log), caps, registry };

  const token = env.RLUSD_ADDRESS ?? '';
  if (!token) throw new Error('PAYOUT_RAIL=xrpl-evm needs RLUSD_ADDRESS (the RLUSD ERC-20 on XRPL EVM)');
  if (registry.size === 0) throw new Error('PAYOUT_RAIL=xrpl-evm needs MERCHANT_PAYOUT_ADDRESSES (id=0xaddress,...)');
  const key = env.ISSUER_PAYOUT_PRIVATE_KEY || undefined;
  if (!key && opts.requireKey !== false) throw new Error('PAYOUT_RAIL=xrpl-evm needs ISSUER_PAYOUT_PRIVATE_KEY');
  const rail = new XrplEvmPayoutRail({
    token,
    payoutAddresses: registry,
    privateKey: key,
    rpc: env.XRPL_EVM_RPC || undefined,
    chainId: num(env.XRPL_EVM_CHAIN_ID) ?? XRPL_EVM_TESTNET_CHAIN_ID,
    decimals: num(env.RLUSD_DECIMALS),
    maxGasPerTransfer: env.PAYOUT_MAX_GAS_PER_TRANSFER ? BigInt(env.PAYOUT_MAX_GAS_PER_TRANSFER) : undefined,
    maxGasPriceWei: env.PAYOUT_MAX_GAS_PRICE_GWEI ? BigInt(env.PAYOUT_MAX_GAS_PRICE_GWEI) * 10n ** 9n : undefined,
    maxBatchFeeWei: env.PAYOUT_MAX_BATCH_FEE_XRP ? xrpToWei(env.PAYOUT_MAX_BATCH_FEE_XRP) : undefined,
    xrpPriceRlusd: num(env.XRP_PRICE_RLUSD),
    receiptTimeoutMs: num(env.PAYOUT_RECEIPT_TIMEOUT_MS),
    log,
  });
  // Top-ups arrive at ISSUER_PAYOUT; payouts must leave from the same address.
  if (rail.address && env.ISSUER_PAYOUT && rail.address.toLowerCase() !== env.ISSUER_PAYOUT.toLowerCase()) {
    throw new Error(`ISSUER_PAYOUT_PRIVATE_KEY is for ${rail.address}, but ISSUER_PAYOUT is ${env.ISSUER_PAYOUT}`);
  }
  return { name, rail, caps, registry, address: rail.address };
}
