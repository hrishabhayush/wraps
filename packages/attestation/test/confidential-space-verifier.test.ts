import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AttestationError,
  ConfidentialSpaceVerifier,
  GCP_ATTESTATION_ISSUER,
  confidentialSpaceNonces,
  hashPublicKeys,
  loadConfidentialSpacePolicy,
} from '../src/index';

const audience = 'https://wraps.invalid/issuer';
const imageDigest = `sha256:${'ab'.repeat(32)}`;
const publicKeys = { token: new Uint8Array([1, 2, 3]), tls: new Uint8Array([4, 5, 6]) };
const publicKeysHash = hashPublicKeys(publicKeys);
let signingKey: KeyLike;
let otherSigningKey: KeyLike;
let trustedKeys: ReturnType<typeof createLocalJWKSet>;
const tempDirs: string[] = [];

beforeAll(async () => {
  const trusted = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  signingKey = trusted.privateKey;
  otherSigningKey = other.privateKey;
  trustedKeys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(trusted.publicKey)), kid: 'google-test-key', alg: 'RS256', use: 'sig' }],
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeClaims(nonce: Uint8Array, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GCP_ATTESTATION_ISSUER,
    aud: audience,
    sub: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/1',
    eat_nonce: confidentialSpaceNonces(nonce, publicKeysHash),
    hwmodel: 'GCP_AMD_SEV',
    swname: 'CONFIDENTIAL_SPACE',
    swversion: ['260900'],
    dbgstat: 'disabled-since-boot',
    secboot: true,
    submods: {
      container: { image_digest: imageDigest, image_reference: `us-central1-docker.pkg.dev/p/r/issuer@${imageDigest}` },
      confidential_space: { support_attributes: ['LATEST', 'STABLE', 'USABLE'] },
      gce: { instance_id: '1', instance_name: 'wraps-issuer', project_id: 'p', zone: 'us-central1-a' },
    },
    ...changes,
  };
}

async function signToken(
  claims: Record<string, unknown>,
  options: { key?: KeyLike; issuedAt?: number; expiresAt?: number } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'google-test-key', typ: 'JWT' })
    .setIssuedAt(options.issuedAt ?? nowSec)
    .setNotBefore(nowSec - 1)
    .setExpirationTime(options.expiresAt ?? nowSec + 3600)
    .sign(options.key ?? signingKey);
}

