# wraps live rehearsal

Run this three times end to end before the demo. Do not use a recording as the demonstration.

The core run uses only what is on main: the issuer in Google Cloud Confidential Space, the merchant and agent on a laptop, and the spy bot. It does not need AP4M or a deployed relay. Those are optional add-ons, listed at the end. Add them only when they are merged and deployed.

## Before each run

- [ ] Start the issuer VM (`infra/gcp/deploy.sh issuer`) and confirm `infra/gcp/status.sh issuer` shows it healthy.
- [ ] Run `npm run verify:gcp`. It must pass with a production image: debug off, image digest and key hash matched.
- [ ] If the issuer VM is down, use rehearsal mode instead: `ATTESTATION=mock npm run demo:gcp`. Say on stage that this is mock attestation.
- [ ] For the left screen, fund one XRPL Testnet buyer wallet from the faucet. Keep only testnet funds in it. Set `T54_MAX_AMOUNT` to the merchant's price (default `1000` drops). The buyer refuses any 402 that asks for more.
- [ ] Open the demo view and clear the previous run's event output.

## Run sequence

1. Start the spy bot on mainnet (`npm run spybot -- --merchant ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3 --limit 50`) and confirm it reads public XRPL activity.
2. Left screen: from `packages/spybot`, run the plain x402 testnet buyer once (`python3 src/testnet-agent.py`) and the testnet watcher (`npm run spy:testnet`). See `packages/spybot/README.md`. Confirm the watcher shows the buyer's wallet, the merchant, the amount and the time.
3. Right screen: run `npm run demo:gcp`. The agent and merchant verify the issuer's Google-signed token and pin its TLS key.
4. Confirm the agent tops up (mock rail) and receives blind tokens.
5. Confirm the agent buys merchant services with tokens, and each purchase gets a signed running-total claim.
6. Run `npm run demo:gcp -- --gullible` and confirm the caps stop "buy 500 more".
7. Stop services cleanly. Save logs with wallet seeds, tokens and private keys removed.

## What to say about what is not live

- Top-ups use the mock rail in this run. Mastercard AP4M is not implemented.
- Merchant payouts are mocked (ISS-06 in progress).
- The agent talks to the merchant directly. Hiding its IP through the relay needs PR #5 and PR #16.

## Optional add-ons (only when merged and deployed)

- [ ] **AP4M top-up.** Only if PAY-03 is merged and the AP4M sandbox is set up (INF-17, INF-18). Confirm the voucher redemption on the explorer.
- [ ] **Relay.** Only if PR #5 (SDK through the relay) and PR #16 (relay in Confidential Space) are merged and the relay VM is up. Confirm the relay attestation verifies and the merchant sees the relay address.
- [ ] **On-chain payouts.** Only if ISS-06 ships. Confirm one payout per merchant on the XRPL EVM explorer.

## Record each rehearsal

| Run | Date | Issuer attestation verified | Tokens bought and spent | Caps held (`--gullible`) | Spy result correct | Optional add-ons used | Outcome / issue |
|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |

Count a run only if every core step succeeds in one uninterrupted live run. Fix issues and repeat the failed run. Do not count partial runs.
