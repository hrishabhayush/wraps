import { RpcError, type XrplRpc } from "./rpc.js";

export interface FundingInfo {
  account: string;
  /** Who sent the first payment that created this account. Null if unknown. */
  funder: string | null;
  /** Ledger of the account's first transaction (creation). */
  createdLedger?: number;
  fundingTx?: string;
}

export interface WalletSize {
  account: string;
  balanceXrp: number;
  sequence: number;
  /** Rough count of transactions sent by this account (see estimateSentTxs). */
  estSentTxs: number;
  likelyExchange: boolean;
}

export interface ExchangeRule {
  /** A wallet holding more than this many XRP is treated as a likely exchange. */
  minBalanceXrp: number;
  /** A wallet that has sent more than this many transactions is treated as a likely exchange. */
  minSentTxs: number;
}

export const DEFAULT_EXCHANGE_RULE: ExchangeRule = { minBalanceXrp: 1_000_000, minSentTxs: 1_000_000 };

/** Find who funded `account` by reading its first transaction. */
export async function firstFunder(rpc: XrplRpc, account: string): Promise<FundingInfo> {
  const res: any = await rpc.request("account_tx", {
    account,
    forward: true,
    limit: 1,
    ledger_index_min: -1,
    ledger_index_max: -1,
  });
  const entry = res.transactions?.[0];
  const tx = entry?.tx ?? entry?.tx_json;
  if (!tx) return { account, funder: null };
  const createdLedger = tx.ledger_index ?? entry.ledger_index;
  const isFunding = tx.TransactionType === "Payment" && tx.Destination === account && tx.Account !== account;
  return {
    account,
    funder: isFunding ? tx.Account : null,
    createdLedger,
    fundingTx: tx.hash ?? entry.hash,
  };
}

/**
 * Accounts created after the DeletableAccounts amendment (2020) start their
 * Sequence at the ledger index where they were created. Older accounts start
 * at 1. So: sent ≈ Sequence − createdLedger when Sequence ≥ createdLedger,
 * else ≈ Sequence. It is an estimate, good enough to spot a wallet with
 * millions of transactions.
 */
export function estimateSentTxs(sequence: number, createdLedger?: number): number {
  if (createdLedger && sequence >= createdLedger) return sequence - createdLedger;
  return sequence;
}

export async function walletSize(
  rpc: XrplRpc,
  account: string,
  createdLedger: number | undefined,
  rule: ExchangeRule = DEFAULT_EXCHANGE_RULE,
): Promise<WalletSize | null> {
  try {
    const res: any = await rpc.request("account_info", { account, ledger_index: "validated" });
    const d = res.account_data;
    const balanceXrp = Number(d.Balance) / 1e6;
    const sequence = Number(d.Sequence);
    const estSentTxs = estimateSentTxs(sequence, createdLedger);
    return {
      account,
      balanceXrp,
      sequence,
      estSentTxs,
      likelyExchange: balanceXrp > rule.minBalanceXrp || estSentTxs > rule.minSentTxs,
    };
  } catch (err) {
    if (err instanceof RpcError && err.code === "actNotFound") return null; // deleted account
    throw err;
  }
}

export interface FunderCluster {
  funder: string;
  payers: string[];
  size: WalletSize | null;
  likelyExchange: boolean;
  /** Who funded the funder (annotation only, not used for grouping). Not traced past a likely exchange. */
  fundedBy?: { address: string; size: WalletSize | null; likelyExchange: boolean };
}

export interface ClusterResult {
  payersTraced: number;
  payersUntraced: string[];
  clusters: FunderCluster[];
}

export interface ClusterOptions {
  rule?: ExchangeRule;
  /** Also look up who funded each funder (one extra hop, annotation only). */
  upstream?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Called for each payer once its funder is known. */
  onFunder?: (info: FundingInfo) => void;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/**
 * Group payers by first funder. One level of grouping only.
 * A funder that looks like an exchange is labelled and not traced further.
 */
export async function clusterByFunder(rpc: XrplRpc, payers: string[], opts: ClusterOptions = {}): Promise<ClusterResult> {
  const rule = opts.rule ?? DEFAULT_EXCHANGE_RULE;
  const unique = [...new Set(payers)];
  let done = 0;
  const infos = await mapLimit(unique, opts.concurrency ?? 2, async (p) => {
    let info: FundingInfo;
    try {
      info = await firstFunder(rpc, p);
    } catch {
      info = { account: p, funder: null };
    }
    opts.onFunder?.(info);
    opts.onProgress?.(++done, unique.length);
    return info;
  });

  const groups = new Map<string, string[]>();
  const untraced: string[] = [];
  for (const info of infos) {
    if (!info.funder) {
      untraced.push(info.account);
      continue;
    }
    const list = groups.get(info.funder) ?? [];
    list.push(info.account);
    groups.set(info.funder, list);
  }

  const clusters = await mapLimit([...groups.entries()], opts.concurrency ?? 2, async ([funder, list]) => {
    const fi = await firstFunder(rpc, funder).catch(() => ({ account: funder, funder: null }) as FundingInfo);
    const size = await walletSize(rpc, funder, fi.createdLedger, rule).catch(() => null);
    const cluster: FunderCluster = { funder, payers: list, size, likelyExchange: !!size?.likelyExchange };
    if (opts.upstream && !cluster.likelyExchange && fi.funder) {
      const up = await firstFunder(rpc, fi.funder).catch(() => null);
      const upSize = await walletSize(rpc, fi.funder, up?.createdLedger, rule).catch(() => null);
      cluster.fundedBy = { address: fi.funder, size: upSize, likelyExchange: !!upSize?.likelyExchange };
    }
    return cluster;
  });

  clusters.sort((a, b) => b.payers.length - a.payers.length);
  return { payersTraced: unique.length - untraced.length, payersUntraced: untraced, clusters };
}