function verifier(options: Partial<ConstructorParameters<typeof ConfidentialSpaceVerifier>[0]> = {}) {
  return new ConfidentialSpaceVerifier({
    imageDigest,
    audience,
    hwModels: ['GCP_AMD_SEV'],
    requiredSupportAttribute: 'STABLE',
    keys: trustedKeys,
    ...options,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AttestationError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('ConfidentialSpaceVerifier', () => {
  it('accepts a fresh, Google-signed production token for the pinned image', async () => {
    const nonce = randomBytes(32);
    const result = await verifier().verify(await signToken(makeClaims(nonce)), { nonce, publicKeysHash });
    expect(result.format).toBe('gcp-confidential-space-v1');
    expect(result.details.imageDigest).toBe(imageDigest);
    expect(result.publicKeysHash).toBe(Buffer.from(publicKeysHash).toString('hex'));
    expect(result.details.dbgstat).toBe('disabled-since-boot');
    expect(result.details.supportAttributes).toContain('STABLE');
  });

  it('refuses a token signed by a different key', async () => {
    const nonce = randomBytes(32);
    await expectCode(verifier().verify(await signToken(makeClaims(nonce), { key: otherSigningKey }), { nonce, publicKeysHash }), 'BAD_SIGNATURE');
  });

  it('checks issuer and audience', async () => {
    const nonce = randomBytes(32);
    await expectCode(
      verifier().verify(await signToken(makeClaims(nonce, { iss: 'https://attacker.invalid' })), { nonce, publicKeysHash }),
      'BAD_ISSUER',
    );
    await expectCode(
      verifier().verify(await signToken(makeClaims(nonce, { aud: 'https://sts.googleapis.com' })), { nonce, publicKeysHash }),
      'BAD_AUDIENCE',
    );
  });

  it('rejects non-AMD hardware, plain GCE, insecure boot, and non-STABLE images', async () => {
    const nonce = () => randomBytes(32);
    let n = nonce();
    await expectCode(verifier().verify(await signToken(makeClaims(n, { hwmodel: 'GCP_SHIELDED_VM' })), { nonce: n, publicKeysHash }), 'BAD_PLATFORM');
    n = nonce();
    await expectCode(verifier().verify(await signToken(makeClaims(n, { swname: 'GCE' })), { nonce: n, publicKeysHash }), 'BAD_PLATFORM');
    n = nonce();
    await expectCode(verifier().verify(await signToken(makeClaims(n, { secboot: false })), { nonce: n, publicKeysHash }), 'BAD_PLATFORM');
    n = nonce();
    await expectCode(
      verifier().verify(await signToken(makeClaims(n, { submods: { confidential_space: { support_attributes: ['USABLE'] } } })), { nonce: n, publicKeysHash }),
      'BAD_PLATFORM',
    );
    n = nonce();
    await expectCode(
      verifier().verify(await signToken(makeClaims(n, { submods: { confidential_space: { support_attributes: 'STABLE' } } })), { nonce: n, publicKeysHash }),
      'BAD_PLATFORM',
    );
  });

  it('rejects debug images', async () => {
    const nonce = randomBytes(32);
    await expectCode(verifier().verify(await signToken(makeClaims(nonce, { dbgstat: 'enabled' })), { nonce, publicKeysHash }), 'DEBUG_MODE');
  });

  it('requires the exact expected image digest', async () => {
    const nonce = randomBytes(32);
    const changed = `sha256:${'cd'.repeat(32)}`;
    const changedClaims = makeClaims(nonce);
    ((changedClaims.submods as Record<string, any>).container as Record<string, unknown>).image_digest = changed;
    await expectCode(
      verifier().verify(await signToken(changedClaims), { nonce, publicKeysHash }),
      'IMAGE_MISMATCH',
    );
  });

  it('checks both nonce bindings and rejects replay', async () => {
    const nonce = randomBytes(32);
    const token = await signToken(makeClaims(nonce));
    await expectCode(verifier().verify(token, { nonce: randomBytes(32), publicKeysHash }), 'NONCE_MISMATCH');

    const changedHash = hashPublicKeys({ ...publicKeys, tls: new Uint8Array([9]) });
    await expectCode(verifier().verify(token, { nonce, publicKeysHash: changedHash }), 'KEY_MISMATCH');

    const v = verifier();
    await v.verify(token, { nonce, publicKeysHash });
    await expectCode(v.verify(token, { nonce, publicKeysHash }), 'NONCE_REUSED');
  });

  it('rejects expired and stale tokens', async () => {
    const expiredNonce = randomBytes(32);
    await expectCode(
      verifier().verify(await signToken(makeClaims(expiredNonce), { expiresAt: Math.floor(Date.now() / 1000) - 60 }), {
        nonce: expiredNonce,
        publicKeysHash,
      }),
      'STALE',
    );

    const staleNonce = randomBytes(32);
    const nowSec = Math.floor(Date.now() / 1000);
    await expectCode(
      verifier({ maxAgeMs: 1_000 }).verify(await signToken(makeClaims(staleNonce), { issuedAt: nowSec - 60, expiresAt: nowSec + 3600 }), {
        nonce: staleNonce,
        publicKeysHash,
      }),
      'STALE',
    );
  });

  it('loads per-role expected image digests from the infra policy file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wraps-cs-policy-'));
    tempDirs.push(dir);
    const path = join(dir, 'expected.json');
    await writeFile(path, JSON.stringify({
      audience,
      hwModels: ['GCP_AMD_SEV'],
      requiredSupportAttribute: 'STABLE',
      roles: {
        issuer: { imageDigest, imageReference: 'registry/issuer@sha256:...' },
        relay: { imageDigest: `sha256:${'ef'.repeat(32)}` },
      },
    }));
    expect(loadConfidentialSpacePolicy(path, 'issuer')).toEqual({
      imageDigest,
      audience,
      hwModels: ['GCP_AMD_SEV'],
      requiredSupportAttribute: 'STABLE',
    });
  });

  it('requires a sha256 image digest, custom audience, and AMD SEV policy', () => {
    expect(() => verifier({ imageDigest: 'latest' })).toThrow(/imageDigest/);
    expect(() => verifier({ audience: '' })).toThrow(/audience/);
    expect(() => verifier({ hwModels: ['GCP_SHIELDED_VM'] })).toThrow(/AMD SEV/);
  });
});
