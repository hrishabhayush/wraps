import { expect, it } from 'vitest';
import { POOLED_ESCROW_VAULT_INTERFACE } from '@ap4m/sdk';
import { AP4M_VAULT, CHANNEL_CAP, validateChannelRequest } from '../src/ap4m-channel';

const data = (cap = CHANNEL_CAP) => POOLED_ESCROW_VAULT_INTERFACE.encodeFunctionData('requestPayoutBinding', [{
  operationId: '0x' + '01'.repeat(32), reservationId: '0x' + '02'.repeat(32), beneficiaryReference: '0x' + '03'.repeat(32),
  cap, expectedAccountStatusGeneration: 1n, requestValidBefore: 2000000000n, bindingValidBefore: 2000000000n,
}]);
it('accepts only a zero-value 1 RLUSD binding request to the published vault', () => {
  expect(validateChannelRequest({ to: AP4M_VAULT, data: data() }).value).toBe(0n);
  expect(() => validateChannelRequest({ to: AP4M_VAULT, data: data(CHANNEL_CAP * 5n) })).toThrow('capped');
  expect(() => validateChannelRequest({ to: AP4M_VAULT, data: data(), value: '1' })).toThrow('native transfer');
  expect(() => validateChannelRequest({ to: '0x' + '11'.repeat(20), data: data() })).toThrow('vault');
  const cancel = POOLED_ESCROW_VAULT_INTERFACE.encodeFunctionData('cancelPayoutBindingRequest', ['0x' + '01'.repeat(32)]);
  expect(() => validateChannelRequest({ to: AP4M_VAULT, data: cancel })).toThrow('binding request');
});
