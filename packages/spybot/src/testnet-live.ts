#!/usr/bin/env node
import { SpyBot } from "./spy.js";
import { XrplRpc } from "./rpc.js";
import type { DirectoryEntry } from "./directory.js";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const merchantAddress = required("T54_TESTNET_MERCHANT");
const resourceUrl = required("T54_TESTNET_RESOURCE_URL");
const parsedResource = new URL(resourceUrl);
const resourceLabel = `${parsedResource.origin}${parsedResource.pathname}`;
const service = process.env.T54_TESTNET_SERVICE?.trim() || parsedResource.pathname;
const amountDrops = Number(process.env.T54_TESTNET_AMOUNT_DROPS ?? "1000");
if (!Number.isSafeInteger(amountDrops) || amountDrops <= 0) throw new Error("T54_TESTNET_AMOUNT_DROPS must be a positive integer");

const entry: DirectoryEntry = {
  address: merchantAddress,
  service,
  host: parsedResource.host,
  price: amountDrops / 1_000_000,
  currency: "XRP",
  verified: true,
  merchant: "t54 testnet demo",
};

const rpc = new XrplRpc({
  endpoints: [process.env.XRPL_TESTNET_RPC_URL?.trim() || "https://s.altnet.rippletest.net:51234/"],
});
const spy = new SpyBot({
  merchants: [merchantAddress],
  rpc,
  directory: [entry],
  catalog: false,
  cluster: false,
  follow: true,
  limit: 20,
  pollMs: 1_500,
});

spy.on("directory", (event) => process.stdout.write(`${JSON.stringify({ event: "ready", merchant: merchantAddress, resource: resourceLabel, ...event })}\n`));
spy.on("payment", ({ payment, match }) => {
  process.stdout.write(`${JSON.stringify({
    event: "payment",
    network: "xrpl:1",
    hash: payment.hash,
    ledger: payment.ledger,
    time: payment.time.toISOString(),
    payer: payment.payer,
    merchant: payment.merchant,
    amount: payment.amount,
    currency: payment.currency,
    sourceTag: payment.sourceTag,
    invoiceId: payment.invoiceId,
    facilitator: payment.facilitator,
    service: match.kind === "service" ? match.entry.service : null,
  })}\n`);
});
spy.on("warning", (error) => process.stderr.write(`${JSON.stringify({ event: "warning", message: error.message })}\n`));

process.on("SIGINT", () => {
  spy.stop();
  process.exit(0);
});

spy.run().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: "error", message: (error as Error).message })}\n`);
  process.exitCode = 1;
});
