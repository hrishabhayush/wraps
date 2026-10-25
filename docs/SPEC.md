# Confidential Payments for AI Agents: Hackathon Spec v4

XRPL AI & Fintech Hackathon, NYC, Oct 24 to 25, 2026.

**Name: decide now.** Options: Hush, Blindpay, Quiet Ledger.

**Thesis:** x402 made agent payments less private than a card. Every x402 payment publishes the agent's spending record forever, and the facilitator sees every wallet next to every URL. We let agents pay on their own without being watched, at every layer.

**One line:** "Mastercard lets agents pay. We let them pay without being watched."

**What changed from v3:** AP4M moved to the top-up, so the agent itself signs the voucher (Mastercard's rule). An attested relay (the VPN) hides the agent's IP from merchants. Merchant payouts are batched RLUSD transfers from the issuer.

---

## 1. The user: Sam

Sam is an analyst at a small crypto fund. Sam's research agent buys crypto and DeFi data per call with x402. That is the biggest real x402 category by revenue.

**Sam's problem:**
- Every payment is public: vendor, amount, exact time, forever. Like a published card statement.
- Wallet trackers (Nansen, Arkham) label fund wallets. Arkham pays bounties to unmask owners.
- Agents already rotate wallets: on mainnet, 50 payments to one merchant came from 50 different wallets.
- 44 of the 50 were funded straight from exchange hot wallets (10M+ XRP each). The public can't cluster past an exchange, but the exchange knows who withdrew to each wallet.
- The other 6 were all funded by one ordinary wallet, so the public can link those 6 as one owner.
- The facilitator receives the wallet **and** the exact URL of every request.

**What does not leak on-chain:** the request content, such as which stock. We don't claim it does.

---

## 2. What we build

Three layers. No party sees both **who** and **what**.

| Layer | Hides | How |
|---|---|---|
| **Blind tokens** | Who paid | The issuer signs tokens it never sees (RFC 9578, blind RSA) |
| **Attested relay** (VPN) | Where the request came from | Agent traffic goes through a Nitro Enclave relay. Merchants see the relay's IP |
| **Attested issuer** | That anyone could cheat | Issuer runs in a Nitro Enclave. Agents check its code and keys before paying |

The merchant still sees the request. It has to, to answer it.

---

## 3. Architecture

```
                 ┌──────────────────────────────┐
                 │  Agent (AgentCore) + SDK     │
                 │  caps, tokens, attestation   │
                 └──────┬───────────────┬───────┘
                        │ tunnel (TLS pinned to the relay's attested key)
                        ▼
                 ┌──────────────────────────────┐
                 │  RELAY  (Nitro Enclave #1)   │  sees: agent IP, destination host
                 │  charges tokens per 10 MB    │  not: request content (HTTPS)
                 └──────┬───────────────┬───────┘
          top-up        │               │  purchases
                        ▼               ▼
 ┌───────────────────────────┐   ┌───────────────────────────┐
 │ ISSUER (Nitro Enclave #2)  │◀──│ MERCHANT (one, 2 services) │
 │ separate machine           │   │ 402 → tokens → data        │
 │ /issue  /verify  /settle   │   └───────────────────────────┘
 │ spent list, tabs, claims   │
 └──┬──────────────────┬──────┘
    │ top-up via AP4M   │ fixed times
    ▼                   ▼
 AP4M (Mastercard)    Batched RLUSD transfers to merchants
 agent signs voucher  (XRPL EVM sidechain)
 → VoucherRedeemed
 → RLUSD to issuer's payout address

 Spy bot ── reads plain x402 payments on XRPL (left screen)
 Quicknode ── RPC
```

**Relay and issuer run on separate machines.** One machine doing both could match "agent IP requests merchant M" with "merchant M redeems tokens" by timing.

---

## 4. Step by step

**0. Start-up.** Each enclave makes its keys inside itself. The relay makes a tunnel key. The issuer makes a token-signing key. Each gets a Nitro hardware receipt naming its code hash and public keys.

**1. Check both enclaves.** The SDK verifies each receipt: AWS root certificate, valid signature, code hash (PCR0) matches the published build, not all-zero (debug mode), keys match, fresh nonce. Any failure stops the agent.

**2. Open the tunnel.** TLS to the relay, pinned to the key in its receipt. The agent can reach only the tunnel (firewall rule), so nothing leaks around it.

**3. Top-up through AP4M (the Mastercard moment).** All through the tunnel, so the issuer never sees the agent's IP.
```
Agent balance low
Agent → Issuer:   POST /issue (100 blinded values)
Issuer → Agent:   402 Payment Required, AP4M x402, 10 RLUSD
Agent:            decides to refill, signs an AP4M voucher, submits it   ← no human
Issuer:           redeems → VoucherRedeemed on-chain
AP4M:             RLUSD → issuer's merchant payout address
Issuer → Agent:   100 blind signatures → agent unblinds into tokens
```
On-chain: "agent → issuer, 10 RLUSD." Public, and it was always going to be.

**4. Pay for bandwidth.** The relay is our own merchant. The agent pays it 1 token per 10 MB. This part is closed-loop: our tokens, our service.

**5. Buy data through the tunnel.**
```
Agent ─(tunnel)─▶ Relay ─▶ Merchant      HTTPS end to end
Merchant → Agent:   402, scheme "blindtoken", price 2 tokens
Agent → Merchant:   same request + 2 tokens
Merchant → Issuer:  /verify then /settle (tokens + merchant ID only)
Issuer → Merchant:  valid + signed claim "issuer owes you $4.30 total"
Merchant → Agent:   the data
```

**6. Merchant claims (the commitment).** Each claim is a running total signed with the issuer's attested key. The merchant verifies the signature against the key in the issuer's hardware receipt. The enclave also attests "claims outstanding ≤ funds held" (proof of reserves). Honest limit: without an AP4M channel per merchant, this is a signed, provably backed promise, not an on-chain lock.

**7. Payouts.** At fixed times, the issuer sends each merchant its total in RLUSD on the XRPL EVM sidechain, mixed across all customers. The chain shows "issuer → merchant," never which agent bought what.

---

## 5. Who sees what

| Party | Agent IP | Who funded | Which merchant | Request content |
|---|---|---|---|---|
| Relay | Yes | No | Yes (host) | No, HTTPS |
| Issuer | No, top-ups come through the relay | Yes | Yes | No |
| Merchant | No, sees the relay | No | It's the merchant | Yes, it must |
| AP4M / Mastercard | No | Sees agent → issuer top-ups | No | No |
| Public chain | No | A top-up wallet | Only batched issuer payouts | No |
| Sam (owner) | Yes | Yes | Yes, via receipts | Yes |

---

## 6. Mastercard criteria

| Criterion | How we meet it |
|---|---|
| Agent reads the 402 and chooses to pay | Balance low → hits the issuer's 402 → decides to refill |
| Agent signs and submits the voucher | Yes, the agent's own AP4M wallet |
| Real reason to pay | It buys the private payment credit it needs to work |
| `VoucherRedeemed` on the explorer | Yes, at the PaymentLedger contract |
| RLUSD reaches the merchant payout address | Yes, the issuer is the team's one merchant |
| Live in 3 minutes | Yes. **No recordings for this prize.** |
| Creativity | Private payments and a VPN on top of AP4M. Multi-step agent reasoning on screen |

**Portal limits:** one agent wallet and one merchant payout address per team (as far as we know). Our agent holds the wallet. Our issuer holds the payout address.

---

## 7. Components

**Agent SDK (TypeScript).** Verifies both enclaves. Opens the tunnel. Blinds and unblinds tokens. Handles the `blindtoken` 402 scheme. Signs the AP4M top-up voucher. Per-call and daily caps in code, outside the model. Never falls back to a plain wallet payment.

**The agent (AgentCore).** Makes money decisions on screen: compares the merchant's two services on price, decides what's worth buying, refills when low. Example: `Analytics $0.40. Filings $1.20. Filings needed. Buying both. Budget left: $8.40.`

**Relay (Go, Nitro Enclave #1).** HTTPS CONNECT proxy. TLS ends inside the enclave. Takes tokens for bandwidth. Rate-limits its attestation endpoint.

**Issuer (TypeScript or Python, Nitro Enclave #2).** Token signing key made in the enclave. `/issue` behind AP4M x402. `/verify` (read-only) and `/settle` (spent list + tab + signed claim). Payout job at fixed times. Refuses to issue beyond funds held. Outbound calls through a vsock proxy.

**Merchant (one, two services).** "On-chain analytics" and "filings," different whole-token prices. Accepts the `blindtoken` scheme, sends tokens to the issuer.

**Spy bot.** Left screen: a normal agent paying with plain x402 on XRPL through t54. The bot loads the XRPL AI Hub directory (address → service, price), streams payments, matches price to service, groups wallets by funder. Prints only what the chain shows. Proven on mainnet.

**Libraries.** Blind RSA: `blindrsa-ts` (TypeScript), `circl` (Go). AP4M: `ap4m-hackathon-sdk.js`, `ap4m-x402.mjs`, `AGENTS.md` (start with Demo 1, then Demo 2). x402 on XRPL: t54 docs have TypeScript and Python clients. Nitro: an existing attestation verifier; check the AWS root cert hash by hand.

---

## 8. Priority and build plan

| Part | When |
|---|---|
| AP4M top-up by the agent (Demo 1, then Demo 2 pattern) | Must-have |
| Blind tokens + issuer `/issue` `/verify` `/settle` | Must-have |
| Issuer in Nitro + attestation check + tamper demo | Must-have |
| Merchant with two services + agent money decisions | Must-have |
| Spy bot (left screen) | Must-have |
| Quicknode for chain calls | Free, do it |
| Relay (VPN) in Nitro Enclave #1 | After must-haves, about 3 to 5 hours |
| Merchant payouts in batches | After relay |
| AgentCore wrap | If cheap |
| Ledger approval for over-limit refills | Last |

| Stream | Hours 0 to 12 | Hours 12 to 20 | Hours 20 to 26 |
|---|---|---|---|
| Payments | AP4M Demo 1, then agent top-up via 402 | Issuer token signing, `/verify` `/settle`, claims | Batched payouts |
| Enclaves | Issuer enclave boots, keys in receipt | SDK verification, tamper demo | Relay enclave |
| Agent + merchant | Merchant, two services, token scheme | Agent money decisions, caps | AgentCore wrap |
| Demo | Spy bot on mainnet + left-screen agent | Split-screen UI | Closing slide |

Hours 26 to 29: freeze, rehearse three times. Mastercard needs a **live** run.

---

## 9. The demo (3 minutes, live)

1. **0:00 Sam.** "Sam's fund runs a research agent that buys data with x402."
2. **0:15 The leak.** "Paying with x402 publishes your agent's card statement. Agents already try to hide by rotating wallets. We traced them on mainnet: most were funded straight from an exchange, which knows who you are, and the rest link to one owner."
3. **0:30 Left screen.** A normal agent pays with plain x402. The spy bot prints its vendors, amounts, times and funder group.
4. **1:00 Right screen.** Our agent hits a 402 on its low balance, signs an AP4M voucher, refills. `VoucherRedeemed` on the explorer, RLUSD at the issuer.
5. **1:30** It compares prices, buys through the relay with tokens. The spy bot sees nothing about it. The merchant sees the relay's IP.
6. **2:00 Proof.** Enclave receipts verified live. A modified issuer is refused.
7. **2:20 Safety.** Daily cap reached. The agent stops. (Ledger approval if built.)
8. **2:35 Numbers.** Spy bot accuracy vs number of agents. Payment speed: ours vs about 4 s for plain x402.
9. **2:50 Close.** "Three layers, and no one sees the whole picture. Agents will do most of the buying soon. We make it confidential, and we prove it."

---

## 10. The 30-second pitch

> "x402 made agent payments less private than a card. Every payment publishes your agent's spending record forever, and the facilitator sees every wallet next to every URL. Agents rotate wallets to hide, and on mainnet most of them were funded straight from an exchange, which knows who you are.
>
> We give agents confidential payments. The agent refills its budget on its own through Mastercard's AP4M, then pays any merchant with blind tokens our issuer can't trace, through an attested relay that hides its IP. Both run in AWS Nitro Enclaves, so you verify our code instead of trusting us. Nobody sees both who your agent is and what it buys."

---

## 11. Answers to have ready

**"Why would an agent need privacy?"** "A card statement is private. An x402 statement is public forever. Rotating wallets doesn't fix it: we showed they lead back to exchanges, or to one shared funder."

**"Do you hide which stock I research?"** "No. The merchant must read the request to answer it. We hide who is asking, from the merchant and the public."

**"Isn't this a mixer?"** "Every funder is known at top-up. Spending is confidential from the public and from us. Owners keep receipts. It works like a corporate card."

**"Why trust your issuer?"** "You don't have to. Even if it logged everything, blind signatures stop it linking tokens to buyers. And it runs in a Nitro Enclave you can verify."

**"You hold the money. Aren't you the new middleman?"** "You trust us with your money, not your secrets. Reserves are attested in the enclave."

**"How big is this market?"** "Early. About $30K settled on XRPL, about $19M of real x402 spending across all chains. We're building the privacy layer before the money arrives."

**"Doesn't Ripple's Confidential Transfers do this?"** "It hides how much. Accounts stay visible. We hide who paid whom. They fit together."

**"RLUSD has clawback."** "That's fine for us. We're confidential, not anonymous. Every funder is known. We keep the pool small, and merchants can settle in XRP."

---

## 12. Security must-fixes

- Reject debug-mode attestations (all-zero PCRs).
- Expected code hashes from a reproducible build.
- One issuer signing key, inside the receipt. The SDK checks it, so the issuer can't tag users.
- Spent-list check across all merchants.
- Caps in code, outside the model. Refuse a 402 above the price cap.
- HTTPS only through the relay. Agent firewalled to the tunnel.
- Relay and issuer on separate machines.
- Rate-limit attestation endpoints.
- Don't restart enclaves during the demo: keys and the spent list live in memory.

---

## 13. Honest limits

- Timing can link a top-up to spending when few people use it. Fixed bundle sizes and early top-ups help. It improves with users.
- The AWS hosts see network timing. Enclaves hide data, not traffic patterns.
- One relay hop: the relay sees agent IP and destination. Its verified code doesn't log. Two hops is roadmap.
- In the demo our team runs both enclaves. Say so.
- An agent can reveal itself with logins, API keys or revealing queries.
- Merchant claims are signed and reserve-backed, not on-chain locks.
- RLUSD clawback is enabled on the main ledger.

---

## 14. Compliance

- **Relay bandwidth:** tokens for our own service. Closed-loop prepaid, like a gift card. Safest.
- **Third-party merchants:** money transmission. Production needs a licensed partner, known funders, owner receipts and daily limits.
- **Words:** "confidential," "owner-controlled disclosure." Never "anonymous," "untraceable" or "mixer."
- Tornado Cash's developer was convicted in August 2025, and Samourai Wallet's founders pleaded guilty in 2025, on unlicensed money transmission. Talk to a lawyer before real money.

---

## 15. Market reality (checked Oct 24, 2026)

| Measure | Number |
|---|---|
| XRPL x402 all-time value | $30,509 (XRPL AI Hub) |
| XRPL x402 all-time payments | 14,577,102 |
| Real x402 spending, all chains, May 2025 to Apr 2026 | about $19M (Visa / Artemis, wash and test removed) |
| Base share of real volume | about 93% |
| Base payments that look self-paid or linked | about 85% (Dhali) |
| Coinbase facilitator share of Base settlements | 63.5% (Dhali) |
| Largest real category | Crypto and DeFi data |

Hackathon: strong. Business today: tiny dollar market, a bet on growth. After the hackathon: growth, the Mastercard Agent Pay card route, or a human VPN.

---

## 16. Competition

- **VEIL** (ETHGlobal Cannes, April 2026, 3 first places): attested one-hop VPN, wallet-signed payments. We hide payments too.
- **Private x402 elsewhere:** PRXVT (Base only, no published design), TACEO (hides amounts), curvy.box (stealth addresses), Nethermind PrivateX402 (research), zk-402 and ShieldPay (hackathons).
- **On XRPL:** nobody has shipped it. Ripple is working on private agent payments (in progress).
- **Ripple XLS-96:** hides amounts, not accounts. Not active. Complements us.
- **Safe claim:** "The first working confidential payment layer for x402 agents on XRPL."

---

## 17. Verified facts

| Fact | Status |
|---|---|
| A real x402 payment shows payer, merchant, amount, time, t54 memo, a UUID memo and an InvoiceID. No URL | Read from mainnet |
| SourceTag is t54's facilitator tag (`804681468`), not per endpoint | Read from mainnet |
| Price identifies the service when a merchant prices services differently | Checked against the hub |
| Payer wallets rotate (50 payments, 50 wallets), and 44 of 50 were funded directly by exchange-scale hot wallets (10M to 15M XRP, tens of millions of transactions); 6 shared one ordinary funder. This is NOT one operator: exchanges fund many unrelated users. Correction to v3's "60 wallets → 8 owners" | Traced on mainnet, rechecked by the spy bot |
| The x402 facilitator receives `resource.url`, `description`, `mimeType` and the payer wallet | x402 v2 spec |
| t54's Trustline keeps "a signed, replayable evidence record" of agent identity, owner mandate and intent | t54 website |
| RLUSD issuer has clawback enabled | Mainnet flag |
| XRPL ledger interval about 4.0 s. XRPL EVM block about 5.8 s | Measured |
| AP4M: one budget, many channels. Merchant can redeem vouchers. Funds in a vault | AP4M portal guide |

---

## 18. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Teams can't use AP4M for issuer top-ups | Ask the booth early. Fallback: agent pays our merchant directly via AP4M for one service, tokens for the rest |
| Nitro networking fails | Run the issuer outside the enclave, keep the attestation demo, say so |
| Relay not done | Skip it. Say "merchants see the agent's IP until the relay ships" |
| t54 testnet down (left screen) | Show the mainnet spy bot output instead |
| Live demo breaks | Restart the run. No recording for Mastercard |

---

## 19. Ask at the Mastercard booth

1. Can a team register more than one agent wallet?
2. Our agent pays our issuer through AP4M when it refills, then spends private tokens. Does that meet the autonomy criterion?
3. What fields does `VoucherRedeemed` contain?
4. Are vouchers running totals?

---

## 20. Roadmap

- Two-hop network on different operators and chip vendors
- Merchant payouts through AP4M channels (with more agent wallets), so claims become on-chain locks
- Licensed partner for third-party merchants
- Payouts via Ripple's Confidential Transfers once XLS-96 is active
- Mastercard Agent Pay card route for merchants without crypto
- Several independent issuers, then ZK credentials

---

## 21. Checklist

- [ ] Name chosen
- [ ] Mastercard form, booth activation, testnet RLUSD, booth questions asked
- [ ] Agent wallet with XRP gas, funding wallet, issuer payout address (all different)
- [ ] Quicknode track joined. AWS and Ledger tracks selected
- [ ] Must-haves working end to end
- [ ] Tests: tampered enclave refused, debug mode refused, wrong key refused, replayed receipt refused, double spend rejected, price cap holds, injected "buy 500 more" blocked
- [ ] Benchmarks measured: payment speed, spy bot accuracy vs agents
- [ ] Live run rehearsed three times
