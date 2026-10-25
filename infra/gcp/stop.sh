#!/usr/bin/env bash
# Stops VMs (keeps the disk, stops CPU billing). Keys and the spent list are in memory,
# so a stopped issuer comes back with new keys.
#   infra/gcp/stop.sh            every VM labelled project=wraps
#   infra/gcp/stop.sh issuer     wraps-issuer
#   infra/gcp/stop.sh issuer --debug
source "$(dirname "$0")/lib.sh"
if [ -n "${1:-}" ]; then
  check_role "$1"
  MODE=prod; [ "${2:-}" = "--debug" ] && MODE=debug
  NAMES="$(instance_name "$1" "${MODE}")"
else
  NAMES="$(gc compute instances list --filter='labels.project=wraps AND status=RUNNING' --format='value(name)')"
fi
[ -n "${NAMES}" ] || { echo "No running wraps VMs."; exit 0; }
for n in ${NAMES}; do
  echo "Stopping ${n}..."
  gc compute instances stop "${n}" --zone "${GCP_ZONE}" --quiet
done
gc compute instances list --filter='labels.project=wraps' --format='table(name,status,labels.mode)'
