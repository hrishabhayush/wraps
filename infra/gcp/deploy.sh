#!/usr/bin/env bash
# Creates a Confidential Space VM that runs the role's image, pinned by digest.
#   infra/gcp/deploy.sh issuer            production image (confidential-space)
#   infra/gcp/deploy.sh issuer --debug    debug image (confidential-space-debug): SSH and logs on,
#                                         and the token says dbgstat=enabled, so the SDK refuses it
#   ATTESTATION_AUDIENCE=... ISSUER_URL=... RELAY_HOSTNAME=... infra/gcp/deploy.sh relay
# Another relay region: INSTANCE_NAME=wraps-relay-nl GCP_REGION=europe-west4 GCP_ZONE=europe-west4-a RELAY_ADDRESS=... ...
#   Add --dry-run after the role options to print the create command without changing GCP.
# An existing VM with the same name is deleted first (its in-memory keys die with it).
source "$(dirname "$0")/lib.sh"
ROLE="${1:-}"; check_role "${ROLE}"
MODE=prod; DRY_RUN=0
for option in "${@:2}"; do
  case "${option}" in
    --debug) MODE=debug ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown option: ${option}" ;;
  esac
done
[ "${ROLE}" = relay ] && [ "${MODE}" = debug ] && die "--debug is only supported for issuer"

NAME="$(instance_name "${ROLE}" "${MODE}")"
REF="$(expected_get "j.roles && j.roles['${ROLE}'] && j.roles['${ROLE}'].imageReference")" \
  || die "no image for ${ROLE} in expected.json. Run infra/gcp/build.sh ${ROLE} first."
[[ "${REF}" == *@sha256:* ]] || die "image reference must be pinned by digest: ${REF}"

if [ "${MODE}" = debug ]; then
  FAMILY=confidential-space-debug
  # Debug boots always redirect output; the relay image allows sanitized logs.
  METADATA="^~^tee-image-reference=${REF}~tee-container-log-redirect=true"
else
  FAMILY=confidential-space
  METADATA="^~^tee-image-reference=${REF}"
  # The relay logs only fixed stages and allowlisted failure codes.
  if [ "${ROLE}" = relay ]; then
    METADATA="${METADATA}~tee-container-log-redirect=true"
  fi
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
    if [[ "${REF}${ATTESTATION_AUDIENCE}${ISSUER_URL}${RELAY_HOSTNAME}${WG_METADATA}" != *"${candidate}"* ]]; then
      META_SEPARATOR="${candidate}"
      break
    fi
  done
  [ -n "${META_SEPARATOR}" ] || die "could not choose a safe metadata separator"
  METADATA="^${META_SEPARATOR}^tee-image-reference=${REF}${META_SEPARATOR}tee-env-ATTESTATION_AUDIENCE=${ATTESTATION_AUDIENCE}${META_SEPARATOR}tee-env-ISSUER_URL=${ISSUER_URL}${META_SEPARATOR}tee-env-RELAY_HOSTNAME=${RELAY_HOSTNAME}"
  if [ "${MODE}" = prod ]; then
    METADATA="${METADATA}${META_SEPARATOR}tee-container-log-redirect=true"
  fi
  if [ -n "${WG_METADATA}" ]; then
    WG_METADATA="${WG_METADATA//\~/${META_SEPARATOR}}"
    METADATA="${METADATA}${META_SEPARATOR}${WG_METADATA}"
  fi
fi

VM_TAGS=wraps
[ "${ROLE}" = relay ] && VM_TAGS=wraps,wraps-relay
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

if [ "${DRY_RUN}" = 1 ]; then
  printf 'DRY RUN:'
  printf ' %q' gcloud --project="${GCP_PROJECT}" "${CREATE_ARGS[@]}"
  printf '\n'
  if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ]; then
    printf 'DRY RUN (if firewall rule exists):'
    printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules update wraps-allow-wireguard \
      --allow=udp:51820 --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
    printf '\nDRY RUN (otherwise):'
    printf ' %q' gcloud --project="${GCP_PROJECT}" compute firewall-rules create wraps-allow-wireguard \
      --direction=INGRESS --priority=1000 --network=default --allow=udp:51820 \
      --source-ranges=0.0.0.0/0 --target-tags=wraps-relay
    printf '\n'
  fi
  exit 0
fi

if gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null 2>&1; then
  echo "Deleting existing ${NAME}..."
  gc compute instances delete "${NAME}" --zone "${GCP_ZONE}" --quiet
fi

echo "Creating ${NAME} (${FAMILY}, ${MACHINE_TYPE}, AMD SEV, stops after ${MAX_RUN_DURATION})..."
# gcloud sometimes times out reading the reply even though the VM was created, so on
# failure check whether the instance exists before giving up.
gc "${CREATE_ARGS[@]}" \
|| gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null \
|| die "could not create ${NAME}"

if [ "${ROLE}" = relay ] && [ "${WG_ENABLED:-false}" = true ]; then
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
[ "${MODE}" = prod ] && [ -z "${INSTANCE_NAME:-}" ] && echo "${IP}" > "${STATE_DIR}/${ROLE}.ip"

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
  echo "  infra/gcp/status.sh ${ROLE}$( [ "${MODE}" = debug ] && echo ' --debug --logs')"
fi
