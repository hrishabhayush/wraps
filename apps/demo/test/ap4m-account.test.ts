import { expect, it, vi } from 'vitest';
import { checkAp4mAccount } from '../src/ap4m-account';

it('only signs in and reads channels, without exposing the session or signature', async () => {
  const replies = [
    { challengeId: 'challenge-1', message: 'Sign in to AP4M' },
    { token: 'private-session' },
    { channels: [{ channel_id: 'public-channel', channel_status: 'open', cap_wei: '100', merchant_id: 'merchant', payout: 'public-payout', secret: 'must-not-print' }] },
  ];
  const request = vi.fn(async () => Response.json(replies.shift()));
  const wallet = { getAddress: async () => 'public-agent', signMessage: vi.fn(async () => 'private-signature') };
  const result = await checkAp4mAccount(wallet, 'CBC', request);
  expect(request.mock.calls).toHaveLength(3);
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/public/participant/challenge', '/public/participant/session', '/public/participant/channels',
  ]);
  expect(wallet.signMessage).toHaveBeenCalledWith('Sign in to AP4M');
  expect(JSON.stringify(result)).not.toMatch(/private-session|private-signature|must-not-print/);
  expect(result.channels[0].status).toBe('open');
});

it('refuses an invalid challenge before signing', async () => {
  const signMessage = vi.fn();
  await expect(checkAp4mAccount({ getAddress: async () => 'agent', signMessage }, 'CBC', async () => Response.json({}))).rejects.toThrow('invalid sign-in challenge');
  expect(signMessage).not.toHaveBeenCalled();
});
