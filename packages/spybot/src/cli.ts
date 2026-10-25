#!/usr/bin/env node
import { parseArgs } from "node:util";
import { SpyBot } from "./spy.js";
import { formatCluster, formatPayment } from "./format.js";
import { shortAddr } from "./util.js";

const HELP = `spybot: read plain x402 payments on XRPL mainnet

Usage: npm run spy -- [options]

  --merchant <r...>   Merchant address to watch. Repeat for more. Default: AskSurf.
  --limit <n>         Recent x402 payments to read per merchant (default 50).
  --follow            Keep polling for new payments.
  --no-cluster        Skip funder clustering.
  --no-upstream       Do not look one hop above each funder.
  --no-catalog        Use only the hub home page, not merchant pages.
  --quicknode <url>   Use a Quicknode XRPL endpoint (or env QUICKNODE_XRPL_URL).
  --cache <path>      Directory cache file.
  --json              Print events as JSON lines (for piping to a web page).
  -h, --help
`;

const { values } = parseArgs({
  options: {
    merchant: { type: "string", multiple: true },
    limit: { type: "string", default: "50" },
    follow: { type: "boolean", default: false },
    "no-cluster": { type: "boolean", default: false },
    "no-upstream": { type: "boolean", default: false },
    "no-catalog": { type: "boolean", default: false },
    quicknode: { type: "string" },
    cache: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const merchants = values.merchant?.length ? values.merchant : ["ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3"];
const quicknodeUrl = values.quicknode ?? process.env.QUICKNODE_XRPL_URL;

const spy = new SpyBot({
  merchants,
  limit: Number(values.limit),
  follow: values.follow,
  cluster: !values["no-cluster"],
  upstream: !values["no-upstream"],
  catalog: !values["no-catalog"],
  quicknodeUrl,
  cachePath: values.cache,
});

const log = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

if (values.json) {
  for (const ev of ["directory", "catalog", "payment", "funder", "cluster", "warning", "done"] as const) {
    spy.on(ev, (data?: unknown) => log(JSON.stringify({ event: ev, data: data instanceof Error ? data.message : data })));
  }
} else {
  spy.on("directory", (d) =>
    err(`directory: ${d.count} services from xrpl-ai.org${d.fromCache ? ` (cache from ${d.fetchedAt})` : ""}`),
  );
  err(`watching ${merchants.map((m) => shortAddr(m, 6, 4)).join(", ")} via ${quicknodeUrl ? "Quicknode" : "public nodes"}`);
  spy.on("catalog", (c) =>
    err(
      `catalog ${shortAddr(c.address, 6, 4)}: hub shows ${c.seen} of ${c.total ?? "?"} APIs` +
        (c.complete ? " (complete)" : ' ("~" = best price match among those)'),
    ),
  );
  spy.on("payment", ({ payment, match }) => log(formatPayment(payment, match)));
  spy.on("progress", ({ done, total }) => {
    if (process.stderr.isTTY) process.stderr.write(`\rtracing funders ${done}/${total}`);
    if (done === total && process.stderr.isTTY) process.stderr.write("\n");
  });
  spy.on("retry", (r) => {
    if (r.attempt >= 2) err(`  (rate limited: ${r.reason} at ${new URL(r.endpoint).host}, backing off ${Math.round(r.delayMs)} ms)`);
  });
  spy.on("cluster", (c) => {
    log("");
    for (const line of formatCluster(c)) log(line);
    log("Labels come only from on-chain size. No wallet owner is named.");
  });
  spy.on("warning", (e) => err(`warning: ${e.message}`));
}

process.on("SIGINT", () => {
  spy.stop();
  process.exit(0);
});

spy.run().catch((e) => {
  err(`error: ${(e as Error).message}`);
  process.exit(1);
});
