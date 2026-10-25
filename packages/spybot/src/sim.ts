/**
 * DEM-03 benchmark: what can a chain watcher infer about which agent paid
 * which merchant?
 *
 * Day model (see README "Simulation"):
 * - N agents, M merchants. Each agent tops up once, at a uniform random
 *   time in [0, topUpWindow), with the same fixed bundle of tokens.
 * - Each agent has one home merchant (uniform). Each call goes to the home
 *   merchant with probability `homeShare`, else to a uniform merchant.
 * - The gap from the top-up to each call is exponential with mean
 *   `meanDelay`. Calls after `horizon` are dropped.
 *
 * Two observation modes:
 * - "realistic": the watcher sees only what the chain shows. Each top-up
 *   (wallet, amount, time) and, per payout interval, one total per merchant.
 *   It never sees a single call.
 * - "oracle": an upper bound. The watcher also sees every hidden call on
 *   its own: exact time and merchant. Only the payer is hidden.
 *
 * Watcher: knows the day model (delay distribution, bundle size). It runs EM
 * over each agent's merchant preferences, using the timing likelihood of
 * each observation given each top-up. It ends with a posterior over agents
 * for each observation (a batch, or a call in oracle mode).
 *
 * Scores (ground truth is used only for scoring):
 * - merchantTop: for each merchant, is the watcher's most likely top spender
 *   one of the agents that really spent the most there?
 * - payerProb: average probability the watcher puts on the true payer of a
 *   token.
 * - spendTop1: share of spend whose payer equals the watcher's single best
 *   guess for its batch (or call). Same unit as the old per-call metric.
 *
 * Plain x402 publishes the payer of every call, so all scores are 100%.
 *
 * Not modelled (all would help an attacker): varied top-up amounts, IP or
 * TLS fingerprints, merchant-side knowledge, repeat habits across days.
 */

export type Mode = "realistic" | "oracle";

export interface SimParams {
  agents: number;
  /** All times in minutes. */
  horizon: number;
  topUpWindow: number;
  /** Tokens per top-up bundle. Each agent spends one per call. */
  callsPerAgent: number;
  meanDelay: number;
  payoutInterval: number;
  merchants: number;
  homeShare: number;
  emIterations: number;
  trials: number;
  seed: number;
}

