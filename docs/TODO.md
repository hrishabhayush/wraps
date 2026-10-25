# TODO

Each task has an ID, what it depends on, and when it counts as done. Tasks in different **lanes** touch different folders, so separate agents can work on them in parallel without conflicts.

Status: `[ ]` open · `[~]` in progress · `[x]` done. Put your name after a task when you take it.

---

## Lane 1: Infra (owner: Adarsha)

Platform: **Google Cloud Confidential Space** (AMD SEV confidential VMs), project `wraps-hack`, region `us-central1`. Not AWS Nitro: the AWS account is on the Free plan, which blocks the 4-vCPU instances Nitro needs. Folder: `infra/gcp/`.

### Account and project (done)
- [x] **INF-01** Google Cloud account with the $300 trial. Project `wraps-hack`, billing linked.
- [x] **INF-02** $20 budget with alerts at 50%, 80%, 100% and forecasted 100%. The trial never charges the card automatically.
- [x] **INF-03** APIs on: Compute, Confidential Computing, Artifact Registry, IAM Credentials, Cloud Build, Logging, Billing Budgets.
- [x] **INF-04** Probe: an `n2d-standard-2` with SEV-SNP on AMD Milan launched on the trial, then deleted. N2D CPU quota is 16.
- [x] **INF-05** Artifact Registry repo `us-central1-docker.pkg.dev/wraps-hack/wraps`.
- [x] **INF-06** Service account `wraps-workload` with Confidential Computing workload user, log writer and registry reader roles.
- [x] **INF-07** Firewall rule `wraps-allow-443` for VMs tagged `wraps`.

### Images and deploy (agent working on this)
- [~] **INF-08** Dockerfiles for issuer and relay. Pin base images by digest, use lockfiles.
- [~] **INF-09** Build with Cloud Build, push to the registry, print the image digest. Write digests to `infra/gcp/expected.json`, which the SDK reads.
- [~] **INF-10** `deploy.sh <issuer|relay> [--debug]`: Confidential Space VM, `tee-image-reference` pinned by digest, service account, tag `wraps`, 12-hour max run time that stops the VM, label `project=wraps`. Plus `stop.sh` and `status.sh`.
- [~] **INF-11** First deploy with the debug image to read logs, then the production image for the demo.

### Attestation (agent working on this)
- [~] **INF-12** In the workload, request a Confidential Space attestation token whose nonces bind the client's nonce and the hash of the workload's public keys. Expose `GET /attestation?nonce=`.
- [~] **INF-13** SDK verifier: JWT signed by Google's attestation service, AMD SEV hardware, production image, debug disabled, expected image digest, nonce and key hash match.
- [~] **INF-14** TLS: the workload makes its own key and a self-signed certificate. The SDK pins the key from the attestation.

### Keys and secrets
- [ ] **INF-15** Wallets (three different ones): agent wallet, funding wallet, issuer payout address. Private keys in a local `.env` that is never committed, or Google Secret Manager.
- [ ] **INF-16** XRP for gas on XRPL EVM testnet (faucet) for the agent wallet and the issuer.
- [ ] **INF-17** Mastercard: fill their form, get activated at the booth, get testnet RLUSD. On the AP4M portal "My setup": add the agent wallet and the issuer payout address, fund the budget. Copy the PaymentLedger contract address from "Network config" into `infra/gcp/README.md`.
- [ ] **INF-18** Download the AP4M starter files (`ap4m-hackathon-sdk.js`, `ap4m-x402.mjs`, `AGENTS.md`) into `vendor/ap4m/`. Read `/docs/api-reference.md` while logged in. Answer the booth questions in SPEC §19.

### RPC
- [ ] **INF-19** Quicknode endpoints: XRPL mainnet (spy bot), XRPL testnet, XRPL EVM testnet if supported. Put URLs in `.env`. Join the Quicknode track.

### Run and demo day
- [ ] **INF-20** Logs: Confidential Space production images send container logs to Cloud Logging only if redirect is on. Never log tokens, keys, IPs or merchant IDs together.
- [ ] **INF-21** Demo host firewall: on the machine that runs the agent, allow outbound traffic only to the relay, so nothing leaks around the tunnel.
- [ ] **INF-22** Demo day: start the VMs early and **don't restart them**. Keys and the spent list live in memory.
- [ ] **INF-23** Fallback: run the same images as normal containers with mock attestation if Confidential Space breaks. Say so on stage if used.

### After the hackathon
- [ ] **INF-24** Persist keys safely across restarts (for example Cloud KMS released only to the attested workload).
- [ ] **INF-25** Stop and delete the VMs, images and project resources. Check the credit balance.

