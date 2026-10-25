import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDirectory, parseDirectory } from "../src/directory.js";

const html = readFileSync(new URL("./fixtures/xrpl-ai.html", import.meta.url), "utf8");

describe("parseDirectory (xrpl-ai.org fixture, 2026-10-24)", () => {
  const entries = parseDirectory(html);

  it("finds many service cards and dedupes the marquee copies", () => {
    expect(entries.length).toBeGreaterThan(30);
    const keys = entries.map((e) => `${e.address}|${e.service}|${e.price}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("parses the AskSurf card", () => {
    const e = entries.find((x) => x.address === "ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3");
    expect(e).toMatchObject({
      service: "X Tweets by IDs",
      host: "x402.asksurf.ai",
      price: 0.006,
      currency: "RLUSD",
      issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      verified: true,
      merchant: "AskSurf",
    });
  });

  it("parses the Heurist Inference Router card", () => {
    const e = entries.find((x) => x.address === "rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ");
    expect(e).toMatchObject({ host: "router.heurist.xyz", price: 0.0005, currency: "RLUSD", merchant: "Heurist Inference Router" });
  });

  it("keeps two services for one merchant at different prices", () => {
    const list = entries.filter((x) => x.address === "rGYbaZwYqA5XwFcmxWVdyyut4vUeTD7KcQ");
    expect(list.map((x) => x.price).sort()).toEqual([0.001, 0.01]);
    expect(list.every((x) => x.merchant === "Monid Tool Router")).toBe(true);
  });

  it("handles XRP, unverified and IOU prices", () => {
    expect(entries.find((x) => x.address === "rJMvspZMb1FRHmy8d3RP2eVGPjRmfKXh6e")).toMatchObject({ price: 0.001, currency: "XRP" });
    expect(entries.find((x) => x.address === "raKj7ZGoPy1fWw1vfynuJhyHirpcmUMBhP")).toMatchObject({ currency: "RLUSD", verified: false });
    expect(entries.find((x) => x.address === "rsnHPZjBSastxz1BE38WqKBR3sgpATvreL")).toMatchObject({
      currency: "USDC",
      issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE",
    });
  });

  it("decodes HTML entities", () => {
    expect(entries.some((x) => x.service.includes("&#x27;"))).toBe(false);
  });
});

describe("loadDirectory", () => {
  it("falls back to the cache when the fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spybot-"));
    const cachePath = join(dir, "cache.json");
    const good = (async () => new Response(html)) as unknown as typeof fetch;
    const first = await loadDirectory({ cachePath, fetchImpl: good });
    expect(first.fromCache).toBe(false);

    const bad = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const second = await loadDirectory({ cachePath, fetchImpl: bad });
    expect(second.fromCache).toBe(true);
    expect(second.entries).toEqual(first.entries);
  });

  it("throws when fetch fails and there is no cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spybot-"));
    writeFileSync(join(dir, "x"), "");
    const bad = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(loadDirectory({ cachePath: join(dir, "missing.json"), fetchImpl: bad })).rejects.toThrow(/cache unreadable/);
  });
});
