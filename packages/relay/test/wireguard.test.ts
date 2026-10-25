import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayTlsIdentity } from '../src/tls-identity.js';
import { createWireGuardAttestationResponse } from '../src/attestation.js';
import { startWireGuardGateway } from '../src/wireguard.js';
import { WIREGUARD_BYTES_PER_TOKEN, createWireGuardQuotaController } from '../src/wireguard-quota.js';
import { WireGuardTokenMeter } from '../src/wireguard-meter.js';
import { relaySettlementQuoteId } from '../src/meter.js';

const serverKey = Buffer.alloc(32, 7).toString('base64');
const peerKey = Buffer.alloc(32, 8).toString('base64');
const peer = { publicKey: peerKey, allowedAddress: '10.77.0.2/32' };
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WireGuard gateway', () => {
  it('accepts canonical 32-byte keys and starts with a fail-closed quota firewall', async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    let config = '';
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'wraps-wireguard-test-'));
    tempDirectories.push(runtimeDirectory);
    const gateway = await startWireGuardGateway({
      endpoint: 'relay.example.test',
      listenPort: 51820,
      interfaceAddress: '10.77.0.1/24',
      egressInterface: 'ens4',
      peers: [peer],
      runtimeDirectory,
      requireTmpfs: false,
      runCommand: async (command, args, input) => {
        calls.push({ command, args, input });
        if (command === 'wg' && args[0] === 'genkey') return serverKey;
        if (command === 'wg' && args[0] === 'pubkey') return serverKey;
        if (command === 'sysctl') return '1';
        if (command === 'wg-quick' && args[0] === 'up') config = await readFile(args[1], 'utf8');
        return '';
      },
    });

    expect(gateway.identity.publicKey).toBe(serverKey);
    expect(config).toContain(`PrivateKey = ${serverKey}`);
    expect(calls.some((call) => call.command === 'nft' && call.args[0] === '-f' && call.input?.includes('peers iifname "wg0" drop'))).toBe(true);
    await gateway.stop();
  });

  it('rejects malformed generated WireGuard keys before bringing the interface up', async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === 'wg' && args[0] === 'genkey') return 'not-a-wireguard-key';
      return '';
    });
    await expect(startWireGuardGateway({
      endpoint: 'relay.example.test',
      listenPort: 51820,
      interfaceAddress: '10.77.0.1/24',
      egressInterface: 'ens4',
      peers: [peer],
      requireTmpfs: false,
      runCommand,
    })).rejects.toThrow('generated private key must be a 32-byte WireGuard key');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('binds the 44-character WireGuard public key and quota policy into attestation', async () => {
    const tls = await createRelayTlsIdentity('relay.example.test');
    const nonce = Buffer.alloc(32, 3);
    let publicKeyHash: Uint8Array | undefined;
    const receipt = await createWireGuardAttestationResponse(nonce, {
      tlsCertificate: tls.certPem,
      provider: {
        format: 'test',
        async attest(_nonce, keysHash) { publicKeyHash = keysHash; return 'attestation'; },
      },
      wireGuard: {
        publicKey: serverKey,
        policyHash: 'a'.repeat(64),
        endpoint: 'relay.example.test',
        listenPort: 51820,
        interfaceAddress: '10.77.0.1/24',
        egressInterface: 'ens4',
        peers: [peer],
        clientAllowedIPs: '0.0.0.0/0',
        bytesPerToken: WIREGUARD_BYTES_PER_TOKEN,
        metering: 'bidirectional-inner-ipv4',
      },
    });
    expect(receipt.publicKeys.wireguard).toBe(serverKey);
    expect(receipt.networkPolicy.bytesPerToken).toBe(WIREGUARD_BYTES_PER_TOKEN);
    expect(publicKeyHash).toBeDefined();
  });
});

describe('WireGuard nftables quotas', () => {
  it('sets one shared bidirectional quota and reads/resets its named counter', async () => {
    const quotaName = `p_${createHash('sha256').update(peerKey).digest('hex').slice(0, 24)}`;
    const calls: Array<{ args: string[]; input?: string }> = [];
    const quotas = await createWireGuardQuotaController(async (_command, args, input) => {
      calls.push({ args, input });
      if (args[0] === 'list') return `table inet wraps_wg { quota ${quotaName} { until 10000000 bytes used 10000000 bytes } }`;
      return '';
    });
    const setup = calls[0].input ?? '';
    const blockedDestinations = setup.indexOf('iifname "wg0" ip daddr { 0.0.0.0/8, 10.0.0.0/8');
    const quotaHook = setup.indexOf('iifname "wg0" jump peers');
    expect(blockedDestinations).toBeGreaterThanOrEqual(0);
    expect(blockedDestinations).toBeLessThan(quotaHook);
    await quotas.enable(peerKey, '10.77.0.2');
    expect(calls.some((call) => call.args[0] === '-f' && call.input?.includes('quota name'))).toBe(true);
    expect(await quotas.usedBytes()).toEqual(new Map([[peerKey, WIREGUARD_BYTES_PER_TOKEN]]));
    expect(calls.some((call) => call.args.join(' ') === 'list quotas table inet wraps_wg')).toBe(true);
    await quotas.reset(peerKey);
    await quotas.close();
    expect(calls.some((call) => call.args.join(' ') === 'reset quota inet wraps_wg ' + quotaName)).toBe(true);
  });
});

