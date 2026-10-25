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
T54_MAX_AMOUNT=1000 \
python3 src/testnet-agent.py
```

`T54_MAX_AMOUNT` caps what a 402 may request, in the asset's base units (drops for XRP). The default is 1000. The buyer refuses to pay if the merchant asks for more.

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

`npm run sim` asks: from public chain data alone, what can a watcher infer about which agent paid which merchant?

**Day model.**

- N agents and M = 10 merchants over a 24-hour day.
- Each agent tops up once, at a random time in the first 12 hours, with the same 20-token bundle.
- Each agent has one home merchant that gets 60% of its calls (`--home-share`). The other calls go to a random merchant.
- The gap from top-up to each call is exponential with a mean of 120 minutes. Calls after 24 hours are dropped.

**What the watcher sees.**

- Plain x402: every call is an on-chain payment from the agent's wallet. The watcher reads the payer, so every score is 100%.
- Our system, **realistic mode**: only what the chain shows. Each top-up (wallet, amount, time). Per payout interval, one issuer → merchant total for each merchant. No single call is ever visible. `publicBatches()` builds this view and `inferFromBatches()` takes only top-ups and batches.
- Our system, **oracle mode**: an upper bound. The watcher also sees every hidden call on its own, with exact time and merchant. Only the payer is hidden. The chain does not show this.

**The watcher.** It knows the day model. For each batch (or call) it computes how likely each agent is from the top-up times. It runs EM over each agent's merchant habits. It ends with a probability over agents for each batch.

**Scores.** Ground truth is used only to score.

- Merchant top spender: for each merchant, is the watcher's most likely top spender one of the agents that really spent most there?
- Payer probability: the average probability the watcher puts on the true payer of a token.
- Spend share: the share of spend whose payer is the watcher's best guess for its batch.

**Result** (`npm run sim`, 200 seeded trials, seed 42):

**Merchant top spender named correctly**

| Agents (N) | Plain x402 | Realistic, payouts every 5 min | Realistic, payouts every 1 h | Realistic, payouts every 6 h | Realistic, payouts every 24 h | Oracle (per-call view) | Random guess |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| 5 | 100.0% | 78.2% | 74.5% | 57.3% | 26.9% | 78.3% | 27.8% |
| 20 | 100.0% | 48.5% | 37.4% | 16.9% | 7.0% | 49.5% | 6.3% |
| 100 | 100.0% | 10.0% | 6.0% | 3.0% | 1.9% | 10.8% | 1.4% |

**Probability the watcher puts on the true payer**

| Agents (N) | Plain x402 | Realistic, payouts every 5 min | Realistic, payouts every 1 h | Realistic, payouts every 6 h | Realistic, payouts every 24 h | Oracle (per-call view) | Random guess |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| 5 | 100.0% | 63.4% | 59.2% | 41.0% | 20.0% | 63.8% | 20.0% |
| 20 | 100.0% | 23.5% | 19.5% | 10.4% | 5.0% | 23.9% | 5.0% |
| 100 | 100.0% | 4.3% | 3.6% | 2.0% | 1.0% | 4.4% | 1.0% |

**Share of spend whose payer is the watcher's best guess**

| Agents (N) | Plain x402 | Realistic, payouts every 5 min | Realistic, payouts every 1 h | Realistic, payouts every 6 h | Realistic, payouts every 24 h | Oracle (per-call view) | Random guess |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| 5 | 100.0% | 73.0% | 68.7% | 50.3% | 20.0% | 73.7% | 20.0% |
| 20 | 100.0% | 35.6% | 28.8% | 13.7% | 5.0% | 36.5% | 5.0% |
| 100 | 100.0% | 8.1% | 5.7% | 2.8% | 1.0% | 8.3% | 1.0% |

**Compared with the earlier version.** The earlier simulation gave the watcher each call's payout window and a naive linker (latest top-up wins). It reported 51.9% / 14.7% / 1.6% for N = 5 / 20 / 100 at hourly payouts. A call's window carries the same information as one total per interval, so the flaw was the weak linker, not extra data. The new watcher is stronger: 68.7% / 28.8% / 5.7% spend share at hourly payouts, and 55.8% / 21.7% / 5.3% even with no merchant habits (`--home-share 0`). The old numbers overstated privacy.

**What the numbers say.** Short intervals leak. At 5 minutes, realistic mode is within a point of the oracle. Long intervals hide the payer: at one payout a day every score falls to a random guess. Privacy needs both a crowd and slow payouts.

**What this does not show.**

- One agent alone gets no privacy. Blind tokens need a crowd.
- All agents buy the same bundle. Varied top-up amounts would leak more.
- The model has no IP or TLS fingerprints, no merchant-side knowledge, and no habits across days. Each of these helps a real attacker.
- EM is strong but not optimal. Oracle and realistic use the same method, so an oracle score below realistic by under a point is noise.

Options: `--agents 1,5,20,100`, `--payout-min 5,60,360,1440`, `--trials`, `--calls`, `--merchants`, `--home-share`, `--delay-min`, `--seed`, `--json`.

## Limits of the live bot

- Service names come from hub prices. When the hub shows only part of a catalog, a `~` match is a best guess, not proof.
- The bot reads only t54-style Payments. Some hub merchants are paid another way. The Heurist Inference Router's recent history is CheckCreate and CheckCash with no x402 memo, so the bot prints nothing for it. Those Checks are just as public; reading them is future work.
- "Likely exchange" is a size rule. It never names the exchange or any owner.
