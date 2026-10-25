import { describe, expect, it, vi } from 'vitest';

// The toolkit imports node:sqlite, which Vitest cannot load. These tests never reach it.
vi.mock('../vendor/ap4m/x402.mjs', () => ({ loadX402Context: vi.fn(), buyResource: vi.fn(), createX402Merchant: vi.fn() }));
import { Wallet } from 'ethers';
import { Ap4mPayoutRail } from '../src/payout-ap4m';
import { payoutConfigFromEnv } from '../src/payout-config';

const context = { network: 'eip155:1449000', participantRequest: {} as any, x402: { token: '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3', validBefore: 0, merchant: { environmentManifestDigest: '0x' } } };

describe('AP4M payout rail', () => {
  it('leaves lines unpaid, without throwing, while the wallet is not registered with AP4M', async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    const rail = new Ap4mPayoutRail({
      privateKey: Wallet.createRandom().privateKey, teamName: 'CBC', context, log: (m) => logs.push(m),
      fetch: (async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 401 }); }) as any,
    });
    expect(await rail.payout([{ merchantId: 'relay', amountTokens: 2, amountRlusd: '0.20' }])).toEqual([]);
    expect(calls).toEqual(['https://hackathon.ap4m.build/public/participant/challenge']);
    expect(logs.join('\n')).toContain(`waiting for AP4M registration of ${rail.address}`);
  });

  it('is configured from the environment with the enclave key and a team name', () => {
    const key = Wallet.createRandom().privateKey;
    const cfg = payoutConfigFromEnv({ PAYOUT_RAIL: 'ap4m', ISSUER_PAYOUT_PRIVATE_KEY: key, AP4M_TEAM_NAME: 'CBC' }, { log: () => {} });
    expect(cfg.name).toBe('ap4m');
    expect(cfg.address).toBe(new Wallet(key).address);
    expect(() => payoutConfigFromEnv({ PAYOUT_RAIL: 'ap4m', ISSUER_PAYOUT_PRIVATE_KEY: key }, { log: () => {} })).toThrow('AP4M_TEAM_NAME');
  });
});
