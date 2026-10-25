// Races across an await in IssuerCore (PR #23 review, findings 1 and 2).
import { describe, expect, it } from 'vitest';
import { AttestationProvider, MockAttestationProvider, b64u, fromB64u, hashPublicKeys } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken, toHex, tokenKeyId } from '@wraps/tokens';
import { IssuerCore, MockTopUpRail, MockTopUpWallet, PaymentRequirement, verifyTokenKeys } from '../src/index';

const wallet = new MockTopUpWallet();

describe('finding 1: a paid /issue always gets tokens', () => {
  it('a key rotation while the payment is being redeemed does not strand the paid request', async () => {
    let core!: IssuerCore;
    class RotatingRail extends MockTopUpRail {
      override async redeem(header: string, req: PaymentRequirement) {
        await core.rotateTokenKey(); // the current key changes during the await
        return super.redeem(header, req);
      }
    }
    core = await IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: new RotatingRail() });
    const oldKey = core.publicKeys.token;
    const pending = await blindTokens(oldKey, 2, core.name);
    const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(2)));
    expect(core.publicKeys.token).not.toEqual(oldKey); // it did rotate
    const tokens = (await finalizeTokens(pending, responses.map(fromB64u))).map(serializeToken);
    expect((await core.verify(tokens)).valid).toBe(true);
    const r = core.reserves().reserves;
    expect(r.unspentIssuedTokens).toBe(2);
    expect(r.solvent).toBe(true);
  });

  it('a request that cannot be signed never has its payment redeemed, and the quote stays usable', async () => {
    let redeems = 0;
    class CountingRail extends MockTopUpRail {
      override async redeem(header: string, req: PaymentRequirement) {
        redeems++;
        return super.redeem(header, req);
      }
    }
    const core = await IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: new CountingRail() });
    const pending = await blindTokens(core.publicKeys.token, 1, core.name);
    const good = b64u(pending[0].request);
    const bad = b64u(new Uint8Array([...fromB64u(good).slice(0, 3), 1, 2, 3])); // right key id, garbage body
    const q = core.quote(1);
    const payment = await wallet.pay(q);
    await expect(core.issuePaid([bad], payment)).rejects.toThrow(/bad token request/);
    expect(redeems).toBe(0);
    expect(core.reserves().reserves.fundsHeldTokens).toBe(0);
    const responses = await core.issuePaid([good], payment); // same payment, same quote
    expect(redeems).toBe(1);
    expect(responses).toHaveLength(1);
  });
});

describe('finding 2: attestation fields come from one key epoch', () => {
  it('a rotation while the provider attests does not mix epochs in the response', async () => {
    let core!: IssuerCore;
    let attestedHash: Uint8Array | undefined;
    const inner = new MockAttestationProvider({ buildName: 'issuer' });
    const provider: AttestationProvider = {
      format: inner.format,
      async attest(nonce, publicKeysHash) {
        attestedHash = publicKeysHash;
        await core.rotateTokenKey();
        return inner.attest(nonce, publicKeysHash);
      },
    };
    core = await IssuerCore.create({ provider, rail: new MockTopUpRail() });
    const res = await core.attestation(new Uint8Array(32));
    const token = fromB64u(res.publicKeys.token);
    expect(core.publicKeys.token).not.toEqual(token); // it did rotate after the snapshot
    // Every field names the same key: the attested hash, the key ID, the not-after time, the list.
    expect(Buffer.from(hashPublicKeys({ token, claim: fromB64u(res.publicKeys.claim) }))).toEqual(Buffer.from(attestedHash!));
    expect(res.tokenKeyId).toBe(toHex(tokenKeyId(token)));
    const current = res.tokenKeys!.statement.keys.filter((k) => k.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ keyId: res.tokenKeyId, publicKey: res.publicKeys.token, notAfter: res.tokenKeyNotAfter });
    expect(verifyTokenKeys(res.tokenKeys!, core.publicKeys.claim)).toBe(true);
  });
});
