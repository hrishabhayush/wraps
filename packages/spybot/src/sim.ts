/**
 * DEM-03 benchmark: how well can a chain watcher link a spend to the agent
 * that made it?
 *
 * Model (see README "Simulation"):
 * - N agents. Each agent tops up once, at a uniform random time in
 *   [0, topUpWindow). The top-up is public: agent wallet + time.
 * - After its top-up, each agent makes `callsPerAgent` paid calls. The gap
 *   from the top-up to each call is exponential with mean `meanDelay`.
 *   Calls after `horizon` are dropped.
 * - Plain x402: every call is an on-chain payment from the agent's wallet.
 *   The watcher reads the payer. Accuracy is 100% by construction.
 * - Our system: calls spend blind tokens. Nothing per call is public. The
 *   issuer pays merchants in batches every `payoutInterval`. A watcher sees
 *   only "merchant got k calls' worth in window w".
 * - Naive timing linker: attributes every call in a payout window to the
 *   agent with the most recent top-up before the window closes.
 * - Score: share of calls attributed to the right agent.
 *
 * Not modelled (all would help an attacker or hurt the crowd, and are
 * discussed in the README): unique amounts, IP or TLS fingerprints,
 * merchant-side knowledge, repeated top-ups with habits, very small crowds
 * at quiet hours.
 */

export interface SimParams {
  agents: number;
  /** All times in minutes. */
  horizon: number;
  topUpWindow: number;
  callsPerAgent: number;
  meanDelay: number;
  payoutInterval: number;
  trials: number;
  seed: number;
}

export const DEFAULT_SIM: Omit<SimParams, "agents"> = {
  horizon: 24 * 60,
  topUpWindow: 12 * 60,
  callsPerAgent: 20,
  meanDelay: 120,
  payoutInterval: 60,
  trials: 200,
  seed: 42,
};

/** Small seeded PRNG (mulberry32) so runs are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TrialResult {
  calls: number;
  plainCorrect: number;
  linkerCorrect: number;
}

export function runTrial(p: SimParams, rand: () => number): TrialResult {
  const topUps = Array.from({ length: p.agents }, () => rand() * p.topUpWindow);
  const calls: { agent: number; t: number }[] = [];
  for (let a = 0; a < p.agents; a++) {
    for (let k = 0; k < p.callsPerAgent; k++) {
      const t = topUps[a] - p.meanDelay * Math.log(1 - rand());
      if (t < p.horizon) calls.push({ agent: a, t });
    }
  }

  let linkerCorrect = 0;
  for (const c of calls) {
    // The watcher only learns the payout window the call was settled in.
    const windowEnd = (Math.floor(c.t / p.payoutInterval) + 1) * p.payoutInterval;
    let guess = -1;
    let best = -Infinity;
    for (let a = 0; a < p.agents; a++) {
      if (topUps[a] <= windowEnd && topUps[a] > best) {
        best = topUps[a];
        guess = a;
      }
    }
    if (guess === c.agent) linkerCorrect++;
  }
  // Plain x402: the payer address is in every payment.
  return { calls: calls.length, plainCorrect: calls.length, linkerCorrect };
}

export interface SimRow {
  agents: number;
  calls: number;
  plain: number;
  linker: number;
  random: number;
}

export function simulate(p: SimParams): SimRow {
  const rand = rng(p.seed + p.agents * 7919);
  let calls = 0;
  let plain = 0;
  let linker = 0;
  for (let i = 0; i < p.trials; i++) {
    const r = runTrial(p, rand);
    calls += r.calls;
    plain += r.plainCorrect;
    linker += r.linkerCorrect;
  }
  return {
    agents: p.agents,
    calls,
    plain: calls ? plain / calls : 1,
    linker: calls ? linker / calls : 1,
    random: 1 / p.agents,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatTable(rows: SimRow[]): string {
  const head = "| Agents (N) | Plain x402 | Batched blind tokens, timing linker | Random guess (1/N) |";
  const sep = "|---:|---:|---:|---:|";
  const body = rows.map((r) => `| ${r.agents} | ${pct(r.plain)} | ${pct(r.linker)} | ${pct(r.random)} |`);
  return [head, sep, ...body].join("\n");
}
