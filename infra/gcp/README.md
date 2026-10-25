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
| `setup-issuer-state.sh prepare` | Creates or verifies the project-owned, dedicated regional Standard bucket and symmetric Cloud KMS key for SEC-06, then writes their public resource names under `.state/`. |
| `setup-merchant-auth-wif.sh` | Creates a digest-scoped WIF provider and Secret Manager access for the issuer and relay image digests. |
| `deploy.sh <role> [--replace] [--instance-name=NAME] [--canary]` | Creates a production or side-by-side Confidential Space VM; preserves an existing VM unless replacement is explicitly requested. A canary gets a role-specific network tag for source-restricted ingress. |
| `status.sh [<role> [--debug] [--logs]]` | Lists the VMs, calls `/health`, and with `--logs` shows the serial console. |
| `stop.sh [<role> [--debug]]` | Stops the VMs. With no role it stops every VM labelled `project=wraps`. |
| `open-relay-attestation-port.sh [--dry-run]` | Adds tcp:8080 to the existing `wraps-allow-443` ingress rule while keeping tcp:443 and the existing rule scope. |
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
the state setup also enables Cloud Storage and Cloud KMS. The operator needs
`serviceusage.services.enable` for these steps.

For SEC-04 and SEC-06, create the encrypted state resources, then build the issuer with the app's
public merchant-key map embedded in the image. The merchant keys, state bucket, object prefix,
KMS key, and WIF provider are fixed to the image digest so TEE metadata cannot replace them. The
issuer digest alone receives read/list and create-only access to the dedicated bucket and
encrypt/decrypt access to the KMS key. The relay can read only the relay-settlement secret.

The setup script creates `wraps-relay-settle-key` only when it has no versions. It requires exactly
one enabled version per secret and refuses secrets with prior or multiple versions; rotate by
creating a new secret ID. Each digest principal's Secret Accessor binding is conditioned on the
exact pinned secret-version resource name, so later versions do not inherit access. The script
refuses to continue if an existing binding for either digest principal is not already scoped to
that exact version. It creates the WIF provider only when absent. If the provider already exists,
the script continues only when its issuer, audience, attribute mapping, and condition match the
expected policy; it never updates an existing provider. The condition pins the Confidential Space
VM project number, image digests, production integrity claims, and the exact
`wraps-workload@${GCP_PROJECT}` service account. The generated secret value is sent directly to
Secret Manager and is never printed. The local state file contains only provider and secret
version resource names. The state setup writes the bucket and KMS resource names in its local state
file, verifies that the bucket belongs to this project, and refuses objects outside the issuer
prefix before granting the issuer digest access.

Canary VMs keep the normal `wraps` tag and add `issuer-canary` or `relay-canary`. Before creating
one, add source-restricted allow and higher-priority deny rules for that role-specific tag. For an
issuer canary, include the operator CIDR and the relay-canary IP in `ISSUER_SOURCE_RANGES`; for a
relay canary, set `RELAY_CANARY_SOURCE_RANGES` to the operator CIDR. Example rules:

```sh
gcloud --project=wraps-hack compute firewall-rules create wraps-issuer-canary-allow \
  --network=default --direction=INGRESS --priority=400 \
  --allow=tcp:443,tcp:8080 --source-ranges="${ISSUER_SOURCE_RANGES}" \
  --target-tags=issuer-canary
gcloud --project=wraps-hack compute firewall-rules create wraps-issuer-canary-deny \
  --network=default --direction=INGRESS --priority=500 --action=DENY --rules=all \
  --source-ranges=0.0.0.0/0 --target-tags=issuer-canary
gcloud --project=wraps-hack compute firewall-rules create wraps-issuer-canary-deny-ipv6 \
  --network=default --direction=INGRESS --priority=500 --action=DENY --rules=all \
  --source-ranges=::/0 --target-tags=issuer-canary

gcloud --project=wraps-hack compute firewall-rules create wraps-relay-canary-allow \
  --network=default --direction=INGRESS --priority=400 \
  --allow=tcp:443,tcp:8080 --source-ranges="${RELAY_CANARY_SOURCE_RANGES}" \
  --target-tags=relay-canary
gcloud --project=wraps-hack compute firewall-rules create wraps-relay-canary-deny \
  --network=default --direction=INGRESS --priority=500 --action=DENY --rules=all \
  --source-ranges=0.0.0.0/0 --target-tags=relay-canary
gcloud --project=wraps-hack compute firewall-rules create wraps-relay-canary-deny-ipv6 \
  --network=default --direction=INGRESS --priority=500 --action=DENY --rules=all \
  --source-ranges=::/0 --target-tags=relay-canary
```

