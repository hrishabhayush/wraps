---
marp: true
paginate: true
title: wraps
---

# wraps

**Confidential payments for AI agents on XRPL**

Agents pay on their own. Nobody sees what they buy.

XRPL AI & Fintech Hackathon · NYC · Oct 2026

---

## x402 made agent payments less private than a card

- A card statement is private. An **x402 statement is public, forever.**
- Every payment shows: payer wallet, merchant, amount, exact time.
- The facilitator also receives the **wallet and the exact URL** of every request (x402 v2 spec).
- t54's Trustline keeps "a signed, replayable evidence record" of agent identity, owner mandate and intent.

---

## Proof: a real agent payment on XRPL mainnet

```
21:24:30  rJmsb9…  →  AskSurf "X Tweets by IDs"   0.006 RLUSD
memo: "Facilitator by t54 labs"
```

- Merchant named from the public XRPL AI Hub directory.
- Service identified from the price.
- No request content on-chain. The **spending record** is the leak.

---

## Rotating wallets doesn't fix it

We traced 50 payments to one merchant:

- **50 payments, 50 different wallets.** Agents already try to hide.
- **44 were funded straight from exchange hot wallets.** The exchange knows who withdrew.
- **6 shared one ordinary funder.** Anyone can link them as one owner.

---

## wraps: three layers, no one sees the whole picture

| Layer | Hides | How |
|---|---|---|
| **Blind tokens** (RFC 9578) | Who paid | The issuer signs tokens it never sees |
| **Attested relay** (VPN) | Where the request came from | Merchants see the relay's IP, not the agent's |
| **Attested issuer** | That anyone can cheat | Runs in a Google confidential VM. Agents verify the code first |

The merchant still sees the request. It has to, to answer it.

---

## How it works

1. The agent checks the issuer's **Google-signed attestation**: exact image, debug off, keys bound.
2. It **tops up** with RLUSD on XRPL EVM and gets blind-signed tokens.
3. It **pays merchants with tokens**, through the relay. No wallet, no IP.
4. The issuer checks each token against one spent list and signs a **running-total claim** for the merchant.
5. Merchants are paid in **batches**, mixed across all customers.

---

## Hardware attestation, verified live

| Check | Result |
|---|---|
| Production confidential VM | **Verified.** Google-signed, `GCP_AMD_SEV`, `CONFIDENTIAL_SPACE`, debug disabled since boot, image digest, nonce and key hash matched, TLS key pinned |
| Debug image | **Refused** |
| Wrong image digest | **Refused.** No top-up, no payment |

"Hardware-encrypted by AMD SEV, verified by Google."

---

## x402 facilitators fail published security rules

**"When HTTP 402 Meets the Blockchain"**, USENIX Security 2026
15 production facilitators on **Base and Solana**, serving 60K+ sellers and 360K+ buyers.

- **49 rule violations.**
- **Every facilitator failed at least one rule.**
- Coinbase, PayAI and Mogami confirmed 6 vulnerabilities. Coinbase changed its code.

---

## What they failed

| Rule | Failed | What went wrong |
|---|---|---|
| **SR5** meaningless proofs, idempotency, freshness | **14 of 15** | Zero-value payments accepted, weak time and nonce checks |
| **SR7** re-check before settling | **14 of 15** | No re-validation at settlement time |
| **SR8** only allowed on-chain actions | **9** | Smart-contract wallet signatures triggered unexpected actions |
| **SR6** bounded sponsored fees | **3** (Solana) | No limit on signers or compute fees |
| **SR1–SR3** match, authentic, not expired | **3** | Scheme, nonce freshness, balance not checked |
| **SR4** valid only once settled | **2** | Resource released before payment was final |

Most common attacks: inflated sponsor fees and "free shopping." Asset theft: rarer, highest impact.

---

## wraps passes all eight

**45 conformance tests, all passing.** `npm run test:conformance`

- **SR5:** zero-value, stale and duplicate payments refused.
- **SR7:** `/settle` re-checks everything immediately before marking tokens spent.
- **SR3:** tokens expire with their signing key.
- **SR1 + M3:** each quote is single-use and bound to one resource and price.
- **M5:** paid responses are never cached.
- **SR6, SR8:** tested on our payouts: capped, plain RLUSD transfers only.

Our own tests against the paper's rules. Not an external audit.

---

## Privacy grows with every user

Spy linking a top-up to spending (timing only):

| Agents | Plain x402 | wraps (hourly payouts) | Random guess |
|---:|---:|---:|---:|
| 1 | 100% | 100% | 100% |
| 5 | 100% | 52% | 20% |
| 20 | 100% | 15% | 5% |
| 100 | 100% | 1.6% | 1% |

"Anonymity Loves Company" (Dingledine and Mathewson, 2006).

---

## Private and faster

- Plain x402 on XRPL waits for the ledger: **about 4.0 s** per payment (measured on mainnet).
- wraps payments clear **off-chain**. The chain is used only for top-ups and batched payouts.
- Our measured local latency: see `docs/BENCH.md` (PR #7). Only show the measured number.

---

## Built on research

| Paper | What we use |
|---|---|
| Wang et al., USENIX Security 2026 | The 8 facilitator rules we pass |
| Li, Wang, Wang, "Five Attacks on x402" (2026) | Resource binding, cache hygiene for the relay |
| Ling et al., "Free-Riding the Agentic Web" (2026) | Settlement-race and substitution tests |
| Dold, "The GNU Taler System" (2019) | Payers private, merchant income transparent |
| Dingledine and Mathewson (2006) | Privacy as a network effect |

---

## "Isn't this a mixer?"

No. It's the GNU Taler model: **payers private, merchant income transparent.**

- Every funder is known at top-up.
- Spending is confidential from the public and from us.
- Owners keep receipts and can prove any payment to an auditor.
- Production runs through a licensed partner.

Like a corporate card: the bank knows you, the public doesn't see your receipts.

---

## Market: early, and all of it is public

| Fact | Number |
|---|---|
| XRPL x402, all time | 14.6M payments, $30.5K settled, 177 merchants |
| All chains, real spending (May 2025 to Apr 2026) | about $19M |
| Largest real category | Crypto and DeFi data |

**First working confidential payment layer for x402 agents on XRPL.**
We're building the privacy layer before the money arrives.

---

## Roadmap

- Two-hop network on two chip vendors
- Real on-chain merchant payouts
- Anonymous Credit Tokens: partial spending and anonymous change (IETF drafts, 2026)
- Trust-minimized hub, after TumbleBit and A²L
- Ripple's Confidential Transfers (XLS-96) for payout amounts
- Licensed partner for third-party merchants

---

## Honest limits

- Timing can link top-ups to spending when few people use it.
- We trust Google's attestation service and AMD SEV.
- The image build isn't reproducible yet.
- Merchant payouts are mocked.

---

# wraps

**Three layers. No one sees the whole picture.**

Agents will do most of the buying soon. Right now, all of it is public.
We make it confidential, and we prove it.
