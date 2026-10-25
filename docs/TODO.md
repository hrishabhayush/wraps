# TODO

Each task has an ID, what it depends on, and when it counts as done. Tasks in different **lanes** touch different folders, so separate agents can work on them in parallel without conflicts.

Status: `[ ]` open · `[~]` in progress · `[x]` done. Put your name after a task when you take it.

---

## Lane 1: Infra (owner: Adarsha)

Folder: `infra/`

### Accounts and access
- [ ] **INF-01** AWS account, region `us-east-1`, an IAM user for the team, a budget alarm at $50.
  Done when: everyone who deploys can log in, and the alarm is set.
- [ ] **INF-02** Pick an instance type that supports Nitro Enclaves with at least 4 vCPUs (for example `c6i.xlarge` or `m5.xlarge`). The enclave takes 2 vCPUs and its own memory.
  Done when: the type is written in `infra/README.md`.

### Two hosts (relay and issuer must be separate machines)
- [ ] **INF-03** Launch EC2 host **issuer** with the enclave option on. Depends: INF-01, INF-02.
- [ ] **INF-04** Launch EC2 host **relay** with the enclave option on. Depends: INF-01, INF-02.
- [ ] **INF-05** Security groups. Issuer: 443 open (agents top up, merchants call `/verify` and `/settle`). Relay: 443 open (agent tunnel). SSH only from team IPs.
  Done when: both hosts answer on 443 with a placeholder server.
- [ ] **INF-06** On both hosts: install Docker, `nitro-cli`, and the enclave allocator. Set enclave memory and CPUs in `/etc/nitro_enclaves/allocator.yaml`.
  Done when: `nitro-cli run-enclave` starts the AWS hello-world enclave.

### Enclave images
- [ ] **INF-07** Dockerfile per enclave (issuer, relay). Pin base images by digest and use lockfiles, so builds are reproducible.
- [ ] **INF-08** Script `infra/build-eif.sh`: Docker image → `nitro-cli build-enclave` → `.eif`, and print PCR0, PCR1, PCR2. Depends: INF-07.
- [ ] **INF-09** Write the expected PCRs to `infra/pcrs.json`. The SDK reads this file to check attestations. Depends: INF-08.
  Done when: building twice gives the same PCR0.

### Enclave networking (vsock)
- [ ] **INF-10** Ingress: parent forwards TCP 443 → enclave over vsock (socat or a small proxy). TLS ends **inside** the enclave.
- [ ] **INF-11** Egress: run `vsock-proxy` on the parent with an allowlist only: AP4M (`hackathon.ap4m.build`), XRPL EVM testnet RPC, XRPL RPCs, Quicknode.
  Done when: code in the enclave can call the AP4M `/health` endpoint, and a host not on the list fails.

### Attestation
- [ ] **INF-12** In the enclave, call the Nitro Security Module (NSM) API to get an attestation document with: the client's nonce, the enclave's public key(s), and a hash of all public keys in `user_data`. Expose `GET /attestation?nonce=`.
- [ ] **INF-13** Run enclaves in **production mode** (no `--debug-mode`) for the demo. Debug mode gives all-zero PCRs and lets the operator read memory.
  Done when: the attestation from INF-12 shows the non-zero PCR0 from `infra/pcrs.json`.
- [ ] **INF-14** TLS: each enclave makes its own key and a self-signed certificate inside the enclave. No certificate authority. The SDK trusts the key because it is inside the attestation.

### Keys and secrets
- [ ] **INF-15** Wallets (three different ones): agent wallet, funding wallet, issuer payout address. Keep private keys in AWS SSM Parameter Store or a local `.env` that is never committed.
- [ ] **INF-16** XRP for gas on XRPL EVM testnet (faucet) for the agent wallet and the issuer.
- [ ] **INF-17** Mastercard: fill their form, get activated at the booth, get testnet RLUSD. On the AP4M portal "My setup": add the agent wallet and the issuer payout address, fund the budget. Copy the PaymentLedger contract address from "Network config" into `infra/README.md`.
- [ ] **INF-18** Download the AP4M starter files (`ap4m-hackathon-sdk.js`, `ap4m-x402.mjs`, `AGENTS.md`) into `vendor/ap4m/`. Read `/docs/api-reference.md` while logged in. Answer the booth questions in SPEC §19.

### RPC
- [ ] **INF-19** Quicknode endpoints: XRPL mainnet (spy bot), XRPL testnet, XRPL EVM testnet if Quicknode supports it. Put URLs in `.env`. Join the Quicknode track.

