// ConfidentialSpaceVerifier against locally signed test tokens. The key set is a
// local RSA key standing in for Google's JWKS. Claim names follow the Confidential
// Space token-claims reference.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttestationError,
  ConfidentialSpaceProvider,
  ConfidentialSpaceVerifier,
  GCP_ATTESTATION_ISSUER,
  confidentialSpaceNonces,
  hashPublicKeys,
} from '../src/index';

const AUD = 'https://wraps.invalid/issuer';
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const keys = { token: new Uint8Array([1, 2, 3]), claim: new Uint8Array([4, 5, 6]), tls: new Uint8Array([7, 8]) };
const keysHash = hashPublicKeys(keys);

let signKey: KeyLike;
let otherKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  signKey = kp.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-google', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

function claims(nonce: Uint8Array, over: Record<string, unknown> = {}): JWTPayload {
  const base: JWTPayload = {
    iss: GCP_ATTESTATION_ISSUER,
    aud: AUD,
    sub: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/1',
    eat_nonce: confidentialSpaceNonces(nonce, keysHash),
    hwmodel: 'GCP_AMD_SEV',
    swname: 'CONFIDENTIAL_SPACE',
    swversion: ['250301'],
    dbgstat: 'disabled-since-boot',
    secboot: true,
    oemid: 11129,
    submods: {
      container: { image_digest: DIGEST, image_reference: `us-central1-docker.pkg.dev/p/r/issuer@${DIGEST}` },
      confidential_space: { support_attributes: ['LATEST', 'STABLE', 'USABLE'] },
      gce: { instance_id: '1', instance_name: 'wraps-issuer', project_id: 'p', zone: 'us-central1-a' },
    },
  };
  return { ...base, ...over };
}

async function sign(payload: JWTPayload, key = signKey, ttlSec = 3600): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-google', typ: 'JWT' })
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(key);
}

const verifier = () =>
  new ConfidentialSpaceVerifier({ imageDigest: DIGEST, audience: AUD, hwModels: ['GCP_AMD_SEV'], requiredSupportAttribute: 'STABLE', keys: jwks });

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AttestationError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('Confidential Space verifier', () => {
  it('accepts a good production token', async () => {
    const nonce = randomBytes(32);
    const v = await verifier().verify(await sign(claims(nonce)), { nonce, publicKeysHash: keysHash });
    expect(v.measurement).toBe(DIGEST);
    expect(v.details.dbgstat).toBe('disabled-since-boot');
  });

  it('refuses a tampered image digest', async () => {
    const nonce = randomBytes(32);
    const c = claims(nonce);
    (c.submods as any).container.image_digest = `sha256:${'cd'.repeat(32)}`;
    await expectCode(verifier().verify(await sign(c), { nonce, publicKeysHash: keysHash }), 'IMAGE_MISMATCH');
  });

  it('refuses a debug image (dbgstat enabled, no support attributes)', async () => {
    const nonce = randomBytes(32);
    const c = claims(nonce, { dbgstat: 'enabled' });
    await expectCode(verifier().verify(await sign(c), { nonce, publicKeysHash: keysHash }), 'DEBUG_MODE');
  });

  it('refuses a wrong nonce and a replayed token', async () => {
    const nonce = randomBytes(32);
    const token = await sign(claims(nonce));
    await expectCode(verifier().verify(token, { nonce: randomBytes(32), publicKeysHash: keysHash }), 'NONCE_MISMATCH');
    const v = verifier();
    await v.verify(token, { nonce, publicKeysHash: keysHash });
    await expectCode(v.verify(token, { nonce, publicKeysHash: keysHash }), 'NONCE_REUSED');
  });

  it('refuses a wrong key hash (e.g. a swapped TLS key)', async () => {
    const nonce = randomBytes(32);
    const token = await sign(claims(nonce));
    const other = hashPublicKeys({ ...keys, tls: new Uint8Array([9, 9]) });
    await expectCode(verifier().verify(token, { nonce, publicKeysHash: other }), 'KEY_MISMATCH');
  });

  it('refuses a token not signed by the trusted key', async () => {
    const nonce = randomBytes(32);
    await expectCode(verifier().verify(await sign(claims(nonce), otherKey), { nonce, publicKeysHash: keysHash }), 'BAD_SIGNATURE');
  });

  it('refuses a wrong issuer and a wrong audience', async () => {
    const nonce = randomBytes(32);
    await expectCode(verifier().verify(await sign(claims(nonce, { iss: 'https://evil.invalid' })), { nonce, publicKeysHash: keysHash }), 'BAD_ISSUER');
    await expectCode(verifier().verify(await sign(claims(nonce, { aud: 'https://sts.googleapis.com' })), { nonce, publicKeysHash: keysHash }), 'BAD_AUDIENCE');
  });

  it('refuses an expired token', async () => {
    const nonce = randomBytes(32);
    await expectCode(verifier().verify(await sign(claims(nonce), signKey, -120), { nonce, publicKeysHash: keysHash }), 'STALE');
  });

  it('refuses the wrong platform: plain GCE, unknown hardware, no STABLE support', async () => {
    const nonce = () => randomBytes(32);
    let n = nonce();
    await expectCode(verifier().verify(await sign(claims(n, { swname: 'GCE' })), { nonce: n, publicKeysHash: keysHash }), 'BAD_PLATFORM');
    n = nonce();
    await expectCode(verifier().verify(await sign(claims(n, { hwmodel: 'GCP_SHIELDED_VM' })), { nonce: n, publicKeysHash: keysHash }), 'BAD_PLATFORM');
    n = nonce();
    const c = claims(n);
    (c.submods as any).confidential_space.support_attributes = ['USABLE'];
    await expectCode(verifier().verify(await sign(c), { nonce: n, publicKeysHash: keysHash }), 'BAD_PLATFORM');
  });
});

describe('Confidential Space provider', () => {
  let dir: string;
  let seen: any;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'teeserver-'));
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body: JSON.parse(b) };
        res.end('aaa.bbb.ccc');
      });
    });
    await new Promise<void>((r) => server.listen(join(dir, 'teeserver.sock'), r));
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the launcher for an OIDC token with [nonce, keys hash]', async () => {
    const nonce = randomBytes(32);
    const p = new ConfidentialSpaceProvider({ socketPath: join(dir, 'teeserver.sock') });
    expect(await p.attest(nonce, keysHash)).toBe('aaa.bbb.ccc');
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1/token');
    expect(seen.body).toEqual({ audience: AUD, token_type: 'OIDC', nonces: [nonce.toString('hex'), Buffer.from(keysHash).toString('hex')] });
  });
});
