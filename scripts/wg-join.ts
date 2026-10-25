// npm run wg:join: join the attested wraps relay over WireGuard in one command.
//
// The WireGuard key is generated here and never leaves this machine. The script
// verifies the relay's Confidential Space attestation and WireGuard receipt, buys
// blind tokens from the attested issuer (mock top-up rail), pays the relay with
// them, and writes a WireGuard profile (plus a QR code for the phone app).
//
//   npm run wg:join                       # 10 tokens = 100 MB, QR in the terminal
//   npm run wg:join -- --tokens 3 --out my.conf --no-qr

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { MockTopUpWallet, PrivatePayClient, fetchVerifiedWireGuardReceipt } from '@wraps/sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import embeddedExpected from '../infra/gcp/expected.json' with { type: 'json' };
import { createLiveVerifier, resolveLiveConfig } from './live-config';

// Defaults so the compiled helper works anywhere (the desktop app bundles it).
// Both IPs are reserved; the expected image digests are embedded at build time.
process.env.ISSUER_URL ??= 'https://34.123.78.11';
process.env.RELAY_URL ??= 'https://136.80.57.82';
if (!process.env.EXPECTED_JSON) {
  const dir = mkdtempSync(join(tmpdir(), 'wraps-'));
  process.env.EXPECTED_JSON = join(dir, 'expected.json');
  writeFileSync(process.env.EXPECTED_JSON, JSON.stringify(embeddedExpected), { mode: 0o600 });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --json: machine output for the desktop app. Progress goes to stderr, the
// result (profile included) goes to stdout as one JSON line. No file is written.
const json = process.argv.includes('--json');
const log = (...m: unknown[]) => (json ? console.error : console.log)(...m);
const tokens = Number(arg('--tokens') ?? 10);
if (!Number.isInteger(tokens) || tokens < 1 || tokens > 20) throw new Error('--tokens must be 1 to 20 (1 token = 10 MB)');
const out = arg('--out') ?? `wraps-${randomBytes(3).toString('hex')}.conf`;

function newWireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const d = privateKey.export({ format: 'jwk' }).d!;
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { privateKey: Buffer.from(d, 'base64url').toString('base64'), publicKey: Buffer.from(x, 'base64url').toString('base64') };
}

const config = await resolveLiveConfig();
log(`relay  ${config.relayAttestationUrl}`);
log(`issuer ${config.issuerUrl}`);

const wireGuardAttestationUrl = new URL('/wireguard-attestation', config.relayAttestationUrl).toString();
const receipt = await fetchVerifiedWireGuardReceipt(wireGuardAttestationUrl, createLiveVerifier(config, 'relay'));
log(`✓ relay attestation verified (Confidential Space, image ${config.expected.relayDigest.slice(0, 19)}…)`);
log(`  WireGuard ${receipt.endpoint}:${receipt.listenPort}, registration: ${receipt.registration}`);
if (receipt.registration !== 'open-paid') throw new Error('this relay only admits pre-registered keys');
if (process.argv.includes('--attest-only')) {
  // The desktop app's periodic re-check: attestation verified above, nothing bought.
  process.stdout.write(`${JSON.stringify({ ok: true, imageDigest: config.expected.relayDigest, endpoint: receipt.endpoint, registration: receipt.registration })}\n`);
  process.exit(0);
}

const sdk = new PrivatePayClient({
  issuerUrl: config.issuerUrl,
  verifier: createLiveVerifier(config, 'issuer'),
  wallet: new MockTopUpWallet(),
  caps: { perCallTokens: 5, dailyTokens: 50, maxTopUpTokens: 20 },
});
await sdk.connect();
log('✓ issuer attestation verified, TLS key pinned');
await sdk.topUp(tokens);
log(`✓ bought ${tokens} blind tokens (mock top-up rail)`);

const keys = newWireGuardKeyPair();
let address: string | undefined;
for (let i = 0; i < tokens; i++) {
  const joined = await sdk.joinWireGuard(receipt, keys.privateKey);
  address ??= joined.address;
}
if (!address) throw new Error('relay did not return a tunnel address');
log(`✓ paid the relay ${tokens} tokens = ${tokens * 10} MB, tunnel address ${address}`);

// Portable profile: imports into the WireGuard app on macOS, Windows, iOS and Android.
const profile = [
  '[Interface]',
  `PrivateKey = ${keys.privateKey}`,
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
if (json) {
  process.stdout.write(`${JSON.stringify({ profile, address, endpoint: receipt.endpoint, listenPort: receipt.listenPort, serverPublicKey: receipt.serverPublicKey, megabytes: tokens * 10 })}\n`);
  process.exit(0);
}
writeFileSync(out, profile, { mode: 0o600, flag: 'wx' });
console.log(`✓ wrote ${out} (keep it private: it holds your WireGuard private key)`);

if (!process.argv.includes('--no-qr')) {
  console.log('\nScan with the WireGuard app (Add tunnel → Create from QR code):\n');
  console.log(await QRCode.toString(profile, { type: 'terminal', small: true }));
}
console.log(`Then open https://api.ipify.org: it should show ${receipt.endpoint}.`);
console.log('Every relay restart makes a new server key and clears registrations: run this again after one.');
