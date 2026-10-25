# infra/gcp: the issuer and relay in Google Cloud Confidential Space

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
| `relay.Dockerfile` | Builds the relay with pinned Node, lockfile installs, and an esbuild bundle. |
| `issuer-start.sh` | Exports the baked public merchant-key map at startup; the map is bound by the image digest. |
| `relay-entrypoint.ts` | Verifies the issuer's live attestation, pins its TLS SPKI, creates the in-memory relay TLS identity, and starts the proxy and receipt listeners. |
| `cloudbuild.yaml` | Cloud Build steps. `build.sh` runs it. |
| `build.sh <role>` | Builds with Cloud Build, pushes to Artifact Registry, prints the digest, writes it to `expected.json`. |
| `setup-merchant-auth-wif.sh` | Creates a digest-scoped WIF provider and Secret Manager access for the issuer and relay image digests. |
| `deploy.sh <role> [--debug]` | Creates the Confidential Space VM (deletes an existing one with the same name first). |
| `status.sh [<role> [--debug] [--logs]]` | Lists the VMs, calls `/health`, and with `--logs` shows the serial console. |
| `stop.sh [<role> [--debug]]` | Stops the VMs. With no role it stops every VM labelled `project=wraps`. |
| `open-relay-attestation-port.sh [--dry-run]` | Adds tcp:8080 to the existing `wraps-allow-443` ingress rule while keeping tcp:443 and the existing rule scope. |
| `mock-container-fallback.sh` | Builds and runs the issuer and relay images with mock attestation, then verifies a metered HTTPS request through the relay. |
| `mock-container-probe.ts` | Connects the local SDK to that fallback and asserts the relay response spends one token. |
| `expected.json` | Image digest per role, plus the policy. The SDK reads it. Commit it after each build. |
| `.state/` | Last known VM IPs. Not committed. |

The relay listens for HTTPS CONNECT on port 443 and nonce-bound HTTP attestation on port 8080.
The SDK uses the attested relay key for TLS, then reaches the issuer through a restricted,
tokenless CONNECT route. Metered merchant tunnels carry their blind-token batch in the CONNECT
proxy authorization header.

The relay serves HTTPS CONNECT on tcp:443 and its nonce attestation bootstrap endpoint on plain
HTTP tcp:8080. To allow both ports on the existing `wraps` target tag, run:

```sh
infra/gcp/open-relay-attestation-port.sh --dry-run
infra/gcp/open-relay-attestation-port.sh
```

The script updates only the allowed ports on `wraps-allow-443`; it preserves the rule's current
source ranges, target tags, network, and priority. It is safe to run repeatedly.

## Commands

Prerequisites: `gcloud` is logged in. The project `wraps-hack` already has the APIs, the registry
`us-central1-docker.pkg.dev/wraps-hack/wraps`, the service account
`wraps-workload@wraps-hack.iam.gserviceaccount.com` (`confidentialcomputing.workloadUser`,
`logging.logWriter`, `artifactregistry.reader`) and the firewall rule `wraps-allow-443`
(tcp:443 and tcp:8080 to tag `wraps`). The merchant-auth setup enables the IAM, Resource Manager,
IAM Credentials, Security Token Service, and Secret Manager APIs if they are not already enabled;
the operator needs `serviceusage.services.enable` for that step.

For SEC-04, build the issuer with the app's public merchant-key map embedded in the image. The map
is public, but it is fixed to the issuer digest so TEE metadata cannot replace it. Then build the
relay and create a WIF provider and relay credential restricted to those exact image digests:

The setup script creates `wraps-relay-settle-key` only when it has no enabled version. It creates
or updates a WIF provider whose condition checks the issuer/relay image digests, production
Confidential Space claims, and the `wraps-workload` service account. Secret Manager access is
granted to only the two corresponding digest identities. The generated secret value is sent
directly to Secret Manager and is never printed. The local state file contains only provider and
secret version resource names.

