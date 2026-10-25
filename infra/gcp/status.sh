#!/usr/bin/env bash
# Shows wraps VMs and checks the workload answers.
#   infra/gcp/status.sh                    all VMs
#   infra/gcp/status.sh issuer [--debug] [--logs]
#     --logs   last lines of the serial console (the launcher logs there; the workload's
#              own output only on the debug image)
source "$(dirname "$0")/lib.sh"
gc compute instances list --filter='labels.project=wraps' \
  --format='table(name,status,labels.mode,networkInterfaces[0].accessConfigs[0].natIP:label=IP,scheduling.maxRunDuration.seconds:label=MAX_RUN_S)'
[ -n "${1:-}" ] || exit 0

check_role "$1"
MODE=prod; LOGS=0
for a in "${@:2}"; do
  case "$a" in --debug) MODE=debug ;; --logs) LOGS=1 ;; esac
done
NAME="$(instance_name "$1" "${MODE}")"
IP="$(gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
echo
if [ -n "${IP}" ]; then
  echo "GET https://${IP}/health"
  curl -sk --max-time 5 "https://${IP}/health" || echo "(no answer yet)"
  echo
fi
if [ "${LOGS}" = 1 ]; then
  echo "--- serial console (last 40 lines) ---"
  gc compute instances get-serial-port-output "${NAME}" --zone "${GCP_ZONE}" 2>/dev/null | tail -40
fi
