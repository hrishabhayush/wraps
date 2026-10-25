import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AttestationError,
  MockAttestationProvider,
  MockAttestationVerifier,
  NitroAttestationVerifier,
  ed25519FromSeed,
  generateEd25519,
  hashPublicKeys,
  mockPcrs,
} from '../src/index';

const keys = { token: new Uint8Array([1, 2, 3]), claim: new Uint8Array([4, 5, 6]) };
const keysHash = hashPublicKeys(keys);
const expected = mockPcrs('issuer');

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AttestationError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('mock attestation', () => {
  it('accepts a good receipt', async () => {
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer' }).attest(nonce, keysHash);
    const v = await new MockAttestationVerifier({ expectedPcrs: expected }).verify(att, { nonce, publicKeysHash: keysHash });
    expect(v.pcrs['0']).toBe(expected['0']);
  });

  it('refuses a tampered PCR0 (modified issuer build)', async () => {
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer-tampered' }).attest(nonce, keysHash);
    await expectCode(new MockAttestationVerifier({ expectedPcrs: expected }).verify(att, { nonce, publicKeysHash: keysHash }), 'PCR_MISMATCH');
  });

  it('refuses all-zero PCRs (debug mode), even if the verifier expected zeros', async () => {
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer', debug: true }).attest(nonce, keysHash);
    const zeros = mockPcrs('issuer', true);
    await expectCode(new MockAttestationVerifier({ expectedPcrs: zeros }).verify(att, { nonce, publicKeysHash: keysHash }), 'DEBUG_MODE');
  });

  it('refuses keys that do not match the receipt', async () => {
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer' }).attest(nonce, keysHash);
    const otherHash = hashPublicKeys({ ...keys, token: new Uint8Array([9]) });
    await expectCode(new MockAttestationVerifier({ expectedPcrs: expected }).verify(att, { nonce, publicKeysHash: otherHash }), 'KEY_MISMATCH');
  });

  it('refuses a reused nonce (replayed receipt)', async () => {
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer' }).attest(nonce, keysHash);
    const verifier = new MockAttestationVerifier({ expectedPcrs: expected });
    await verifier.verify(att, { nonce, publicKeysHash: keysHash });
    await expectCode(verifier.verify(att, { nonce, publicKeysHash: keysHash }), 'NONCE_REUSED');
    // Replaying the old receipt against a fresh nonce fails too.
    await expectCode(verifier.verify(att, { nonce: randomBytes(32), publicKeysHash: keysHash }), 'NONCE_MISMATCH');
  });

  it('refuses a receipt that does not chain to the trusted root', async () => {
    const nonce = randomBytes(32);
    const fakeRoot = generateEd25519();
    const att = await new MockAttestationProvider({ buildName: 'issuer', root: fakeRoot }).attest(nonce, keysHash);
    await expectCode(new MockAttestationVerifier({ expectedPcrs: expected }).verify(att, { nonce, publicKeysHash: keysHash }), 'BAD_CHAIN');
  });

  it('accepts a custom root when configured', async () => {
    const root = ed25519FromSeed(new Uint8Array(32).fill(7));
    const nonce = randomBytes(32);
    const att = await new MockAttestationProvider({ buildName: 'issuer', root }).attest(nonce, keysHash);
    const v = new MockAttestationVerifier({ expectedPcrs: expected, rootPublicKey: root.publicKeyBytes });
    await expect(v.verify(att, { nonce, publicKeysHash: keysHash })).resolves.toBeTruthy();
  });

  it('Nitro verifier is a clearly failing stub', async () => {
    const v = new NitroAttestationVerifier({ expectedPcrs: expected, awsRootCertSha256: '' });
    await expectCode(v.verify('x', { nonce: randomBytes(32), publicKeysHash: keysHash }), 'NOT_IMPLEMENTED');
  });
});
