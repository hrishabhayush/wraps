# TODO

Each task has an ID, what it depends on, and when it counts as done. Tasks in different **lanes** touch different folders, so separate agents can work on them in parallel without conflicts.

Status: `[ ]` open · `[~]` in progress · `[x]` done. Put your name after a task when you take it.

---

## Lane 1: Infra (owner: Adarsha)

Platform: **Google Cloud Confidential Space** (AMD SEV confidential VMs), project `wraps-hack`, region `us-central1`. Folder: `infra/gcp/`.

### Account and project (done)
- [x] **INF-01** Google Cloud account with the $300 trial. Project `wraps-hack`, billing linked.
- [x] **INF-02** $20 budget with alerts at 50%, 80%, 100% and forecasted 100%. The trial never charges the card automatically.
- [x] **INF-03** APIs on: Compute, Confidential Computing, Artifact Registry, IAM Credentials, Cloud Build, Logging, Billing Budgets.
- [x] **INF-04** Probe: an `n2d-standard-2` with SEV-SNP on AMD Milan launched on the trial, then deleted. N2D CPU quota is 16.
- [x] **INF-05** Artifact Registry repo `us-central1-docker.pkg.dev/wraps-hack/wraps`.
- [x] **INF-06** Service account `wraps-workload` with Confidential Computing workload user, log writer and registry reader roles.
- [x] **INF-07** Firewall rule `wraps-allow-443` for VMs tagged `wraps`, including TCP 8080 for issuer nonce attestation. The live rule and reproducible update script are in merged PR #25.

### Images and deploy
- [x] **INF-08** Dockerfiles for issuer and relay. Pin base images by digest, use lockfiles.
- [x] **INF-09** Build with Cloud Build, push to the registry, print the image digest. Write digests to `infra/gcp/expected.json`, which the SDK reads.
- [x] **INF-10** `deploy.sh <issuer|relay> [--debug]`: Confidential Space VM, `tee-image-reference` pinned by digest, service account, tag `wraps`, 12-hour max run time that stops the VM, label `project=wraps`. Plus `stop.sh` and `status.sh`.
- [x] **INF-11** First deploy with the debug image to read logs, then the production image for the demo. Issuer and relay were deployed and verified; the VMs are stopped after the smoke run.

### Attestation
- [x] **INF-12** In the workload, request a Confidential Space attestation token whose nonces bind the client's nonce and the hash of the workload's public keys. Expose `GET /attestation?nonce=`.
- [x] **INF-13** SDK verifier: JWT signed by Google's attestation service, AMD SEV hardware, production image, debug disabled, expected image digest, nonce and key hash match.
- [x] **INF-14** TLS: the workload makes its own key and a self-signed certificate. The SDK pins the key from the attestation.

