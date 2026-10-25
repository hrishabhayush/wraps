import { POOLED_ESCROW_VAULT_INTERFACE } from '@ap4m/sdk';
import { parseUnits } from 'ethers';

export const CHANNEL_CAP = parseUnits('1', 18);
export const AP4M_VAULT = '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0';
export function validateChannelRequest(prepared: { to?: unknown; data?: unknown; value?: unknown }) {
  if (typeof prepared.to !== 'string' || prepared.to.toLowerCase() !== AP4M_VAULT.toLowerCase()
    || typeof prepared.data !== 'string' || BigInt(String(prepared.value ?? 0)) !== 0n) {
    throw new Error('Refused channel request: unexpected vault or native transfer');
  }
  const parsed = POOLED_ESCROW_VAULT_INTERFACE.parseTransaction({ data: prepared.data });
  if (!parsed || parsed.name !== 'requestPayoutBinding' || parsed.args[0].cap !== CHANNEL_CAP) {
    throw new Error('Refused channel request: expected a binding request capped at exactly 1 RLUSD');
  }
  return { to: AP4M_VAULT, data: prepared.data, value: 0n };
}
