import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paymentConfig, purchase } from '../src/browser-payment';
import { AP4M_TASK_RESOURCES } from '../src/ap4m-task';

const toolkit = vi.hoisted(() => ({ loadX402Context: vi.fn(async () => ({})), buyResource: vi.fn(async (_options: unknown) => { throw new Error('SDK reached'); }) }));
vi.mock('../vendor/ap4m/x402.mjs', () => toolkit);

const configured = {
  AP4M_RESOURCE_URL: 'https://merchant.example/resource',
  AP4M_CHANNEL_ID: '0x' + 'ab'.repeat(32), AP4M_AGENT_KEY_FILE: '/missing/private-key', AP4M_STATE_DIR: '/missing/state',
};
const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
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
  it('validates catalog IDs and URLs before accepting payment configuration', () => {
    expect(paymentConfig({ ...configured, AP4M_RESOURCES: JSON.stringify(AP4M_TASK_RESOURCES) }).resources).toHaveLength(3);
    for (const resources of [[], null, [null], [{ ...AP4M_TASK_RESOURCES[0], id: '../escape' }],
      [AP4M_TASK_RESOURCES[0], AP4M_TASK_RESOURCES[0]], [{ ...AP4M_TASK_RESOURCES[0], url: 'http://public.example/resource' }]]) {
      expect(() => paymentConfig({ ...configured, AP4M_RESOURCES: JSON.stringify(resources) })).toThrow();
    }
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
  it('skips completed services while recovering another unresolved voucher', async () => {
    const env = await savedPayment(true);
    await mkdir(join(env.AP4M_STATE_DIR, 'gas-report-1'));
    await writeFile(join(env.AP4M_STATE_DIR, 'gas-report-1', 'purchase.json'), JSON.stringify({ complete: false }));
    await writeFile(join(env.AP4M_STATE_DIR, 'result.json'), JSON.stringify({
      channelId: env.AP4M_CHANNEL_ID, resourceUrl: env.AP4M_RESOURCE_URL,
      result: { resource: { block: 123 }, transactionHash: '0x' + 'cd'.repeat(32), spentRlusd: '0.05' },
    }));
    const result = await purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0');
    expect(result).toMatchObject({ resource: { block: 123 }, cached: true, spentRlusd: '0' });
  });
  it('starts a fresh paid operation for an already purchased service and retains its old voucher', async () => {
    const env = { ...await savedPayment(true), AGENT_PRIVATE_KEY: '11'.repeat(32) };
    const previous = await readFile(join(env.AP4M_STATE_DIR, 'purchase.json'), 'utf8');
    await expect(purchase(env, 'exit', 'exit', () => {}, '0')).rejects.toThrow('zero payment budget');
    await expect(purchase(env, 'exit', 'exit', () => {}, '0.04')).rejects.toThrow('SDK reached');
    expect(toolkit.buyResource).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.stringMatching(/^purchase-/), maximumAmount: '40000000000000000', stateDirectory: env.AP4M_STATE_DIR,
    }));
    expect(await readFile(join(env.AP4M_STATE_DIR, 'purchase.json'), 'utf8')).toBe(previous);
  });
  it('refuses a changed recovery budget and a zero-budget new payment before loading the key', async () => {
    const env = await savedPayment(false);
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0.04')).rejects.toThrow('original budget');
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0')).rejects.toThrow('zero payment budget');
    await expect(purchase(env, '136.80.57.82', '136.80.57.82', () => {}, '0.06')).rejects.toThrow('server payment limit');
  });
  it('blocks a new service while another voucher is unresolved, even after a catalog change', async () => {
    const env = await savedPayment(false);
    await expect(purchase({ ...env, AP4M_RESOURCES: JSON.stringify(AP4M_TASK_RESOURCES) }, 'exit', 'exit', () => {}, '0.05', 'gas-report-1')).rejects.toThrow('Resume unresolved');
    await mkdir(join(env.AP4M_STATE_DIR, 'old-service'));
    await writeFile(join(env.AP4M_STATE_DIR, 'old-service', 'purchase.json'), JSON.stringify({ complete: false }));
    await expect(purchase(env, 'exit', 'exit', () => {}, '0.05')).rejects.toThrow('old-service');
  });
  it('resumes a later service in its own directory with its original authority after the task restarts', async () => {
    const env = { ...await savedPayment(true), AGENT_PRIVATE_KEY: '11'.repeat(32), AP4M_MAX_RLUSD: '0.15', AP4M_RESOURCES: JSON.stringify(AP4M_TASK_RESOURCES) };
    const directory = join(env.AP4M_STATE_DIR, 'gas-report-1');
    await mkdir(directory);
    await writeFile(join(directory, 'purchase.json'), JSON.stringify({ complete: false, intent: {
      channelId: env.AP4M_CHANNEL_ID, resourceUrl: AP4M_TASK_RESOURCES[1].url, operation: 'gas-report-1', maximumAmount: '100000000000000000',
    } }));
    await expect(purchase(env, 'exit', 'exit', () => {}, '0.15', 'gas-report-1')).rejects.toThrow('SDK reached');
    expect(toolkit.buyResource).toHaveBeenCalledWith(expect.objectContaining({ stateDirectory: directory,
      operation: 'gas-report-1', resourceUrl: AP4M_TASK_RESOURCES[1].url, maximumAmount: '100000000000000000' }));
  });
});