### Relay networking
- [~] **INF-27** Configure WireGuard in the Confidential Space relay runtime (PR #33 merged; depends on RLY-04 in #32 and #38). The new image reaches ready state and `/attestation` returns 200; `/wireguard-attestation` returns 404 (tracked in RLY-05), and authorized-peer traffic is unvalidated.
- [~] **INF-28** Pin the relay image and deploy WireGuard with corrected Confidential Space metadata (PR #40 merged; depends on merged RLY-04 #38). The image reaches ready state and `/attestation` returns 200; `/wireguard-attestation` returns 404 (tracked in RLY-05), and authorized-peer traffic is unvalidated.
- [x] **INF-29** Run a separately isolated standard GCE WireGuard/NAT gateway for test traffic while keeping the issuer and HTTPS proxy in Confidential Space; no wallet or issuer secrets on the gateway.

### Keys and secrets
- [ ] **INF-15** Wallets (three different ones): agent wallet, funding wallet, issuer payout address. Private keys in a local `.env` that is never committed, or Google Secret Manager.
- [ ] **INF-16** XRP for gas on XRPL EVM testnet (faucet) for the agent wallet and the issuer.
- [ ] **INF-17** Mastercard: fill their form, get activated at the booth, get testnet RLUSD. On the AP4M portal "My setup": add the agent wallet and the issuer payout address, fund the budget. Copy the PaymentLedger contract address from "Network config" into `infra/gcp/README.md`.
- [ ] **INF-18** Download the AP4M starter files (`ap4m-hackathon-sdk.js`, `ap4m-x402.mjs`, `AGENTS.md`) into `vendor/ap4m/`. Read `/docs/api-reference.md` while logged in. Answer the booth questions in SPEC §19.

### RPC
- [ ] **INF-19** Quicknode endpoints: XRPL mainnet (spy bot), XRPL testnet, XRPL EVM testnet if supported. Put URLs in `.env`. Join the Quicknode track.

### Run and demo day
- [x] **INF-20** Logs: Confidential Space production images send container logs to Cloud Logging only if redirect is on. Never log tokens, keys, IPs or merchant IDs together.
- [~] **INF-21** Demo host firewall: on the machine that runs the agent, allow outbound traffic only to the relay, so nothing leaks around the tunnel.
- [ ] **INF-22** Demo day: start the VMs early and **don't restart them**. Keys and the spent list live in memory.
- [ ] **INF-23** Fallback: run the same images as normal containers with mock attestation if Confidential Space breaks. Say so on stage if used.

### After the hackathon
- [ ] **INF-24** Persist keys safely across restarts (for example Cloud KMS released only to the attested workload).
- [ ] **INF-25** Stop and delete the VMs, images and project resources. Check the credit balance.

---

## Lane 2: Tokens and issuer (folder `packages/tokens`, `packages/issuer`)

- [x] **ISS-01** Token library: RFC 9578 type 0x0002 using `@cloudflare/privacypass-ts` / `@cloudflare/blindrsa-ts`. Issuer keygen, client blind/finalize, verify, `Authorization: PrivateToken` header format. (The stopped cloud agent started this in its worktree.) (core agent)
- [x] **ISS-02** `POST /issue` behind a 402 (top-up). Use a `TopUpRail` interface: mock first, AP4M later (PAY-03). (core agent) Mock rail done; AP4M rail is PAY-03.
- [x] **ISS-03** `POST /verify` (read-only: signature and not spent) and `POST /settle` (mark spent, add to the merchant's tab). (core agent)
- [x] **ISS-04** Signed running-total claim for merchants, signed with a key that is in the attestation. (core agent)
- [x] **ISS-05** Solvency: refuse to issue beyond funds held. Attest "outstanding ≤ funds held." (core agent)
- [~] **ISS-06** Batched payouts at fixed times (mock first, RLUSD transfers on XRPL EVM later). Mock payout job done; RLUSD transfers open.
- [x] **ISS-07** Run the issuer in Confidential Space (INF-08 to INF-14).

## Lane 3: Payments / AP4M (folder `packages/ap4m`)

- [ ] **PAY-01** Run AP4M Demo 1 (`node ap4m-agent.js`). Depends: INF-17, INF-18.
- [ ] **PAY-02** Run AP4M Demo 2 (x402 agent and merchant).
- [ ] **PAY-03** `Ap4mRail`: the issuer's `/issue` answers 402 via AP4M x402. The agent signs the voucher. `VoucherRedeemed` shows on the explorer. RLUSD reaches the issuer's payout address.

## Lane 4: Relay / VPN (folder `packages/relay`)

- [x] **RLY-01** HTTPS CONNECT proxy. HTTPS only; loopback by default, public destination IPs only, raw TCP tunnel.
- [x] **RLY-02** Charges one blind token per 10,000,000 tunnel bytes, settled through the issuer. Partial blocks are charged; tunnels close at quota. (Codex)
- [x] **RLY-03** Wire into the relay enclave (INF-10 to INF-14). (Codex)
- [~] **RLY-04** Add an attested WireGuard gateway with prepaid, metered peer quotas (PRs #32 and #38 merged). The live image reaches ready state and `/attestation` returns 200; `/wireguard-attestation` returns 404 (RLY-05), and authorized-peer traffic is unvalidated.
- [~] **RLY-05** Serve and test the nonce-bound WireGuard attestation receipt at `/wireguard-attestation`.

## Lane 5: Agent and SDK (folders `packages/sdk`, `packages/agent`)

- [x] **SDK-01** Verify issuer and relay attestations (mock verifier first, then the Confidential Space verifier against `infra/gcp/expected.json`). Reject debug images, wrong image digests, wrong keys, reused nonces. Live GCP smoke passed.
- [x] **SDK-02** Tunnel through the relay, pinned to its attested key.
- [~] **SDK-03** Top-up: hit the issuer's 402, sign the AP4M voucher, receive and unblind tokens. (core agent) Mock wallet done; the real AP4M voucher is PAY-03.
- [x] **SDK-06** Verify attested WireGuard settings, register prepaid quota and build the client profile (merged PR #37; depends on #33 and #32). Live relay integration remains tracked in INF-27 and INF-28.
- [x] **SDK-04** Pay `blindtoken` 402s. Per-call and daily caps in code. Never fall back to a wallet payment. (core agent)
- [x] **SDK-05** Demo agent: compares prices, decides, refills when low, prints its reasoning. (core agent)
- [~] **SDK-07** Bound WireGuard attestation receipt fetching; test nonce/policy verification, registration outcomes, and kill-switch profiles (PR #39).

## Lane 6: Merchant (folder `packages/merchant`)

- [x] **MER-01** One merchant, two services ("on-chain analytics", "filings") at different whole-token prices. (core agent)
- [x] **MER-02** 402 with scheme `blindtoken`. Accept tokens, call issuer `/verify` then `/settle`, store claims. (core agent)

## Lane 7: Spy bot (folder `packages/spybot`)

- [ ] **SPY-01** Load the XRPL AI Hub directory (address → service, price) from `xrpl-ai.org`.
- [ ] **SPY-02** Stream payments for a merchant from public XRPL nodes (rotate, back off on rate limits). Match price to service.
- [ ] **SPY-03** Group payer wallets by first funder. Stop at very large wallets (likely exchanges).
- [x] **SPY-04** Left-screen agent: a normal agent paying plain x402 on XRPL testnet through t54, read live by the bot. (Codex)

## Lane 8: Demo and pitch (folder `apps/demo`, `docs/`)

- [x] **DOC-01** Reconcile this checklist with merged GCP work, active PRs and verified remaining gaps.
- [x] **DEM-01** Split-screen page: spy bot left, our agent right, live events. (Codex)
- [x] **DEM-02** Tamper test starts a modified issuer build and shows the SDK refusing its changed PCR0 before top-up or purchase. (Codex)
- [ ] **DEM-03** Benchmarks: payment speed (p50/p95), spy bot accuracy vs number of agents.
- [ ] **DEM-04** Tests from SPEC §21 passing.
- [x] **DEM-05** Update the explainer page to v4 (Confidential Space issuer, relay status, top-up; AP4M marked not implemented). (Codex)
- [ ] **DEM-06** Pick the name. Rehearse the live run three times. Mastercard needs it live, no recording.
- [x] **DEM-07** Merge website updates and maintain the project site (PR #31 merged; claim corrections are in `gh-pages`).

## Lane 9: Security and dependency health

- [ ] **SEC-01** Resolve or document the production dependency audit findings. `npm audit --omit=dev` currently reports 5 findings (1 moderate, 4 high): `ws` through `viem` has a reported npm fix; `sjcl` through the Cloudflare PrivatePass dependency chain has no fix reported.
- [ ] **SEC-04** Merchant authentication on `/settle` and `/settle/status`. The issuer enforces credentials when `ISSUER_MERCHANT_AUTH_KEYS` or `ISSUER_RELAY_SETTLE_KEY` is set and otherwise logs/reports legacy-open mode. Relay client support is implemented, but its image needs rebuilding/redeployment with the key; the desktop app still needs request credentials before enforcement is enabled in production.
- [ ] **APP-SEC-01** Teammate: `app/src/tokens.ts` must stop settling directly as `node:<id>` without a credential before enforcement is turned on in production.
- [ ] **SEC-05** Make relay and app settles idempotent by sending a quote ID, like the merchant does (PR #44 only covers quote-ID settles).
- [ ] **SEC-06** Persist issuer state (spent list, settlement records, in-flight payouts) safely across restarts. A hash-chained file store is available for local/non-enclave runs; the current Confidential Space image remains in-memory until attestation-bound encrypted storage is implemented.

## Follow-ups (from the Oct 25 review pass)

- [~] **FUP-01** PR #42 (INF-20, production forwarding for WireGuard in the relay): rebuilt from committed source and verified live in production with tunneled HTTPS egress. The clean digest is pinned; waiting for a human to merge PR #42.
- [x] **FUP-02** Close PR #22 (INF-09). Its `eth0` and WireGuard endpoint fixes are folded into PR #42.
- [x] **FUP-03** Removed the temporary test/debug VMs (`wraps-relay-debug`, `wraps-wg-client-test`, `wraps-relay-inf28-debug`, and `wraps-relay-inf09-test`; `wraps-relay-inf09-wireguard` was already absent). Released `wraps-relay-inf09-test-ip`. Kept `wraps-issuer`, `wraps-relay`, and `wraps-wg-gateway`.
- [ ] **FUP-04** Live testnet payout: fund an issuer wallet with testnet RLUSD and XRP for gas, then follow `packages/issuer/README.md` (`payout:dry-run`, `payout:once`).
- [ ] **FUP-05** The standalone WireGuard gateway (PR #43) runs on a plain VM, outside Confidential Space: no attestation, no token metering. Don't describe it as attested.

---

## Order that unblocks the most

1. Complete **INF-17, INF-18** (Mastercard activation and AP4M SDK access), plus **INF-15, INF-16** (wallet setup and testnet gas).
2. Implement and verify **PAY-03**; then finish the real top-up path in **SDK-03** and RLUSD payouts in **ISS-06**.
3. For the WireGuard path, the **RLY-04** implementation (#32, #38), **INF-27** runtime (#33), **INF-28** deployment (#40) and **SDK-06** profile (#37) are merged. Add and test the missing receipt route in **RLY-05**, then validate an authorized peer before completing the live path and **SDK-07** (#39).
4. Address **SEC-01** and finish **SPY-01 to SPY-03**, **DEM-03**, **DEM-04** and **DEM-06** before the live demo.
