import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paymentConfig, purchase } from '../src/browser-payment';

const configured = {
  AP4M_RESOURCE_URL: 'https://merchant.example/resource',
  AP4M_CHANNEL_ID: '0x' + 'ab'.repeat(32), AP4M_AGENT_KEY_FILE: '/missing/private-key', AP4M_STATE_DIR: '/missing/state',
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function savedPayment(complete: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'wraps-payment-test-'));
  directories.push(directory);
  await writeFile(join(directory, 'purchase.json'), JSON.stringify({ complete, intent: {
    channelId: configured.AP4M_CHANNEL_ID, resourceUrl: configured.AP4M_RESOURCE_URL,
    operation: 'xrp-research-1', maximumAmount: '50000000000000000',
  } }));
  return { ...configured, AP4M_STATE_DIR: directory, AP4M_ENABLE_PAYMENTS: '1', AP4M_MAX_RLUSD: '0.05' };
}
describe('browser demo payment gates', () => {
  it('defaults to preview even with complete channel settings', () => {
    expect(paymentConfig(configured).ready).toBe(false);
    expect(paymentConfig({}).missing).toHaveLength(4);
  });
  it('requires explicit opt-in and complete configuration', () => {
    expect(paymentConfig({ ...configured, AP4M_ENABLE_PAYMENTS: '1' }).ready).toBe(true);
    expect(paymentConfig({ AP4M_ENABLE_PAYMENTS: '1' }).ready).toBe(false);
  });
  it('accepts the exported agent key and a local merchant for the self-hosted demo', () => {
    const { AP4M_AGENT_KEY_FILE: _file, ...withoutFile } = configured;
    const cfg = paymentConfig({ ...withoutFile, AGENT_PRIVATE_KEY: 'configured-in-terminal', AP4M_ENABLE_PAYMENTS: '1', AP4M_RESOURCE_URL: 'http://127.0.0.1:4180/resource', AP4M_MAX_RLUSD: '0.05' });
    expect(cfg.ready).toBe(true);
    expect(cfg.maximum).toBe('0.05');
    expect(JSON.stringify(cfg)).not.toContain('configured-in-terminal');
  });
  it.each(['0', '-1', '1.01', 'Infinity', '1e2'])('refuses invalid or excessive budget %s', maximum => {
    expect(() => paymentConfig({ AP4M_MAX_RLUSD: maximum })).toThrow();
  });
  it.each(['http://merchant.example/resource', 'https://user:pass@merchant.example/resource', 'https://merchant.example/resource?key=secret'])('refuses unsafe merchant URL %s', url => {
    expect(() => paymentConfig({ AP4M_RESOURCE_URL: url })).toThrow();
  });
  it('blocks before loading a key or signing when disabled or the exit mismatches', async () => {
    await expect(purchase(configured, '136.80.57.82', '136.80.57.82', () => {})).rejects.toThrow('disabled');
    await expect(purchase({ ...configured, AP4M_ENABLE_PAYMENTS: '1' }, '131.239.151.74', '136.80.57.82', () => {})).rejects.toThrow('egress');
  });
  it('retrieves a completed report with zero budget without loading a signing key', async () => {
    const env = await savedPayment(true);
    await writeFile(join(env.AP4M_STATE_DIR, 'result.json'), JSON.stringify({
      channelId: env.AP4M_CHANNEL_ID, resourceUrl: env.AP4M_RESOURCE_URL,
      result: { resource: { block: 123 }, transactionHash: '0x' + 'cd'.repeat(32), spentRlusd: '0.05' },
    }));
    const result = await purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0');
    expect(result).toMatchObject({ resource: { block: 123 }, cached: true, spentRlusd: '0' });
  });
  it('refuses a changed recovery budget and a zero-budget new payment before loading the key', async () => {
    const env = await savedPayment(false);
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0.04')).rejects.toThrow('original budget');
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0')).rejects.toThrow('zero payment budget');
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0.06')).rejects.toThrow('server payment limit');
  });
});
