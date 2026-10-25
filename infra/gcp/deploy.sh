#!/usr/bin/env bash
# Creates a Confidential Space VM that runs the role's image, pinned by digest.
#   infra/gcp/deploy.sh issuer [--replace] production image (confidential-space)
#   ATTESTATION_AUDIENCE=... ISSUER_URL=... RELAY_HOSTNAME=... infra/gcp/deploy.sh relay
#   Add --instance-name=wraps-relay-canary to launch a side-by-side candidate.
#   Add --canary to add a role-specific firewall tag for source-restricted ingress rules.
#   Add --dry-run to print the create command without changing GCP.
# Existing VMs are preserved unless --replace is explicitly supplied.
source "$(dirname "$0")/lib.sh"
ROLE="${1:-}"; check_role "${ROLE}"
MODE=prod; DRY_RUN=0; REPLACE=0; CANARY=0; CANARY_WG=0; INSTANCE_NAME=''
for option in "${@:2}"; do
  case "${option}" in
    --debug) die "the digest-scoped production WIF provider rejects debug workloads; use the local mock rehearsal instead" ;;
    --dry-run) DRY_RUN=1 ;;
    --replace) REPLACE=1 ;;
    --canary) CANARY=1 ;;
    --instance-name=*) INSTANCE_NAME="${option#*=}" ;;
    *) die "unknown option: ${option}" ;;
  esac
done

STATE_ENV="${STATE_DIR}/issuer-state.env"
MERCHANT_AUTH_ENV="${STATE_DIR}/merchant-auth.env"
[ -f "${STATE_ENV}" ] || die "issuer state configuration is missing; run infra/gcp/setup-issuer-state.sh prepare"
# shellcheck source=/dev/null
source "${STATE_ENV}"
if [ -f "${MERCHANT_AUTH_ENV}" ]; then
  # shellcheck source=/dev/null
  source "${MERCHANT_AUTH_ENV}"
fi

