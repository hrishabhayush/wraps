import type { XrplRpc } from "./rpc.js";
import type { DirectoryEntry } from "./directory.js";
import { decodeCurrency, hexToUtf8, rippleTimeToDate, shortAddr, sleep } from "./util.js";

export const X402_MEMO_TYPE = "urn:x402:facilitator";
export const T54_SOURCE_TAG = 804681468;

/** One x402 payment, exactly as the chain shows it. */
export interface X402Payment {
  hash: string;
  ledger: number;
  time: Date;
  payer: string;
  merchant: string;
  /** Delivered amount (from meta.delivered_amount). */
  amount: number;
  /** Decoded currency, e.g. "RLUSD" or "XRP". */
  currency: string;
  issuer?: string;
  sourceTag?: number;
  /** Facilitator id from the memo JSON, e.g. "t54-xrpl-x402". */
  facilitator: string;
  invoiceId?: string;
  /** Other memo payloads in plain text (e.g. a per-request UUID). */
  otherMemos: string[];
}

interface Amount {
  value: number;
  currency: string;
  issuer?: string;
}

function readAmount(a: unknown): Amount | null {
  if (typeof a === "string") {
    if (!/^\d+$/.test(a)) return null; // e.g. "unavailable"
    return { value: Number(a) / 1e6, currency: "XRP" };
  }
  if (a && typeof a === "object" && "value" in a && "currency" in a) {
    const o = a as { value: string; currency: string; issuer?: string };
    return { value: Number(o.value), currency: decodeCurrency(o.currency), issuer: o.issuer };
  }
  return null;
}

/**
 * Turn one `account_tx` entry into an X402Payment, or null if it is not a
 * successful Payment carrying an x402 facilitator memo. Works with
 * api_version 1 (`tx`) and 2 (`tx_json` + `hash`).
 */
export function parseX402Payment(entry: any): X402Payment | null {
  const tx = entry?.tx ?? entry?.tx_json;
  const meta = entry?.meta ?? entry?.metaData;
  if (!tx || !meta || tx.TransactionType !== "Payment") return null;
  if (meta.TransactionResult !== "tesSUCCESS") return null;

  let facilitator: string | null = null;
  const otherMemos: string[] = [];
  for (const { Memo } of (tx.Memos ?? []) as { Memo: Record<string, string> }[]) {
    const type = hexToUtf8(Memo?.MemoType);
    const data = hexToUtf8(Memo?.MemoData);
    if (type === X402_MEMO_TYPE) {
      try {
        const obj = JSON.parse(data);
        facilitator = String(obj.id ?? obj.name ?? "unknown");
      } catch {
        facilitator = data || "unknown";
      }
    } else if (data) {
      otherMemos.push(data);
    }
  }
  if (facilitator === null) return null;

  const amt = readAmount(meta.delivered_amount ?? meta.DeliveredAmount ?? tx.DeliverMax ?? tx.Amount);
  if (!amt) return null;

  const time =
    typeof tx.date === "number"
      ? rippleTimeToDate(tx.date)
      : entry.close_time_iso
        ? new Date(entry.close_time_iso)
        : new Date(NaN);

  return {
    hash: tx.hash ?? entry.hash,
    ledger: tx.ledger_index ?? entry.ledger_index,
    time,
    payer: tx.Account,
    merchant: tx.Destination,
    amount: amt.value,
    currency: amt.currency,
    ...(amt.issuer ? { issuer: amt.issuer } : {}),
    ...(typeof tx.SourceTag === "number" ? { sourceTag: tx.SourceTag } : {}),
    facilitator,
    ...(tx.InvoiceID ? { invoiceId: tx.InvoiceID } : {}),
    otherMemos,
  };
}

export type ServiceMatch =
  /**
   * Exactly one known service has this price. `exact` is true only when we
   * hold the merchant's whole catalog; otherwise it is the best price match
   * among the services the hub shows.
   */
  | { kind: "service"; merchantLabel: string; entry: DirectoryEntry; exact: boolean }
  /** Several services share this price: we know only the merchant. */
  | { kind: "merchant"; merchantLabel: string; candidates: number; partial: boolean }
  /** The merchant is listed but no known service has this price. */
  | { kind: "unmatched-price"; merchantLabel: string }
  /** The address is not in the directory. */
  | { kind: "unlisted"; merchantLabel: string };