describe('WireGuard prepaid token meter', () => {
  it('reopens an exhausted peer after each single-token prepaid refill', async () => {
    vi.useFakeTimers();
    const usage = new Map<string, number>();
    const reset = vi.fn(async (key: string) => { usage.set(key, 0); });
    const quotas = {
      enable: vi.fn(async (key: string) => { usage.set(key, 0); }),
      usedBytes: vi.fn(async () => new Map(usage)),
      reset,
      close: vi.fn(async () => {}),
    };
    const settle = vi.fn(async (_merchantId: string, _token: string, _quoteId: string) => {});
    const meter = new WireGuardTokenMeter([peer], 'relay', {
      verify: async () => true,
      settle,
    }, quotas, 10);
    try {
      await meter.register(peerKey, ['token-1']);
      usage.set(peerKey, WIREGUARD_BYTES_PER_TOKEN);
      await vi.advanceTimersByTimeAsync(10);
      expect(reset).not.toHaveBeenCalled();

      await meter.register(peerKey, ['token-2']);
      expect(reset).toHaveBeenCalledTimes(1);
      expect(usage.get(peerKey)).toBe(0);

      usage.set(peerKey, WIREGUARD_BYTES_PER_TOKEN);
      await vi.advanceTimersByTimeAsync(10);
      expect(reset).toHaveBeenCalledTimes(1);
      await meter.register(peerKey, ['token-3']);
      expect(reset).toHaveBeenCalledTimes(2);
      expect(usage.get(peerKey)).toBe(0);
      expect(settle).toHaveBeenCalledTimes(3);
      expect(settle.mock.calls.map(([, , quoteId]) => quoteId)).toEqual([
        relaySettlementQuoteId('wireguard-registration', peerKey, 'token-1'),
        relaySettlementQuoteId('wireguard-registration', peerKey, 'token-2'),
        relaySettlementQuoteId('wireguard-registration', peerKey, 'token-3'),
      ]);
    } finally {
      meter.close();
    }
  });

  it('replays a completed registration without settling or granting another quota block', async () => {
    const usage = new Map<string, number>();
    const enable = vi.fn(async (key: string) => { usage.set(key, 0); });
    const settle = vi.fn(async (_merchantId: string, _token: string, _quoteId: string) => {});
    let verifies = 0;
    const meter = new WireGuardTokenMeter([peer], 'relay', {
      verify: async () => { verifies++; return true; },
      settle,
    }, {
      enable,
      usedBytes: async () => new Map(usage),
      reset: async () => { usage.set(peerKey, 0); },
      close: async () => {},
    }, 10);
    try {
      const first = await meter.register(peerKey, ['retry-token']);
      const retry = await meter.register(peerKey, ['retry-token']);
      expect(retry).toBe(first);
      expect(verifies).toBe(1);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(enable).toHaveBeenCalledTimes(1);
    } finally {
      meter.close();
    }
  });

  it('reuses the quote ID when settlement succeeded but quota setup must be retried', async () => {
    const usage = new Map<string, number>();
    const settle = vi.fn(async (_merchantId: string, _token: string, _quoteId: string) => {});
    const settleStatus = vi.fn(async () => ({ status: 'settled-by-you' }));
    const enable = vi.fn(async (key: string) => {
      if (enable.mock.calls.length === 1) throw new Error('quota unavailable');
      usage.set(key, 0);
    });
    let verifies = 0;
    const meter = new WireGuardTokenMeter([peer], 'relay', {
      verify: async () => { verifies++; return verifies === 1; },
      settle,
      settleStatus,
    }, {
      enable,
      usedBytes: async () => new Map(usage),
      reset: async () => { usage.set(peerKey, 0); },
      close: async () => {},
    }, 10);
    try {
      await expect(meter.register(peerKey, ['retry-after-quota-failure'])).rejects.toThrow('quota-failed');
      const address = await meter.register(peerKey, ['retry-after-quota-failure']);
      expect(address).toBe(peer.allowedAddress);
      expect(settle).toHaveBeenCalledTimes(2);
      expect(settle.mock.calls[0][2]).toBe(settle.mock.calls[1][2]);
      expect(settleStatus).toHaveBeenCalledWith(
        'relay',
        relaySettlementQuoteId('wireguard-registration', peerKey, 'retry-after-quota-failure'),
        ['retry-after-quota-failure'],
      );
      expect(enable).toHaveBeenCalledTimes(2);
    } finally {
      meter.close();
    }
  });
});
