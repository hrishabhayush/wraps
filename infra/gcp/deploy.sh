#!/usr/bin/env bash
# Creates a Confidential Space VM that runs the role's image, pinned by digest.
#   infra/gcp/deploy.sh issuer            production image (confidential-space)
#   infra/gcp/deploy.sh issuer --debug    debug image (confidential-space-debug): SSH and logs on,
#                                         and the token says dbgstat=enabled, so the SDK refuses it
# An existing VM with the same name is deleted first (its in-memory keys die with it).
source "$(dirname "$0")/lib.sh"
ROLE="${1:-}"; check_role "${ROLE}"
MODE=prod; [ "${2:-}" = "--debug" ] && MODE=debug

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

if gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null 2>&1; then
  echo "Deleting existing ${NAME}..."
  gc compute instances delete "${NAME}" --zone "${GCP_ZONE}" --quiet
fi

echo "Creating ${NAME} (${FAMILY}, ${MACHINE_TYPE}, AMD SEV, stops after ${MAX_RUN_DURATION})..."
gc compute instances create "${NAME}" \
  --zone="${GCP_ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --confidential-compute-type=SEV \
  --maintenance-policy=MIGRATE \
  --shielded-secure-boot \
  --image-project=confidential-space-images \
  --image-family="${FAMILY}" \
  --metadata="${METADATA}" \
  --service-account="${WORKLOAD_SA}" \
  --scopes=cloud-platform \
  --tags=wraps \
  --labels="project=wraps,role=${ROLE},mode=${MODE}" \
  --max-run-duration="${MAX_RUN_DURATION}" \
  --instance-termination-action=STOP

IP="$(gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
mkdir -p "${STATE_DIR}"
echo "${IP}" > "${STATE_DIR}/${NAME}.ip"
[ "${MODE}" = prod ] && echo "${IP}" > "${STATE_DIR}/${ROLE}.ip"

echo
echo "VM:   ${NAME}  (${IP})"
echo "URL:  https://${IP}   (self-signed; the SDK pins the attested key)"
echo "The image takes about a minute to boot and pull. Then:"
echo "  curl -sk https://${IP}/health"
echo "  infra/gcp/status.sh ${ROLE}$( [ "${MODE}" = debug ] && echo ' --debug --logs')"
