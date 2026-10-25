// XRPL EVM sidechain constants and pure helpers (no wallet, no network).

export const XRPL_EVM_TESTNET = {
  id: 1449000,
  hex: '0x161c28',
  name: 'XRPL EVM Sidechain Testnet',
  rpc: 'https://rpc.testnet.xrplevm.org',
  explorer: 'https://explorer.testnet.xrplevm.org',
  native: { name: 'XRP', symbol: 'XRP', decimals: 18 },
} as const;

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

// calldata for ERC-20 transfer(address,uint256)
export function erc20Transfer(to: string, amount: bigint) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`bad address: ${to}`);
  if (amount < 0n) throw new Error('negative amount');
  return '0xa9059cbb' + word(to) + word(amount.toString(16));
}

// calldata for ERC-20 balanceOf(address)
export const erc20BalanceOf = (owner: string) => '0x70a08231' + word(owner);
export const ERC20_DECIMALS = '0x313ce567';

// Exact decimal → base units (no float rounding), truncating extra precision.
export function toUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export const fromUnits = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
