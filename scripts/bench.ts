#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { MockAttestationVerifier, b64u, generateEd25519, mockPcrs } from '@wraps/attestation';
import { Merchant } from '@wraps/merchant';
import { startIssuer } from '@wraps/issuer';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';
import { DEFAULT_SIM, formatReport, report } from '../packages/spybot/src/sim';

const { values } = parseArgs({
  options: {
    samples: { type: 'string', default: '50' },
    warmup: { type: 'string', default: '5' },
    agents: { type: 'string', default: '1,5,20,100' },
    'payout-min': { type: 'string', default: '5,60,360,1440' },
    trials: { type: 'string', default: String(DEFAULT_SIM.trials) },
    seed: { type: 'string', default: String(DEFAULT_SIM.seed) },
    json: { type: 'boolean', default: false },
  },
});

const sampleCount = Number(values.samples);
const warmupCount = Number(values.warmup);
const trials = Number(values.trials);
const seed = Number(values.seed);
const agentCounts = values.agents.split(',').map(Number);
const intervals = values['payout-min'].split(',').map(Number);
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 5000) throw new Error('--samples must be an integer from 1 to 5000');
if (!Number.isInteger(warmupCount) || warmupCount < 0 || warmupCount > 500) throw new Error('--warmup must be an integer from 0 to 500');
if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer');
if (!Number.isFinite(seed)) throw new Error('--seed must be a number');
if (agentCounts.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--agents must be comma-separated positive integers');
if (intervals.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('--payout-min must be comma-separated positive minutes');

const quiet = () => {};
const verifier = new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') });
const caps = { perCallTokens: 5, dailyTokens: 10_000, maxTopUpTokens: 20 };
const merchantId = 'merchant-research-data';
const merchantAuthKey = generateEd25519();
const issuer = await startIssuer({
  log: quiet,
  payoutIntervalMs: 3_600_000,
  merchantAuth: { publicKeys: { [merchantId]: b64u(merchantAuthKey.publicKeyBytes) } },
});
const merchant = new Merchant({ merchantId, authPrivateKey: merchantAuthKey.privateKey, issuerUrl: issuer.url, verifier, log: quiet, injectPrompt: false });

try {
  const merchantUrl = await merchant.start();
  const sdk = new PrivatePayClient({
    issuerUrl: issuer.url,
    verifier,
    wallet: new MockTopUpWallet(),
    caps,
  });
  await sdk.connect();
  await sdk.topUp(caps.maxTopUpTokens);

  const purchase = `${merchantUrl}/analytics?asset=XRP`;
  const buy = async () => {
    if (sdk.balance < 2) await sdk.topUp(caps.maxTopUpTokens);
    const start = performance.now();
    const response = await sdk.fetch(purchase);
    if (!response.ok) throw new Error(`paid request failed with HTTP ${response.status}`);
    await response.arrayBuffer();
    return performance.now() - start;
  };

  for (let i = 0; i < warmupCount; i++) await buy();
  const durations: number[] = [];
  for (let i = 0; i < sampleCount; i++) durations.push(await buy());
  durations.sort((a, b) => a - b);

  const percentile = (p: number) => durations[Math.max(0, Math.ceil(p * durations.length) - 1)];
  const latency = {
    samples: sampleCount,
    warmup: warmupCount,
    p50Ms: Number(percentile(0.50).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    minMs: Number(durations[0].toFixed(2)),
    maxMs: Number(durations[durations.length - 1].toFixed(2)),
    environment: 'local HTTP servers; mock attestation, top-up rail and payouts; includes 402 challenge, blind-token payment, issuer verify/settle and merchant response',
  };

  const simParams = { ...DEFAULT_SIM, trials, seed };
  const privacy = report(simParams, agentCounts, intervals);
  if (values.json) {
    process.stdout.write(JSON.stringify({ latency, privacy, simulation: simParams }, null, 2) + '\n');
  } else {
    process.stdout.write('Paid-call latency, measured locally (local HTTP servers, mock attestation and rails; not a Nitro, Confidential Space or ledger benchmark)\n');
    process.stdout.write(`samples=${sampleCount}, warmup=${warmupCount} · p50 ${latency.p50Ms} ms · p95 ${latency.p95Ms} ms · min ${latency.minMs} ms · max ${latency.maxMs} ms\n\n`);
    process.stdout.write(`Watcher inference, simulated (${trials} seeded trials; seed ${seed}).\n`);
    process.stdout.write('Realistic: the watcher sees only top-ups and one payout total per merchant per interval.\n');
    process.stdout.write("Oracle: the watcher also sees every hidden call's exact time and merchant. Upper bound, not observable on chain.\n\n");
    process.stdout.write(formatReport(privacy) + '\n');
  }
} finally {
  await merchant.close();
  await issuer.close();
}
