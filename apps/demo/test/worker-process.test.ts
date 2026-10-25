import { describe, expect, it } from 'vitest';
import { buildWorkerRunArgs, DEFAULT_WORKER_IMAGE } from '../src/worker-process';

const input = {
  expectedJson: '/repo/infra/gcp/expected.json',
  issuerUrl: 'https://34.123.78.11',
  relayUrl: 'https://136.80.57.82',
  relayAttestationUrl: 'http://136.80.57.82:8080/attestation',
  relayIp: '136.80.57.82',
  merchantUrl: 'https://merchant.example',
  containerName: 'wraps-agent-test',
};

describe('isolated live agent worker', () => {
  it('runs with a read-only policy mount and only the relay IP in its egress config', () => {
    const args = buildWorkerRunArgs(input);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--cap-add=NET_ADMIN');
    expect(args).toContain('--cap-add=SETUID');
    expect(args).toContain('--cap-add=SETGID');
    expect(args).toContain('--read-only');
    expect(args).toContain('--dns=127.0.0.1');
    expect(args).toContain('--dns-search=.');
    expect(args).toContain('WRAPS_RELAY_IP=136.80.57.82');
    expect(args).toContain('RELAY_URL=https://136.80.57.82');
    expect(args).toContain('RELAY_ATTESTATION_URL=http://136.80.57.82:8080/attestation');
    expect(args).toContain('DEMO_MERCHANT_URL=https://merchant.example');
    expect(args).toContain(DEFAULT_WORKER_IMAGE);
    expect(args).not.toContain('--network=host');
    expect(args).not.toContain('QUICKNODE_XRPL_URL');
  });

  it('refuses hostnames for the allowlisted relay and issuer addresses', () => {
    expect(() => buildWorkerRunArgs({ ...input, relayIp: 'relay.example' })).toThrow(/numeric IPv4 relay IP/);
    expect(() => buildWorkerRunArgs({ ...input, issuerUrl: 'https://issuer.example' })).toThrow(/numeric IPv4 issuer/);
  });

  it('rejects a policy mount path that Docker could parse as extra mount options', () => {
    expect(() => buildWorkerRunArgs({ ...input, expectedJson: '/tmp/expected,readonly=false.json' })).toThrow(/comma or colon/);
  });
});
