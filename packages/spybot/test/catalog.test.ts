import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCatalogPage } from "../src/catalog.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseCatalogPage (merchant pages, 2026-10-24)", () => {
  it("reads AskSurf: 120 APIs, only the first 24 in server HTML", () => {
    const r = parseCatalogPage(fixture("address-asksurf.html"), "ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3");
    expect(r.total).toBe(120);
    expect(r.entries.length).toBe(24);
    expect(r.entries[0]).toMatchObject({ service: "Technical Indicator", host: "x402.asksurf.ai", price: 0.012, currency: "RLUSD" });
  });

  it("reads the Heurist Inference Router: one API, so the catalog is complete", () => {
    const r = parseCatalogPage(fixture("address-heurist-router.html"), "rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ");
    expect(r.total).toBe(1);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ host: "router.heurist.xyz", price: 0.0005, currency: "RLUSD" });
  });
});
