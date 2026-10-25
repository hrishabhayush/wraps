import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, tokensFor, clock, WIREGUARD_TOKENS_PER_CONNECT, wireGuardQuotaMB } from './meter.ts';

test('one desktop connect prepays exactly one 10 MB WireGuard quota block', () => {
  assert.equal(WIREGUARD_TOKENS_PER_CONNECT, 1);
  assert.equal(wireGuardQuotaMB(WIREGUARD_TOKENS_PER_CONNECT), 10);
});

test('WireGuard quota conversion rejects invalid token counts', () => {
  assert.throws(() => wireGuardQuotaMB(-1), /non-negative integer/);
  assert.throws(() => wireGuardQuotaMB(1.5), /non-negative integer/);
});

test('charges price per MB while connected', () => {
  const r = tick({ mb: 0, cost: 0 }, 10, 2, 0.002, 5);
  assert.equal(r.meter.mb, 20);
  assert.ok(Math.abs(r.meter.cost - 0.04) < 1e-12);
  assert.equal(r.exhausted, false);
});

test('never charges past the balance and reports exhaustion', () => {
  const r = tick({ mb: 100, cost: 1 }, 10, 2, 0.002, 0.01);
  assert.equal(r.charge, 0.01);
  assert.equal(r.meter.mb, 105);
  assert.equal(r.exhausted, true);
});

test('empty balance charges nothing', () => {
  const r = tick({ mb: 0, cost: 0 }, 1, 2, 0.002, 0);
  assert.deepEqual(r.meter, { mb: 0, cost: 0 });
  assert.equal(r.exhausted, true);
});

test('tokens and clock formatting', () => {
  assert.equal(tokensFor(12.4), 124);
  assert.equal(clock(2511), '00:41:51');
});
