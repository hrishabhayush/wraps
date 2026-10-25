---
marp: true
paginate: true
title: wraps
---

# wraps

**Confidential payments for AI agents on XRPL**

Agents pay on their own. The chain stops showing what they buy.

XRPL AI & Fintech Hackathon · NYC · Oct 2026 · Prototype

---

## x402 made agent payments less private than a card

- A card statement is private. An **x402 statement is public, forever.**
- Every payment shows: payer wallet, merchant, amount, exact time.
- The x402 v2 payment payload carries the payer wallet, and it can carry the resource URL (the optional `resource` field). The facilitator receives it at verify and settle. ([x402 v2 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), §5.2, §7)
- t54's Trustline keeps "a signed, replayable evidence record" of agent identity, owner mandate and intent. ([t54.ai](https://t54.ai))

---

## Proof: a real agent payment on XRPL mainnet

```
21:24:30  rJmsb9…  →  AskSurf "X Tweets by IDs"   0.006 RLUSD
memo: "Facilitator by t54 labs"
```

- Merchant named from the public [XRPL AI Hub](https://xrpl-ai.org/) directory.
- Service identified from the price.
- No request content on-chain. The **spending record** is the leak.

Measured with our spy bot (on main), Oct 24, 2026.

---

## Rotating wallets doesn't fix it

We traced 50 payments to one merchant:

- **50 payments, 50 different wallets.** Agents already try to hide.
- **44 were funded straight from exchange hot wallets.** The exchange can tie each one to an account.
- **6 shared one ordinary funder.** Anyone can link them as one owner.

Measured with our spy bot (on main): `npm run spybot -- --merchant ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3 --limit 50`

---

## wraps: three layers

| Layer | What it does | Status |
|---|---|---|
| **Blind tokens** (RFC 9578) | The issuer cannot link a token it issued to its redemption | **On main** |
| **Attested issuer** | Runs in Google Cloud Confidential Space (AMD SEV). Agents verify the code before they pay | **On main**, verified live |
| **Attested relay** (VPN) | Would hide the agent's IP from merchants and the issuer | **In progress.** Proxy and metering on main. SDK route PR #5 (open), deployment PR #16 (draft) |

Tokens do not hide metadata or timing. Until the relay ships, merchants see the agent's IP. The merchant always sees the request. It has to, to answer it.

---

## How it works

1. The agent checks the issuer's **Google-signed attestation**: exact image, debug off, keys bound. *(on main)*
2. It **tops up** with RLUSD on XRPL EVM testnet and gets blind-signed tokens. *(on main; AP4M top-up not implemented)*
3. It **pays merchants with tokens**. No wallet payment per purchase. *(on main)* Routing through the relay to hide the IP: *in progress (PR #5, PR #16)*.
4. The issuer checks each token against one spent list and signs a **running-total claim** for the merchant. *(on main)*
5. Merchants are paid in **batches** across all customers. *(mocked; ISS-06 in progress)*

---

## Hardware attestation, verified live

| Check | Result |
|---|---|
| Production confidential VM | **Verified.** Google-signed, `GCP_AMD_SEV`, `CONFIDENTIAL_SPACE`, debug disabled since boot, image digest, nonce and key hash matched, TLS key pinned |
| Debug image | **Refused** |
| Wrong image digest | **Refused.** No top-up, no payment |

"Hardware-attested by AMD SEV, verified by Google." On main (PR #20).

---

## x402 facilitators fail published security rules

**"When HTTP 402 Meets the Blockchain"**, USENIX Security 2026 ([arXiv 2607.19545](https://arxiv.org/abs/2607.19545))
15 major x402 facilitators, used by 60K+ sellers and 360K+ buyers.

- **49 rule violations.**
- **Every facilitator violated at least one rule.**
- Coinbase, PayAI and Mogami confirmed 6 distinct vulnerabilities. Coinbase changed its code.

---

## What they failed

| Rule | Failed | What went wrong |
|---|---|---|
| **SR5** meaningless proofs, idempotency, freshness | **14 of 15** | Zero-value payments accepted, weak time and nonce checks |
| **SR7** re-check before settling | **14 of 15** | No re-validation at settlement time |
| **SR8** only allowed on-chain actions | **9** | Smart-contract wallet signatures triggered unexpected actions |
| **SR6** bounded sponsored fees | **3** (Solana) | No limit on signers or compute fees |
| **SR1–SR3** match, authentic, not expired | **3** | Scheme, nonce freshness, balance not checked |
| **SR4** valid only once settled | **2 validated cases** | Resource released before payment was final |

Source: [arXiv 2607.19545](https://arxiv.org/abs/2607.19545).

---

## How wraps measures up

**45 conformance tests, all passing on main.** `npm run test:conformance`

wraps passes **SR1 to SR5 and SR7 as written, and SR6/SR8 on the closest equivalent**.

- **SR5:** zero-value, stale and duplicate payments refused.
- **SR7:** `/settle` re-checks everything immediately before marking tokens spent.
- **SR3:** tokens expire with their signing key.
- **SR1 + M3:** each quote is single-use and bound to one resource and price.
- **M5:** paid responses are never cached.
- **SR6, SR8:** we sponsor no per-payment on-chain execution, so we test the closest equivalent: our payouts are capped and are plain RLUSD transfers only.

Our own tests against the paper's rules. Not an external audit. Details: `docs/SECURITY-CONFORMANCE.md`.

---

## Privacy grows with every user (in progress)

- Plain x402: a spy links every payment to its wallet. That is our measured mainnet finding.
- With blind tokens, a spy must guess which top-up funded which purchase. The more agents, the harder the guess.
- A realistic measurement is **in progress (PR #7)**. Our earlier simulation used an oracle assumption the watcher cannot observe, so we do not quote its numbers.

Background: Dingledine and Mathewson, ["Anonymity Loves Company"](https://www.freehaven.net/anonbib/cache/usability:weis2006.pdf) (2006).

---

## Off-chain settlement

- Plain x402 on XRPL waits for the ledger: XRPL mainnet averaged **about 4.0 s** per ledger over 20 ledgers (our measurement).
- wraps merchant payments clear **off-chain**. The chain is used only for top-ups and batched payouts.
- Our own latency: **benchmark pending (PR #7)**. No speed comparison until it is measured.

---

## Built on research

| Paper | What we use |
|---|---|
| Wang et al., USENIX Security 2026 ([arXiv 2607.19545](https://arxiv.org/abs/2607.19545)) | The 8 facilitator rules we test against |
| Li, Wang, Wang, "Five Attacks on x402" ([arXiv 2605.11781](https://arxiv.org/abs/2605.11781)) | Resource binding, cache hygiene for the relay |
| Ling et al., "Free-Riding the Agentic Web" ([arXiv 2605.30998](https://arxiv.org/abs/2605.30998)) | Settlement-race and substitution tests |
| Dold, "The GNU Taler System" (2019) ([PDF](https://taler.net/papers/thesis-dold-phd-2019.pdf)) | Payers private, merchant income transparent |
| Dingledine and Mathewson (2006) | Privacy as a network effect |

---

## "Isn't this a mixer?"

The design follows the GNU Taler model: **payers private, merchant income transparent.**

- Every funder is known at top-up.
- The public chain shows top-ups and payouts, not per-purchase payments.
- Owners keep receipts and can prove any payment to an auditor.
- Production would need a licensed partner. Today it is a testnet prototype.

Like a corporate card: the bank knows you, the public doesn't see your receipts.

---

## Market: early, and all of it is public

| Fact | Number | Source |
|---|---|---|
| XRPL x402, all time | 14.6M payments, over $30K settled, 177 merchants | [XRPL AI Hub](https://xrpl-ai.org/), read Oct 24, 2026 |
| All chains, real spending (May 2025 to Apr 2026, wash and test removed) | about $19M | Visa / Artemis, via [The Defiant](https://thedefiant.io/converge/infrastructure/visa-s-sheffield-pegs-adjusted-x402-volume-at-19m) |

We found no shipped confidential payment layer for x402 on XRPL as of Oct 24, 2026. Ripple is working on private agent payments ([Ripple's XRPL privacy and AI agent roadmap](https://cryptopotato.com/major-ripple-xrp-reveal-from-seoul-xrpl-gets-privacy-ai-agent-upgrades-and-more/)).
We're building the privacy layer before the money arrives.

---

## Roadmap

- **In progress:** SDK through the relay (PR #5), relay in Confidential Space (PR #16), on-chain merchant payouts (ISS-06), latency benchmark and realistic privacy model (PR #7)
- **Roadmap:** Mastercard AP4M top-up
- **Roadmap:** two-hop network on two chip vendors
- **Roadmap:** Anonymous Credit Tokens: partial spending and anonymous change ([IETF draft](https://datatracker.ietf.org/doc/html/draft-schlesinger-cfrg-act-01))
- **Roadmap:** trust-minimized hub, after TumbleBit and A²L
- **Roadmap:** Ripple's Confidential Transfers (XLS-96) for payout amounts
- **Roadmap:** licensed partner for third-party merchants

---

## Honest limits

- Prototype on testnet.
- Relay IP hiding does not work end to end yet.
- Merchant payouts are mocked. AP4M top-up is not implemented.
- Blind tokens hide the issuance-to-redemption link only. Not metadata, timing or IPs.
- Timing can link top-ups to spending when few people use it.
- We trust Google's attestation service and AMD SEV.
- The image build isn't reproducible yet.

---

# wraps

**Blind tokens and an attested issuer, live today. The relay is next.**

Agent payments are early. Right now, every one of them is public.
We are building the confidential layer, and we show what is proven.
