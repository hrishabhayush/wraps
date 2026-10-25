# infra/gcp: the issuer in Google Cloud Confidential Space

The issuer runs as a container on a Confidential VM (AMD SEV, `n2d-standard-2`) with Google's
Confidential Space image. The hardware encrypts the VM's memory. The Confidential Space image
runs only the container we name by digest, and it gives the operator no shell on the production
image.

At start-up the issuer makes its keys in memory: the blind-RSA token key, the Ed25519 claim key,
and a P-256 TLS key with a self-signed certificate. On `GET /attestation?nonce=<hex>` it asks the
Confidential Space launcher for a token. Google Cloud Attestation checks the hardware evidence and
signs the token. The SDK then checks the token's signature against Google's published keys and
checks these claims:

| Claim | Required value |
|---|---|
| `iss` | `https://confidentialcomputing.googleapis.com` |
| `aud` | `https://wraps.invalid/issuer` (our custom audience) |
| `exp`, `iat` | not expired, issued in the last 5 minutes |
| `hwmodel` | one of `expected.json` `hwModels` (`GCP_AMD_SEV`) |
| `swname` | `CONFIDENTIAL_SPACE` (a revoked image reports `GCE`) |
| `secboot` | `true` |
| `dbgstat` | `disabled-since-boot` (the debug image reports `enabled`) |
| `submods.confidential_space.support_attributes` | contains `STABLE` (Google's recommendation; debug images have none) |
| `submods.container.image_digest` | the digest in `expected.json` |
| `eat_nonce` | `[hex(client nonce), hex(hashPublicKeys({token, claim, tls}))]` |

The SDK also checks that the TLS key on the connection is the `tls` key in the attestation. After
that it pins that key for every call. If the key differs, the SDK closes the socket before it
sends the request.

Claim names come from the Confidential Space docs (token claims reference, connect to external
resources, images). See `packages/attestation/src/confidential-space.ts`.

## Files

| File | What it does |
|---|---|
| `issuer.Dockerfile` | Builds the issuer. Node 22 pinned by digest, `npm ci`, esbuild bundle, `EXPOSE 443`. |
| `cloudbuild.yaml` | Cloud Build steps. `build.sh` runs it. |
| `build.sh <role>` | Builds with Cloud Build, pushes to Artifact Registry, prints the digest, writes it to `expected.json`. |
| `deploy.sh <role> [--debug]` | Creates the Confidential Space VM (deletes an existing one with the same name first). |
| `status.sh [<role> [--debug] [--logs]]` | Lists the VMs, calls `/health`, and with `--logs` shows the serial console. |
| `stop.sh [<role> [--debug]]` | Stops the VMs. With no role it stops every VM labelled `project=wraps`. |
| `expected.json` | Image digest per role, plus the policy. The SDK reads it. Commit it after each build. |
| `.state/` | Last known VM IPs. Not committed. |

There is no relay image yet, because `packages/relay` does not exist. The scripts refuse
`relay` until `relay.Dockerfile` exists.

## Commands

Prerequisites: `gcloud` is logged in. The project `wraps-hack` already has the APIs, the registry
`us-central1-docker.pkg.dev/wraps-hack/wraps`, the service account
`wraps-workload@wraps-hack.iam.gserviceaccount.com` (`confidentialcomputing.workloadUser`,
`logging.logWriter`, `artifactregistry.reader`) and the firewall rule `wraps-allow-443`
(tcp:443 to tag `wraps`).

```sh
# 1. Build and push. Writes the digest to infra/gcp/expected.json.
infra/gcp/build.sh issuer

# 2. Try it on the debug image first. Logs go to the serial console and Cloud Logging.
infra/gcp/deploy.sh issuer --debug
infra/gcp/status.sh issuer --debug --logs
npm run verify:gcp -- https://<debug IP>      # must print REFUSED (DEBUG_MODE)

# 3. Production image.
infra/gcp/deploy.sh issuer
infra/gcp/status.sh issuer
npm run verify:gcp                            # reads infra/gcp/.state/issuer.ip; must print VERIFIED

# 4. Merchant and agent on this laptop, against the live issuer.
npm run demo:gcp                              # or ISSUER_URL=https://<IP> npm run demo:gcp

# Or run them as separate processes:
ATTESTATION=confidential-space ISSUER_URL=https://<IP> npm run merchant
ATTESTATION=confidential-space ISSUER_URL=https://<IP> npm run agent

# 5. Stop the VMs when you are done. Stopped VMs keep their disks and cost almost nothing.
infra/gcp/stop.sh
```

`ATTESTATION=mock npm run demo:gcp` runs the same flow against a local HTTPS issuer with the
mock attestation. Use it to rehearse without a VM.

## VM settings (from `deploy.sh`)

```
--machine-type=n2d-standard-2 --confidential-compute-type=SEV --maintenance-policy=MIGRATE
--shielded-secure-boot --image-project=confidential-space-images
--image-family=confidential-space | confidential-space-debug
--metadata=^~^tee-image-reference=<registry>/issuer@sha256:<digest>[~tee-container-log-redirect=true]
--service-account=wraps-workload@wraps-hack.iam.gserviceaccount.com --scopes=cloud-platform
--tags=wraps --labels=project=wraps,role=<role>,mode=<prod|debug>
--max-run-duration=12h --instance-termination-action=STOP
```

- The Confidential Space docs list `SEV` and `TDX`. They do not list `SEV_SNP`, so we use `SEV`.
- `tee-container-log-redirect` is set on the debug image only. The image's launch policy
  (`tee.launch_policy.log_redirect=debugonly`) allows redirect only there.
- The image fixes its own env (`ATTESTATION`, `ISSUER_TLS`, `ISSUER_PORT`). It has no
  `allow_env_override` label, so the operator cannot change them.
- Every VM stops itself after a fixed 12 hours; the machine type and runtime cap cannot be overridden.
- A stopped and restarted VM gets a new external IP and new keys. Run `status.sh` for the IP.

## Cost

- A running `n2d-standard-2` bills by the second: the machine, the Confidential VM premium and
  the external IP. Check the Compute Engine pricing page for the current rate. Expect cents per
  hour, not dollars.
- A stopped VM bills only for its 11 GB `pd-standard` boot disk, a few cents per month.
- Cloud Build gives free build-minutes every day. One issuer build takes about 35 seconds.
- `deploy.sh` caps every VM at 12 hours, then stops it. The project also has a $20 budget alert.

What we spent on Oct 24, 2026 is in `STATUS.md`.
