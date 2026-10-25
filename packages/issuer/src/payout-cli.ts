// npm run payout:dry-run   prints the next payout batch of a running issuer, sends nothing
// npm run payout:once      asks the running issuer to send one batch now (PAYOUT_RAIL=xrpl-evm and a key)
//
// ISSUER_URL (default http://127.0.0.1:4001), ISSUER_ADMIN_TOKEN (if the issuer has one).
// The payout key stays in the issuer process. This script never sees it.
import { XRPL_EVM_TESTNET_EXPLORER, type PayoutPreview } from './payout';
import { payoutConfigFromEnv } from './payout-config';
import type { PayoutLine } from './core';

const mode = process.argv[2];
if (mode !== 'dry-run' && mode !== 'once') {
  console.error('usage: payout-cli.ts dry-run|once');
  process.exit(2);
}
const base = (process.env.ISSUER_URL ?? 'http://127.0.0.1:4001').replace(/\/$/, '');
const headers: Record<string, string> = process.env.ISSUER_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.ISSUER_ADMIN_TOKEN}` } : {};

interface Pending {
  rail: string;
  canSend: boolean;
  from?: string;
  caps: Record<string, number>;
  lines: PayoutLine[];
  preview?: PayoutPreview;
}

async function call<T>(method: string, path: string): Promise<T> {
  const r = await fetch(base + path, { method, headers });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${body.error ?? ''}`);
  return body;
}

function printPreview(p: PayoutPreview) {
  for (const t of p.transfers) {
    console.log(`  ${t.merchantId.padEnd(20)} ${t.amountRlusd.padStart(10)} RLUSD → ${t.payTo}`);
    console.log(`    to ${t.to} value ${t.value} data ${t.data}`);
  }
  for (const s of p.skipped) console.log(`  ${s.merchantId.padEnd(20)} SKIPPED: ${s.reason}`);
}

const pending = await call<Pending>('GET', '/payouts/pending');
console.log(`issuer ${base}: payout rail ${pending.rail}${pending.from ? ` from ${pending.from}` : ''}; caps ${JSON.stringify(pending.caps)}`);
if (pending.lines.length === 0) {
  console.log('no unpaid tabs');
  process.exit(0);
}

if (mode === 'dry-run') {
  console.log(`next batch: ${pending.lines.length} line(s), ${pending.lines.reduce((s, l) => s + l.amountTokens, 0)} tokens`);
  if (pending.preview) {
    printPreview(pending.preview);
  } else {
    // A mock-rail issuer: plan the transfers here from this shell's env, if it has the settings.
    for (const l of pending.lines) console.log(`  ${l.merchantId.padEnd(20)} ${l.amountRlusd.padStart(10)} RLUSD`);
    if (process.env.RLUSD_ADDRESS && process.env.MERCHANT_PAYOUT_ADDRESSES) {
      const cfg = payoutConfigFromEnv({ ...process.env, PAYOUT_RAIL: 'xrpl-evm', ISSUER_PAYOUT_PRIVATE_KEY: '' }, { requireKey: false, log: () => {} });
      console.log('transfers with this shell\'s RLUSD_ADDRESS and MERCHANT_PAYOUT_ADDRESSES:');
      printPreview(cfg.rail.preview!(pending.lines));
    } else {
      console.log('(set RLUSD_ADDRESS and MERCHANT_PAYOUT_ADDRESSES to see the calldata)');
    }
  }
  console.log('dry run: nothing sent');
  process.exit(0);
}

if (pending.rail !== 'xrpl-evm' || !pending.canSend) {
  console.error('the issuer has no live payout rail. Restart it with PAYOUT_RAIL=xrpl-evm and ISSUER_PAYOUT_PRIVATE_KEY (see packages/issuer/README.md).');
  process.exit(1);
}
const out = await call<{ paid: (PayoutLine & { txRef: string })[]; unpaid: PayoutLine[] }>('POST', '/payouts/run');
for (const p of out.paid) console.log(`PAID ${p.merchantId} ${p.amountRlusd} RLUSD ${XRPL_EVM_TESTNET_EXPLORER}/tx/${p.txRef}`);
for (const u of out.unpaid) console.log(`UNPAID ${u.merchantId} ${u.amountRlusd} RLUSD (retried next batch)`);
console.log(`${out.paid.length} paid, ${out.unpaid.length} still unpaid`);
