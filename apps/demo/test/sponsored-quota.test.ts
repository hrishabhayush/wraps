import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SponsoredQuota } from '../src/sponsored-quota';

it('keeps the sponsored allowance across restarts and simultaneous requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wraps-quota-'));
  try {
    const quota = new SponsoredQuota(directory, 3);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => quota.reserve()));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    const restarted = new SponsoredQuota(directory, 3);
    expect(await restarted.remaining()).toBe(0);
    await expect(restarted.reserve()).rejects.toThrow('exhausted');
    expect(() => new SponsoredQuota(directory, 11)).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
