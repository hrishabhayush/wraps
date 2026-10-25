#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_SIM, formatTable, simulate } from "./sim.js";

const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "1,5,20,100" },
    trials: { type: "string", default: String(DEFAULT_SIM.trials) },
    calls: { type: "string", default: String(DEFAULT_SIM.callsPerAgent) },
    "payout-min": { type: "string", default: String(DEFAULT_SIM.payoutInterval) },
    "delay-min": { type: "string", default: String(DEFAULT_SIM.meanDelay) },
    seed: { type: "string", default: String(DEFAULT_SIM.seed) },
    json: { type: "boolean", default: false },
  },
});

const base = {
  ...DEFAULT_SIM,
  trials: Number(values.trials),
  callsPerAgent: Number(values.calls),
  payoutInterval: Number(values["payout-min"]),
  meanDelay: Number(values["delay-min"]),
  seed: Number(values.seed),
};
const rows = values.agents.split(",").map((n) => simulate({ ...base, agents: Number(n) }));

if (values.json) {
  process.stdout.write(JSON.stringify({ params: base, rows }, null, 2) + "\n");
} else {
  process.stdout.write(
    `Share of paid calls a watcher links to the right agent ` +
      `(${base.trials} trials, ${base.callsPerAgent} calls/agent, payouts every ${base.payoutInterval} min, ` +
      `mean top-up-to-call delay ${base.meanDelay} min, seed ${base.seed})\n\n`,
  );
  process.stdout.write(formatTable(rows) + "\n");
}
