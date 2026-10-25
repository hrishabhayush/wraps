# spybot

The spy bot reads plain x402 payments on XRPL mainnet. It prints only what the chain and the public XRPL AI Hub show: who paid, which merchant, which service the price points to, and who funded the paying wallets. It never names a wallet owner.

Lane 7 in `docs/TODO.md` (SPY-01, SPY-02, SPY-03) and the DEM-03 simulation.

## Run

Needs Node 20 or later.

```sh
cd packages/spybot
npm install
npm run spy -- --merchant ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3 --limit 50
npm run sim
npm test
```

## t54 Testnet demo (SPY-04)

The merchant, buyer, and watcher run separately. The local FastAPI merchant protects `/hello` with t54's XRPL x402 middleware; the buyer pays it on XRPL Testnet, and the watcher tails the merchant account and emits JSONL `payment` events for the demo UI.

Install the Python dependencies once (Python 3.11+):

```sh
python3 -m pip install 'x402-xrpl==0.3.4' requests fastapi uvicorn
```

Create two XRPL Testnet wallets and fund them from the [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets). Keep their seeds in environment variables and out of source control. Start the merchant:

```sh
XRPL_MERCHANT_SEED=sMerchantSeed \
T54_TESTNET_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai \
uvicorn src.testnet-merchant:app --host 127.0.0.1 --port 8787
```

The same resource URL and merchant account go to the watcher and buyer:

Watcher:

```sh
T54_TESTNET_RESOURCE_URL=http://127.0.0.1:8787/hello \
T54_TESTNET_MERCHANT=rMerchantAddress \
T54_TESTNET_AMOUNT_DROPS=1000 \
npm run spy:testnet
```

Buyer:

```sh
XRPL_BUYER_SEED=sTestnetSeed \
T54_TESTNET_RESOURCE_URL=http://127.0.0.1:8787/hello \
python3 src/testnet-agent.py
```

The watcher recognizes the current t54 v2 payment form only when both the default t54 `SourceTag` (`804681468`) and an XRPL `InvoiceID` are present. Older x402 transactions with a facilitator memo continue to use the mainnet parser. The payment tag alone is not treated as proof of x402.

Options for `npm run spy`:

| Option | Meaning |
|---|---|
| `--merchant <r...>` | Merchant to watch. Repeat for more. Default: AskSurf. |
| `--limit <n>` | Recent x402 payments to read per merchant. Default 50. |
| `--follow` | Keep polling for new payments (every 4 s). |
| `--no-cluster` | Skip funder clustering. |
| `--no-upstream` | Do not look one hop above each funder. |
| `--no-catalog` | Use only the hub home page. |
| `--quicknode <url>` | Use a Quicknode XRPL mainnet endpoint. Env: `QUICKNODE_XRPL_URL`. Public nodes stay as fallback. |
| `--json` | Print events as JSON lines. |

## Example output (live mainnet, 2026-10-24)

```
catalog ra9b6J…gzC3: hub shows 24 of 120 APIs ("~" = best price match among those)
20:08:41  rntPo5…  →  AskSurf ~"X Tweets by IDs"  0.006 RLUSD
20:09:00  r4u9ta…  →  AskSurf ~"X Tweets by IDs"  0.006 RLUSD
...
50 wallets → 7 funders
  rBtttd…eA1A  funded 12 wallets  [likely exchange: 14,384,905 XRP, ~3,429,930 txs sent]
  rarG6F…bZKk  funded 8 wallets  [likely exchange: 10,603,174 XRP, ~1,322,732 txs sent]
  ...
  rBNFYY…Vrv4  funded 6 wallets  ← funded by rao8BV…h8Gh
  rDAE53…JPxr  funded 3 wallets  [likely exchange: 151,558,546 XRP, ~4,127,199 txs sent]
```

## How it works

**Directory (SPY-01).** `loadDirectory()` fetches `https://xrpl-ai.org/` and parses its service cards into `{address, service, host, price, currency, issuer, verified, merchant}`. A good fetch is cached to `data/directory-cache.json`. If the fetch fails, the bot reads the cache.

The home page shows only one sample card per merchant. So the bot also reads each watched merchant's page (`/address/<r>`, `loadCatalog()`). That page shows an "Active APIs" count and the first 24 services. Later pages render in the browser, so the server HTML does not have them. Catalogs are cached to `data/catalog-cache.json` for 6 hours.

