# Infra: two AWS Nitro Enclaves (issuer and relay)

This folder takes you from an empty AWS account to two running enclaves: the
**issuer** and the **relay**, on two separate EC2 hosts (SPEC §3, §12). Each
step maps to a task in `docs/TODO.md`, lane 1 (INF-01 to INF-24).

Region: **us-east-1**. Host OS: **Amazon Linux 2023**. Instance: **c6i.xlarge**.

## What is here

| Path | What it is |
|---|---|
| `scripts/host-setup.sh` | Installs Docker, nitro-cli, allocator, systemd units (INF-06) |
| `scripts/smoke-hello.sh` | Runs the AWS hello-world enclave (INF-06 done-when) |
| `scripts/prepare-build.sh` | Pins base images by digest, makes `Cargo.lock`. Run once, commit (INF-07) |
| `scripts/build-eif.sh` | Docker image to `.eif`, prints PCRs, writes `pcrs.json` (INF-08, INF-09) |
| `scripts/deploy.sh` | Runs the enclave in production mode, starts proxies (INF-10, 11, 13, 20) |
| `scripts/stop.sh`, `scripts/status.sh` | Stop everything. Show state (INF-20) |
| `scripts/fallback-docker.sh` | Same image as a plain container, mock attestation (INF-24) |
| `scripts/demo-firewall.sh` | Agent machine may talk only to the relay (INF-22) |
| `docker/*.Dockerfile` | Enclave images, pinned and reproducible (INF-07) |
| `config/egress.<role>.conf` | Egress allowlist. One file drives both enclave and parent (INF-11) |
| `config/<role>.env` | CPUs, memory, CID, ports per host |
| `config/build.env` | Build inputs that affect PCR0 |
| `systemd/` | Parent services: ingress, egress proxies, log receiver |
| `enclave-common/` | Node/TS helper for the apps: keys, NSM attestation, TLS, `/attestation` (INF-12, INF-14) |
| `pcrs.schema.json`, `pcrs.example.json` | Format of `pcrs.json`, which the SDK reads (INF-09) |

`infra/pcrs.json` does not exist until the first `build-eif.sh` run. Commit it after a build you deploy.

---

## The short path

Run these in order. Each one is explained in the sections below.

```bash
# Laptop
aws configure                                   # region us-east-1        (INF-01)
# ... create budget, key pair, security groups, two hosts, two Elastic IPs (INF-01..05, commands below)
# ... fill the PLACEHOLDER lines in infra/config/egress.*.conf             (INF-11)
infra/scripts/prepare-build.sh                  # needs Docker; or run it on the issuer host (INF-07)
git add infra && git commit -m "infra: pin images"
rsync -az --exclude node_modules --exclude infra/build ./ ec2-user@$ISSUER_IP:agent-pay-hackathon/
rsync -az --exclude node_modules --exclude infra/build ./ ec2-user@$RELAY_IP:agent-pay-hackathon/

# Both hosts
cd agent-pay-hackathon
infra/scripts/host-setup.sh issuer              # "relay" on the relay host (INF-06)
exit; ssh back in                               # group changes apply
infra/scripts/smoke-hello.sh                    # hello-world enclave       (INF-06)

# Issuer host: build both images, so one pcrs.json holds both
infra/scripts/build-eif.sh issuer --check       # INF-08, INF-09
infra/scripts/build-eif.sh relay --check
scp infra/build/relay.eif ec2-user@$RELAY_IP:agent-pay-hackathon/infra/build/
# copy infra/pcrs.json back to the laptop and commit it

# Each host
sudo install -m 0600 my-issuer.boot.json /etc/ifi/issuer.boot.json   # if the app needs config
infra/scripts/deploy.sh issuer                  # "relay" on the relay host (INF-13, INF-20)
infra/scripts/status.sh

# Agent machine, just before the demo
sudo infra/scripts/demo-firewall.sh apply $RELAY_IP                       # INF-22
sudo infra/scripts/demo-firewall.sh undo                                  # after the demo
```

### What the other lanes must deliver first

`build-eif.sh` checks these and stops with a clear message if one is missing.

