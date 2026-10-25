import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const HUB_URL = "https://xrpl-ai.org/";

/** One service card from the XRPL AI Hub. */
export interface DirectoryEntry {
  /** Merchant XRPL address that receives payments. */
  address: string;
  /** Service name shown on the card. */
  service: string;
  /** Endpoint host shown on the card. */
  host: string;
  /** Price per call, as a number. */
  price: number;
  /** Currency code as shown: RLUSD, XRP, USDC... */
  currency: string;
  /** Issuer address for issued currencies, when the card names one. */
  issuer?: string;
  /** False when the hub marks the currency "Unverified". */
  verified: boolean;
  /** Merchant display name, when the hub shows one (leaderboard). */
  merchant?: string;
}

export interface Directory {
  source: string;
  fetchedAt: string;
  entries: DirectoryEntry[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Parse a hub price span. `amount` is "0.006"; `rawCurrency` is one of
 * "RLUSD", "XRP", "Unverified RLUSD", "IOU USDC · rGm7WCVp…uWhE";
 * `attrs` may hold `title="Issuer: r..."`.
 */
export function parsePriceText(
  amount: string,
  rawCurrency: string,
  attrs = "",
): Pick<DirectoryEntry, "price" | "currency" | "issuer" | "verified"> | null {
  const price = Number(amount);
  if (!Number.isFinite(price)) return null;
  const verified = !/unverified/i.test(rawCurrency);
  const currency = text(rawCurrency).replace(/^(Unverified|IOU)\s+/i, "").split(/\s|·/)[0];
  if (!currency) return null;
  const issuer = attrs.match(/title="Issuer:\s*(r\w+)"/)?.[1];
  return { price, currency, ...(issuer ? { issuer } : {}), verified };
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function text(html: string): string {
  return decodeEntities(html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "")).trim();
}

/**
 * Parse the hub's server-rendered HTML. A service card is an anchor
 * `href="/address/<r-address>"` that holds an `<h3>` (service name), a `<p>`
 * (host), a price span like `0.006 RLUSD`, and the text `Per call`.
 * Leaderboard anchors to the same address hold only a merchant name in a `<p>`;
 * we use those to name merchants.
 */
export function parseDirectory(html: string): DirectoryEntry[] {
  const anchorRe = /<a\b[^>]*href="\/address\/(r[1-9A-HJ-NP-Za-km-z]{24,34})"[^>]*>([\s\S]*?)<\/a>/g;
  const names = new Map<string, string>();
  const entries = new Map<string, DirectoryEntry>();

  for (const m of html.matchAll(anchorRe)) {
    const [, address, body] = m;
    const h3 = body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    const p = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);

    if (!h3) {
      // Leaderboard card: merchant name only. Skip placeholder names like "rJSiKSFB...DK1x".
      const name = p ? text(p[1]) : "";
      if (name && !/^r\w+\.\.\.\w+$/.test(name) && !names.has(address)) names.set(address, name);
      continue;
    }
    if (!/Per call/i.test(body)) continue;

    const priceSpan = body.match(/<span\b([^>]*)>\s*([\d.]+)\s+([^<]+?)\s*<\/span>/);
    if (!priceSpan) continue;
    const [, attrs, amount, rawCurrency] = priceSpan;
    const parsed = parsePriceText(amount, rawCurrency, attrs);
    if (!parsed) continue;

    const entry: DirectoryEntry = { address, service: text(h3[1]), host: p ? text(p[1]) : "", ...parsed };
    const key = `${address}|${entry.service}|${entry.price}|${entry.currency}`;
    if (!entries.has(key)) entries.set(key, entry);
  }

  return [...entries.values()].map((e) => (names.has(e.address) ? { ...e, merchant: names.get(e.address) } : e));
}

export interface LoadOptions {
  url?: string;
  /** JSON cache file. Written on a good fetch, read when the fetch fails. */
  cachePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Skip the network and read only the cache. */
  offline?: boolean;
}

/** Fetch and parse the hub. On failure, fall back to the cache file. */
export async function loadDirectory(opts: LoadOptions = {}): Promise<Directory & { fromCache: boolean }> {
  const url = opts.url ?? HUB_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let fetchError: unknown;

  if (!opts.offline) {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": "Mozilla/5.0 (spybot; +x402 privacy demo)" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseDirectory(await res.text());
      if (entries.length === 0) throw new Error("no service cards found (page layout changed?)");
      const dir: Directory = { source: url, fetchedAt: new Date().toISOString(), entries };
      if (opts.cachePath) {
        await mkdir(dirname(opts.cachePath), { recursive: true });
        await writeFile(opts.cachePath, JSON.stringify(dir, null, 2) + "\n");
      }
      return { ...dir, fromCache: false };
    } catch (err) {
      fetchError = err;
    }
  }

  if (!opts.cachePath) throw new Error(`directory fetch failed and no cache: ${String(fetchError)}`);
  try {
    const dir = JSON.parse(await readFile(opts.cachePath, "utf8")) as Directory;
    return { ...dir, fromCache: true };
  } catch (err) {
    throw new Error(`directory fetch failed (${String(fetchError ?? "offline")}) and cache unreadable: ${String(err)}`);
  }
}

/** Group entries by merchant address. */
export function byAddress(entries: DirectoryEntry[]): Map<string, DirectoryEntry[]> {
  const map = new Map<string, DirectoryEntry[]>();
  for (const e of entries) {
    const list = map.get(e.address) ?? [];
    list.push(e);
    map.set(e.address, list);
  }
  return map;
}
