import { startIssuer } from './start';

const issuer = await startIssuer({
  port: Number(process.env.ISSUER_PORT ?? 4001),
  buildName: process.env.ISSUER_BUILD ?? 'issuer',
  debugMode: process.env.ISSUER_DEBUG_MODE === '1',
  payoutIntervalMs: Number(process.env.PAYOUT_INTERVAL_MS ?? 30_000),
});
console.log(`[issuer] listening on ${issuer.url} (MOCK attestation, MOCK AP4M rail, MOCK payouts)`);
