import { describe, expect, it } from "vitest";
import { DEFAULT_SIM, formatTable, simulate } from "../src/sim.js";

const quick = { ...DEFAULT_SIM, trials: 50 };

describe("simulate", () => {
  it("plain x402 is always 100%", () => {
    for (const n of [1, 5, 20]) expect(simulate({ ...quick, agents: n }).plain).toBe(1);
  });

  it("one agent is always linked: no crowd, no privacy", () => {
    expect(simulate({ ...quick, agents: 1 }).linker).toBe(1);
  });

  it("linking gets harder as the crowd grows", () => {
    const r5 = simulate({ ...quick, agents: 5 }).linker;
    const r100 = simulate({ ...quick, agents: 100 }).linker;
    expect(r5).toBeGreaterThan(r100);
    expect(r100).toBeLessThan(0.1);
  });

  it("one payout per horizon reduces the linker to a random guess", () => {
    const r = simulate({ ...quick, agents: 20, payoutInterval: quick.horizon });
    expect(r.linker).toBeCloseTo(1 / 20, 1);
  });

  it("is deterministic for a seed", () => {
    expect(simulate({ ...quick, agents: 20 })).toEqual(simulate({ ...quick, agents: 20 }));
  });

  it("formats a markdown table", () => {
    expect(formatTable([simulate({ ...quick, agents: 1 })])).toContain("| 1 | 100.0% | 100.0% | 100.0% |");
  });
});
