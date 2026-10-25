# Benchmarks

Run both benchmarks with:

```sh
npm run bench
```

The command reports two things. The first is measured on this machine. The second is a simulation.

## Paid-call latency (measured, local only)

Each sample is one complete paid call: the merchant's 402, the SDK's token submission, issuer verify and settle, and the merchant's response. Attestation setup and top-ups happen before sampling.

Everything runs on local HTTP servers with mock attestation, a mock top-up rail and mock payouts. This is not a Nitro, Confidential Space, AP4M or XRPL number. It says nothing about network latency in production.

Result (`npm run bench`, 50 samples after 5 warm-up calls, one laptop, 2026-10-24):

| Metric | Local mock flow |
|---|---:|
| p50 | 1.79 ms |
| p95 | 3.52 ms |
| min | 1.37 ms |
| max | 3.98 ms |

## Watcher inference (simulated)

The question: from public chain data alone, what can a watcher infer about which agent paid which merchant?

The full model is in [`packages/spybot/README.md`](../packages/spybot/README.md#simulation-dem-03). In short:

- N agents and 10 merchants. Each agent tops up once with the same 20-token bundle, at a random time in the first 12 hours of a day.
- Each agent has a home merchant that gets 60% of its calls. The other calls go to a random merchant.
- Calls follow the top-up by an exponential delay with a mean of 2 hours.
- **Realistic mode.** The watcher sees only what the chain shows: each top-up (wallet, amount, time) and, per payout interval, one issuer → merchant total for each merchant. It never sees a single call.
- **Oracle mode.** The watcher also sees every hidden call on its own, with exact time and merchant. Only the payer is hidden. This is not observable on chain. It is an upper bound.
- The watcher knows the model. It runs EM over each agent's merchant habits, using how likely each batch (or call) is given each top-up time.

Three scores. Ground truth is used only to score, never by the watcher.

- **Merchant top spender:** for each merchant, the watcher names the agent it thinks spent most there. Correct if that agent really is a top spender.
- **Payer probability:** the average probability the watcher puts on the true payer of a token.
- **Spend share:** the share of spend whose payer is the watcher's single best guess for its batch. This is the same unit as the old per-call score.

Plain x402 publishes the payer of every call, so it is 100% on every score.

Result (`npm run bench` or `npm run sim`, 200 seeded trials, seed 42):

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

### How this compares with the earlier numbers

The earlier version of this benchmark reported 51.9% / 14.7% / 1.6% for N = 5 / 20 / 100 with hourly payouts. Those numbers were too good for us.

- The earlier model gave the watcher each call's payout window and scored it per call. Without merchants, that is the same information as one total per interval. The real flaw was the watcher. It gave every call in a window to the agent with the latest top-up and ignored everything else.
- The new watcher uses the top-up times as a likelihood and learns merchant habits. With hourly payouts its spend share is 68.7% / 28.8% / 5.7%. With no merchant habits at all (`--home-share 0`) it is still 55.8% / 21.7% / 5.3%, above the old numbers.
- The oracle is barely ahead of realistic mode at 5-minute payouts. Within a short interval, exact call times add little to what totals show. Long intervals are what hide the payer.
- At one payout a day, the realistic watcher falls to a random guess on every score. At 6 hours it is about two to three times a random guess.

What this means for the design: privacy needs both a crowd and slow payouts. Hourly payouts with 20 agents still let a watcher name a merchant's top spender 37% of the time, against 6% by chance.

### What this does not show

- One agent alone gets no privacy. Blind tokens need a crowd.
- All agents buy the same bundle. Varied top-up amounts would leak more.
- No IP or TLS fingerprints, no merchant-side knowledge, no habits across days. Each of these helps a real attacker.
- EM is a strong watcher but not optimal. The oracle uses the same method, so small inversions (oracle below realistic by under a point) are noise, not a real effect.

## Options

```sh
npm run bench -- --samples 100 --warmup 10 --trials 500 --seed 42 --agents 1,5,20,100 --payout-min 5,60,360,1440
npm run bench -- --json
npm run sim -- --home-share 0 --merchants 20
```
