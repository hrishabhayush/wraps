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

Most tests live in `packages/issuer/test/conformance.test.ts` and
`packages/merchant/test/conformance.test.ts`. SEC-04 and SEC-06 coverage is in
`packages/issuer/test/merchant-auth-conformance.test.ts` and
`packages/issuer/test/state-conformance.test.ts`. Each test name starts with its rule ID. The SDK
reservation tests (SEC-02) live in `packages/sdk/test/reservation.test.ts`, and the payout rail
tests live in `packages/issuer/test/payout-xrpl-evm.test.ts` and `payout-anvil.test.ts`.
`npm test` runs all of them.

## Sources

1. **[USENIX'26]** Wang, Yang, Chen, Ji, Payer. "When HTTP 402 Meets the Blockchain: Risks on
   Emerging x402 Payments." USENIX Security 2026. <https://arxiv.org/abs/2607.19545>.
   Eight facilitator rules, SR1 to SR8. All 15 production facilitators they tested broke at least one.
2. **[Five]** Li, Wang, Wang. "Five Attacks on x402 Agentic Payment Protocol."
   <https://arxiv.org/abs/2605.11781>. We use mitigations M1, M3 and M5.
3. **[FreeRide]** Ling et al. "Free-Riding the Agentic Web: A Systematic Security Analysis of
   x402 Payments." <https://arxiv.org/abs/2605.30998>. We use four flaw classes.

SEC-02 and SEC-03 are our own findings, not rules from the papers.

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
| SR4 valid only when settled | pass | `SR4: /verify is read-only and does not settle; only /settle moves the tab`, `SR4 / FreeRide denial of settlement: the merchant serves nothing when settlement fails, and the payer can retry` | The merchant serves only after the issuer confirms its own settle: a signed claim, or `settled-by-you` from `/settle/status` (SEC-03). The issuer signs top-up tokens only after the rail confirms payment. |
| SR5 meaningless proofs, idempotency, freshness | pass (fixed) | `SR5: zero, negative and fractional top-up quotes are refused`, `SR5/M1: a duplicate payment ID is refused, in one batch and on replay (idempotent settle)`, `SR5: a payment against a stale quote is refused` | No zero or fractional prices or quotes. The spent list refuses a token twice. With a quote ID, a repeat settle returns the original claim instead (SEC-03). Merchant quotes expire after 60 s. |
| SR6 sponsored execution caps | pass with equivalent | `SR6: payout batch is capped by line count and total`, `SR6: a batch whose fee is above the cap is not sent and nothing is marked paid`, `a gas price above the cap sends nothing`, `every signed tx carries a gas limit at or below the cap`, `the batch fee cap stops the batch; the rest waits` | We sponsor no payer transactions. The equivalent is our own spend: caps on payout lines, payout total, batch fee, gas price, gas per transfer, and tokens per request. |
| SR7 re-verify before settle | pass | `SR7: a token that passed /verify but was spent since is refused at /settle`, `SR7: a token that passed /verify but expired since is refused at /settle` | `/settle` runs the full verification itself and marks spent with no await in between. |
| SR8 allowed, unambiguous on-chain semantics | pass with equivalent | `SR8: payouts are plain RLUSD transfers to the registered address only`, `SR8: approve, transferFrom, extra calldata, native value, other contracts and other payees are refused`, `an unregistered merchant is not paid; registered ones in the same batch are`, `a registered address cannot be changed` | Settling a token has no on-chain call. The equivalent is payouts: the issuer signs only `transfer(address, amount)` on RLUSD to a registered merchant address. |
| M1 canonical encoding and freshness | pass (fixed) | `M1: malformed and non-canonical token encodings are refused`, `M1: malformed authorization headers and quote ids are refused` | A token must round-trip byte for byte. Truncated, padded or trailing bytes are refused. Duplicates and stale quotes are refused (SR5). |
| M3 single-use grant bound to resource | pass (fixed) | `M3: a quote is a single-use grant; fresh tokens cannot reuse a paid quote`, `M3 / FreeRide duplicate-settlement race: concurrent identical paid requests, exactly one is served`, `M3: the same tokens on two quotes at once: only one request is served` | The merchant claims (quote, tokens) atomically before it calls `/settle`. It releases the claim only when it knows the settle did not land (SEC-02). |
| M5 cache and header hygiene | pass (fixed) | `M5: paid merchant responses carry Cache-Control: no-store, private`, `M5: the relay does not cache and does not modify the payment headers` | Paid responses send `Cache-Control: no-store, private` and `Vary: authorization`. The relay is a CONNECT tunnel and passes bytes through unchanged. |
| FreeRide cross-resource substitution | pass (fixed) | `FreeRide cross-resource substitution: a quote for the cheap service does not unlock the expensive one` | The quote names the resource. A quote for `/analytics` cannot pay for `/filings`. |
| FreeRide duplicate-settlement race | pass | `FreeRide duplicate-settlement race: concurrent /settle of one token, exactly one wins` | Check and mark are atomic in the issuer, across all merchants. |
| FreeRide allowance overdraft | pass | `FreeRide allowance overdraft: the issuer never signs beyond funds held` | The issuer refuses to sign beyond funds held or beyond the paid quote. The SDK enforces per-call and daily caps. |
| FreeRide denial of settlement | pass | `SR4 / FreeRide denial of settlement: the merchant serves nothing when settlement fails, and the payer can retry` | Settle comes before serve, so a merchant is never left unpaid. A settle the issuer refused reopens the quote. An ambiguous settle keeps it held (SEC-02). The payer loses nothing either way. |
| SEC-02 ambiguous settle | pass (fixed) | `SR4 ambiguous settle: the answer is lost after the issuer settled; /settle/status confirms it and the merchant serves once`, `SR4 ambiguous settle: issuer unreachable; the quote stays held, even past expiry, until the same tokens settle it`, `SR4 ambiguous settle race: a delayed settle lands after the merchant answered pending; the retry serves once and the tab counts it once`, `SR4 ambiguous settle race: after a gateway 504, concurrent retries with the same tokens are served exactly once`, `SEC-02: a network error keeps the tokens reserved, not reusable, until resolvePending settles them`, `SEC-02: a merchant whose settle was ambiguous answers 503 pending; the SDK retries with the same tokens and is served once` | A timeout, network error or gateway 502/504 on `/settle` never reopens the quote blindly. The merchant looks the outcome up. If it cannot know, it keeps the quote and tokens held and answers 503 `pending` with `retry-after`. The SDK reserves tokens before it pays. A definite refusal restores the unspent ones. An ambiguous outcome keeps them reserved until `resolvePending()` retries with the same tokens and quote. |
| SEC-03 cross-merchant double-serve | pass (fixed) | `SEC-03 cross-merchant race: tokens settled at merchant B during A's ambiguous settle; A refuses, B serves, exactly one serve`, `SEC-03 cross-merchant race: after A answers pending, the payer spends the tokens at B; A's retry refuses and never serves`, `SEC-03: retrying /settle after a lost answer and a failed status lookup is safe; the original claim comes back and the tab counts once`, `SEC-03: a repeat settle with the same merchant, quote and tokens returns the original claim and counts once`, `SEC-03: concurrent identical settles for one quote all return the one original claim`, `SEC-03: a repeat settle on the same quote with different tokens is refused, and those tokens stay unspent`, `SEC-03: /settle/status answers settled-by-you, settled-by-other, unspent and expired`, `SEC-03: a token settled and then expired still reports settled, and a repeat settle still returns the original claim`, `SEC-03: /settle/status refuses malformed input and forged tokens instead of guessing`, `SEC-03: /settle/status over HTTP never reveals the other merchant, its quote or its claim` | See below. Settle is idempotent per (merchant, quote). After an ambiguous settle the merchant asks a merchant-scoped status, and serves only on `settled-by-you`. |
| SEC-04 merchant authentication | partial: merchant routes pass; relay integration gap | `SEC-04: rejects unauthenticated, wrong-key, stale and replayed settle requests; identities cannot be substituted`, `SEC-04: allows the fixed relay ID only with its separately configured legacy key` | `/settle`, `/settle/status` and `GET /payouts?merchantId=` require an Ed25519 signature bound to merchant ID, method, path, body hash, timestamp and nonce. The issuer persists nonce use. The relay key mode is implemented, but the current relay client does not send its bearer credential yet. |
| SEC-06 issuer state persistence | local file store pass; Confidential Space gap | `SEC-06: restores spent tokens, settlements, tabs and funds after restart; old keys are not restored`, `SEC-06: resumes the same in-flight signed payout after restart and does not broadcast a second transfer`, `SEC-06: detects journal tampering, partial truncation and rollback to an older valid record` | `IssuerStateStore` has an in-memory default and an append-only file implementation for local/non-enclave runs. File records have sequence numbers, a SHA-256 chain and a separately fsynced head marker. The current Confidential Space image has no persistent disk and stays in-memory. |

## SEC-03: cross-merchant double-serve

**The race.** After an ambiguous `/settle`, the merchant used to ask `/verify` whether the
tokens were spent. `/verify` says "spent" but not who spent them. A payer could send the same
tokens to merchant B while merchant A was unsure. B settled and served. A then saw "spent",
took it as proof that its own settle landed, and served too. Two merchants served, and only B
was paid.

**The fix, in the issuer.**

- `POST /settle` takes an optional `quoteId`. With it, settle is idempotent per
  (merchantId, quoteId). The issuer records each settlement: merchant ID, quote ID and a
  fingerprint of the exact tokens. A repeat with the same tokens returns the original signed
  claim and changes nothing, even after the tokens expire. A repeat with other tokens for the
  same quote gets 409. Without a `quoteId`, settle works as before (the relay and the app use it).
- `POST /settle/status` takes `{merchantId, quoteId, tokens}` and answers `{status}` with exactly
  one of `settled-by-you`, `settled-by-other`, `unspent` or `expired`. It is read-only. It checks
  spent before expired, so a token that was settled and then expired still reports as settled.
  `settled-by-other` covers every spender that is not this (merchant, quote): another merchant,
  or this merchant on another quote. It never names the merchant, the quote or the claim.
  Malformed or forged tokens get 400 or 409, not a guess.
- `/verify` is unchanged.

**The fix, in the merchant.** The merchant sends its quote ID on every `/settle`. After an
ambiguous settle it calls `/settle/status`:

| Answer | Merchant action |
|---|---|
| `settled-by-you` | Serve once. The quote is used. |
| `settled-by-other` | Refuse with 402. Never serve. The quote reopens for a fresh payment. |
| `expired` | Refuse with 402. The quote reopens. |
| `unspent` | Reopen only if the issuer itself answered the settle. After a network error or 502/504, keep the quote held and answer 503 `pending`. |
| no answer | Keep the quote held and answer 503 `pending` (SEC-02). |

A retry with the same tokens and quote calls `/settle` again. If the first settle landed, the
issuer returns the original claim. The merchant accepts an older claim only on such a retry,
and does not store it as its latest claim.

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
  refused. Non-canonical token encodings are refused. `/verify`, `/settle` and `/settle/status`
  cap tokens per request.
- **Payouts (SR6, SR8).** `PayoutScheduler` takes `PayoutCaps`: `maxLines`, `maxBatchTokens`,
  `maxFeeRlusd`. `XrplEvmPayoutRail` signs and sends plain RLUSD transfers to registered
  addresses only, with caps on gas price, gas per transfer and batch fee. A tab is marked paid
  only after a success receipt. A transfer whose send timed out, or whose receipt has not come,
  stays in flight. The next batch checks its receipt by hash and rebroadcasts the same signed
  bytes, so a merchant is never paid twice. Registered addresses cannot change after start-up.
  The mock rail is the default (`PAYOUT_RAIL=mock`). `PAYOUT_RAIL=xrpl-evm` needs a key, the
  RLUSD address and merchant addresses.
- **Ambiguous settle (SEC-02).** See the SEC-02 row.
- **Cross-merchant double-serve (SEC-03).** See the SEC-03 section.
- **Merchant authentication (SEC-04).** Configure `ISSUER_MERCHANT_AUTH_KEYS` as a JSON object mapping merchant IDs to base64url Ed25519 SPKI public keys. Merchants sign `/settle` and `/settle/status`; payout-history lookups use the same request format. Unknown IDs, bad signatures, stale timestamps and repeated nonces are refused. Local demos generate and register an ephemeral key automatically. `ISSUER_DEV_MERCHANT_AUTH=1` is restricted to loopback mock runs. The relay's temporary `ISSUER_RELAY_SETTLE_KEY` is bound to one fixed relay ID; its current client still needs to attach `Authorization: Bearer <key>`.
- **Issuer state (SEC-06).** `MemoryIssuerStateStore` is the default. `FileIssuerStateStore` appends snapshots and fsyncs each record before acknowledging the state change. It checks the sequence/hash chain and head marker on load, and contains spent IDs, settlements, tabs, paid history, funds held, unspent-issued counts, merchant nonces and signed in-flight payout bytes. Set `ISSUER_STATE_FILE` only for a local/non-enclave run whose filesystem survives process restarts.

## Honest limits

- **Relay authentication integration remains open.** The issuer has a separate fixed-ID bearer credential (`ISSUER_RELAY_SETTLE_KEY`) because relay settles have no quote ID and the current relay HTTP client does not sign. The relay needs to attach `Authorization: Bearer <key>` through its `issuerFetch` before strict authentication can be enabled for relay traffic. This task did not edit `packages/relay` or `infra/`; unsigned relay settles are rejected outside local loopback development mode.
- **Confidential Space state does not survive restart today.** The deployed confidential VM has no persistent disk and uses `MemoryIssuerStateStore`. Durable enclave state needs storage encrypted and integrity-protected with a key released only to the attested workload, for example Cloud KMS with an attestation-bound policy. That is roadmap work; the file journal is for local/non-enclave runs. Its local head marker detects a truncated or rolled-back journal while the marker remains intact; replacing both local files together needs an external monotonic anchor to detect.
- **Signing keys are memory-only.** Restarting the enclave creates new token and claim keys. In a file-backed local run, persisted spent IDs and settlement records remain, but old tokens fail as unknown-key/bad-signature and old signed claims/payout records cannot be verified against the new claim key. Tabs, payout history and in-flight payout bytes remain; `/settle/status` can still identify a previously settled quote.
- Settles without a quote ID (relay, app) are not idempotent. A repeat is refused as "already
  spent", as before.
- The attestation itself still binds only the current token key and the claim key. Older
  epochs and all not-after times are bound through the claim-key signature on `tokenKeys`.
- Expired tokens that were never spent stay counted as outstanding. The funds stay held.
- SR6 and SR8 are tested against our closest equivalent, not the rule as written, because the
  issuer sponsors no payer transactions and settling a token touches no chain.
- `XrplEvmPayoutRail` is tested on a local anvil chain and on a fake JSON-RPC node. It has not
  sent a live testnet payout yet.
