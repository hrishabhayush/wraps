import { describe, expect, it } from 'vitest';
import { blindTokens, b64u, finalizeTokens, fromB64u, serializeToken } from '@wraps/tokens';
import { MockTopUpWallet, startIssuer } from '@wraps/issuer';
import { BandwidthMeter, HttpRelayIssuer } from '../src/meter.js';

async function issueSerializedToken(issuer: Awaited<ReturnType<typeof startIssuer>>): Promise<string> {
  const pending = await blindTokens(issuer.core.publicKeys.token, 1, issuer.core.name);
  const responses = await issuer.core.issuePaid(
    pending.map((item) => b64u(item.request)),
    await new MockTopUpWallet().pay(issuer.core.quote(1)),
  );
  return serializeToken((await finalizeTokens(pending, responses.map(fromB64u)))[0]);
}

describe('SEC-04 relay settlement authentication', () => {
  it('SEC-04: relay meter settles against an enforced real issuer only with its configured key', async () => {
    const settleKey = 'relay-test-secret';
    const issuer = await startIssuer({
      host: '127.0.0.1',
      log: () => {},
      payoutIntervalMs: 3_600_000,
      merchantAuth: { enforce: true, publicKeys: {}, relay: { merchantId: 'relay:fixed', key: settleKey } },
    });
    try {
      const validToken = await issueSerializedToken(issuer);
      const authenticatedIssuer = new HttpRelayIssuer(issuer.url, fetch, 10_000, { settleKey, merchantId: 'relay:fixed' });
      expect(await authenticatedIssuer.verify([validToken])).toBe(true);
      const authenticatedMeter = new BandwidthMeter('caller-value-is-ignored', [validToken], authenticatedIssuer, 10);
      expect((await authenticatedMeter.forward(Buffer.from('bytes'))).bytes.toString()).toBe('bytes');
      expect((await issuer.core.verify([validToken])).valid).toBe(false);

      const untouchedToken = await issueSerializedToken(issuer);
      const unauthenticatedIssuer = new HttpRelayIssuer(issuer.url, fetch, 10_000, { settleKey: null, merchantId: 'relay:fixed' });
      expect(await unauthenticatedIssuer.verify([untouchedToken])).toBe(true);
      const unauthenticatedMeter = new BandwidthMeter('relay:fixed', [untouchedToken], unauthenticatedIssuer, 10);
      await expect(unauthenticatedMeter.forward(Buffer.from('bytes'))).rejects.toThrow('issuer /settle returned HTTP 401');
      expect((await issuer.core.verify([untouchedToken])).valid).toBe(true);
    } finally {
      await issuer.close();
    }
  });
});
