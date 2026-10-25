# x402 security conformance

This page maps published x402 security rules to our `blindtoken` scheme. The issuer is the
x402 facilitator: `/verify` is read-only, and `/settle` marks tokens spent and adds them to the
merchant's tab. The merchant quotes, collects tokens, and serves data.

**These are our own tests against the papers' rules. They are not an external audit.** A pass
means our test for our reading of the rule passes. It does not mean the papers' authors checked us.

Run them:

```sh
npm run test:conformance
```

Tests live in `packages/issuer/test/conformance.test.ts` and
`packages/merchant/test/conformance.test.ts`. Each test name starts with its rule ID.

## Sources

1. **[USENIX'26]** Wang, Yang, Chen, Ji, Payer. "When HTTP 402 Meets the Blockchain: Risks on
   Emerging x402 Payments." USENIX Security 2026. <https://arxiv.org/abs/2607.19545>.
   Eight facilitator rules, SR1 to SR8. All 15 production facilitators they tested broke at least one.
2. **[Five]** Li, Wang, Wang. "Five Attacks on x402 Agentic Payment Protocol."
   <https://arxiv.org/abs/2605.11781>. We use mitigations M1, M3 and M5.
3. **[FreeRide]** Ling et al. "Free-Riding the Agentic Web: A Systematic Security Analysis of
   x402 Payments." <https://arxiv.org/abs/2605.30998>. We use four flaw classes.

## How the rules map to blind tokens

A blind token is an RFC 9578 type 0x0002 token. It is worth a fixed 0.10 RLUSD. Tokens are
generic: one token works at any merchant. So the "payment proof" is a set of tokens, and the
"server-declared requirements" are the merchant's quote: resource, price in tokens, and expiry.
Settlement is a ledger update inside the issuer, not an on-chain call. The issuer's own on-chain
actions are merchant payouts in RLUSD on the XRPL EVM sidechain. Top-ups are paid by the payer,
through the mock AP4M voucher rail or a real RLUSD transfer (`XrplEvmTransferRail`).

## Status

| Rule | Status | Test | Why |
|---|---|---|---|
| SR1 proof matches requirements | pass (fixed) | `SR1: a payment that does not reference a quote is refused and the tokens stay unspent`, `SR1: a quote for one query cannot pay for another query on the same path`, `SR1: top-up payment for fewer tokens than requested is refused` | The 402 carries a quote bound to resource, price and expiry. The payment must name it. Top-up proofs must match quote, payee and amount. |
| SR2 authentic authorization | pass | `SR2: a token with a forged (bit-flipped) RSA signature is refused`, `SR2: a token signed by a key outside the attested key set is refused`, `SR2: a top-up voucher with a bad payer signature is refused` | Tokens verify under Blind RSA (PSS, SHA-384) with a known issuer key epoch. Vouchers verify under Ed25519. |
| SR3 expired authorization | pass (fixed) | `SR3: expired token is refused`, `SR3: after key rotation the old key stays verifiable until its not-after` | Tokens used to live forever. Now each token key has an epoch with a not-after time. Tokens from expired epochs are refused. |
| SR4 valid only when settled | pass | `SR4: /verify is read-only and does not settle; only /settle moves the tab`, `SR4 / FreeRide denial of settlement: the merchant serves nothing when settlement fails, and the payer can retry` | The merchant serves only after `/settle` returns a signed claim. The issuer signs top-up tokens only after the rail confirms payment. |
| SR5 meaningless proofs, idempotency, freshness | pass (fixed) | `SR5: zero, negative and fractional top-up quotes are refused`, `SR5/M1: a duplicate payment ID is refused, in one batch and on replay (idempotent settle)`, `SR5: a payment against a stale quote is refused` | No zero or fractional prices or quotes. The spent list makes settle idempotent. Merchant quotes expire after 60 s. |
| SR6 sponsored execution caps | pass with equivalent | `SR6: payout batch is capped by line count and total`, `SR6: a batch whose fee is above the cap is not sent and nothing is marked paid` | We sponsor no payer transactions. The equivalent is our own spend: configurable caps on payout lines, payout total, payout fee, and tokens per request. |
| SR7 re-verify before settle | pass | `SR7: a token that passed /verify but was spent since is refused at /settle`, `SR7: a token that passed /verify but expired since is refused at /settle` | `/settle` runs the full verification itself and marks spent with no await in between. |
| SR8 allowed, unambiguous on-chain semantics | pass with equivalent | `SR8: payouts are plain RLUSD transfers to the registered address only`, `SR8: approve, transferFrom, extra calldata, native value, other contracts and other payees are refused` | Settling a token has no on-chain call. The equivalent is payouts: only `transfer(address, amount)` on RLUSD to a registered merchant address. |
| M1 canonical encoding and freshness | pass (fixed) | `M1: malformed and non-canonical token encodings are refused`, `M1: malformed authorization headers and quote ids are refused` | A token must round-trip byte for byte. Truncated, padded or trailing bytes are refused. Duplicates and stale quotes are refused (SR5). |
| M3 single-use grant bound to resource | pass (fixed) | `M3: a quote is a single-use grant; fresh tokens cannot reuse a paid quote`, `M3 / FreeRide duplicate-settlement race: concurrent identical paid requests, exactly one is served`, `M3: the same tokens on two quotes at once: only one request is served` | The merchant claims (quote, tokens) atomically before it calls `/settle`, and releases the claim only if settle fails. |
| M5 cache and header hygiene | pass (fixed) | `M5: paid merchant responses carry Cache-Control: no-store, private`, `M5: the relay does not cache and does not modify the payment headers` | Paid responses send `Cache-Control: no-store, private` and `Vary: authorization`. The relay is a CONNECT tunnel and passes bytes through unchanged. |
| FreeRide cross-resource substitution | pass (fixed) | `FreeRide cross-resource substitution: a quote for the cheap service does not unlock the expensive one` | The quote names the resource. A quote for `/analytics` cannot pay for `/filings`. |
| FreeRide duplicate-settlement race | pass | `FreeRide duplicate-settlement race: concurrent /settle of one token, exactly one wins` | Check and mark are atomic in the issuer, across all merchants. |
| FreeRide allowance overdraft | pass | `FreeRide allowance overdraft: the issuer never signs beyond funds held` | The issuer refuses to sign beyond funds held or beyond the paid quote. The SDK enforces per-call and daily caps. |
| FreeRide denial of settlement | pass | `SR4 / FreeRide denial of settlement: the merchant serves nothing when settlement fails, and the payer can retry` | Settle comes before serve, so a merchant is never left unpaid. A failed settle reopens the quote, so the payer loses nothing. |

## What changed to pass

- **Key epochs (SR3).** `IssuerCore` keeps a list of token keys. Each has a key ID, a
  not-before and a not-after time (default lifetime 30 days). `rotateTokenKey()` starts a new
  epoch. Old keys stay verifiable until their not-after. The issuer rotates on attestation or
  `GET /keys` once less than half the lifetime is left, so every new token gets at least that
  long. Blinded requests for a retired key are refused before any payment is redeemed.
  The attestation response keeps `publicKeys` unchanged and adds `tokenKeyId`,
  `tokenKeyNotAfter` and `tokenKeys`. `tokenKeys` is signed with the attested claim key, so
  clients can trust the not-after times. Merchants re-check the issuer attestation every 10
  minutes so their 402 challenge follows rotation.
- **Quote binding (SR1, M3, cross-resource).** The merchant 402 adds `quoteId`, `resource` and
  `expiresAt`. The client sends the quote back in the `x-blindtoken-quote` header. The SDK does
  this, and refuses a 402 whose `resource` is not the URL it asked for.
- **Cache headers (M5).** Paid responses send `Cache-Control: no-store, private`. All issuer and
  merchant JSON responses default to the same.
- **Meaningless and malformed proofs (SR5, M1).** Zero or fractional quotes and prices are
  refused. Non-canonical token encodings are refused. `/verify` and `/settle` cap tokens per
  request.
- **Payout caps (SR6) and plain transfers (SR8).** `PayoutScheduler` takes `PayoutCaps`:
  `maxLines`, `maxBatchTokens`, `maxFeeRlusd`. `XrplEvmPayoutRail` now builds only plain RLUSD
  transfers to registered addresses. Signing and sending are still TODO (ISS-06).

## Honest limits

- The attestation itself still binds only the current token key and the claim key. Older
  epochs and all not-after times are bound through the claim-key signature on `tokenKeys`.
- Expired tokens that were never spent stay counted as outstanding. The funds stay held.
- The merchant keeps quotes in memory, like the issuer's spent list (SPEC §12).
- SR6 and SR8 are tested against our closest equivalent, not the rule as written, because the
  issuer sponsors no payer transactions and settling a token touches no chain.
- `XrplEvmPayoutRail` does not sign or send yet. The tests cover the transaction it would send.
