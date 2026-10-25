#!/usr/bin/env bash
# Creates a Confidential Space VM that runs the role's image, pinned by digest.
#   infra/gcp/deploy.sh issuer            production image (confidential-space)
#   infra/gcp/deploy.sh issuer --debug    debug image (confidential-space-debug): SSH and logs on,
#                                         and the token says dbgstat=enabled, so the SDK refuses it
#   ATTESTATION_AUDIENCE=... ISSUER_URL=... RELAY_HOSTNAME=... infra/gcp/deploy.sh relay
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
  # The image's launch policy allows log redirect on the debug image only.
  METADATA="^~^tee-image-reference=${REF}~tee-container-log-redirect=true"
else
  FAMILY=confidential-space
  METADATA="^~^tee-image-reference=${REF}"
fi

if [ "${ROLE}" = relay ]; then
  [ -n "${ATTESTATION_AUDIENCE:-}" ] || die "ATTESTATION_AUDIENCE is required for relay"
  [ -n "${ISSUER_URL:-}" ] || die "ISSUER_URL is required for relay"
  [ -n "${RELAY_HOSTNAME:-}" ] || die "RELAY_HOSTNAME is required for relay"
  [[ "${ISSUER_URL}" == https://* ]] || die "ISSUER_URL must use HTTPS"

  for value in "${ATTESTATION_AUDIENCE}" "${ISSUER_URL}" "${RELAY_HOSTNAME}"; do
    [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "relay metadata values cannot contain newlines"
  done

  # Gcloud supports a custom one-character metadata separator. Pick one absent
  # from all values, then quote the complete metadata argument at invocation.
  separator='~;@%+:!#?,|/'
  META_SEPARATOR=''
  for ((i = 0; i < ${#separator}; i++)); do
    candidate="${separator:i:1}"
    if [[ "${REF}${ATTESTATION_AUDIENCE}${ISSUER_URL}${RELAY_HOSTNAME}" != *"${candidate}"* ]]; then
      META_SEPARATOR="${candidate}"
      break
    fi
  done
  [ -n "${META_SEPARATOR}" ] || die "could not choose a safe metadata separator"
  METADATA="^${META_SEPARATOR}^tee-image-reference=${REF}${META_SEPARATOR}tee-env-ATTESTATION_AUDIENCE=${ATTESTATION_AUDIENCE}${META_SEPARATOR}tee-env-ISSUER_URL=${ISSUER_URL}${META_SEPARATOR}tee-env-RELAY_HOSTNAME=${RELAY_HOSTNAME}"
fi

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
  --tags=wraps
  "--labels=project=wraps,role=${ROLE},mode=${MODE}"
  "--max-run-duration=${MAX_RUN_DURATION}"
  --instance-termination-action=STOP
)

if [ "${DRY_RUN}" = 1 ]; then
  printf 'DRY RUN:'
  printf ' %q' gcloud --project="${GCP_PROJECT}" "${CREATE_ARGS[@]}"
  printf '\n'
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

IP="$(gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
mkdir -p "${STATE_DIR}"
echo "${IP}" > "${STATE_DIR}/${NAME}.ip"
[ "${MODE}" = prod ] && echo "${IP}" > "${STATE_DIR}/${ROLE}.ip"

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
