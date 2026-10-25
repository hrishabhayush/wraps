# Demo day VM readiness

Use this checklist for a live Confidential Space rehearsal. It assumes AP4M is skipped and the
demo's top-up and merchant payout use the documented mock rails. The issuer and relay
attestations, image-digest checks, TLS pins, and any explicitly configured WireGuard path still
need to pass live checks.

## Before demo day

- Freeze the source revision and record the issuer and relay image digests in `expected.json`.
  Build both images from the reviewed revision; do not accept a digest reported by an old VM as
  the expected digest.
- Run the repo typecheck and test suite, `npm run demo:core`, and the canary firewall fixture
  `node infra/gcp/test-deploy-canary-firewall.mjs`. Rehearse the tampered-attestation and debug
  mode cases locally; both must stop before top-up or purchase.
- Confirm `infra/gcp/.state/issuer-state.env` and `merchant-auth.env` match the image configuration.
  Build the issuer with the intended merchant public-key map, then run the WIF setup for those
  exact image digests. Keep merchant private keys out of source control, image metadata, and logs.
- Decide whether to use the production VMs or side-by-side canaries. For a canary, follow the
  source-restricted ingress steps in `README.md`; set explicit operator/client CIDRs. The
  WireGuard canary uses its dedicated UDP rule and must not modify the production
  `wraps-allow-wireguard` rule.
- Reserve a rehearsal window that ends well before the VM's fixed 12-hour maximum runtime. Check
  the $20 project budget alert and expected VM/build costs.

## Start the VMs

Start the VMs roughly an hour before the first full run, leaving time for startup and all live
checks while avoiding a long idle period. Every workload VM must remain an `n2d-standard-2`, carry
the `project=wraps` label, and use the enforced 12-hour stop limit.

1. Deploy the issuer first. Record its current external IP and confirm `status.sh issuer` reports
   it ready. Verify the live issuer attestation against the digest in `expected.json`.
2. Deploy the relay with the issuer's current IP. Record the relay IP and confirm `status.sh relay`
   reports it ready. A stopped or restarted issuer can have a different IP; do not keep using a
   stale relay configuration.
3. Run `npm run verify:gcp` and `npm run demo:preflight`. Continue only if the expected image
   digests, both attestations, TLS pins, merchant-auth mode, issuer route through the relay, and
   required external services all pass. A red check means the rehearsal is not ready. Fix and
   rebuild from reviewed source instead of changing `expected.json` to trust the running image.
4. If this run includes WireGuard, use the dedicated canary with the exact client CIDR allow rule.
   Verify authorized client egress through the relay before the rehearsal; confirm unrelated
   outbound traffic cannot bypass the tunnel. Do not use the production peer or change the global
   production firewall rule for a canary test.

## Run three rehearsals without restarting

The current production status records the issuer's keys and state as memory-only. The INF-31
candidate adds encrypted GCS/KMS snapshots for issuer state, but the keys are still generated in
memory and the snapshots do not have an independent rollback-resistant anchor. That candidate is
not a verified restart-safe production rollout. For demo-day operation, treat the active issuer
generation as non-resumable across a restart, even if encrypted snapshots are present.

- Keep the same issuer and relay process generation running through all three live rehearsals.
  Use fresh demo inputs for each run and follow `docs/REHEARSAL.md` for the exact command and
  evidence to record.
- Do not stop, restart, replace, or reboot either VM after the first issuer key is created or any
  token is issued. The issuer generates new keys on restart. The current production image also
  loses its in-memory spent list and settlements; the candidate snapshot store does not make the
  previous key epoch resumable or prevent administrative rollback. Old tokens and prior rehearsal
  state therefore cannot be resumed safely.
- Re-run `npm run demo:preflight` before each rehearsal. Save the result, timestamp, image digests,
  and the observed attestation/relay checks in the rehearsal record. Never record private keys,
  tokens, or merchant data.
- If a VM stops unexpectedly, its 12-hour limit is reached, or any preflight check fails, stop the
  live run. Treat it as a new deployment: deploy from the reviewed digest, refresh current IPs,
  and complete every preflight check before issuing tokens again. Do not restart the old VM to
  continue with its previous wallet or spent-list state.

## After the rehearsals

Stop the canary VMs after saving the non-sensitive run records. Remove only the canary resources
created for this rehearsal, including its dedicated firewall rules; leave the production VMs and
production WireGuard firewall rule untouched. Follow the project's separate post-hackathon
cleanup plan before deleting shared images, buckets, keys, or project resources.

## Rehearsal status (2026-10-25)

Three isolated Confidential Space canary runs passed on the same running issuer and relay
generation. The runs verified the image digests, both attestations, TLS pins, enforced merchant
authentication in the canary, issuer traffic through the relay, and the merchant's forwarded relay
IP. The top-up and payout rails were mocked and a temporary merchant key was used. Full outcomes,
canary digests, the wrong-digest rejection, and the separate WireGuard peer check are recorded in
the DEM-06 rehearsal update (PR #58).

These runs validate the rehearsal steps, but do not certify the production VMs. A read-only
preflight against the production endpoints using the current main `expected.json` verified both
production image digests and attestations, but failed because the issuer reported
`merchantAuth: legacy-open` and no local live merchant signing key was configured. The INF-31
candidate `expected.json` also names different image digests from those currently running in
production. Do not change expected digests just to accept a running image; build and deploy the
reviewed candidate, configure its intended merchant key map, then require a green preflight before
the production demo.

INF-22 remains a day-of operational task. The canary rehearsals are recorded; the production start
and run still need to pass on the reviewed deployment without restarting either workload.