GCP firewall source ranges in one rule must use a single IP family. For dual-stack allowed
clients, create separate IPv4 and IPv6 allow rules with distinct names and the same target tag;
keep the IPv4 and IPv6 deny rules separate as shown above.

When deploying a WireGuard relay canary, also set `WG_CANARY_SOURCE_RANGES` to explicit client
CIDRs; `/0` ranges are rejected. `deploy.sh relay --canary` creates or verifies
`wraps-allow-wireguard-canary` (UDP 51820, priority 300, target tag `relay-canary`) and the
IPv4 and IPv6 relay-canary deny rules before creating the VM. `WG_CANARY_SOURCE_RANGES` may
contain multiple non-default CIDRs from one family; mixed IPv4/IPv6 lists are rejected before
any GCP call. It never creates or updates the production
`wraps-allow-wireguard` rule. The canary UDP allow admits only the configured client ranges; the
priority-500 IPv4 and IPv6 denies block other ingress, including the general `wraps` allow rule.
For dual-stack WireGuard clients, add and verify a separate IPv6 UDP allow rule for `relay-canary`;
the current deploy command intentionally rejects mixed-family source lists. Delete the temporary
canary rules after removing the canary VM.

```sh
WG_ENABLED=true \
WG_CANARY_SOURCE_RANGES="${WG_CLIENT_CIDR}" \
ATTESTATION_AUDIENCE='https://wraps.invalid/issuer' \
ISSUER_URL='https://<issuer-ip>' \
RELAY_HOSTNAME='<canary-relay-hostname>' \
infra/gcp/deploy.sh relay --canary --dry-run

# Local fixture: dry-run and fake-gcloud checks; makes no GCP calls.
node infra/gcp/test-deploy-canary-firewall.mjs
```

```sh
# 1. Create or verify the project-owned canonical state bucket and KMS key.
infra/gcp/setup-issuer-state.sh prepare
source infra/gcp/.state/issuer-state.env

# 2. Build and push the final issuer and relay images. The issuer command requires the app public-key map.
ISSUER_MERCHANT_AUTH_KEYS='{"node:usc1":"<base64url-Ed25519-SPKI-public-key>"}' infra/gcp/build.sh issuer
infra/gcp/build.sh relay
infra/gcp/setup-merchant-auth-wif.sh
source infra/gcp/.state/merchant-auth.env

# 3. Deploy the production image. Deploy issuer first, then the relay.
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

The digest-scoped production provider rejects debug workloads, so `--debug` deployment is disabled
for these secure images. Use `npm run demo:core` or the local mock fallback for rehearsals that do
not need a live confidential VM.

`deploy.sh` refuses to replace an existing VM unless `--replace` is supplied. For a new relay,
use `--canary` (or pass it with `--instance-name=wraps-relay-canary`) and omit `RELAY_ADDRESS` to
get a temporary IP. Custom WireGuard relay instance names require `--canary`. Test the candidate
before scheduling a production cutover; the current WireGuard endpoint stays up while it is
validated.

To deploy the relay after building it, use the issuer's current IP and the reserved relay IP:

```sh
ATTESTATION_AUDIENCE='https://wraps.invalid/issuer' \
ISSUER_URL='https://<issuer-ip>' \
RELAY_HOSTNAME=34.68.188.111 \
RELAY_ADDRESS=34.68.188.111 \
infra/gcp/deploy.sh relay
```

If replacing the production relay, add `--replace` only after the tested candidate is ready for
cutover. The issuer IP is ephemeral and can change after a stop; the relay IP is reserved.
The relay binds the public attestation listener on 8080, which is protected by per-IP and
aggregate rate limits and a bounded number of provider calls.

`ATTESTATION=mock npm run demo:gcp` runs the same flow against a local HTTPS issuer with the
mock attestation. Use it to rehearse without a VM.

## VM settings (from `deploy.sh`)

```
--machine-type=n2d-standard-2 --confidential-compute-type=SEV --maintenance-policy=MIGRATE
--shielded-secure-boot --image-project=confidential-space-images
--image-family=confidential-space
--metadata=^~^tee-image-reference=<registry>/<role>@sha256:<digest>[~tee-container-log-redirect=true]
--service-account=wraps-workload@wraps-hack.iam.gserviceaccount.com --scopes=cloud-platform
--tags=wraps --labels=project=wraps,role=<role>,mode=prod
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