1. `packages/issuer/src/cli.ts` and `packages/relay/src/cli.ts`: the entry points the images run.
2. `"infra/enclave-common"` added to `workspaces` in the root `package.json`, then `npm install`, then commit `package-lock.json`. The apps then import `@wraps/enclave-common`.
3. The issuer and relay apps call `enclave-common` at boot (see [Using enclave-common](#using-enclave-common)).

---

## INF-01: Account, IAM, budget

**Console (manual):**

1. Sign in to the AWS account. Switch the region to **US East (N. Virginia) us-east-1**.
2. IAM > User groups > Create group `ifi-deployers`. Attach `AmazonEC2FullAccess`.
3. IAM > Users > Create user per teammate. Add each to `ifi-deployers`. Enable console access. Create an access key for CLI use.
4. Billing > Budgets: the CLI below works too.

**CLI (same result as steps 2 and 3, plus the budget):**

```bash
aws configure set region us-east-1
aws iam create-group --group-name ifi-deployers
aws iam attach-group-policy --group-name ifi-deployers \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess
aws iam create-user --user-name ifi-<NAME>
aws iam add-user-to-group --user-name ifi-<NAME> --group-name ifi-deployers
aws iam create-login-profile --user-name ifi-<NAME> --password '<TEMP_PASSWORD>' --password-reset-required

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"ifi-50usd","BudgetLimit":{"Amount":"50","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[
    {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":50,"ThresholdType":"PERCENTAGE"},
     "Subscribers":[{"SubscriptionType":"EMAIL","Address":"<TEAM_EMAIL>"}]},
    {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
     "Subscribers":[{"SubscriptionType":"EMAIL","Address":"<TEAM_EMAIL>"}]}]'
```

Done when: every deployer can log in, and the budget shows in Billing > Budgets.

## INF-02: Instance type

**Choice: `c6i.xlarge`** (4 vCPUs, 8 GiB, about $0.17 per hour on demand).

- Nitro Enclaves on Intel and AMD instances need **at least 4 vCPUs**. Burstable types (t3, t3a) do not support enclaves.
- The enclave takes **whole CPU cores**. On c6i one core is 2 vCPUs, so the enclave gets 2 vCPUs and the parent keeps 2. The parent needs its share for Docker builds, socat and vsock-proxy.
- The enclave takes **its own memory**, carved out of the host at boot by the allocator. We give it 3072 MiB. The enclave image unpacks into RAM, and a Node image is a few hundred MB, so 3 GiB leaves room for the heap. The parent keeps about 5 GiB.
- x86 matches the team's laptops and every base image. Graviton (c7g) also supports enclaves, but then the images are arm64.
- `m5.xlarge` (4 vCPUs, 16 GiB, about $0.19 per hour) works the same way. Use it if 3 GiB proves too small: raise `ENCLAVE_MEMORY_MIB` in `config/<role>.env` and run `host-setup.sh` again.

Two hosts for 48 hours cost about $17, plus a few dollars for disks and Elastic IPs.

## INF-03, INF-04: Launch the two hosts

The relay and the issuer **must** be separate machines (SPEC §3, §12). One machine could match "agent IP asks for merchant M" with "merchant M redeems tokens" by timing.

```bash
export AWS_REGION=us-east-1
AMI=$(aws ssm get-parameters --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameters[0].Value' --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)

# One key pair for the team. Keep the .pem out of git.
aws ec2 create-key-pair --key-name ifi-team --key-type ed25519 \
  --query KeyMaterial --output text > ~/.ssh/ifi-team.pem
chmod 600 ~/.ssh/ifi-team.pem
```

Create the security groups first (next section), then launch:

```bash
launch() {  # launch <name> <security-group-id>
  aws ec2 run-instances \
    --image-id "$AMI" \
    --instance-type c6i.xlarge \
    --key-name ifi-team \
    --security-group-ids "$2" \
    --enclave-options Enabled=true \
    --metadata-options HttpTokens=required \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=ifi-$1},{Key=Project,Value=ifi}]" \
    --query 'Instances[0].InstanceId' --output text
}
ISSUER_ID=$(launch issuer "$SG_ISSUER")
RELAY_ID=$(launch relay "$SG_RELAY")
aws ec2 wait instance-running --instance-ids "$ISSUER_ID" "$RELAY_ID"

# Fixed public IPs. The relay egress list and the demo firewall need them to stay the same.
for pair in "issuer:$ISSUER_ID" "relay:$RELAY_ID"; do
  name=${pair%%:*}; id=${pair#*:}
  alloc=$(aws ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=ifi-$name}]" \
    --query AllocationId --output text)
  aws ec2 associate-address --instance-id "$id" --allocation-id "$alloc" >/dev/null
done
aws ec2 describe-instances --instance-ids "$ISSUER_ID" "$RELAY_ID" \
  --query 'Reservations[].Instances[].[Tags[?Key==`Name`]|[0].Value,PublicIpAddress,PublicDnsName,EnclaveOptions.Enabled]' \
  --output table
```

Write down both public IPs and the issuer's **public DNS name** (`ec2-…compute-1.amazonaws.com`). The relay egress list needs the DNS name.

Check: `EnclaveOptions.Enabled` is `True` for both. You cannot turn it on after launch without stopping the instance.

## INF-05: Security groups

Port 443 is open to the world on both hosts: agents top up and merchants call `/verify` and `/settle` on the issuer, and agents open the tunnel on the relay. SSH is open only to team IPs.

```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)       # repeat --cidr for each teammate's IP

for role in issuer relay; do
  sg=$(aws ec2 create-security-group --group-name "ifi-$role" \
    --description "ifi $role: 443 public, ssh team only" --vpc-id "$VPC" \
    --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 443 --cidr 0.0.0.0/0
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$MY_IP/32"
  # aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr <TEAMMATE_IP>/32
  [ "$role" = issuer ] && SG_ISSUER=$sg || SG_RELAY=$sg
done
echo "SG_ISSUER=$SG_ISSUER SG_RELAY=$SG_RELAY"
```

Optional hardening: allow the issuer's 443 only from the relay's Elastic IP and the merchant host. Then all agent traffic must go through the relay. Do this only once the merchant's IP is known.

Done-when check, on each host, before any enclave runs:

```bash
sudo python3 -m http.server 443          # on the host; Ctrl-C after the test
curl -s http://<HOST_IP>:443/ | head -3  # from the laptop: you get a directory listing
```

## INF-06: Host setup and hello-world

Copy the repo to each host. Either `git clone` (if the hosts can reach the remote) or rsync from the laptop:

```bash
rsync -az -e "ssh -i ~/.ssh/ifi-team.pem" --exclude node_modules --exclude infra/build \
  ./ ec2-user@<HOST_IP>:agent-pay-hackathon/
```

On each host:

```bash
ssh -i ~/.ssh/ifi-team.pem ec2-user@<HOST_IP>
cd agent-pay-hackathon
infra/scripts/host-setup.sh issuer     # or: relay
exit                                   # log out, then ssh in again for the docker and ne groups
infra/scripts/smoke-hello.sh
```

`host-setup.sh` does:

- `dnf install docker aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel socat jq git`
- adds you to the `docker` and `ne` groups
- writes `/etc/nitro_enclaves/allocator.yaml`:
  ```yaml
  ---
  memory_mib: 3072
  cpu_count: 2
  ```
- enables `docker` and `nitro-enclaves-allocator`, disables the stock KMS `nitro-enclaves-vsock-proxy`
- installs `ifi-ingress`, `ifi-egress@`, `ifi-logs` units (not started yet)
- installs the `docker buildx` plugin if missing, and checks that `socat` has VSOCK support

`smoke-hello.sh` builds `/usr/share/nitro_enclaves/examples/hello`, runs it, and shows its console. It uses `--debug-mode` only so the console is readable. Done when you see `Hello from the enclave side!`.

## INF-07: Reproducible images

`docker/issuer.Dockerfile` and `docker/relay.Dockerfile` have three stages:

1. **nsm**: builds the `nsm-attest` helper from `enclave-common/nsm-helper` with `cargo build --locked`.
2. **deps**: `npm ci` from the root `package-lock.json`, only for the app's workspaces. Then copies just `node_modules` and the needed packages.
3. **final**: `node:22-bookworm-slim` plus `socat` and `iproute2` from a fixed Debian snapshot, the helper, `enclave-init`, the egress list and the app.

What keeps PCR0 stable:

| Input | How it is fixed |
|---|---|
| Base images | Pinned by `@sha256` digest. `prepare-build.sh` fills them in |
| npm packages | `npm ci` with the committed lockfile, `--ignore-scripts` |
| Rust crates | `Cargo.lock` committed, `--locked` |
| Debian packages | `snapshot.debian.org` at `DEBIAN_SNAPSHOT` from `config/build.env` |
| File timestamps | `SOURCE_DATE_EPOCH` plus BuildKit `rewrite-timestamp=true` |
| BuildKit itself | `moby/buildkit` pinned by digest, used through a `docker-container` buildx builder |
| Build context | `<name>.Dockerfile.dockerignore` drops `.git`, `node_modules`, secrets, `infra/build` |

Run once, on the laptop if it has Docker, else on the issuer host:

```bash
infra/scripts/prepare-build.sh
git diff infra       # FROM lines now carry digests; build.env pins BuildKit; Cargo.lock exists
git add infra && git commit -m "infra: pin base images and Cargo.lock"
```

If you ran it on the host, copy back `infra/docker/*.Dockerfile`, `infra/config/build.env` and `infra/enclave-common/nsm-helper/Cargo.lock`, then commit.

## INF-08, INF-09: Build the EIF and publish PCRs

Build both images on the issuer host, so one `pcrs.json` holds both entries:

```bash
infra/scripts/build-eif.sh issuer --check
infra/scripts/build-eif.sh relay --check
scp infra/build/relay.eif ec2-user@<RELAY_IP>:agent-pay-hackathon/infra/build/
```

`build-eif.sh` builds the image, runs `nitro-cli build-enclave`, prints PCR0, PCR1, PCR2, and writes them to `infra/pcrs.json`. `--check` builds a second time without cache and fails if PCR0 differs. That is the INF-09 done-when.

Copy `infra/pcrs.json` back to the laptop and commit it. Build from a clean, committed tree: the script marks the entry `-dirty` otherwise.

Anything that changes the image changes PCR0: app code, lockfile, egress list, `build.env`. Rebuild, redeploy and recommit `pcrs.json` together.

## INF-10, INF-11: Enclave networking

An enclave has no network card. Its only channel is vsock to its parent. The parent CID is always 3.

```
                          PARENT EC2 HOST                                  ENCLAVE
 internet :443 ──▶ ifi-ingress (socat TCP:443 → vsock 16:8443) ═══▶ socat vsock:8443 → 127.0.0.1:8443 → app (TLS ends here)

 app → https://hackathon.ap4m.build
     /etc/hosts: hackathon.ap4m.build = 127.0.10.2
     socat 127.0.10.2:443 → vsock 3:8001 ═══▶ ifi-egress@8001 (vsock-proxy, allowlist) ──▶ hackathon.ap4m.build:443

 app stdout/stderr → FIFO → socat → vsock 3:9000 ═══▶ ifi-logs (socat → journald)
 deploy.sh boot config → vsock 16:7000 ═══▶ socat → 127.0.0.1:7000 → waitForBootConfig()
```

**Ingress (INF-10).** `ifi-ingress` on the parent listens on TCP 443 and copies bytes to vsock `ENCLAVE_CID:8443`. Inside, `enclave-init` copies vsock 8443 to the app on `127.0.0.1:8443`.

**Egress (INF-11).** `config/egress.<role>.conf` lists `<vsock_port> <host> <remote_port>`. From that one file:

- inside the enclave, `enclave-init` maps each host to a loopback IP in `/etc/hosts` and runs a small socat forwarder from `<ip>:<remote_port>` to vsock `3:<vsock_port>`. That is the "tiny forwarder": the app just calls `https://hackathon.ap4m.build/...` as normal.
- on the parent, `deploy.sh` writes `/etc/nitro_enclaves/vsock-proxy.yaml` and starts one `vsock-proxy` per line (`ifi-egress@<port>`).

The enclave has no DNS server, so a host not on the list does not even resolve. And `vsock-proxy` refuses any destination missing from its yaml. Example yaml: `config/vsock-proxy.example.yaml`.

Issuer allowlist: `hackathon.ap4m.build`, the XRPL EVM testnet RPC host, `s1.ripple.com`, `s2.ripple.com`, `xrplcluster.com`, the Quicknode host.

- **XRPL EVM testnet RPC:** a placeholder. Confirm the host on the AP4M portal "Network config" page. It is likely `rpc.testnet.xrplevm.org`.
- **Quicknode:** a placeholder. Use the endpoint's host only, e.g. `your-name.xrp-testnet.quiknode.pro`. The token in the URL path goes in the boot config, not here.

Relay allowlist: the issuer's public DNS name and the merchant host. The relay is a CONNECT proxy, so it can reach only these. Add a line for every host the agent must tunnel to.

**TLS ends inside the enclave, in both directions.**

- Ingress: the parent's socat sees only ciphertext. The client pins the TLS key from the attestation, so the parent cannot swap in its own certificate.
- Egress: the app's TLS client checks the real server's certificate against the real hostname, with Node's built-in CA list. The parent's `vsock-proxy` sees only ciphertext and the destination host.

**Client IPs.** Through socat, the enclave sees every connection as coming from the parent. The apps never learn the agent's IP. The parent host OS still sees it, and sees network timing (SPEC §13).

Done-when for INF-11: call `checkEgress()` from `enclave-common` at boot. It fetches `https://hackathon.ap4m.build/health` (must work) and `https://example.com/` (must fail), and logs both. Read it with `journalctl -u ifi-logs`.

## INF-12, INF-13, INF-14: Attestation, production mode, TLS

**INF-12.** `enclave-common` serves `GET /attestation?nonce=<hex>`. The nonce must be 16 to 64 bytes. The endpoint is rate-limited (5 per second, bursts of 20). Each call asks NSM for a fresh document with:

| NSM field | Value |
|---|---|
| `nonce` | the client's nonce |
| `public_key` | the TLS public key (SPKI DER) |
| `user_data` | SHA-256 over **all** public keys (`wraps-keys-sha256-v1`, see [pcrs.json for the SDK team](#pcrsjson-for-the-sdk-team)) |

**INF-13.** `deploy.sh` never passes `--debug-mode`. After `run-enclave` it reads `Flags` from `nitro-cli describe-enclaves` and terminates the enclave if it is not `NONE`. Debug mode gives all-zero PCRs and lets the operator read the console. The SDK rejects all-zero PCRs. Done when `status.sh` shows PCR0 "match" against `pcrs.json`.

**INF-14.** At boot, `enclave-common` makes a P-256 key and a self-signed certificate for `<role>.enclave`, in memory. No CA signs it. The SDK trusts the key because the same key is in the attestation document.

### Calling NSM from Node: the choice

**Chosen: a small Rust binary, `nsm-attest`, called with `execFile`.** It uses AWS's own crate, [`aws-nitro-enclaves-nsm-api`](https://github.com/aws/aws-nitro-enclaves-nsm-api), and is under 100 lines (`enclave-common/nsm-helper/src/main.rs`). The Dockerfile builds it in a Rust stage and copies it to `/usr/local/bin/nsm-attest`. `NsmHelperProvider` in `enclave-common/src/nsm.ts` passes nonce, user_data and public_key as hex arguments and reads the document as hex.

Why:

- The NSM code path is AWS's maintained crate, not ours.
- No Node ABI coupling. A native addon must match the Node version and needs a napi toolchain in the build.
- No npm package for NSM has wide use and active maintenance that we could rely on.
- The binary works from any language. If the relay moves to Go, it can call the same binary (or use `github.com/hf/nsm`).

Trade-offs:

- One process spawn per attestation, a few milliseconds. The rate limit keeps this cheap.
- A Rust stage in the build. A cold build takes a few minutes longer. `--check` pays it twice.
- `Cargo.lock` must exist before the first build (`prepare-build.sh` makes it).

Not used: `nitro-enclaves-sdk-c` and `kmstool`. They target KMS, which we do not use during the hackathon (INF-25 is after).

### Using enclave-common

```ts
import {
  createEnclaveIdentity, startEnclaveServer, waitForBootConfig,
  generateSigningKeyPair, checkEgress, log,
} from '@wraps/enclave-common';

// 1. Keys, in memory. Blind RSA key from @wraps/tokens; claim key from here.
const tokenKey = await issuerKeygen();                 // your code; needs its SPKI
const claimKey = generateSigningKeyPair('ed25519');

// 2. Identity: adds the TLS key, computes user_data, picks NSM (or mock in Docker mode).
const identity = await createEnclaveIdentity({
  role: 'issuer',
  publicKeys: { tokenSigning: tokenKey.spkiDer, claimSigning: claimKey.publicKey },
});

// 3. HTTPS server with /attestation and /healthz built in; your routes in `handler`.
const server = startEnclaveServer({ identity, handler: app });   // relay: server.on('connect', ...)

// 4. Runtime config pushed by deploy.sh (RPC URLs, payout key). Not attested.
const config = await waitForBootConfig<{ quicknodeUrl: string }>();
await checkEgress();
```

Keys are fixed once `createEnclaveIdentity` returns. Generate every key the SDK must see before you call it.

In the Docker fallback, `createEnclaveIdentity` uses an unsigned mock that a real verifier rejects. For a mock the SDK's mock verifier accepts, pass `provider: new MockNitroProvider(...)` from `@wraps/attestation`. Its interface is the same.

## INF-15 to INF-19: Wallets, Mastercard, RPC (manual)

These are not scripts. Do them in parallel with the hosts.

- **INF-15** Three different wallets: agent, funding, issuer payout. Keep keys in AWS SSM Parameter Store (`aws ssm put-parameter --type SecureString --name /ifi/<name> --value ...`) or a local `.env` that is never committed. The issuer payout key reaches the enclave only through `/etc/ifi/issuer.boot.json` (mode 0600).
- **INF-16** XRP for gas on XRPL EVM testnet (faucet), for the agent wallet and the issuer payout address.
- **INF-17** Mastercard form, booth activation, testnet RLUSD. AP4M portal "My setup": add the agent wallet and the issuer payout address, fund the budget. From "Network config", record:
  - PaymentLedger contract address: `<FILL IN FROM PORTAL>`
  - XRPL EVM testnet RPC host: `<FILL IN>` (also goes in `config/egress.issuer.conf`)
  - Chain ID: `<FILL IN>`
- **INF-18** AP4M starter files into `vendor/ap4m/`. Booth questions in SPEC §19.
- **INF-19** Quicknode endpoints in `.env`. The host goes in `config/egress.issuer.conf`. The full URL with token goes in the boot config.

## INF-20: Deploy, stop, status

```bash
sudo install -m 0600 issuer.boot.json /etc/ifi/issuer.boot.json   # optional, see config/boot.example.json
infra/scripts/deploy.sh issuer
infra/scripts/status.sh
```

`deploy.sh <role>`:

1. Refuses if an enclave already runs (INF-23). `--force` overrides.
2. Writes `/etc/ifi/ifi.env` and `/etc/nitro_enclaves/vsock-proxy.yaml`.
3. Starts `ifi-logs`, then one `ifi-egress@<port>` per egress line.
4. `nitro-cli run-enclave --cpu-count 2 --memory 3072 --enclave-cid 16 --enclave-name ifi-<role>`, without `--debug-mode`. Checks `Flags == NONE`.
5. Starts `ifi-ingress`.
6. Pushes `/etc/ifi/<role>.boot.json` over vsock, if present. The app answers `ok`. The first push wins.
7. Waits for `GET /healthz` and compares the live PCR0 with `pcrs.json`.

From the laptop:

```bash
curl -sk "https://<ISSUER_IP>/attestation?nonce=$(openssl rand -hex 32)" | jq '{provider, publicKeys: (.publicKeys|keys)}'
```

`stop.sh` asks, then terminates the enclave and stops all ifi services and any fallback container. `stop.sh --yes` skips the question.

## INF-21: Logs

Production enclaves have no console. `enclave-init` sends the app's stdout and stderr through a FIFO to vsock port 9000. `ifi-logs` on the parent writes them to journald:

```bash
journalctl -u ifi-logs -f
```

If `ifi-logs` is down, the enclave buffers 64 KiB, then app writes block until it is back. `ifi-logs` restarts on failure. Do not stop it while the enclave runs.

**Never log tokens, keys, IPs and merchant IDs together.** Together they link a buyer to a purchase, which is exactly what the system hides. Logs leave the enclave, so the parent operator reads them. The `log()` helper in `enclave-common` drops fields named `token`, `key`, `ip`, `authorization`, `nonce` and similar. It cannot see values you put inside the message string. Log counts and outcomes, not identifiers.

## INF-22: Demo machine firewall

On the machine that runs the agent, allow outbound traffic only to the relay:

```bash
sudo infra/scripts/demo-firewall.sh apply <RELAY_IP>                 # macOS (pf) or Linux (iptables)
sudo infra/scripts/demo-firewall.sh apply <RELAY_IP> --allow <LLM_API_CIDR>   # if the model API must stay reachable
sudo infra/scripts/demo-firewall.sh status
sudo infra/scripts/demo-firewall.sh undo
```

- Loopback stays open for the local demo UI.
- DNS is blocked. Give the relay as an IP. The agent sends merchant names inside CONNECT, so it needs no local DNS.
- `apply` runs a self-test: `https://1.1.1.1` must fail and the relay must answer.
- macOS: rules go into the pf anchor `com.apple/250.ifi-demo`. `undo` flushes it and releases the pf enable token.
- Linux: a chain `IFI_DEMO_OUT` at the top of `OUTPUT` (IPv4) and an IPv6 chain that allows only loopback. Containers use `FORWARD`, so run the agent on the host.
- If the agent's model runs in AgentCore or another cloud API, that traffic needs `--allow`. It does not carry payment data, but say so if asked.

## INF-23: Demo day

- Start both enclaves early. **Do not restart them.** Keys and the spent list live only in enclave memory. A restart makes new keys, so the SDK must re-attest and old tokens become invalid.
- `deploy.sh` and `fallback-docker.sh` refuse to replace a running enclave without `--force`.
- Use `status.sh` to check, never `deploy.sh`.
- Keep `ifi-logs` running.

## INF-24: Fallback without Nitro

If Nitro breaks, run the same image as a plain container on the same host. One command per host:

```bash
infra/scripts/fallback-docker.sh issuer       # on the issuer host
infra/scripts/fallback-docker.sh relay        # on the relay host
infra/scripts/fallback-docker.sh issuer --stop   # back to Nitro: then deploy.sh issuer
```

It stops `ifi-ingress`, then runs `docker run --init -e ENCLAVE_MODE=docker -p 443:8443` with the boot config mounted. In this mode:

- `/attestation` returns `provider: "mock"` with all-zero PCRs. The SDK must run in mock mode. **Say so on stage** (SPEC §18).
- The egress allowlist is not enforced.
- The host can read the container's memory.

---

## pcrs.json for the SDK team

`infra/pcrs.json` is written by `build-eif.sh`. Schema: `pcrs.schema.json`. Example: `pcrs.example.json`.

```json
{
  "schemaVersion": 1,
  "hashAlgorithm": "SHA384",
  "enclaves": {
    "issuer": { "pcr0": "<96 hex>", "pcr1": "<96 hex>", "pcr2": "<96 hex>",
                "imageId": "sha256:…", "gitCommit": "…", "nitroCliVersion": "1.4.2",
                "builtAt": "2026-10-24T18:00:00Z", "reproducibilityChecked": true },
    "relay":  { "…": "same fields" }
  }
}
```

| Field | Meaning | SDK rule |
|---|---|---|
| `pcr0` | Hash of the whole enclave image | **Must** equal PCR0 in the document |
| `pcr1` | Kernel and boot ramdisk | May check. Changes with the nitro-cli version |
| `pcr2` | Application ramdisk | May check |
| others | Build metadata | Display only |

If `pcrs.json` or the role's entry is missing, the SDK must refuse. It must never fall back to "accept any".

### GET /attestation response

```json
{
  "provider": "nitro",
  "document": "<base64 COSE_Sign1 from NSM>",
  "nonce": "<hex, echo>",
  "publicKeys": { "tls": "<base64 SPKI DER>", "tokenSigning": "<base64 SPKI DER>", "claimSigning": "…" },
  "userDataAlg": "wraps-keys-sha256-v1",
  "userData": "<hex, for debugging only>",
  "publicKeyField": "tls"
}
```

### Checks the SDK must make (SPEC §4 step 1, §12)

1. Send a fresh random nonce, 32 bytes, hex. Never reuse one.
2. `provider` is `"nitro"`. Accept `"mock"` only in an explicit mock mode.
3. Decode `document` (base64) as COSE_Sign1. The certificate chain ends at the AWS Nitro root G1. Check the root's SHA-256 fingerprint by hand. The ES384 signature verifies.
4. PCR0, PCR1 and PCR2 are not all zero (debug mode). PCR0 equals `pcrs.json` `enclaves.<role>.pcr0`.
5. The document's `nonce` equals the nonce you sent. Its `timestamp` is recent (a few minutes).
6. The document's `user_data` equals `wraps-keys-sha256-v1(publicKeys)`:
   ```ts
   const canonical = JSON.stringify(Object.keys(publicKeys).sort().map((k) => [k, publicKeys[k]]));
   const userData = createHash('sha256').update(canonical).digest();
   ```
   This matches `keysHash()` in `packages/attestation/src/measure.ts` when the values are base64 SPKI DER.
7. The document's `public_key` equals `base64decode(publicKeys.tls)`.
8. Pin TLS to that key. The certificate is self-signed, so connect with `rejectUnauthorized: false` and check the key on `secureConnect`, **before sending anything**. Node does not call `checkServerIdentity` when the chain check fails, so do not rely on it:
   ```ts
   const pin = createHash('sha256').update(Buffer.from(att.publicKeys.tls, 'base64')).digest('hex');
   socket.once('secureConnect', () => {
     const spki = socket.getPeerX509Certificate()!.publicKey.export({ type: 'spki', format: 'der' });
     if (createHash('sha256').update(spki).digest('hex') !== pin) socket.destroy(new Error('TLS key not attested'));
   });
   ```

---

## Ports

| Where | Port | What |
|---|---|---|
| Parent, public | TCP 443 | `ifi-ingress` to enclave vsock 8443 |
| Enclave | vsock 8443 to TCP 127.0.0.1:8443 | App HTTPS server |
| Enclave | vsock 7000 to TCP 127.0.0.1:7000 | Boot config, one push |
| Parent | vsock 9000 | `ifi-logs` receiver |
| Parent | vsock 8001 and up | `ifi-egress@<port>`, one per allowlist line |
| Enclave CID | 16 | Set in `config/<role>.env` |

## Troubleshooting

| Symptom | Check |
|---|---|
| `host-setup.sh`: allocator fails | Memory too high for the instance. Lower `ENCLAVE_MEMORY_MIB`, run again |
| `run-enclave`: "insufficient memory" | EIF too big for 3072 MiB. Raise memory in `config/<role>.env`, run `host-setup.sh` again |
| `build-eif.sh --check` fails | Something non-deterministic in the image. Compare `docker history` of both builds. Common causes: an unpinned `FROM`, a missing lockfile, an install script writing timestamps |
| `/healthz` not responding | `journalctl -u ifi-logs -n 100`. Is the app listening on `ENCLAVE_LISTEN_HOST:APP_PORT`? Did it crash on a missing boot config? |
| App cannot reach a host | Is the host in `egress.<role>.conf`? Was the image rebuilt after the change? `systemctl status ifi-egress@<port>` |
| Boot config not accepted | The app must call `waitForBootConfig()`. `deploy.sh` retries for 120 s |
| Enclave exits right away | The app crashed. Start the same EIF once with `--debug-mode` and `nitro-cli console` to read the error. Never demo that run |

---

## Not verified (no AWS access when written)

Everything below was written without a Nitro host. Expect to fix small things on first run.

- None of the scripts has run on Amazon Linux 2023. All pass `bash -n`. `lib.sh` helpers (allowlist render, placeholder check) were run locally.
- `enclave-common` was type-checked and tested in Docker mode on macOS: `/attestation`, `/healthz`, the rate limit, the TLS key pin and the boot config listener all work. The NSM path was not run.
- `nsm-attest` has not been compiled (no Rust toolchain here). It targets `aws-nitro-enclaves-nsm-api` 0.4.0.
- Base image digests are placeholders until `prepare-build.sh` runs.
- `npm ci -w … --include-workspace-root` depends on the root lockfile and the npm version in the image. If it fails, drop the `-w` flags and use plain `npm ci`.
- PCR0 reproducibility (`--check`) depends on BuildKit `rewrite-timestamp` and on `nitro-cli` producing the same ramdisk for the same image.
- Exact `nitro-cli` output format (the JSON after `build-enclave`, `Flags` and `Measurements` in `describe-enclaves`). The scripts parse what current versions print.
- `aws-nitro-enclaves-cli` package names and the `vsock-proxy` path on AL2023.
- socat VSOCK support in the AL2023 and Debian bookworm packages (`host-setup.sh` checks the parent side).
- macOS pf anchor behaviour on the demo laptop's macOS version. Run `apply`, then `status`, then `undo` once before demo day.
- The XRPL EVM testnet RPC host, the Quicknode host and the merchant host are placeholders.
