# Benchmarks

Run the local benchmark with:

```sh
npm run bench
```

The command reports two measurements:

- **Paid-call latency:** p50 and p95 for a complete local mock payment. Each sample includes the merchant's initial 402, SDK token submission, issuer verification and settlement, and the merchant response. Attestation setup and token top-ups happen before sampling. This uses local HTTP servers, mock attestation, and mock rails; it is not a Nitro, AP4M, XRPL, or production latency result.
- **Watcher attribution accuracy:** the seeded timing-linker simulation at 1, 5, 20, and 100 agents. The plain x402 row is 100% by construction because each payment publishes the payer. The blind-token row models only the timing information described in `packages/spybot/README.md`.

Options can tune run size and reproduce simulation output:

```sh
npm run bench -- --samples 100 --warmup 10 --trials 500 --seed 42 --agents 1,5,20,100
npm run bench -- --json
```

These are independent models: local paid-call latency describes the SDK/issuer/merchant mock flow, while the privacy figures are simulated and do not imply measured production traffic.