**Payments (SPY-02).** `readRecentPayments()` calls `account_tx` on the merchant. A transaction counts as x402 when it is a successful Payment with a memo of type `urn:x402:facilitator` (t54 writes `{"id":"t54-xrpl-x402",...}`). The amount is `meta.delivered_amount`. `SourceTag 804681468` is t54's facilitator tag, the same for every endpoint, so the bot does not use it to name services.

Naming a service from the price:

| What the bot knows | Output |
|---|---|
| Full catalog, one service at this price | `AskSurf "X Tweets by IDs"` |
| Partial catalog, one known service at this price | `AskSurf ~"X Tweets by IDs"` (best match) |
| Several services at this price | `Monid Tool Router (24+ services at this price)` |
| Merchant listed, price not listed | `Heurist Mesh (price not in directory)` |

When the home card and the merchant page disagree on a service's price, the merchant page wins.

**Funders (SPY-03).** `clusterByFunder()` reads each payer's first transaction (`account_tx`, `forward: true`, `limit: 1`). If that is a Payment into the payer, its sender is the funder. Payers are grouped by funder, one level only.

A funder is labelled "likely exchange" when it holds more than 1,000,000 XRP or has sent more than about 1,000,000 transactions. The bot does not trace past such a wallet. For other funders it looks one hop up, for display only.

The sent count is an estimate. Accounts created after 2020 start their `Sequence` at the creation ledger, so sent ≈ `Sequence − creation ledger`. Older accounts start at 1, so sent ≈ `Sequence`.

**RPC.** `XrplRpc` rotates between `s1.ripple.com`, `s2.ripple.com` and `xrplcluster.com` on every call. On `tooBusy`, `slowDown`, HTTP 429/5xx or a network error it moves to the next node and backs off (500 ms doubling, max 10 s, with jitter). A Quicknode URL goes first in the rotation.

## Event API

For the demo page (DEM-01):

```ts
import { SpyBot, formatPayment } from "@agent-pay/spybot";

const spy = new SpyBot({ merchants: ["ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3"], limit: 20, follow: true });
spy.on("payment", ({ payment, match }) => console.log(formatPayment(payment, match)));
spy.on("cluster", (c) => console.log(`${c.payersTraced} wallets → ${c.clusters.length} funders`));
await spy.run(); // spy.stop() ends follow mode
```

Events: `directory`, `catalog`, `payment`, `funder`, `progress`, `cluster`, `retry`, `warning`, `done`. `npm run spy -- --json` prints the same events as JSON lines.

## Simulation (DEM-03)

`npm run sim` asks: if a watcher sees every top-up and every payout, how often can it link a paid call to the right agent?

**Model.**

- N agents. Each tops up once, at a random time in the first 12 hours of a 24-hour day. The top-up is public: wallet and time.
- After its top-up, each agent makes 20 paid calls. The gap from top-up to each call is exponential with a mean of 120 minutes.
- Plain x402: each call is an on-chain payment from the agent's wallet. The watcher reads the payer, so it is always right.
- Our system: calls spend blind tokens and leave no per-call trace. The issuer pays merchants in one batch every 60 minutes. The watcher learns only which payout window a call fell in.
- Naive timing linker: it gives every call in a window to the agent with the most recent top-up before the window closes.
- Score: the share of calls given to the right agent. 200 seeded trials per row.

**Result** (`npm run sim`, seed 42):

| Agents (N) | Plain x402 | Batched blind tokens, timing linker | Random guess (1/N) |
|---:|---:|---:|---:|
| 1 | 100.0% | 100.0% | 100.0% |
| 5 | 100.0% | 51.9% | 20.0% |
| 20 | 100.0% | 14.7% | 5.0% |
| 100 | 100.0% | 1.6% | 1.0% |

The payout interval matters. With payouts every 5 minutes the linker gets 59.8% / 24.6% / 5.0% for N = 5 / 20 / 100. With one payout a day it falls to a random guess. Try `npm run sim -- --payout-min 5`.

**What this does not show.**

- One agent alone gets no privacy. Blind tokens need a crowd.
- The model has no unique amounts, no IP or TLS fingerprints, no merchant-side knowledge, and no repeat habits across days. Each of these helps a real attacker.
- The linker is naive on purpose. A smarter one can do better at small N.
- The crowd is assumed active over the same day. A quiet hour shrinks it.

## Limits of the live bot

- Service names come from hub prices. When the hub shows only part of a catalog, a `~` match is a best guess, not proof.
- The bot reads only t54-style Payments. Some hub merchants are paid another way. The Heurist Inference Router's recent history is CheckCreate and CheckCash with no x402 memo, so the bot prints nothing for it. Those Checks are just as public; reading them is future work.
- "Likely exchange" is a size rule. It never names the exchange or any owner.
