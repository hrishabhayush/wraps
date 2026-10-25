import { describe, expect, it } from "vitest";
import { DEFAULT_SIM, formatTable, generateDay, publicBatches, report, rng, simulate } from "../src/sim.js";

const quick = { ...DEFAULT_SIM, trials: 30 };

describe("public view", () => {
  it("shows one total per merchant per payout interval, never single calls", () => {
    const p = { ...quick, agents: 20 };
    const day = generateDay(p, rng(1));
    const batches = publicBatches(p, day.calls);
    const keys = new Set(batches.map((b) => `${b.merchant}:${b.start}`));
    expect(keys.size).toBe(batches.length);
    expect(batches.reduce((s, b) => s + b.total, 0)).toBe(day.calls.length);
    for (const b of batches) expect(b.end - b.start).toBe(p.payoutInterval);
    expect(batches.length).toBeLessThan(day.calls.length);
  });

  it("with one payout a day, shows at most one total per merchant", () => {
    const p = { ...quick, agents: 20, payoutInterval: quick.horizon };
    const day = generateDay(p, rng(1));
    expect(publicBatches(p, day.calls).length).toBeLessThanOrEqual(p.merchants);
  });

  it("top-ups show wallet, amount and time", () => {
    const day = generateDay({ ...quick, agents: 3 }, rng(1));
    for (const t of day.topUps) expect(Object.keys(t).sort()).toEqual(["amount", "t", "wallet"]);
  });
});

describe("simulate", () => {
  it("plain x402 is always 100%", () => {
    for (const n of [1, 5, 20]) expect(simulate({ ...quick, agents: n }).plain).toBe(1);
  });

  it("one agent is always linked in both modes: no crowd, no privacy", () => {
    for (const mode of ["realistic", "oracle"] as const) {
      const r = simulate({ ...quick, agents: 1 }, mode);
      expect([r.merchantTop, r.payerProb, r.spendTop1]).toEqual([1, 1, 1]);
    }
  });

  it("linking gets harder as the crowd grows", () => {
    const r5 = simulate({ ...quick, agents: 5 });
    const r100 = simulate({ ...quick, agents: 100 });
    expect(r5.payerProb).toBeGreaterThan(r100.payerProb);
    expect(r5.merchantTop).toBeGreaterThan(r100.merchantTop);
    expect(r100.payerProb).toBeLessThan(0.1);
  });

  it("longer payout intervals leak less", () => {
    const fast = simulate({ ...quick, agents: 20, payoutInterval: 5 });
    const slow = simulate({ ...quick, agents: 20, payoutInterval: 360 });
    expect(fast.payerProb).toBeGreaterThan(slow.payerProb);
  });

  it("one payout per day reduces the watcher to a random guess", () => {
    const r = simulate({ ...quick, agents: 20, payoutInterval: quick.horizon });
    expect(r.payerProb).toBeCloseTo(1 / 20, 2);
    expect(r.spendTop1).toBeCloseTo(1 / 20, 1);
  });

  it("the oracle sees at least about as much as the realistic watcher", () => {
    const real = simulate({ ...quick, agents: 20 }, "realistic");
    const oracle = simulate({ ...quick, agents: 20 }, "oracle");
    expect(oracle.payerProb).toBeGreaterThan(real.payerProb - 0.01);
    expect(oracle.payerProb).toBeLessThan(1);
  });

  it("is deterministic for a seed", () => {
    expect(simulate({ ...quick, agents: 20 })).toEqual(simulate({ ...quick, agents: 20 }));
  });

  it("formats a markdown table", () => {
    const r = report({ ...quick, trials: 5 }, [1], [60]);
    const t = formatTable(r, "payerProb");
    expect(t).toContain("Realistic, payouts every 1 h");
    expect(t).toContain("Oracle (per-call view)");
    expect(t).toContain("| 1 | 100.0% | 100.0% | 100.0% | 100.0% |");
  });
});