```sh
# 1. Build and push the issuer and relay. The issuer command requires the app public-key map.
ISSUER_MERCHANT_AUTH_KEYS='{"node:usc1":"<base64url-Ed25519-SPKI-public-key>"}' infra/gcp/build.sh issuer
infra/gcp/build.sh relay
infra/gcp/setup-merchant-auth-wif.sh
source infra/gcp/.state/merchant-auth.env

# 2. Try it on the debug image first. Logs go to the serial console and Cloud Logging.
infra/gcp/deploy.sh issuer --debug
infra/gcp/status.sh issuer --debug --logs
npm run verify:gcp -- 'https://<debug-ip>'    # must print REFUSED (DEBUG_MODE)

# 3. Production image. Deploy issuer first, then the relay.
infra/gcp/deploy.sh issuer
infra/gcp/status.sh issuer
npm run verify:gcp                            # reads infra/gcp/.state/issuer.ip; must print VERIFIED
ATTESTATION_AUDIENCE='https://wraps.invalid/issuer' \
ISSUER_URL='https://<issuer-ip>' \
RELAY_HOSTNAME='<relay-hostname>' \
infra/gcp/deploy.sh relay

# 4. Merchant and agent on this laptop, against the live issuer.
npm run demo:gcp                              # or ISSUER_URL='https://<issuer-ip>' npm run demo:gcp

# Or run them as separate processes:
ATTESTATION=confidential-space ISSUER_URL='https://<issuer-ip>' npm run merchant
ATTESTATION=confidential-space ISSUER_URL='https://<issuer-ip>' npm run agent

# 5. Stop the VMs when you are done. Stopped VMs keep their disks and cost almost nothing.
infra/gcp/stop.sh
```

To deploy the relay after building it, use the issuer's current IP and the reserved relay IP:

```sh
ATTESTATION_AUDIENCE='https://wraps.invalid/issuer' \
ISSUER_URL='https://<issuer-ip>' \
RELAY_HOSTNAME=34.68.188.111 \
RELAY_ADDRESS=34.68.188.111 \
infra/gcp/deploy.sh relay
```

The deploy command deletes and recreates an existing relay instance so its in-memory keys are
discarded. The issuer IP is ephemeral and can change after a stop; the relay IP is reserved.
The relay binds the public attestation listener on 8080, which is protected by per-IP and
aggregate rate limits and a bounded number of provider calls.

To rehearse the container fallback without a VM, run:

```sh
infra/gcp/mock-container-fallback.sh
```

The script builds the production issuer and relay Dockerfiles, starts both images with mock
attestation and a temporary local relay credential on an isolated container network, and sends an
HTTPS request to `example.com` through the relay. It exits nonzero unless the SDK verifies both
mock attestations, pins the issuer TLS key, receives HTTP 200, and spends exactly one meter token.
It removes the temporary containers
and network on exit. Set `ISSUER_MERCHANT_AUTH_KEYS` to the app's public-key JSON entry to bake the
same merchant identity into the local issuer image. Issuer bootstrap and top-up connect directly to
the local issuer container; the paid merchant request traverses the relay. This tests the same images
and metering path while avoiding a host route to a container's private IP.

## VM settings (from `deploy.sh`)

```
--machine-type=n2d-standard-2 --confidential-compute-type=SEV --maintenance-policy=MIGRATE
--shielded-secure-boot --image-project=confidential-space-images
--image-family=confidential-space | confidential-space-debug
--metadata=^~^tee-image-reference=<registry>/<role>@sha256:<digest>[~tee-container-log-redirect=true]
--service-account=wraps-workload@wraps-hack.iam.gserviceaccount.com --scopes=cloud-platform
--tags=wraps --labels=project=wraps,role=<role>,mode=<prod|debug>
--max-run-duration=12h --instance-termination-action=STOP
```

- The Confidential Space docs list `SEV` and `TDX`. They do not list `SEV_SNP`, so we use `SEV`.
- Relay images allow `tee-container-log-redirect` in production so startup failures are
  observable. Relay output is restricted to fixed startup stages and allowlisted error codes;
  never print raw errors, keys, tokens, endpoints, or merchant data. Other workloads can keep
  the `debugonly` policy unless their logs are similarly reviewed.
- WireGuard-enabled relay launches briefly add `CAP_SYS_ADMIN` so the startup wrapper can set
  the container guest's IPv4 forwarding sysctl. It remounts `/proc/sys` read-only afterward and
  removes `CAP_SYS_ADMIN` from the Node process; WireGuard itself keeps only `CAP_NET_ADMIN`.
- The production image fixes its workload settings. Relay audience, issuer URL, and relay
  hostname are non-secret public configuration passed as `tee-env-*` metadata; do not put keys,
  tokens, or credentials in instance metadata.
- Every VM stops itself after a fixed 12 hours; the machine type and runtime cap cannot be overridden.
- A stopped and restarted VM gets a new external IP and new keys. Run `status.sh` for the IP.

## Cost

- A running `n2d-standard-2` bills by the second: the machine, the Confidential VM premium and
  the external IP. Check the Compute Engine pricing page for the current rate. Expect cents per
  hour, not dollars.
- A stopped VM bills only for its 11 GB `pd-standard` boot disk, a few cents per month.
- Cloud Build gives free build-minutes every day. One issuer build takes about 35 seconds.
- `deploy.sh` caps every VM at 12 hours, then stops it. The project also has a $20 budget alert.

The latest live verification and remaining costs are in `STATUS.md`.
