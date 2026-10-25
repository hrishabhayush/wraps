// Payout rail from environment variables. PAYOUT_RAIL=mock (default), xrpl-evm or ap4m.
// Uses the same names as the XRPL EVM top-up rail: RLUSD_ADDRESS, XRPL_EVM_RPC, ISSUER_PAYOUT.
import { MerchantRegistry } from './merchant-registry';
import { Ap4mPayoutRail } from './payout-ap4m';
import { MockPayoutRail, PayoutCaps, PayoutRail, XRPL_EVM_TESTNET_CHAIN_ID, XrplEvmPayoutRail } from './payout';

export type PayoutRailName = 'mock' | 'xrpl-evm' | 'ap4m';

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
  if (name !== 'mock' && name !== 'xrpl-evm' && name !== 'ap4m') throw new Error(`PAYOUT_RAIL must be mock, xrpl-evm or ap4m, got ${name}`);
  const registry = MerchantRegistry.parse(env.MERCHANT_PAYOUT_ADDRESSES);
  const caps: PayoutCaps = {
    maxLines: num(env.PAYOUT_MAX_LINES),
    maxBatchTokens: num(env.PAYOUT_MAX_BATCH_TOKENS),
    maxFeeRlusd: num(env.PAYOUT_MAX_FEE_RLUSD),
  };
  for (const k of Object.keys(caps) as (keyof PayoutCaps)[]) if (caps[k] === undefined) delete caps[k];
  const log = opts.log ?? ((m: string) => console.log(`[issuer] ${m}`));
  if (name === 'mock') return { name, rail: new MockPayoutRail(log), caps, registry };

  // ap4m: merchants are paid through the issuer's own Mastercard AP4M Channel. AP4M fixes the
  // merchant and its payout per Channel, so MERCHANT_PAYOUT_ADDRESSES is not used.
  if (name === 'ap4m') {
    const key = env.ISSUER_PAYOUT_PRIVATE_KEY || undefined;
    if (!key) throw new Error('PAYOUT_RAIL=ap4m needs ISSUER_PAYOUT_PRIVATE_KEY (ISSUER_WALLET=enclave sets it)');
    const teamName = env.AP4M_TEAM_NAME ?? '';
    if (!teamName) throw new Error('PAYOUT_RAIL=ap4m needs AP4M_TEAM_NAME (the team registered with AP4M)');
    const rail = new Ap4mPayoutRail({ privateKey: key, teamName, apiUrl: env.AP4M_API_URL || undefined, rpc: env.XRPL_EVM_RPC || undefined, token: env.RLUSD_ADDRESS || undefined, log });
    return { name, rail, caps, registry, address: rail.address };
  }

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
