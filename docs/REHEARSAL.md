# wraps live rehearsal

Run this three times end to end before the Mastercard demo. Use testnet funds and the real AP4M sandbox flow. Do not use a recording as the demonstration.

## Before each run

- [ ] Start the issuer and relay from the documented deployment procedure.
- [ ] Confirm the issuer and relay attestations verify, including non-debug image measurements.
- [ ] Confirm the agent can reach the merchant only through the relay.
- [ ] Confirm the agent wallet, issuer budget, merchant payout address, and AP4M sandbox setup are ready.
- [ ] Open the explorer and the demo view; clear the previous run's event output.

## Run sequence

1. Start the spy bot and confirm it can read the public XRPL activity.
2. Start the agent with its configured budget and daily cap.
3. Let the agent hit the issuer's top-up challenge and complete the AP4M voucher payment.
4. Confirm the voucher redemption on the explorer and the issuer's funded balance.
5. Let the agent buy both merchant services through the relay using blind tokens.
6. Confirm both services succeed, the issuer records the settled tokens, and the spy bot does not attribute those service calls to the agent.
7. Confirm the merchant sees the relay address and can verify the issuer's signed running-total claim.
8. Stop services cleanly and save logs with wallet seeds, tokens, and private keys excluded.

## Record each rehearsal

| Run | Date | Top-up visible | Both services paid | Spy result correct | Attestations verified | Outcome / issue |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |

Count a run only if every item in the sequence succeeds in one uninterrupted live run. Fix issues and repeat the failed run; do not count partial runs.
