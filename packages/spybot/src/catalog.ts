import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DirectoryEntry } from "./directory.js";
import { decodeEntities, parsePriceText } from "./directory.js";

/**
 * What the hub shows about one merchant's services on `xrpl-ai.org/address/<r>`.
 *
 * The hub home page shows only one sample card per merchant. The merchant
 * page shows the first page of its catalog plus an "Active APIs" count.
 * Later catalog pages are rendered in the browser, so we cannot read them
 * from the server HTML (checked 2026-10-24: `?page=2` returns page 1).
 * Naming a service from a price is only certain when `complete` is true.
 */
export interface Catalog {
  address: string;
  /** "Active APIs" count shown on the page. Null if the page did not say. */
  total: number | null;
  entries: DirectoryEntry[];
  /** True when we hold every service the page says the merchant has. */
  complete: boolean;
  fetchedAt: string;
}

function strip(s: string): string {
  return decodeEntities(s.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "")).trim();
}

/** Parse a merchant page: the "Active APIs" count and the visible catalog cards. */
export function parseCatalogPage(html: string, address: string): { total: number | null; entries: DirectoryEntry[] } {
  // Only read the server-rendered HTML, not the inline React payload.
  const body = html.replace(/<script\b[\s\S]*?<\/script>/g, "");
  const totalMatch =
    body.match(/>Active APIs<\/p>(?:\s*<[^>]+>)*\s*([\d,]+)\s*</) ?? body.match(/>(?:Page \d+ of \d+ · )?([\d,]+) APIs</);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null;

  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  // Cards hold an <h3> name, a <p title="https://..."> URL, then a price span.
  const cardRe =
    /<h3\b[^>]*>([\s\S]*?)<\/h3>(?:(?!<h3\b)[\s\S]){0,600}?<p\b[^>]*title="(https?:\/\/[^"]+)"[^>]*>(?:(?!<h3\b)[\s\S]){0,1200}?<span\b([^>]*)>\s*([\d.]+)\s+([^<]+?)\s*<\/span>/g;
  for (const m of body.matchAll(cardRe)) {
    const [, name, url, attrs, amount, cur] = m;
    const parsed = parsePriceText(amount, cur, attrs);
    if (!parsed) continue;
    let host = "";
    try {
      host = new URL(decodeEntities(url)).host;
    } catch {
      /* keep empty host */
    }
    const service = strip(name);
    const key = `${service}|${decodeEntities(url)}|${parsed.price}|${parsed.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ address, service, host, ...parsed });
  }
  return { total, entries };
}

export interface CatalogOptions {
  baseUrl?: string;
  cachePath?: string;
  /** Reuse a cached catalog younger than this. Default 6 hours. */
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
}

type CacheFile = Record<string, Catalog>;

async function readCache(path?: string): Promise<CacheFile> {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

/** Load a merchant's catalog: fresh cache, else the hub, else a stale cache, else null. */
export async function loadCatalog(address: string, opts: CatalogOptions = {}): Promise<Catalog | null> {
  const cached = (await readCache(opts.cachePath))[address];
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < (opts.maxAgeMs ?? 6 * 3600_000)) return cached;

  const base = (opts.baseUrl ?? "https://xrpl-ai.org").replace(/\/$/, "");
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}/address/${address}`, {
      headers: { "user-agent": "Mozilla/5.0 (spybot; +x402 privacy demo)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { total, entries } = parseCatalogPage(await res.text(), address);
    if (entries.length === 0) throw new Error("no catalog cards found");
    const catalog: Catalog = {
      address,
      total,
      entries,
      complete: total !== null && entries.length >= total,
      fetchedAt: new Date().toISOString(),
    };
    if (opts.cachePath) {
      const fresh = await readCache(opts.cachePath);
      fresh[address] = catalog;
      await mkdir(dirname(opts.cachePath), { recursive: true });
      await writeFile(opts.cachePath, JSON.stringify(fresh, null, 1) + "\n");
    }
    return catalog;
  } catch {
    return cached ?? null;
  }
}
