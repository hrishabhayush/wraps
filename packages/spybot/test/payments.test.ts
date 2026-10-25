import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchService, parseX402Payment, T54_SOURCE_TAG } from "../src/payments.js";
import { formatPayment } from "../src/format.js";
import type { DirectoryEntry } from "../src/directory.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/account_tx-asksurf.json", import.meta.url), "utf8"));
const entry = fixture.result.transactions[0];

const ASKSURF = "ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3";
const card = (service: string, price: number): DirectoryEntry => ({
  address: ASKSURF,
  service,
  host: "x402.asksurf.ai",
  price,
  currency: "RLUSD",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  verified: true,
  merchant: "AskSurf",
});

describe("parseX402Payment", () => {
  it("reads a real mainnet x402 payment", () => {
    const p = parseX402Payment(entry)!;
    expect(p).not.toBeNull();
    expect(p.payer).toBe("rJmsb9rZrpL8EBnnCspgjpd1jJCgvHgUVz");
    expect(p.merchant).toBe(ASKSURF);
    expect(p.amount).toBe(0.006);
    expect(p.currency).toBe("RLUSD");
    expect(p.issuer).toBe("rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De");
    expect(p.sourceTag).toBe(T54_SOURCE_TAG);
    expect(p.facilitator).toBe("t54-xrpl-x402");
    expect(p.invoiceId).toMatch(/^[0-9A-F]{64}$/);
    expect(p.time.getUTCFullYear()).toBe(2026);
  });

  it("ignores payments without the x402 facilitator memo", () => {
    const plain = structuredClone(entry);
    delete plain.tx.Memos;
    expect(parseX402Payment(plain)).toBeNull();
  });

  it("ignores failed transactions", () => {
    const failed = structuredClone(entry);
    failed.meta.TransactionResult = "tecPATH_DRY";
    expect(parseX402Payment(failed)).toBeNull();
  });

  it("supports api_version 2 (tx_json + hash)", () => {
    const v2 = { tx_json: { ...entry.tx }, meta: entry.meta, hash: entry.tx.hash, ledger_index: entry.tx.ledger_index };
    delete (v2.tx_json as any).hash;
    expect(parseX402Payment(v2)?.hash).toBe(entry.tx.hash);
  });
});

describe("matchService", () => {
  const p = parseX402Payment(entry)!;

  it("names the service when one service has the price", () => {
    const m = matchService(p, [card("X Tweets by IDs", 0.006), card("Other", 0.012)]);
    expect(m.kind).toBe("service");
    expect(formatPayment(p, m)).toMatch(/  rJmsb9…  →  AskSurf "X Tweets by IDs"  0\.006 RLUSD$/);
  });

  it("reports only the merchant when several services share the price", () => {
    const m = matchService(p, [card("A", 0.006), card("B", 0.006)]);
    expect(m).toMatchObject({ kind: "merchant", candidates: 2 });
  });

  it("says so when the price is not listed", () => {
    expect(matchService(p, [card("A", 0.012)]).kind).toBe("unmatched-price");
    expect(matchService(p, undefined).kind).toBe("unlisted");
  });
});