export const DEFAULT_SIM: Omit<SimParams, "agents"> = {
  horizon: 24 * 60,
  topUpWindow: 12 * 60,
  callsPerAgent: 20,
  meanDelay: 120,
  payoutInterval: 60,
  merchants: 10,
  homeShare: 0.6,
  emIterations: 25,
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

/** Public: a top-up transaction into the issuer. */
export interface TopUp {
  wallet: string;
  amount: number;
  t: number;
}

/** Public: one issuer → merchant payout for one interval. */
export interface Batch {
  merchant: number;
  start: number;
  end: number;
  total: number;
}

/** Hidden: one paid call. */
export interface Call {
  agent: number;
  merchant: number;
  t: number;
}

export interface Day {
  topUps: TopUp[];
  calls: Call[];
}

export function generateDay(p: SimParams, rand: () => number): Day {
  const topUps: TopUp[] = [];
  const calls: Call[] = [];
  for (let a = 0; a < p.agents; a++) {
    const t0 = rand() * p.topUpWindow;
    topUps.push({ wallet: `agent-${a}`, amount: p.callsPerAgent, t: t0 });
    const home = Math.floor(rand() * p.merchants);
    for (let k = 0; k < p.callsPerAgent; k++) {
      const t = t0 - p.meanDelay * Math.log(1 - rand());
      const merchant = rand() < p.homeShare ? home : Math.floor(rand() * p.merchants);
      if (t < p.horizon) calls.push({ agent: a, merchant, t });
    }
  }
  return { topUps, calls };
}

/** What the public chain shows under batched payouts. */
export function publicBatches(p: SimParams, calls: readonly Call[]): Batch[] {
  const totals = new Map<number, number>();
  const windows = Math.ceil(p.horizon / p.payoutInterval);
  for (const c of calls) {
    const key = c.merchant * windows + Math.floor(c.t / p.payoutInterval);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return [...totals.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([key, total]) => {
      const w = key % windows;
      return { merchant: Math.floor(key / windows), start: w * p.payoutInterval, end: (w + 1) * p.payoutInterval, total };
    });
}

/** One thing the watcher observes: a batch, or a single call in oracle mode. */
interface Item {
  merchant: number;
  count: number;
}

export interface Inference {
  /** Posterior over agents per observed item, flattened items × agents. */
  posterior: Float64Array;
  items: Item[];
}

/**
 * EM over agents' merchant preferences. `lik[i*N+a]` is the timing
 * likelihood of item i coming from agent a.
 */
function em(p: SimParams, items: Item[], lik: Float64Array): Inference {
  const N = p.agents;
  const M = p.merchants;
  const alpha = 0.5;
  const theta = new Float64Array(N * M).fill(1 / M);
  const post = new Float64Array(items.length * N);
  const counts = new Float64Array(N * M);
  for (let iter = 0; iter <= p.emIterations; iter++) {
    counts.fill(0);
    for (let i = 0; i < items.length; i++) {
      const { merchant: m, count } = items[i];
      let sum = 0;
      for (let a = 0; a < N; a++) {
        const v = lik[i * N + a] * theta[a * M + m];
        post[i * N + a] = v;
        sum += v;
      }
      for (let a = 0; a < N; a++) {
        const r = sum > 0 ? post[i * N + a] / sum : 1 / N;
        post[i * N + a] = r;
        counts[a * M + m] += count * r;
      }
    }
    if (iter === p.emIterations) break;
    for (let a = 0; a < N; a++) {
      let total = 0;
      for (let m = 0; m < M; m++) total += counts[a * M + m];
      for (let m = 0; m < M; m++) theta[a * M + m] = (counts[a * M + m] + alpha) / (total + M * alpha);
    }
  }
  return { posterior: post, items };
}

/** Realistic watcher: sees only top-ups and per-merchant batch totals. */
export function inferFromBatches(p: SimParams, topUps: readonly TopUp[], batches: readonly Batch[]): Inference {
  const N = topUps.length;
  const cdf = (x: number) => (x > 0 ? 1 - Math.exp(-x / p.meanDelay) : 0);
  const lik = new Float64Array(batches.length * N);
  batches.forEach((b, i) => {
    for (let a = 0; a < N; a++) lik[i * N + a] = cdf(b.end - topUps[a].t) - cdf(b.start - topUps[a].t);
  });
  return em({ ...p, agents: N }, batches.map((b) => ({ merchant: b.merchant, count: b.total })), lik);
}

/** Oracle watcher: sees every hidden call's exact time and merchant. */
export function inferFromCalls(p: SimParams, topUps: readonly TopUp[], calls: readonly Omit<Call, "agent">[]): Inference {
  const N = topUps.length;
  const lik = new Float64Array(calls.length * N);
  calls.forEach((c, i) => {
    for (let a = 0; a < N; a++) {
      const dt = c.t - topUps[a].t;
      lik[i * N + a] = dt >= 0 ? Math.exp(-dt / p.meanDelay) : 0;
    }
  });
  return em({ ...p, agents: N }, calls.map((c) => ({ merchant: c.merchant, count: 1 })), lik);
}

export interface TrialScore {
  tokens: number;
  payerProb: number;
  spendTop1: number;
  merchants: number;
  merchantTop: number;
  merchantTopRandom: number;
}

const argmax = (v: Float64Array, from: number, n: number) => {
  let best = 0;
  for (let a = 1; a < n; a++) if (v[from + a] > v[from + best]) best = a;
  return best;
};

/** Scores one inference. `truth[i]` lists the true payer of each token in item i. */
function score(p: SimParams, inf: Inference, truth: number[][]): TrialScore {
  const N = p.agents;
  const M = p.merchants;
  const est = new Float64Array(N * M);
  const real = new Float64Array(N * M);
  let tokens = 0;
  let payerProb = 0;
  let spendTop1 = 0;
  inf.items.forEach((item, i) => {
    const guess = argmax(inf.posterior, i * N, N);
    for (const a of truth[i]) {
      tokens++;
      payerProb += inf.posterior[i * N + a];
      if (a === guess) spendTop1++;
      real[a * M + item.merchant]++;
    }
    for (let a = 0; a < N; a++) est[a * M + item.merchant] += item.count * inf.posterior[i * N + a];
  });
  let merchants = 0;
  let merchantTop = 0;
  let merchantTopRandom = 0;
  for (let m = 0; m < M; m++) {
    let top = 0;
    for (let a = 0; a < N; a++) top = Math.max(top, real[a * M + m]);
    if (top === 0) continue;
    merchants++;
    let guess = 0;
    let topSet = 0;
    for (let a = 0; a < N; a++) {
      if (est[a * M + m] > est[guess * M + m]) guess = a;
      if (real[a * M + m] === top) topSet++;
    }
    if (real[guess * M + m] === top) merchantTop++;
    merchantTopRandom += topSet / N;
  }
  return { tokens, payerProb, spendTop1, merchants, merchantTop, merchantTopRandom };
}

export function runTrial(p: SimParams, mode: Mode, rand: () => number): TrialScore {
  const day = generateDay(p, rand);
  if (mode === "oracle") {
    const inf = inferFromCalls(p, day.topUps, day.calls.map(({ merchant, t }) => ({ merchant, t })));
    return score(p, inf, day.calls.map((c) => [c.agent]));
  }
  const batches = publicBatches(p, day.calls);
  const inf = inferFromBatches(p, day.topUps, batches);
  const windows = Math.ceil(p.horizon / p.payoutInterval);
  const index = new Map<number, number>();
  batches.forEach((b, i) => index.set(b.merchant * windows + b.start / p.payoutInterval, i));
  const truth: number[][] = batches.map(() => []);
  for (const c of day.calls) truth[index.get(c.merchant * windows + Math.floor(c.t / p.payoutInterval))!].push(c.agent);
  return score(p, inf, truth);
}

export interface SimRow {
  mode: Mode;
  agents: number;
  payoutInterval: number;
  tokens: number;
  /** Plain x402 reveals every payer: 1 on every score. */
  plain: number;
  merchantTop: number;
  merchantTopRandom: number;
  payerProb: number;
  spendTop1: number;
  random: number;
}

export function simulate(p: SimParams, mode: Mode = "realistic"): SimRow {
  // Same seed for both modes, so both watchers see the same days.
  const rand = rng(p.seed + p.agents * 7919);
  const sum = { tokens: 0, payerProb: 0, spendTop1: 0, merchants: 0, merchantTop: 0, merchantTopRandom: 0 };
  for (let i = 0; i < p.trials; i++) {
    const r = runTrial(p, mode, rand);
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r[k];
  }
  const div = (x: number, y: number) => (y ? x / y : 1);
  return {
    mode,
    agents: p.agents,
    payoutInterval: p.payoutInterval,
    tokens: sum.tokens,
    plain: 1,
    merchantTop: div(sum.merchantTop, sum.merchants),
    merchantTopRandom: div(sum.merchantTopRandom, sum.merchants),
    payerProb: div(sum.payerProb, sum.tokens),
    spendTop1: div(sum.spendTop1, sum.tokens),
    random: 1 / p.agents,
  };
}

export type Metric = "merchantTop" | "payerProb" | "spendTop1";

export const METRIC_TITLES: Record<Metric, string> = {
  merchantTop: "Merchant top spender named correctly",
  payerProb: "Probability the watcher puts on the true payer",
  spendTop1: "Share of spend whose payer is the watcher's best guess",
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtInterval = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

export interface Report {
  realistic: SimRow[];
  oracle: SimRow[];
}

/** Realistic rows for every (interval, N), plus oracle rows per N. */
export function report(base: Omit<SimParams, "agents">, agents: number[], intervals: number[]): Report {
  return {
    realistic: intervals.flatMap((payoutInterval) => agents.map((n) => simulate({ ...base, payoutInterval, agents: n }, "realistic"))),
    oracle: agents.map((n) => simulate({ ...base, agents: n }, "oracle")),
  };
}

/** One markdown table for one metric: rows are N, columns are payout intervals. */
export function formatTable(r: Report, metric: Metric): string {
  const agents = r.oracle.map((o) => o.agents);
  const intervals = [...new Set(r.realistic.map((x) => x.payoutInterval))];
  const head = [
    "Agents (N)",
    "Plain x402",
    ...intervals.map((i) => `Realistic, payouts every ${fmtInterval(i)}`),
    "Oracle (per-call view)",
    "Random guess",
  ];
  const sep = head.map(() => "---:");
  const body = agents.map((n) => {
    const o = r.oracle.find((x) => x.agents === n)!;
    const cells = intervals.map((i) => pct(r.realistic.find((x) => x.agents === n && x.payoutInterval === i)![metric]));
    const random = metric === "merchantTop" ? o.merchantTopRandom : o.random;
    return [String(n), pct(o.plain), ...cells, pct(o[metric]), pct(random)];
  });
  return [head, sep, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function formatReport(r: Report): string {
  return (Object.keys(METRIC_TITLES) as Metric[])
    .map((m) => `${METRIC_TITLES[m]}\n\n${formatTable(r, m)}`)
    .join("\n\n");
}
