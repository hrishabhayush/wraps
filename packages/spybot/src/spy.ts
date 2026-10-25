import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { XrplRpc } from "./rpc.js";
import { byAddress, loadDirectory, type DirectoryEntry } from "./directory.js";
import { followPayments, matchService, readRecentPayments, type ServiceMatch, type X402Payment } from "./payments.js";
import { clusterByFunder, type ClusterResult, type ExchangeRule, type FundingInfo } from "./funders.js";

export const DEFAULT_CACHE_PATH = fileURLToPath(new URL("../data/directory-cache.json", import.meta.url));

export interface SpyEvents {
  directory: [{ count: number; fromCache: boolean; fetchedAt: string }];
  payment: [{ payment: X402Payment; match: ServiceMatch }];
  funder: [FundingInfo];
  progress: [{ stage: "funders"; done: number; total: number }];
  cluster: [ClusterResult];
  retry: [{ endpoint: string; attempt: number; reason: string; delayMs: number }];
  warning: [Error];
  done: [];
}

export interface SpyOptions {
  merchants: string[];
  /** Recent x402 payments to read per merchant. */
  limit?: number;
  /** Keep polling for new payments after the recent ones. */
  follow?: boolean;
  /** Group payers by first funder after reading. Default true. */
  cluster?: boolean;
  /** Look one hop above each funder (annotation only). Default true. */
  upstream?: boolean;
  exchangeRule?: ExchangeRule;
  /** Quicknode XRPL mainnet URL. Tried first, public nodes as fallback. */
  quicknodeUrl?: string;
  /** Provide your own RPC client (tests, custom endpoints). */
  rpc?: XrplRpc;
  /** Provide directory entries directly and skip the hub fetch. */
  directory?: DirectoryEntry[];
  cachePath?: string;
  pollMs?: number;
}

/**
 * The spy bot as an event emitter, so a web page or CLI can subscribe.
 *
 *   const spy = new SpyBot({ merchants: ["ra9b6..."] });
 *   spy.on("payment", ({ payment, match }) => ...);
 *   await spy.run();
 */
export class SpyBot extends EventEmitter<SpyEvents> {
  readonly rpc: XrplRpc;
  private ctrl = new AbortController();

  constructor(private opts: SpyOptions) {
    super();
    this.rpc =
      opts.rpc ??
      XrplRpc.withQuicknode(opts.quicknodeUrl, {
        onRetry: (info) => this.emit("retry", info),
      });
  }

  stop(): void {
    this.ctrl.abort();
  }

  async run(): Promise<{ payments: X402Payment[]; cluster?: ClusterResult }> {
    const o = this.opts;
    let entries = o.directory;
    if (!entries) {
      const dir = await loadDirectory({ cachePath: o.cachePath ?? DEFAULT_CACHE_PATH });
      entries = dir.entries;
      this.emit("directory", { count: entries.length, fromCache: dir.fromCache, fetchedAt: dir.fetchedAt });
    } else {
      this.emit("directory", { count: entries.length, fromCache: false, fetchedAt: new Date().toISOString() });
    }
    const dirByAddr = byAddress(entries);

    const payments: X402Payment[] = [];
    for (const m of o.merchants) {
      try {
        for await (const p of readRecentPayments(this.rpc, m, { limit: o.limit ?? 50 })) payments.push(p);
      } catch (err) {
        this.emit("warning", err as Error);
      }
    }
    // Replay oldest first so the output reads like a live feed.
    payments.sort((a, b) => a.time.getTime() - b.time.getTime());
    for (const p of payments) this.emit("payment", { payment: p, match: matchService(p, dirByAddr.get(p.merchant)) });

    let cluster: ClusterResult | undefined;
    if (o.cluster !== false && payments.length > 0) {
      cluster = await clusterByFunder(
        this.rpc,
        payments.map((p) => p.payer),
        {
          rule: o.exchangeRule,
          upstream: o.upstream !== false,
          onFunder: (f) => this.emit("funder", f),
          onProgress: (done, total) => this.emit("progress", { stage: "funders", done, total }),
        },
      );
      this.emit("cluster", cluster);
    }

    if (o.follow) {
      const startLedger = payments.reduce((mx, p) => Math.max(mx, p.ledger ?? 0), 0);
      await Promise.all(
        o.merchants.map(async (m) => {
          try {
            const from = startLedger || (await this.rpc.request("ledger", { ledger_index: "validated" })).ledger_index;
            for await (const p of followPayments(this.rpc, m, from, { signal: this.ctrl.signal, intervalMs: o.pollMs })) {
              payments.push(p);
              this.emit("payment", { payment: p, match: matchService(p, dirByAddr.get(p.merchant)) });
            }
          } catch (err) {
            if (!this.ctrl.signal.aborted) this.emit("warning", err as Error);
          }
        }),
      );
    }

    this.emit("done");
    return { payments, cluster };
  }
}
