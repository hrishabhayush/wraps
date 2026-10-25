import type { ServiceMatch, X402Payment } from "./payments.js";
import type { ClusterResult, FunderCluster, WalletSize } from "./funders.js";
import { hms, shortAddr } from "./util.js";

export function formatAmount(n: number): string {
  return String(Number(n.toPrecision(12)));
}

export function describeMatch(m: ServiceMatch): string {
  switch (m.kind) {
    case "service":
      return `${m.merchantLabel} "${m.entry.service}"`;
    case "merchant":
      return `${m.merchantLabel} (${m.candidates} services at this price)`;
    case "unmatched-price":
      return `${m.merchantLabel} (price not in directory)`;
    case "unlisted":
      return `${m.merchantLabel} (not in directory)`;
  }
}

/** `21:24:30  rJmsb9…  →  AskSurf "X Tweets by IDs"  0.006 RLUSD` */
export function formatPayment(p: X402Payment, m: ServiceMatch): string {
  return `${hms(p.time)}  ${shortAddr(p.payer)}  →  ${describeMatch(m)}  ${formatAmount(p.amount)} ${p.currency}`;
}

function sizeNote(s: WalletSize | null): string {
  if (!s) return "";
  const xrp = Math.round(s.balanceXrp).toLocaleString("en-US");
  const txs = s.estSentTxs.toLocaleString("en-US");
  return `${xrp} XRP, ~${txs} txs sent`;
}

function clusterLine(c: FunderCluster): string {
  const n = c.payers.length;
  let line = `  ${shortAddr(c.funder, 6, 4)}  funded ${n} wallet${n === 1 ? "" : "s"}`;
  if (c.likelyExchange) line += `  [likely exchange: ${sizeNote(c.size)}]`;
  if (c.fundedBy) {
    line += `  ← funded by ${shortAddr(c.fundedBy.address, 6, 4)}`;
    if (c.fundedBy.likelyExchange) line += ` [likely exchange: ${sizeNote(c.fundedBy.size)}]`;
  }
  return line;
}

/** `60 wallets → 8 funders` plus one line per funder. */
export function formatCluster(r: ClusterResult): string[] {
  const lines = [`${r.payersTraced} wallets → ${r.clusters.length} funders`];
  for (const c of r.clusters) lines.push(clusterLine(c));
  if (r.payersUntraced.length) lines.push(`  (${r.payersUntraced.length} wallets: first transaction was not a plain funding payment)`);
  return lines;
}
