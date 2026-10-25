#!/usr/bin/env bash
# stop.sh [--yes]   (INF-20)
#
# Terminates the enclave and stops the ifi services and the Docker fallback
# container on this host. The enclave's keys and spent list are lost (INF-23),
# so it asks first unless you pass --yes.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Terminate the enclave? Its keys and spent list will be lost. Type 'yes': " answer
  [[ "$answer" == "yes" ]] || die "aborted"
fi

if command -v nitro-cli >/dev/null && [[ "$(running_enclaves)" != "0" ]]; then
  log "terminating enclaves"
  nitro_cli terminate-enclave --all >/dev/null
else
  log "no enclave running"
fi

for c in $(as_root docker ps -aq --filter 'name=ifi-.*-fallback' 2>/dev/null || true); do
  log "removing fallback container $c"
  as_root docker rm -f "$c" >/dev/null
done

log "stopping ifi services"
as_root systemctl stop ifi-ingress.service 2>/dev/null || true
for unit in $(systemctl list-units --all --plain --no-legend 'ifi-egress@*' | awk '{print $1}'); do
  as_root systemctl stop "$unit" 2>/dev/null || true
done
as_root systemctl stop ifi-logs.service 2>/dev/null || true
log "stopped"
