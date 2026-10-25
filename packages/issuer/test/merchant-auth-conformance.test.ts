import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64u, fromB64u, generateEd25519, MockAttestationProvider } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken } from '@wraps/tokens';
import { MockTopUpWallet, signMerchantRequest, startIssuer } from '../src/index';

const quiet = () => {};

describe('SEC-04 merchant request authentication', () => {
  it('SEC-04: rejects unauthenticated, wrong-key, stale and replayed settle requests; identities cannot be substituted', async () => {
    let now = Date.now();
    const keyA = generateEd25519();
    const keyB = generateEd25519();
    const issuer = await startIssuer({
      now: () => now,
      log: quiet,
      payoutIntervalMs: 3_600_000,
      merchantAuth: {
        timestampWindowMs: 1_000,
        publicKeys: { 'merchant-a': b64u(keyA.publicKeyBytes), 'merchant-b': b64u(keyB.publicKeyBytes) },
      },
    });
    try {
      const pending = await blindTokens(issuer.core.publicKeys.token, 1, issuer.core.name);
      const response = await issuer.core.issuePaid(
        pending.map((p) => b64u(p.request)),
        await new MockTopUpWallet().pay(issuer.core.quote(1)),
      );
      const tokens = (await finalizeTokens(pending, response.map(fromB64u))).map(serializeToken);
      const body = { merchantId: 'merchant-a', quoteId: 'sec04-own-quote', tokens };
      const raw = JSON.stringify(body);
      const path = '/settle';
      const unsigned = async () => fetch(`${issuer.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
      });
      expect((await unsigned()).status).toBe(401);

      const wrongKey = signMerchantRequest(keyB.privateKey, 'merchant-a', 'POST', path, raw, now);
      expect((await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...wrongKey }, body: raw })).status).toBe(401);

      const stale = signMerchantRequest(keyA.privateKey, 'merchant-a', 'POST', path, raw, now - 1_001);
      expect((await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...stale }, body: raw })).status).toBe(401);

      const anotherMerchant = { ...body, merchantId: 'merchant-b' };
      const otherRaw = JSON.stringify(anotherMerchant);
      const signedByA = signMerchantRequest(keyA.privateKey, 'merchant-a', 'POST', path, otherRaw, now);
      expect((await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signedByA }, body: otherRaw })).status).toBe(401);

      const valid = signMerchantRequest(keyA.privateKey, 'merchant-a', 'POST', path, raw, now);
      const settled = await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...valid }, body: raw });
      expect(settled.status).toBe(200);
      const replay = await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...valid }, body: raw });
      expect(replay.status).toBe(409);

      const statusPath = '/settle/status';
      const statusBody = JSON.stringify(body);
      expect((await fetch(`${issuer.url}${statusPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: statusBody })).status).toBe(401);
      const statusOtherBody = JSON.stringify({ ...body, merchantId: 'merchant-b' });
      const statusAsOther = signMerchantRequest(keyA.privateKey, 'merchant-a', 'POST', statusPath, statusOtherBody, now);
      expect((await fetch(`${issuer.url}${statusPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...statusAsOther }, body: statusOtherBody })).status).toBe(401);

      const statusOwn = signMerchantRequest(keyA.privateKey, 'merchant-a', 'POST', statusPath, statusBody, now, randomBytes(16).toString('base64url'));
      const statusResponse = await fetch(`${issuer.url}${statusPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...statusOwn }, body: statusBody });
      expect(await statusResponse.json()).toEqual({ status: 'settled-by-you' });

      const payoutPath = '/payouts?merchantId=merchant-b';
      const payoutAsA = signMerchantRequest(keyA.privateKey, 'merchant-a', 'GET', payoutPath, '', now);
      expect((await fetch(`${issuer.url}${payoutPath}`, { headers: payoutAsA })).status).toBe(401);
      const unknownRaw = JSON.stringify({ ...body, merchantId: 'unregistered' });
      const unknownAuth = signMerchantRequest(keyA.privateKey, 'unregistered', 'POST', path, unknownRaw, now);
      expect((await fetch(`${issuer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...unknownAuth }, body: unknownRaw })).status).toBe(401);
      expect((await issuer.core.verify(tokens)).valid).toBe(false); // the valid authenticated request settled exactly once
    } finally {
      await issuer.close();
    }
  });

  it('SEC-04: allows the fixed relay ID only with its separately configured legacy key', async () => {
    const issuer = await startIssuer({
      log: quiet,
      payoutIntervalMs: 3_600_000,
      merchantAuth: { publicKeys: {}, relay: { merchantId: 'relay', key: 'relay-secret' } },
    });
    try {
      const pending = await blindTokens(issuer.core.publicKeys.token, 1, issuer.core.name);
      const response = await issuer.core.issuePaid(
        pending.map((p) => b64u(p.request)),
        await new MockTopUpWallet().pay(issuer.core.quote(1)),
      );
      const token = serializeToken((await finalizeTokens(pending, response.map(fromB64u)))[0]);
      const body = JSON.stringify({ merchantId: 'relay', tokens: [token] });
      const url = `${issuer.url}/settle`;
      expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
      const responseWithKey = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer relay-secret' }, body });
      expect(responseWithKey.status).toBe(200);
      expect((await responseWithKey.json() as { claim: { merchantId: string } }).claim.merchantId).toBe('relay');
      const otherMerchant = JSON.stringify({ merchantId: 'merchant-a', tokens: [token] });
      expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer relay-secret' }, body: otherMerchant })).status).toBe(401);
    } finally {
      await issuer.close();
    }
  });
});
