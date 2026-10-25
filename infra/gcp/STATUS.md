# Status: issuer and relay on Confidential Space

Checked live on Oct 25, 2026 (US time), after the relay attestation hardening deployment.

## What works

- Issuer and relay images run on Google Confidential Space AMD SEV VMs using `n2d-standard-2`.
- Both deployments are pinned by the image digest in `expected.json`; the workload VMs use the `wraps` tag, `project=wraps` label, and 12-hour stop limit.
- The issuer creates its token, claim, and TLS keys in memory. The relay creates its TLS key and self-signed certificate in memory.
- The relay startup fetches and verifies the issuer's live attestation, pins the issuer TLS SPKI, then starts the TLS CONNECT listener and nonce-bound attestation listener.
- The relay attestation listener is limited to 60 valid receipt requests per client IP and 120 total per minute, with at most 4 provider calls in flight. A receipt request returns 503 after 5 seconds if Google attestation has not completed; the in-flight slot stays occupied until the provider call settles.
- SDK-02 verifies the relay receipt and TLS key, reaches the issuer through the restricted tokenless CONNECT route, pins the issuer TLS key, and sends metered merchant tunnels through the relay.

## Current image references

| Role | Image | Result |
|---|---|---|
| Issuer | `us-central1-docker.pkg.dev/wraps-hack/wraps/issuer@sha256:892a2b1a22c5a911c221ce7f31aee477f33bf986083111c843935213dbc6fbea` | Verified in Confidential Space; `GCP_AMD_SEV`, `STABLE`, production debug state, expected digest. |
| Relay | `us-central1-docker.pkg.dev/wraps-hack/wraps/relay@sha256:016cbdb68f3faa8e6653988cf7e3bd72057ff689e58348c6cb4484f8ff3fa303` | Verified in Confidential Space; receipt's image digest and TLS SPKI matched `expected.json`. |

## Live results

The ingress rule `wraps-allow-443` in project `wraps-hack` allows tcp:443 and tcp:8080. Its
source range remains `0.0.0.0/0`, target tag remains `wraps`, and network and priority remain
`default` and `1000`. INF-07 added tcp:8080 for the relay's plain HTTP nonce endpoint; no VM was
created or changed.

| Check | Result |
|---|---|
| Issuer `GET /health` | HTTP 200. |
| `npm run verify:gcp -- https://34.56.67.232` | VERIFIED: AMD SEV, `STABLE`, `dbgstat=disabled-since-boot`, and expected issuer image digest. The address was ephemeral and may change after stopping the VM. |
| Relay `GET /attestation?nonce=...` on port 8080 | Returned a nonce-bound Google Confidential Space receipt for the pinned relay image. |
| SDK live flow | Verified relay and issuer attestations, pinned the issuer key through the relay, completed a mock top-up, and sent an HTTPS request through a metered tunnel. Relay token spend was 1. |
| Full repository validation | `npm run typecheck` and `npm test` passed: 22 main test files / 213 tests and 4 demo test files / 24 tests. |

All workload VMs are now stopped. `wraps-issuer-debug` remains terminated rather than deleted. The reserved relay IP `34.68.188.111` remains attached to the stopped `wraps-relay` VM for redeployment. Stopped VM boot disks and Artifact Registry images remain and can incur storage charges.

## What is still mocked

- AP4M top-up signing/redemption and merchant payouts. The live SDK smoke test used `MockTopUpWallet`; no real RLUSD or voucher was used.
- The relay verifier is tested with a mock provider in unit tests. The live relay used Google Confidential Space attestation.

## Trade-offs and limits

- **Trust in Google.** Google Cloud Attestation checks the hardware evidence and signs the token. The SDK checks Google's signature and claims; it does not independently verify AMD's report.
- **AMD SEV.** The Confidential Space image uses SEV, not SEV-SNP.
- **Image reproducibility.** Base images are pinned by digest and dependencies install from the lockfile, but build timestamps can make rebuilt images differ.
- **Ephemeral keys and issuer IP.** Stopping and restarting a VM changes its in-memory keys and ephemeral external IP. Redeploy the issuer first, then deploy the relay with the issuer's current IP. Keep the relay's reserved address attached.
- **Attestation timeout.** A timed-out Google provider call is not cancellable through the current provider interface. Its concurrency slot remains held until it settles, preventing unlimited calls but potentially reducing availability if calls hang.
- **Public ingress.** The firewall allows source `0.0.0.0/0` to TCP 443 and 8080 on VMs with the `wraps` target tag. The public attestation endpoint is nonce-bound and rate-limited.
- **Logs.** Production container logs are not redirected; the Confidential Space launcher still writes its own serial-console logs.
- **Budget.** The repository records a $20 project budget alert. The budget resource itself was not rechecked during this deployment.

## Next operations

- Before a demo, redeploy the issuer, verify its new IP, then deploy the relay with that issuer URL and the reserved relay IP. Verify both attestations before using the SDK.
- Stop both VMs after use with `infra/gcp/stop.sh`.
- Delete the debug VM and its disk when no longer needed. Remove old Artifact Registry images when their digests are no longer referenced.
