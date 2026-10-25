# Highlights

What we can claim, and the proof behind each claim. Every item says where the proof lives: **on main**, **in a PR**, **measured**, **simulated** or **cited**. Parts that do not work yet are marked **mocked**, **in progress (PR #N)** or **roadmap**. Use this for the pitch, the demo and judge questions. Don't claim anything that isn't on this page.

Last updated: Oct 24, 2026.

---

## 1. Real hardware attestation, verified live

**Claim:** "Our issuer runs in a Google Cloud confidential VM. Before paying, the agent checks a Google-signed token that names the exact code running. A changed image is refused."

| Proof | Status |
|---|---|
| Issuer deployed in Google Confidential Space (AMD SEV) on project `wraps-hack` | On main (PR #20). Re-verified live a second time on Oct 25 |
| SDK verified a live **production** token from a laptop: signed by Google (RS256), `GCP_AMD_SEV`, `CONFIDENTIAL_SPACE`, debug `disabled-since-boot`, image digest, nonce and key hash all matched, TLS key pinned | Measured, PR #20 |
| **Debug** image refused (`DEBUG_MODE`) | Measured, PR #20 |
| **Wrong image digest** refused (`IMAGE_MISMATCH`), no top-up or payment sent | Measured, PR #20 |
| Merchant and agent ran against the live issuer: 1 top-up (mock rail), 8 purchases, 8 signed claims checked against the attested key | Measured, PR #20 |

**Say:** "hardware-attested by AMD SEV, verified by Google." **Don't say:** "trustless" or "SEV-SNP" (we deployed SEV).

**Show:** Start the issuer VM, then run `npm run verify:gcp` and `npm run demo:gcp`.

---

## 2. Blind tokens on the IETF standard

**Claim:** "Payments use Privacy Pass tokens (RFC 9578, blind RSA). The issuer cannot link a token it issued to that token's redemption."

**Scope:** this covers issuance vs redemption only. It does not hide top-up identity, metadata, timing, IP addresses (until the relay ships, see §8) or what the merchant sees.

| Proof | Status |
|---|---|
| RFC 9578 token type 0x0002 built on Cloudflare's `@cloudflare/privacypass-ts` | On main |
| Same token rejected twice, at one merchant and across merchants, including concurrent settles | On main, tested |

---

## 3. Security tests

**Claim:** "The listed security flaws and failure modes have regression tests."

| Proof | Status |
|---|---|
| 151 tests passing, typecheck clean | On main |
| Confidential Space verifier tests cover tampered digest, debug mode, wrong nonce, replay, wrong key hash, bad signature, wrong issuer or audience, expired token, wrong platform, and TLS pinning | On main |
| Tampered issuer refused, debug mode refused, replayed receipt refused | On main (`npm run demo:core -- --tamper`) |
| Prompt injection ("buy 500 more") stopped by caps in code, not by the model | On main (`npm run demo:core -- --gullible`) |
| 402 above the price cap refused, no wallet fallback | On main |

---

## 4. Passing the published x402 facilitator rules

**Claim:** "A USENIX Security 2026 study ([arXiv 2607.19545](https://arxiv.org/abs/2607.19545)) tested 15 major x402 facilitators against 8 security rules and found violations in all of them. wraps passes SR1 to SR5 and SR7 as written, and SR6/SR8 on the closest equivalent."

| Proof | Status |
|---|---|
| 45 conformance tests for SR1 to SR8, M1, M3, M5 and the four Free-Riding flaw classes, all passing (`npm run test:conformance`) | On main (PR #23) |
| Fixes for real gaps the rules exposed: token expiry via key epochs (SR3), single-use quotes bound to resource and price (SR1, M3), `no-store` on paid responses (M5), payout caps (SR6), canonical token encoding (M1) | On main (PR #23) |
| Table of rule → status → test. SR6 and SR8 are tested on their closest equivalent (our payouts), because we sponsor no per-payment on-chain execution | `docs/SECURITY-CONFORMANCE.md` on main |

Be honest: these are our own tests against the paper's rules, not an external audit.

---

## 5. The problem, proven on mainnet

**Claim:** "x402 publishes your agent's spending record. Here it is, live."

| Proof | Status |
|---|---|
| Real x402 payment read from XRPL mainnet: payer wallet, merchant, 0.006 RLUSD, exact time, t54 facilitator memo. No URL or request content on-chain | Measured |
| Service identified from merchant plus price via the [XRPL AI Hub](https://xrpl-ai.org/) directory | Measured, spy bot on main |
| 50 payments to one merchant came from 50 different wallets. 44 were funded straight from exchange hot wallets (10M+ XRP each), so the exchange can tie each one to an account. The other 6 shared one ordinary funder, so the public can link them | Measured, spy bot on main |
| The x402 v2 payment payload carries the payer wallet, and it can carry the resource URL (optional `resource` field; the spec's example includes it). The facilitator receives the payload at verify and settle | Cited: [x402 v2 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), §5.2, §7 |
| t54's Trustline keeps "a signed, replayable evidence record" of agent identity, owner mandate and intent | Cited: [t54.ai](https://t54.ai) |

**Show:** `npm run spybot -- --merchant ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3 --limit 50`

---

## 6. Privacy needs a crowd and slow payouts

**Claim:** "Plain x402 shows the payer of every payment. With blind tokens, a watcher of the public chain must guess. In simulation, privacy needs both many agents and slow payouts."

Share of spend whose payer is the watcher's best guess (200 trials):

| Agents | Plain x402 | Payouts every 5 min | every 1 h | every 6 h | every 24 h | Random guess |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 100% | 100% | 100% | 100% | 100% | 100% |
| 5 | 100% | 73.0% | 68.7% | 50.3% | 20.0% | 20.0% |
| 20 | 100% | 35.6% | 28.8% | 13.7% | 5.0% | 5.0% |
| 100 | 100% | 8.1% | 5.7% | 2.8% | 1.0% | 1.0% |

Status: **simulation, PR #7** (open; `docs/BENCH.md` there). The watcher sees only top-ups and one issuer→merchant total per merchant per payout interval, and runs EM. A per-call "oracle" view is the upper bound. It models timing and merchant habits only. Real attackers could also use amounts, IPs and merchant data.

**Say:** "With hourly payouts a watcher still attributes 69% of spend at 5 agents and 6% at 100. At one payout a day it falls to a random guess." The older 52% / 15% / 1.6% table overstated privacy. Don't use it.

Cited: Dingledine and Mathewson, ["Anonymity Loves Company"](https://www.freehaven.net/anonbib/cache/usability:weis2006.pdf) (2006): anonymity grows with the user base.

---

## 7. Off-chain merchant settlement

**Claim:** "Merchant payments clear off-chain, so the merchant response does not wait for a ledger. Local benchmark: p50 1.8 ms vs about 4 s ledger wait for plain x402."

| Proof | Status |
|---|---|
| XRPL mainnet ledger interval averaged **4.0 s** over 20 ledgers | Measured |
| xrpl.org: the x402 response returns once settlement is verified | Cited: [xrpl.org x402 docs](https://xrpl.org/docs/agents/agentic-payments-x402) |
| Our paid-call latency: p50 1.79 ms, p95 3.52 ms. Local HTTP, mock attestation, mock top-up, mock payouts, one laptop | Measured locally, PR #7 (open) |

**Don't say:** "faster in production". The local number has no network or real attestation in it.

---

## 8. The VPN layer

**Claim:** "The relay can tunnel and meter HTTPS traffic." End-to-end IP hiding does **not** work yet. Until PR #5 and PR #16 ship, merchants and the issuer see the agent's IP.

| Proof | Status |
|---|---|
| HTTPS CONNECT relay proxy | On main (PR #2 merged) |
| Relay metered with blind tokens per 10 MB | On main (PR #3 merged) |
| SDK tunnels through the attested relay | PR #5 (open; not yet on main) |
| Relay in Confidential Space | PR #16 (draft; not yet deployed) |

---

## 9. Real money moving

| Proof | Status |
|---|---|
| Real RLUSD top-ups to the issuer on XRPL EVM testnet, from a browser wallet (WalletConnect) | On main (teammate) |
| Menu bar app buys and spends real blind tokens | On main (teammate) |
| Signed merchant claims and signed proof of reserves ("outstanding ≤ funds held") | On main |
| Merchant payouts on-chain | Mocked (ISS-06 in progress) |
| AP4M (Mastercard) top-up | Not implemented (skipped for now) |

---

## 10. Research behind the design

| Paper | What we take from it |
|---|---|
| Wang et al., "When HTTP 402 Meets the Blockchain", USENIX Security 2026 ([arXiv 2607.19545](https://arxiv.org/abs/2607.19545)) | The 8 facilitator rules we test against |
| Li, Wang, Wang, "Five Attacks on x402" ([arXiv 2605.11781](https://arxiv.org/abs/2605.11781)) | Resource binding (M3) and cache hygiene (M5), which matter for our relay |
| Ling et al., "Free-Riding the Agentic Web" ([arXiv 2605.30998](https://arxiv.org/abs/2605.30998)) | Duplicate-settlement races and cross-resource substitution tests |
| Dold, "The GNU Taler System" (PhD thesis, 2019) ([PDF](https://taler.net/papers/thesis-dold-phd-2019.pdf)) | "Income transparency": payers private, merchant income visible. Our answer to "isn't this a mixer?" Production would need a licensed partner |
| Schlesinger, Katz, Meunier, "Anonymous Credit Tokens" (IETF drafts, 2026) ([draft](https://datatracker.ietf.org/doc/html/draft-schlesinger-cfrg-act-01)) | Roadmap: partial spending and anonymous change instead of many fixed tokens |
| Heilman et al., "TumbleBit" (NDSS 2017) and Tairi et al., "A²L" (IEEE S&P 2021) | Roadmap: an intermediary that can neither link nor steal funds |
| Dingledine and Mathewson, "Anonymity Loves Company" (2006) ([PDF](https://www.freehaven.net/anonbib/cache/usability:weis2006.pdf)) | Privacy as a network effect |

---

## 11. Market and ecosystem facts (checked)

| Fact | Source |
|---|---|
| XRPL x402: over $30K settled, 14.6M payments, 177 merchants (all time; the hub counts a batch settlement once) | [XRPL AI Hub](https://xrpl-ai.org/), read Oct 24, 2026 |
| All chains: about $19M real x402 spending, May 2025 to Apr 2026, wash and test activity removed | Visa / Artemis, via [The Defiant](https://thedefiant.io/converge/infrastructure/visa-s-sheffield-pegs-adjusted-x402-volume-at-19m) |
| We found no shipped confidential payment layer for x402 on XRPL as of Oct 24, 2026. Ripple is working on private agent payments | Our search, Oct 24, 2026; [Ripple's XRPL privacy and AI agent roadmap](https://cryptopotato.com/major-ripple-xrp-reveal-from-seoul-xrpl-gets-privacy-ai-agent-upgrades-and-more/) |

**Current status:** "A confidential-payment prototype for x402 agents on XRPL. The issuer's attestation is live; end-to-end relay privacy is still in progress."

---

## Honest limits (have the answer ready, don't lead with them)

- Timing can link top-ups to spending when few people use it.
- We trust Google's attestation service and AMD SEV.
- The image build isn't reproducible yet, so a rebuild can change the digest.
- Merchant payouts are mocked. AP4M top-up is not implemented.
- Relay IP hiding does not work end to end yet (PR #5, PR #16).
- Blind tokens hide only the issuance-to-redemption link, not metadata, timing or IPs.
- Production would need a licensed partner. Today it is a testnet prototype.
- The market is early: about $30K settled on XRPL so far.
