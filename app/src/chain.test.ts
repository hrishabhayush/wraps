import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erc20Transfer, erc20BalanceOf, toUnits, fromUnits, short } from './chain.ts';

const TO = '0x00000000000000000000000000000000000000Aa';

test('encodes ERC-20 transfer calldata', () => {
  const data = erc20Transfer(TO, 10n * 10n ** 18n);
  assert.equal(data.length, 2 + 8 + 64 + 64);
  assert.ok(data.startsWith('0xa9059cbb' + '0'.repeat(62) + 'aa'));
  assert.ok(data.endsWith('8ac7230489e80000')); // 10e18
});

test('rejects bad recipients', () => {
  assert.throws(() => erc20Transfer('0x123', 1n));
});

test('encodes balanceOf', () => {
  assert.equal(erc20BalanceOf(TO), '0x70a08231' + '0'.repeat(62) + 'aa');
});

test('converts decimal amounts exactly', () => {
  assert.equal(toUnits('10', 18), 10n ** 19n);
  assert.equal(toUnits('4.1666666', 6), 4166666n);
  assert.equal(toUnits('0.5', 6), 500000n);
  assert.equal(fromUnits(1_500_000n, 6), 1.5);
  assert.equal(short('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
});
