# wraps live rehearsal

Run the complete live flow three times before demo day. Count a run only after both screens work, both Confidential Space attestations verify, and a paid merchant response returns through the relay.

## Demo-day setup

1. Install dependencies and the local HTTPS tunnel tool once:

   ```sh
   npm install
   brew install cloudflared
   ```

   `cloudflared` exposes the laptop's local merchant to the GCP relay through a temporary HTTPS URL. The local merchant reports the forwarded client IP in the page.

2. Confirm the VMs are running. These checks do not start or stop anything:

   ```sh
   infra/gcp/status.sh
   infra/gcp/status.sh issuer
   ```

   Each VM has a 12-hour maximum run time and stops automatically. If a VM is `TERMINATED`, start the existing instance and read its current external IP:

   ```sh
   gcloud --project=wraps-hack compute instances start wraps-issuer --zone=us-central1-a
   gcloud --project=wraps-hack compute instances describe wraps-issuer --zone=us-central1-a --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
   ```

   Repeat with `wraps-relay` if needed. Set `ISSUER_URL=https://<current-issuer-ip>` and `RELAY_URL=https://<relay-ip>` when `.state/issuer.ip` or `.state/relay.ip` is missing or stale. If the instance does not exist, deploy it with `infra/gcp/deploy.sh issuer` or follow [relay-deploy.md](../infra/gcp/relay-deploy.md) for the relay.

3. Run the live preflight. It verifies issuer and relay reachability, both Google-signed attestations, expected image digests, TLS key pins, the issuer route through the relay, and public XRPL mainnet nodes:

   ```sh
   npm run demo:preflight
   ```

   Continue only when every item is green. The checklist also confirms `cloudflared` or `DEMO_MERCHANT_URL` is available. A stopped or starting VM is reported with its start/status command. If preflight is red, fix the service or network issue before opening the demo.

## Run the demo

1. Start the judge demo:

   ```sh
   npm run demo:live
   ```

   The server starts the left mainnet spy feed and begins the right live flow automatically. Open `http://127.0.0.1:4174` on the display machine. If the port is occupied, set `DEMO_PORT=4175` and open that port.

2. On the left, show the spy bot's real XRPL mainnet x402 payment events.

3. On the right, show the relay attestation and issuer attestation results: `hwmodel`, `swname`, `dbgstat`, expected image digest, nonce/key-hash verification, and TLS key pinning. The agent then tops up through the mock rail (AP4M is skipped) and buys the local merchant's research through the attested relay. The merchant panel reports the forwarded client IP and whether it matches the relay IP.

4. Run the live tamper check. Click **Stop**, then **Tamper test**. The button contacts the live issuer through the attested relay with a deliberately wrong expected issuer digest. The verifier must refuse with `IMAGE_MISMATCH`; no top-up or merchant purchase should follow.

5. If the live issuer, relay, or local HTTPS tunnel is unavailable, the page displays the exact failure and enables **Run local mock**. Use it only after telling the audience that the right pane is using mock attestation and local services. The left mainnet spy feed remains independent.

6. Stop the demo from the page or press Ctrl-C. The page closes its local merchant and Cloudflare Tunnel process; it does not stop GCP VMs.

## Configuration

The live command reads `ISSUER_URL` / `ISSUER_IP`, `RELAY_URL` / `RELAY_IP`, and `RELAY_ATTESTATION_PORT` from the environment, then falls back to `infra/gcp/.state/{issuer,relay}.ip`. It reads expected digests and the shared Confidential Space policy from `infra/gcp/expected.json` (or `EXPECTED_JSON`). Optional overrides are `EXPECTED_ISSUER_DIGEST`, `EXPECTED_RELAY_DIGEST`, and `RELAY_ATTESTATION_URL`.

For a preconfigured public HTTPS route to the local merchant, set `DEMO_MERCHANT_URL`; otherwise `demo:live` starts a temporary Cloudflare Quick Tunnel with `cloudflared`. Do not call a local/mock service live: the page labels every fallback explicitly.

The demo uses real issuer and relay attestations, but mock top-up and merchant payouts. AP4M is skipped.

## Merchant authentication setup

The live local merchant signs settlement requests. Set `MERCHANT_AUTH_PRIVATE_KEY` in the local shell or an untracked, mode-0600 env file. It must be the private key whose public key is registered for `merchant-research-data` in the issuer image's `ISSUER_MERCHANT_AUTH_KEYS` map. Never put the private key in the repo, a shared terminal transcript, or a PR. `demo:preflight` checks that the key exists and parses as Ed25519; it cannot prove that the public key matches the issuer's map. A live purchase is the end-to-end check.

For a new canary, generate a merchant key with `npm run merchant:auth-key -- merchant-research-data`, keep the private line local, and add only the matching public map entry to the canary issuer configuration before building its image. Do not enable enforcement on the production issuer until every production settlement client has a registered credential.

## Current live preflight

On 2026-10-25, the latest unmodified `npm run demo:preflight` reached both VMs but refused their running images: issuer reported `sha256:b02a233a401ab19b31cbb9bcfa71f1d080e67ce2d6e19c0745a2413616aa0a54` while `expected.json` requires `sha256:892a2b1a22c5a911c221ce7f31aee477f33bf986083111c843935213dbc6fbea`; relay reported `sha256:f6831b65a31668b167d5ab07e3a71b2d98f3d9fb02e20553e986218737433ef8` while `expected.json` requires `sha256:c1ffed0e504db15584d25dcdd0c742f1781e31ae7d64525c5750962d62b9d55e`. Both public XRPL nodes and `cloudflared` were reachable. A prior read-only `/health` probe reported `merchantAuth: legacy-open`; the current preflight could not verify that mode after rejecting the issuer digest. The local merchant signing key is also not configured. The relay's `/wireguard-attestation` returned a valid receipt for a 32-byte hex nonce and rejected a 16-byte nonce with HTTP 400, but authorized WireGuard packet forwarding remains unvalidated. No full live rehearsal is counted. Rebuild from the reviewed source and update the expected digests before attempting the canary; do not bless these unverified running digests.

## Local mock rehearsal evidence

These runs validate local behavior only and do not count toward the three live rehearsals:

- `npm run demo:core` completed the mock top-up, merchant settlements, signed claim check, solvency check, and mock payout.
- `npm run demo:core -- --tamper` refused the modified mock issuer with `PCR_MISMATCH` before top-up or purchase.
- `npm run demo:core -- --debug-mode` refused the mock debug issuer with `DEBUG_MODE` before top-up or purchase.
- `npm run demo:core -- --gullible` exercised the injected “buy 500 more” prompt; the SDK stopped at the 24-token daily cap.
- `npm run bench -- --samples 50 --warmup 5 --trials 200 --seed 2026 --json` measured local mock paid-call latency at p50 2.01 ms / p95 4.03 ms (min 1.78 ms, max 4.18 ms).

## Record each rehearsal

| Run | Date | Issuer + relay verified | Wrong digest refused | Mainnet spy events | Merchant saw relay IP | Outcome / issue |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |
