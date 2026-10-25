#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_SIM, formatReport, report } from "./sim.js";

const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "1,5,20,100" },
    "payout-min": { type: "string", default: "5,60,360,1440" },
    trials: { type: "string", default: String(DEFAULT_SIM.trials) },
    calls: { type: "string", default: String(DEFAULT_SIM.callsPerAgent) },
    merchants: { type: "string", default: String(DEFAULT_SIM.merchants) },
    "home-share": { type: "string", default: String(DEFAULT_SIM.homeShare) },
    "delay-min": { type: "string", default: String(DEFAULT_SIM.meanDelay) },
    seed: { type: "string", default: String(DEFAULT_SIM.seed) },
    json: { type: "boolean", default: false },
  },
});

const list = (s: string) => s.split(",").map(Number);
const base = {
  ...DEFAULT_SIM,
  trials: Number(values.trials),
  callsPerAgent: Number(values.calls),
  merchants: Number(values.merchants),
  homeShare: Number(values["home-share"]),
  meanDelay: Number(values["delay-min"]),
  seed: Number(values.seed),
};
const r = report(base, list(values.agents), list(values["payout-min"]));

if (values.json) {
  process.stdout.write(JSON.stringify({ params: base, ...r }, null, 2) + "\n");
} else {
  process.stdout.write(
    `What a chain watcher infers about who paid whom ` +
      `(${base.trials} trials, ${base.callsPerAgent} calls/agent, ${base.merchants} merchants, ` +
      `home share ${base.homeShare}, mean top-up-to-call delay ${base.meanDelay} min, seed ${base.seed}).\n` +
      `Realistic: top-ups + one payout total per merchant per interval. ` +
      `Oracle: also every hidden call's exact time and merchant (upper bound).\n\n`,
  );
  process.stdout.write(formatReport(r) + "\n");
}
