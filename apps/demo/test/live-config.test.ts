import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveConfigError, parseLiveConfig, resolveLiveConfig, resolveLiveConfigForPreflight } from '../../../scripts/live-config';

const DIGEST_ISSUER = `sha256:${'a'.repeat(64)}`;
const DIGEST_RELAY = `sha256:${'b'.repeat(64)}`;
let dir: string;

function setup() {
  dir = mkdtempSync(resolve(tmpdir(), 'wraps-live-config-'));
  mkdirSync(resolve(dir, 'infra/gcp/.state'), { recursive: true });
  writeFileSync(resolve(dir, 'infra/gcp/expected.json'), JSON.stringify({
    audience: 'https://wraps.invalid/issuer',
    hwModels: ['GCP_AMD_SEV'],
    requiredSupportAttribute: 'STABLE',
    roles: { issuer: { imageDigest: DIGEST_ISSUER }, relay: { imageDigest: DIGEST_RELAY } },
  }));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('live demo configuration', () => {
  it('reads issuer/relay addresses from .state and digests from expected.json', () => {
    const cwd = setup();
    writeFileSync(resolve(cwd, 'infra/gcp/.state/issuer.ip'), '34.1.2.3\n');
    writeFileSync(resolve(cwd, 'infra/gcp/.state/relay.ip'), '34.4.5.6\n');

    const config = parseLiveConfig({}, cwd);

    expect(config.issuerUrl).toBe('https://34.1.2.3');
    expect(config.relayUrl).toBe('https://34.4.5.6');
    expect(config.relayAttestationUrl).toBe('http://34.4.5.6:8080/attestation');
    expect(config.expected.issuerDigest).toBe(DIGEST_ISSUER);
    expect(config.expected.relayDigest).toBe(DIGEST_RELAY);
  });

  it('uses explicit environment values and validates the relay attestation port', () => {
    const cwd = setup();
    const config = parseLiveConfig({
      ISSUER_URL: 'https://issuer.example',
      RELAY_IP: '34.7.8.9',
      RELAY_ATTESTATION_PORT: '18080',
      RELAY_ATTESTATION_URL: 'http://relay.example:8088/custom',
      EXPECTED_ISSUER_DIGEST: DIGEST_RELAY,
    }, cwd);

    expect(config.issuerUrl).toBe('https://issuer.example');
    expect(config.relayUrl).toBe('https://34.7.8.9');
    expect(config.relayAttestationUrl).toBe('http://relay.example:8088/attestation');
    expect(config.relayAttestationPort).toBe(18080);
    expect(config.expected.issuerDigest).toBe(DIGEST_RELAY);
    expect(() => parseLiveConfig({
      ISSUER_URL: 'https://issuer.example',
      RELAY_URL: 'https://relay.example',
      RELAY_ATTESTATION_PORT: '70000',
    }, cwd)).toThrow(/RELAY_ATTESTATION_PORT/);
  });

  it('reports the exact deploy command when an endpoint is missing', () => {
    const cwd = setup();
    expect(() => parseLiveConfig({}, cwd)).toThrow(/infra\/gcp\/deploy\.sh issuer/);
  });

  it('uses injected read-only VM discovery when state files are absent', async () => {
    const cwd = setup();
    const seen: string[] = [];
    const config = await resolveLiveConfig({}, cwd, async (role) => {
      seen.push(role);
      return role === 'issuer' ? '34.1.2.3' : '34.4.5.6';
    });
    expect(seen).toEqual(['issuer', 'relay']);
    expect(config.issuerUrl).toBe('https://34.1.2.3');
    expect(config.relayUrl).toBe('https://34.4.5.6');
  });

  it('keeps the other endpoint available to preflight when one VM is stopped', async () => {
    const cwd = setup();
    const resolved = await resolveLiveConfigForPreflight({}, cwd, async (role) => {
      if (role === 'issuer') throw new LiveConfigError('issuer VM is STAGING', role);
      return '34.4.5.6';
    });
    expect(resolved.unavailable.issuer).toBe('issuer VM is STAGING');
    expect(resolved.config.relayUrl).toBe('https://34.4.5.6');
  });
});