### Not used
- AWS Nitro Enclaves (PR #1). Kept for reference. Could return later as a second chip vendor.

---

## Lane 2: Tokens and issuer (folder `packages/tokens`, `packages/issuer`)

- [x] **ISS-01** Token library: RFC 9578 type 0x0002 using `@cloudflare/privacypass-ts` / `@cloudflare/blindrsa-ts`. Issuer keygen, client blind/finalize, verify, `Authorization: PrivateToken` header format. (The stopped cloud agent started this in its worktree.) (core agent)
- [x] **ISS-02** `POST /issue` behind a 402 (top-up). Use a `TopUpRail` interface: mock first, AP4M later (PAY-03). (core agent) Mock rail done; AP4M rail is PAY-03.
- [x] **ISS-03** `POST /verify` (read-only: signature and not spent) and `POST /settle` (mark spent, add to the merchant's tab). (core agent)
- [x] **ISS-04** Signed running-total claim for merchants, signed with a key that is in the attestation. (core agent)
- [x] **ISS-05** Solvency: refuse to issue beyond funds held. Attest "outstanding ≤ funds held." (core agent)
- [~] **ISS-06** Batched payouts at fixed times (mock first, RLUSD transfers on XRPL EVM later). (core agent) Mock payout job done; RLUSD transfers open.
- [ ] **ISS-07** Run the issuer in Confidential Space (INF-08 to INF-14).

## Lane 3: Payments / AP4M (folder `packages/ap4m`)

- [ ] **PAY-01** Run AP4M Demo 1 (`node ap4m-agent.js`). Depends: INF-17, INF-18.
- [ ] **PAY-02** Run AP4M Demo 2 (x402 agent and merchant).
- [ ] **PAY-03** `Ap4mRail`: the issuer's `/issue` answers 402 via AP4M x402. The agent signs the voucher. `VoucherRedeemed` shows on the explorer. RLUSD reaches the issuer's payout address.

## Lane 4: Relay / VPN (folder `packages/relay`)

- [x] **RLY-01** HTTPS CONNECT proxy. HTTPS only; loopback by default, public destination IPs only, raw TCP tunnel.
- [x] **RLY-02** Charges one blind token per 10,000,000 tunnel bytes, settled through the issuer. Partial blocks are charged; tunnels close at quota. (Codex)
- [ ] **RLY-03** Wire into the relay enclave (INF-10 to INF-14).

## Lane 5: Agent and SDK (folders `packages/sdk`, `packages/agent`)

- [~] **SDK-01** Verify issuer and relay attestations (mock verifier first, then the Confidential Space verifier against `infra/gcp/expected.json`). Reject debug images, wrong image digests, wrong keys, reused nonces. Mock verifier done; Confidential Space verifier in progress.
- [ ] **SDK-02** Tunnel through the relay, pinned to its attested key.
- [~] **SDK-03** Top-up: hit the issuer's 402, sign the AP4M voucher, receive and unblind tokens. (core agent) Mock wallet done; the real AP4M voucher is PAY-03.
- [x] **SDK-04** Pay `blindtoken` 402s. Per-call and daily caps in code. Never fall back to a wallet payment. (core agent)
- [x] **SDK-05** Demo agent: compares prices, decides, refills when low, prints its reasoning. (core agent)

## Lane 6: Merchant (folder `packages/merchant`)

- [x] **MER-01** One merchant, two services ("on-chain analytics", "filings") at different whole-token prices. (core agent)
- [x] **MER-02** 402 with scheme `blindtoken`. Accept tokens, call issuer `/verify` then `/settle`, store claims. (core agent)

## Lane 7: Spy bot (folder `packages/spybot`)

- [ ] **SPY-01** Load the XRPL AI Hub directory (address → service, price) from `xrpl-ai.org`.
- [ ] **SPY-02** Stream payments for a merchant from public XRPL nodes (rotate, back off on rate limits). Match price to service.
- [ ] **SPY-03** Group payer wallets by first funder. Stop at very large wallets (likely exchanges).
- [x] **SPY-04** Left-screen agent: a normal agent paying plain x402 on XRPL testnet through t54, read live by the bot. (Codex)

## Lane 8: Demo and pitch (folder `apps/demo`, `docs/`)

- [x] **DEM-01** Split-screen page: spy bot left, our agent right, live events. (Codex)
- [ ] **DEM-02** Tamper button: restart the issuer with a different code hash, show the SDK refusing it.
- [ ] **DEM-03** Benchmarks: payment speed (p50/p95), spy bot accuracy vs number of agents.
- [ ] **DEM-04** Tests from SPEC §21 passing.
- [ ] **DEM-05** Update the explainer page to v4 (relay, AP4M at top-up).
- [ ] **DEM-06** Pick the name. Rehearse the live run three times. Mastercard needs it live, no recording.

---

## Order that unblocks the most

1. **INF-17, INF-18** (Mastercard activation, AP4M files): everything AP4M waits on this.
2. **INF-08 to INF-11** (images and deploy on Google Cloud) in parallel with **ISS-01, MER-01, SPY-01 to SPY-03** (no infra needed).
3. **INF-12 to INF-14** (attestation), then **ISS-07, RLY-03**.
4. **PAY-03, SDK-03**, then the full demo.