### Deploy and run
- [ ] **INF-20** Scripts in `infra/`: `deploy.sh` (copy EIF, run enclave, start vsock proxies), `stop.sh`, `status.sh`.
- [ ] **INF-21** Logs: production enclaves have no console. Send app logs to the parent over vsock. Never log tokens, keys, IPs or merchant IDs together.
- [ ] **INF-22** Demo host firewall: on the machine that runs the agent, allow outbound traffic only to the relay (iptables or a network namespace), so nothing leaks around the tunnel.
- [ ] **INF-23** Demo day: start enclaves early and **don't restart them**. Keys and the spent list live in memory.
- [ ] **INF-24** Fallback: the same images run as plain Docker containers on the hosts, with a mock attestation, if Nitro breaks. Say so on stage if used.

### After the hackathon
- [ ] **INF-25** AWS KMS with a key policy tied to PCR0, so enclaves survive restarts without exposing keys.
- [ ] **INF-26** Tear down everything and check the bill.

---

## Lane 2: Tokens and issuer (folder `packages/tokens`, `packages/issuer`)

- [x] **ISS-01** Token library: RFC 9578 type 0x0002 using `@cloudflare/privacypass-ts` / `@cloudflare/blindrsa-ts`. Issuer keygen, client blind/finalize, verify, `Authorization: PrivateToken` header format. (The stopped cloud agent started this in its worktree.) (core agent)
- [x] **ISS-02** `POST /issue` behind a 402 (top-up). Use a `TopUpRail` interface: mock first, AP4M later (PAY-03). (core agent) Mock rail done; AP4M rail is PAY-03.
- [x] **ISS-03** `POST /verify` (read-only: signature and not spent) and `POST /settle` (mark spent, add to the merchant's tab). (core agent)
- [x] **ISS-04** Signed running-total claim for merchants, signed with a key that is in the attestation. (core agent)
- [x] **ISS-05** Solvency: refuse to issue beyond funds held. Attest "outstanding ≤ funds held." (core agent)
- [~] **ISS-06** Batched payouts at fixed times (mock first, RLUSD transfers on XRPL EVM later). (core agent) Mock payout job done; RLUSD transfers open.
- [ ] **ISS-07** Wire into the enclave (INF-10 to INF-14).

## Lane 3: Payments / AP4M (folder `packages/ap4m`)

- [ ] **PAY-01** Run AP4M Demo 1 (`node ap4m-agent.js`). Depends: INF-17, INF-18.
- [ ] **PAY-02** Run AP4M Demo 2 (x402 agent and merchant).
- [ ] **PAY-03** `Ap4mRail`: the issuer's `/issue` answers 402 via AP4M x402. The agent signs the voucher. `VoucherRedeemed` shows on the explorer. RLUSD reaches the issuer's payout address.

## Lane 4: Relay / VPN (folder `packages/relay`)

- [x] **RLY-01** HTTPS CONNECT proxy. HTTPS only; loopback by default, public destination IPs only, raw TCP tunnel.
- [x] **RLY-02** Charges one blind token per 10,000,000 tunnel bytes, settled through the issuer. Partial blocks are charged; tunnels close at quota. (Codex)
- [ ] **RLY-03** Wire into the relay enclave (INF-10 to INF-14).

## Lane 5: Agent and SDK (folders `packages/sdk`, `packages/agent`)

- [~] **SDK-01** Verify issuer and relay attestations (mock verifier first, Nitro verifier against `infra/pcrs.json`). Reject all-zero PCRs, wrong keys, reused nonces. (core agent) Mock verifier done; NitroAttestationVerifier is a stub.
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

- [ ] **DEM-01** Split-screen page: spy bot left, our agent right, live events.
- [ ] **DEM-02** Tamper button: restart the issuer with a different code hash, show the SDK refusing it.
- [ ] **DEM-03** Benchmarks: payment speed (p50/p95), spy bot accuracy vs number of agents.
- [ ] **DEM-04** Tests from SPEC §21 passing.
- [ ] **DEM-05** Update the explainer page to v4 (relay, AP4M at top-up).
- [ ] **DEM-06** Pick the name. Rehearse the live run three times. Mastercard needs it live, no recording.

---

## Order that unblocks the most

1. **INF-17, INF-18** (Mastercard activation, AP4M files): everything AP4M waits on this.
2. **INF-01 to INF-06** (AWS and hosts) in parallel with **ISS-01, MER-01, SPY-01 to SPY-03** (no infra needed).
3. **INF-07 to INF-14** (enclave images, networking, attestation), then **ISS-07, RLY-03**.
4. **PAY-03, SDK-03**, then the full demo.