NAME="$(instance_name "${ROLE}" "${MODE}")"
if [ -n "${INSTANCE_NAME}" ]; then
  [[ "${INSTANCE_NAME}" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "invalid Compute Engine instance name"
  NAME="${INSTANCE_NAME}"
elif [ "${CANARY}" = 1 ]; then
  NAME="${NAME}-canary"
fi
if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ] && [ -n "${INSTANCE_NAME}" ] && [ "${CANARY}" = 0 ]; then
  die "custom WireGuard relay instance names require --canary so the global WireGuard rule is not changed"
fi
REF="$(expected_get "j.roles && j.roles['${ROLE}'] && j.roles['${ROLE}'].imageReference")" \
  || die "no image for ${ROLE} in expected.json. Run infra/gcp/build.sh ${ROLE} first."
[[ "${REF}" == *@sha256:* ]] || die "image reference must be pinned by digest: ${REF}"

# SEC-04 production images fetch the relay credential directly through WIF.
# The provider and issuer-state resources are baked into the digest; only the
# pinned Secret Manager version reference is deployment metadata.
AUTH_METADATA=''
[[ "${ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION:-}" =~ ^projects/[A-Za-z0-9][A-Za-z0-9.-]{0,62}/secrets/[A-Za-z0-9_-]{1,255}/versions/[1-9][0-9]*$ ]] \
  || die "ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION must be a pinned Secret Manager version"
AUTH_METADATA="tee-env-ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION=${ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION}"
EXPECTED_PROVIDER="$(expected_get "j.roles && j.roles['${ROLE}'] && j.roles['${ROLE}'].config && j.roles['${ROLE}'].config.gcpWifProvider")" \
  || die "${ROLE} image config is missing its baked WIF provider; rebuild it"
[ "${EXPECTED_PROVIDER}" = "${GCP_WIF_PROVIDER}" ] || die "issuer-state.env WIF provider does not match the ${ROLE} image digest"
if [ "${ROLE}" = issuer ]; then
  EXPECTED_BUCKET="$(expected_get 'j.roles && j.roles.issuer.config && j.roles.issuer.config.issuerStateGcsBucket')" \
    || die "issuer image config is missing its baked state bucket"
  EXPECTED_PREFIX="$(expected_get 'j.roles && j.roles.issuer.config && j.roles.issuer.config.issuerStateGcsPrefix')" \
    || die "issuer image config is missing its baked state prefix"
  EXPECTED_KEY="$(expected_get 'j.roles && j.roles.issuer.config && j.roles.issuer.config.issuerStateKmsKey')" \
    || die "issuer image config is missing its baked KMS key"
  [ "${EXPECTED_BUCKET}" = "${ISSUER_STATE_GCS_BUCKET}" ] && [ "${EXPECTED_PREFIX}" = "${ISSUER_STATE_GCS_PREFIX}" ] && [ "${EXPECTED_KEY}" = "${ISSUER_STATE_KMS_KEY}" ] \
    || die "issuer-state.env resources do not match the issuer image digest"
fi
if [ "${ROLE}" = issuer ]; then
  KEY_FINGERPRINT="$(expected_get "j.roles && j.roles.issuer && j.roles.issuer.merchantAuthKeyFingerprint")" \
    || die "issuer image does not record its merchant public-key fingerprint; rebuild with ISSUER_MERCHANT_AUTH_KEYS"
  [[ "${KEY_FINGERPRINT}" =~ ^[0-9a-f]{64}$ ]] || die "issuer image merchant public-key fingerprint is invalid"
fi

FAMILY=confidential-space
METADATA="^~^tee-image-reference=${REF}"
# The relay logs only fixed stages and allowlisted failure codes.
if [ "${ROLE}" = relay ]; then
  METADATA="${METADATA}~tee-container-log-redirect=true"
fi

if [ "${ROLE}" = relay ]; then
  [ -n "${ATTESTATION_AUDIENCE:-}" ] || die "ATTESTATION_AUDIENCE is required for relay"
  [ -n "${ISSUER_URL:-}" ] || die "ISSUER_URL is required for relay"
  [ -n "${RELAY_HOSTNAME:-}" ] || die "RELAY_HOSTNAME is required for relay"
  [[ "${ISSUER_URL}" == https://* ]] || die "ISSUER_URL must use HTTPS"

  WG_METADATA=''
  if [ "${WG_ENABLED:-false}" = true ]; then
    [ -n "${WG_ENDPOINT:-}" ] || die "WG_ENDPOINT is required when WG_ENABLED=true"
    [ -n "${WG_INTERFACE_ADDRESS:-}" ] || die "WG_INTERFACE_ADDRESS is required when WG_ENABLED=true"
    # Empty peer list = open, paid registration: any key that pays a token can join.
    WG_PEERS_JSON="${WG_PEERS_JSON:-[]}"
    case "${WG_ENDPOINT}" in
      *:*|*/*|*' '* ) die "WG_ENDPOINT must be a bare hostname or IPv4 address; the UDP port is configured separately" ;;
    esac
    WG_EGRESS_INTERFACE="${WG_EGRESS_INTERFACE:-eth0}"
    if [ "${CANARY}" = 1 ]; then
      [ -n "${WG_CANARY_SOURCE_RANGES:-}" ] \
        || die "WG_CANARY_SOURCE_RANGES is required for a WireGuard relay canary"
      WG_CANARY_SOURCE_RANGES="$(WG_CANARY_SOURCE_RANGES="${WG_CANARY_SOURCE_RANGES}" node <<'NODE'
const { isIP } = require('node:net');
const raw = process.env.WG_CANARY_SOURCE_RANGES;
const ranges = raw.split(',').map((value) => value.trim());
if (ranges.some((range) => !range)) throw new Error('empty source CIDR');
for (const range of ranges) {
  const slash = range.lastIndexOf('/');
  const address = range.slice(0, slash);
  const prefixText = range.slice(slash + 1);
  const version = isIP(address);
  const prefix = Number(prefixText);
  if (slash < 1 || !version || !/^[0-9]+$/.test(prefixText) ||
      prefix < 1 || prefix > (version === 4 ? 32 : 128)) {
    throw new Error('each WG_CANARY_SOURCE_RANGES entry must be a non-default IPv4 or IPv6 CIDR');
  }
}
process.stdout.write([...new Set(ranges)].sort().join(','));
NODE
      )" || die "WG_CANARY_SOURCE_RANGES must contain valid non-default CIDRs"
      CANARY_WG=1
    fi
    for value in "${WG_ENABLED}" "${WG_ENDPOINT}" "${WG_INTERFACE_ADDRESS}" "${WG_EGRESS_INTERFACE}" "${WG_PEERS_JSON}"; do
      [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "WireGuard metadata values cannot contain newlines"
    done
    WG_METADATA="tee-added-capabilities=[\"CAP_NET_ADMIN\",\"CAP_SYS_ADMIN\"]~tee-env-WG_ENABLED=true~tee-env-WG_ENDPOINT=${WG_ENDPOINT}~tee-env-WG_INTERFACE_ADDRESS=${WG_INTERFACE_ADDRESS}~tee-env-WG_EGRESS_INTERFACE=${WG_EGRESS_INTERFACE}~tee-env-WG_PEERS_JSON=${WG_PEERS_JSON}"
  fi

  for value in "${ATTESTATION_AUDIENCE}" "${ISSUER_URL}" "${RELAY_HOSTNAME}"; do
    [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "relay metadata values cannot contain newlines"
  done

  # Gcloud supports a custom one-character metadata separator. Pick one absent
  # from all values, then quote the complete metadata argument at invocation.
  separator='~;@%+:!#?,|/'
  META_SEPARATOR=''
  for ((i = 0; i < ${#separator}; i++)); do
    candidate="${separator:i:1}"
    if [[ "${REF}${ATTESTATION_AUDIENCE}${ISSUER_URL}${RELAY_HOSTNAME}${WG_METADATA}${AUTH_METADATA}" != *"${candidate}"* ]]; then
      META_SEPARATOR="${candidate}"
      break
    fi
  done
  [ -n "${META_SEPARATOR}" ] || die "could not choose a safe metadata separator"
  METADATA="^${META_SEPARATOR}^tee-image-reference=${REF}${META_SEPARATOR}tee-env-ATTESTATION_AUDIENCE=${ATTESTATION_AUDIENCE}${META_SEPARATOR}tee-env-ISSUER_URL=${ISSUER_URL}${META_SEPARATOR}tee-env-RELAY_HOSTNAME=${RELAY_HOSTNAME}"
  METADATA="${METADATA}${META_SEPARATOR}tee-container-log-redirect=true"
  if [ -n "${WG_METADATA}" ]; then
    WG_METADATA="${WG_METADATA//\~/${META_SEPARATOR}}"
    METADATA="${METADATA}${META_SEPARATOR}${WG_METADATA}"
  fi
  if [ -n "${AUTH_METADATA}" ]; then
    AUTH_METADATA="${AUTH_METADATA//\~/${META_SEPARATOR}}"
    METADATA="${METADATA}${META_SEPARATOR}${AUTH_METADATA}"
  fi
else
  METADATA="${METADATA}~${AUTH_METADATA}"
fi

VM_TAGS=wraps
[ "${ROLE}" = relay ] && VM_TAGS=wraps,wraps-relay
[ "${CANARY}" = 1 ] && VM_TAGS="${VM_TAGS},${ROLE}-canary"
CREATE_ARGS=(
  compute instances create "${NAME}"
  "--zone=${GCP_ZONE}"
  "--machine-type=${MACHINE_TYPE}"
  --confidential-compute-type=SEV
  --maintenance-policy=MIGRATE
  --shielded-secure-boot
  --image-project=confidential-space-images
  "--image-family=${FAMILY}"
  "--metadata=${METADATA}"
  "--service-account=${WORKLOAD_SA}"
  --scopes=cloud-platform
  "--tags=${VM_TAGS}"
  "--labels=project=wraps,role=${ROLE},mode=${MODE}"
  "--max-run-duration=${MAX_RUN_DURATION}"
  --instance-termination-action=STOP
)
if [ "${ROLE}" = relay ] && [ -n "${RELAY_ADDRESS:-}" ]; then
  [[ "${RELAY_ADDRESS}" != *$'\n'* && "${RELAY_ADDRESS}" != *$'\r'* ]] || die "RELAY_ADDRESS cannot contain newlines"
  CREATE_ARGS+=("--address=${RELAY_ADDRESS}")
fi
if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ]; then
  CREATE_ARGS+=(--can-ip-forward)
fi

EXISTING=0
if gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null 2>&1; then
  EXISTING=1
  [ "${REPLACE}" = 1 ] || die "${NAME} already exists; preserve it or pass --replace to delete it explicitly"
fi

if [ "${DRY_RUN}" = 1 ]; then
  if [ "${EXISTING}" = 1 ]; then
    printf 'DRY RUN (replace):'
    printf ' %q' gcloud --project="${GCP_PROJECT}" compute instances delete "${NAME}" --zone "${GCP_ZONE}" --quiet
    printf '\n'
  fi
  printf 'DRY RUN:'
  printf ' %q' gcloud --project="${GCP_PROJECT}" "${CREATE_ARGS[@]}"
  printf '\n'
  if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ]; then
    if [ "${CANARY_WG}" = 1 ]; then
      printf 'DRY RUN (canary WireGuard allow):'
      printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules create wraps-allow-wireguard-canary \
        --direction=INGRESS --priority=300 --network=default --allow=udp:51820 \
        "--source-ranges=${WG_CANARY_SOURCE_RANGES}" --target-tags=relay-canary
      printf '\nDRY RUN (canary ingress deny):'
      printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules create wraps-relay-canary-deny \
        --direction=INGRESS --priority=500 --network=default --action=DENY --rules=all \
        --source-ranges=0.0.0.0/0,::/0 --target-tags=relay-canary
      printf '\n'
    else
      printf 'DRY RUN (if firewall rule exists):'
      printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules update wraps-allow-wireguard \
        --allow=udp:51820 --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
      printf '\nDRY RUN (otherwise):'
      printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules create wraps-allow-wireguard \
        --direction=INGRESS --priority=1000 --network=default --allow=udp:51820 \
        --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
      printf '\n'
    fi
  fi
  exit 0
fi

if [ "${CANARY_WG}" = 1 ]; then
  WG_CANARY_ALLOW_RULE=wraps-allow-wireguard-canary
  WG_CANARY_DENY_RULE=wraps-relay-canary-deny
  if ! gc compute firewall-rules describe "${WG_CANARY_ALLOW_RULE}" >/dev/null 2>&1; then
    gc compute firewall-rules create "${WG_CANARY_ALLOW_RULE}" --direction=INGRESS --priority=300 \
      --network=default --allow=udp:51820 --source-ranges="${WG_CANARY_SOURCE_RANGES}" --target-tags=relay-canary
  fi
  WG_CANARY_ALLOW_JSON="$(gc compute firewall-rules describe "${WG_CANARY_ALLOW_RULE}" --format=json)"
  WG_CANARY_SOURCE_RANGES="${WG_CANARY_SOURCE_RANGES}" node - "${WG_CANARY_ALLOW_JSON}" <<'NODE' \
    || die "${WG_CANARY_ALLOW_RULE} must allow only UDP 51820 from WG_CANARY_SOURCE_RANGES to relay-canary at priority 300"
const rule = JSON.parse(process.argv[2]);
const expectedRanges = process.env.WG_CANARY_SOURCE_RANGES.split(',').sort();
const allowed = rule.allowed ?? [];
const actualRanges = [...(rule.sourceRanges ?? [])].sort();
const network = String(rule.network ?? '');
if (rule.direction !== 'INGRESS' || rule.disabled || rule.priority !== 300 ||
    JSON.stringify(actualRanges) !== JSON.stringify(expectedRanges) ||
    JSON.stringify([...(rule.targetTags ?? [])].sort()) !== JSON.stringify(['relay-canary']) ||
    !(network === 'default' || network.endsWith('/networks/default')) ||
    allowed.length !== 1 || allowed[0].IPProtocol !== 'udp' ||
    JSON.stringify(allowed[0].ports ?? []) !== JSON.stringify(['51820']) || (rule.denied ?? []).length) process.exit(1);
NODE
  if ! gc compute firewall-rules describe "${WG_CANARY_DENY_RULE}" >/dev/null 2>&1; then
    gc compute firewall-rules create "${WG_CANARY_DENY_RULE}" --direction=INGRESS --priority=500 \
      --network=default --action=DENY --rules=all --source-ranges=0.0.0.0/0,::/0 --target-tags=relay-canary
  fi
  WG_CANARY_DENY_JSON="$(gc compute firewall-rules describe "${WG_CANARY_DENY_RULE}" --format=json)"
  node - "${WG_CANARY_DENY_JSON}" <<'NODE' \
    || die "${WG_CANARY_DENY_RULE} must deny all IPv4 and IPv6 ingress to relay-canary at priority 500"
const rule = JSON.parse(process.argv[2]);
const denied = rule.denied ?? [];
const network = String(rule.network ?? '');
if (rule.direction !== 'INGRESS' || rule.disabled || rule.priority !== 500 ||
    JSON.stringify([...(rule.sourceRanges ?? [])].sort()) !== JSON.stringify(['0.0.0.0/0', '::/0']) ||
    JSON.stringify([...(rule.targetTags ?? [])].sort()) !== JSON.stringify(['relay-canary']) ||
    !(network === 'default' || network.endsWith('/networks/default')) ||
    denied.length !== 1 || denied[0].IPProtocol !== 'all' || (rule.allowed ?? []).length) process.exit(1);
NODE
fi

if [ "${EXISTING}" = 1 ]; then
  echo "Deleting existing ${NAME} as requested..."
  gc compute instances delete "${NAME}" --zone "${GCP_ZONE}" --quiet
fi

echo "Creating ${NAME} (${FAMILY}, ${MACHINE_TYPE}, AMD SEV, stops after ${MAX_RUN_DURATION})..."
# gcloud sometimes times out reading the reply even though the VM was created, so on
# failure check whether the instance exists before giving up.
gc "${CREATE_ARGS[@]}" \
|| gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null \
|| die "could not create ${NAME}"

if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ] && [ "${CANARY_WG}" = 0 ]; then
  RULE=wraps-allow-wireguard
  if gc compute firewall-rules describe "${RULE}" >/dev/null 2>&1; then
    gc compute firewall-rules update "${RULE}" --allow=udp:51820 --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
  else
    gc compute firewall-rules create "${RULE}" --direction=INGRESS --priority=1000 --network=default \
      --allow=udp:51820 --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
  fi
fi

IP="$(gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
mkdir -p "${STATE_DIR}"
echo "${IP}" > "${STATE_DIR}/${NAME}.ip"
if [ "${NAME}" = "$(instance_name "${ROLE}" "${MODE}")" ]; then
  echo "${IP}" > "${STATE_DIR}/${ROLE}.ip"
fi

echo
echo "VM:   ${NAME}  (${IP})"
if [ "${ROLE}" = relay ]; then
  echo "Proxy:       https://${RELAY_HOSTNAME}"
  echo "Attestation: http://${IP}:8080/attestation"
  echo "The image takes about a minute to boot and pull. Configure the SDK proxy URL as https://${RELAY_HOSTNAME}."
else
  echo "URL:  https://${IP}   (self-signed; the SDK pins the attested key)"
  echo "The image takes about a minute to boot and pull. Then:"
  echo "  curl -sk https://${IP}/health"
  echo "  infra/gcp/status.sh ${ROLE}"
fi
