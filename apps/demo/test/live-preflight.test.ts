import { describe, expect, it, vi } from 'vitest';
import { parseLiveConfig } from '../../../scripts/live-config';
import { runLivePreflight, type PreflightDependencies } from '../../../scripts/live-preflight';
import type { PinnedRelayTransport } from '@wraps/sdk';
import type { AttestedIssuer } from '@wraps/issuer';

const config = parseLiveConfig({
  ISSUER_URL: 'https://issuer.example',
  RELAY_URL: 'https://relay.example',
});

function fakeIssuer(measurement = config.expected.issuerDigest): AttestedIssuer {
  return {
    url: config.issuerUrl,
    issuerName: 'wraps',
    tokenKey: new Uint8Array([1]),
    claimKey: new Uint8Array([2]),
    tlsKey: new Uint8Array([3]),
    attestation: {
      format: 'gcp-confidential-space-v1',
      moduleId: 'test',
      timestamp: Date.now(),
      pcrs: {},
      measurement,
      publicKeysHash: '00',
      nonce: '00',
    },
  };
}

function fakeRelay(measurement = config.expected.relayDigest): PinnedRelayTransport {
  return {
    relay: {
      url: config.relayUrl,
      tunnelKey: new Uint8Array([1]),
      tlsCertificate: 'certificate',
      attestation: {
        format: 'gcp-confidential-space-v1',
        moduleId: 'test',
        timestamp: Date.now(),
        pcrs: {},
        measurement,
        publicKeysHash: '00',
        nonce: '00',
      },
    },
    issuerOrigin: config.issuerUrl,
    fetchWithTokens: vi.fn(),
    fetchIssuerWithPeer: vi.fn(),
    fetchIssuer: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as PinnedRelayTransport;
}

function deps(overrides: Partial<PreflightDependencies> = {}): PreflightDependencies {
  return {
    probeIssuer: vi.fn(async () => {}),
    verifyIssuer: vi.fn(async () => fakeIssuer()),
    probeRelay: vi.fn(async () => {}),
    verifyRelay: vi.fn(async () => fakeRelay()),
    verifyRelayTlsPin: vi.fn(async () => {}),
    verifyIssuerThroughRelay: vi.fn(async () => fakeIssuer()),
    probeXrplNode: vi.fn(async () => {}),
    vmHint: vi.fn(async (role) => `check VM for ${role}`),
    checkMerchantTunnel: vi.fn(async () => 'cloudflared available'),
    ...overrides,
  };
}

describe('live demo preflight checklist', () => {
  it('prints a green checklist when issuer, relay, and XRPL checks pass', async () => {
    const lines: string[] = [];
    const result = await runLivePreflight(config, deps(), (line) => lines.push(line));
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain('Issuer attestation verifies');
    expect(result.checks.map((check) => check.name)).toContain('Relay image digest matches expected.json');
    expect(lines.some((line) => line.startsWith('✓ PASS'))).toBe(true);
    expect(lines.at(-1)).toBe('All live demo checks passed.');
  });

  it('marks service failures red and still reports XRPL node results', async () => {
    const lines: string[] = [];
    const result = await runLivePreflight(config, deps({
      probeIssuer: async () => { throw new Error('issuer refused connection'); },
      verifyRelay: async () => fakeRelay(`sha256:${'c'.repeat(64)}`),
      probeXrplNode: async (url) => {
        if (url.includes('s1.ripple.com')) throw new Error('node timeout');
      },
    }), (line) => lines.push(line));
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'Issuer reachable')?.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'Relay image digest matches expected.json')?.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'XRPL mainnet public nodes reachable')?.passed).toBe(true);
    expect(lines.at(-1)).toMatch(/Preflight failed/);
  });
});
