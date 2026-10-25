// Register a desktop app's existing blind token for one WireGuard quota block.
// The token and private key arrive over stdin; neither is placed in process arguments or logs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveWireGuardPublicKey,
  fetchVerifiedWireGuardReceipt,
  registerWireGuardPeer,
  WireGuardRegistrationError,
} from '@wraps/sdk';
import { deserializeToken } from '@wraps/tokens';
import embeddedExpected from '../../infra/gcp/expected.json' with { type: 'json' };
import { createLiveVerifier, resolveLiveConfig } from '../../scripts/live-config';

type Input = { token: string; privateKey: string };

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new RangeError('connect input is too large');
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<Input>;
  if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(value.token)) throw new TypeError('one serialized blind token is required');
  if (typeof value.privateKey !== 'string') throw new TypeError('a WireGuard private key is required');
  return { token: value.token, privateKey: value.privateKey };
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  let registrationAttempted = false;
  const attestOnly = process.argv.includes('--attest-only');
  try {
    const input = attestOnly ? undefined : await readInput();
    if (input) {
      deriveWireGuardPublicKey(input.privateKey);
      deserializeToken(input.token);
    }

    // Match the standalone helper: the attested image digest is embedded at app build time.
    process.env.ISSUER_URL ??= 'https://34.123.78.11';
    process.env.RELAY_URL ??= 'https://136.80.57.82';
    let embeddedDir: string | undefined;
    if (!process.env.EXPECTED_JSON) {
      embeddedDir = mkdtempSync(join(tmpdir(), 'wraps-'));
      process.env.EXPECTED_JSON = join(embeddedDir, 'expected.json');
      writeFileSync(process.env.EXPECTED_JSON, JSON.stringify(embeddedExpected), { mode: 0o600 });
    }
    const config = await (async () => {
      try {
        return await resolveLiveConfig();
      } finally {
        if (embeddedDir) rmSync(embeddedDir, { recursive: true, force: true });
      }
    })();

    const receipt = await fetchVerifiedWireGuardReceipt(
      new URL('/wireguard-attestation', config.relayAttestationUrl).toString(),
      createLiveVerifier(config, 'relay'),
    );
    if (attestOnly) {
      output({ ok: true, imageDigest: config.expected.relayDigest, endpoint: receipt.endpoint, registration: receipt.registration });
      return;
    }
    if (!input) throw new Error('connect token is missing');
    if (receipt.registration !== 'open-paid') throw new Error('relay does not allow paid peer registration');

    registrationAttempted = true;
    const address = await registerWireGuardPeer(receipt, input.privateKey, [deserializeToken(input.token)]);
    if (!address) throw new Error('relay returned no tunnel address');

    const profile = [
      '[Interface]',
      `PrivateKey = ${input.privateKey}`,
      `Address = ${address}`,
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${receipt.serverPublicKey}`,
      `Endpoint = ${receipt.endpoint}:${receipt.listenPort}`,
      `AllowedIPs = ${receipt.clientAllowedIPs}`,
      'PersistentKeepalive = 25',
      '',
    ].join('\n');
    output({ status: 'registered', profile, address, endpoint: receipt.endpoint, megabytes: 10 });
  } catch (error) {
    if (attestOnly) {
      process.stderr.write(`Error: ${String(error).replace(/[\r\n]/g, ' ').slice(0, 160)}\n`);
      process.exitCode = 1;
      return;
    }
    const status = error instanceof WireGuardRegistrationError
      ? error.outcome
      : registrationAttempted ? 'unknown' : 'rejected';
    output({ status, error: String(error).replace(/[\r\n]/g, ' ').slice(0, 160) });
  }
}

void main();