/** What we know about one merchant's services. */
export interface MerchantServices {
  entries: DirectoryEntry[];
  /** True when `entries` is the merchant's whole catalog. */
  complete: boolean;
}

const EPS = 1e-9;

export function merchantLabel(address: string, entries: DirectoryEntry[] | undefined): string {
  const e = entries?.find((x) => x.merchant) ?? entries?.[0];
  return e?.merchant ?? e?.host ?? shortAddr(address);
}

/**
 * Name the service by matching the paid amount to listed prices.
 * Pass a bare entry list (treated as incomplete) or a MerchantServices.
 */
export function matchService(p: X402Payment, known: DirectoryEntry[] | MerchantServices | undefined): ServiceMatch {
  const ms: MerchantServices | undefined = Array.isArray(known) ? { entries: known, complete: false } : known;
  const label = merchantLabel(p.merchant, ms?.entries);
  if (!ms?.entries.length) return { kind: "unlisted", merchantLabel: label };
  const hits = ms.entries.filter(
    (e) =>
      e.currency === p.currency &&
      (!e.issuer || !p.issuer || e.issuer === p.issuer) &&
      Math.abs(e.price - p.amount) < EPS,
  );
  const services = new Set(hits.map((h) => h.service));
  if (services.size === 1) return { kind: "service", merchantLabel: label, entry: hits[0], exact: ms.complete };
  if (services.size > 1) return { kind: "merchant", merchantLabel: label, candidates: services.size, partial: !ms.complete };
  return { kind: "unmatched-price", merchantLabel: label };
}

export interface ReadOptions {
  /** Stop after this many x402 payments. */
  limit?: number;
  /** account_tx page size. */
  pageSize?: number;
  /** Safety cap on pages scanned. */
  maxPages?: number;
}

/**
 * Read recent x402 payments received by `merchant`, newest first.
 * Outgoing transactions and non-x402 payments are skipped.
 */
export async function* readRecentPayments(
  rpc: XrplRpc,
  merchant: string,
  opts: ReadOptions = {},
): AsyncGenerator<X402Payment> {
  const limit = opts.limit ?? 50;
  const pageSize = opts.pageSize ?? Math.min(200, Math.max(20, limit * 2));
  const maxPages = opts.maxPages ?? 10;
  let marker: unknown;
  let found = 0;
  for (let page = 0; page < maxPages; page++) {
    const res: any = await rpc.request("account_tx", {
      api_version: 2,
      account: merchant,
      limit: pageSize,
      forward: false,
      ...(marker ? { marker } : {}),
    });
    for (const entry of res.transactions ?? []) {
      const p = parseX402Payment(entry);
      if (!p || p.merchant !== merchant) continue;
      yield p;
      if (++found >= limit) return;
    }
    marker = res.marker;
    if (!marker) return;
  }
}

/**
 * Poll for new x402 payments to `merchant` after ledger `fromLedger`.
 * Yields oldest first. Runs until `signal` aborts.
 */
export async function* followPayments(
  rpc: XrplRpc,
  merchant: string,
  fromLedger: number,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<X402Payment> {
  let min = fromLedger + 1;
  while (!opts.signal?.aborted) {
    let marker: unknown;
    let maxSeen = min - 1;
    do {
      const res: any = await rpc.request("account_tx", {
        api_version: 2,
        account: merchant,
        ledger_index_min: min,
        ledger_index_max: -1,
        forward: true,
        limit: 200,
        ...(marker ? { marker } : {}),
      });
      for (const entry of res.transactions ?? []) {
        const p = parseX402Payment(entry);
        const ledger = (entry.tx ?? entry.tx_json)?.ledger_index ?? entry.ledger_index;
        if (typeof ledger === "number") maxSeen = Math.max(maxSeen, ledger);
        if (p && p.merchant === merchant) yield p;
      }
      marker = res.marker;
    } while (marker && !opts.signal?.aborted);
    min = maxSeen + 1;
    await sleep(opts.intervalMs ?? 4000);
  }
}
