#!/usr/bin/env bash
# deploy.sh <issuer|relay> [--force]   (INF-10, INF-11, INF-13, INF-20, INF-21)
#
# Runs infra/build/<role>.eif as a PRODUCTION enclave (never --debug-mode) and
# starts the parent-side services:
#   ifi-logs           vsock LOG_PORT  -> journald            (started first)
#   ifi-egress@<port>  vsock <port>    -> allowlisted host    (one per egress line)
#   ifi-ingress        TCP PUBLIC_PORT -> enclave vsock APP_PORT
# Then it pushes /etc/ifi/<role>.boot.json into the enclave, if that file exists,
# and waits for GET /healthz.
#
# INF-23: if an enclave is already running it stops. Restarting loses the
# in-memory keys and the spent list. --force terminates it anyway.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need nitro-cli jq socat curl

require_role "${1:-}"
ROLE="$1"
FORCE=0
[[ "${2:-}" == "--force" ]] && FORCE=1
load_role_config "$ROLE"

EIF="$BUILD_DIR/$ROLE.eif"
BOOT_JSON="$IFI_ETC/$ROLE.boot.json"
[[ -f "$EIF" ]] || die "$EIF missing. Run infra/scripts/build-eif.sh $ROLE first."
check_no_placeholders "$INFRA_DIR/config/egress.$ROLE.conf" 'PLACEHOLDER'

# --- INF-23 guard ------------------------------------------------------------
if [[ "$(running_enclaves)" != "0" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    nitro_cli describe-enclaves | jq -r '.[] | "  running: \(.EnclaveName // .EnclaveID) state=\(.State) flags=\(.Flags)"' >&2
    die "an enclave is already running. Restarting loses its keys and spent list (INF-23). Use --force if you mean it."
  fi
  warn "--force: terminating the running enclave. Its keys and spent list are gone."
  nitro_cli terminate-enclave --all >/dev/null
fi
if as_root docker ps -q --filter "name=ifi-$ROLE-fallback" 2>/dev/null | grep -q .; then
  die "the Docker fallback container is running. Stop it first: infra/scripts/fallback-docker.sh $ROLE --stop"
fi

# --- Parent config ---------------------------------------------------------------
log "writing $IFI_ETC/ifi.env and /etc/nitro_enclaves/vsock-proxy.yaml"
as_root install -d -m 0755 "$IFI_ETC" "$IFI_ETC/egress"
printf 'ROLE=%s\nENCLAVE_CID=%s\nPUBLIC_PORT=%s\nAPP_PORT=%s\nLOG_PORT=%s\nBOOT_CONFIG_PORT=%s\n' \
  "$ROLE" "$ENCLAVE_CID" "$PUBLIC_PORT" "$APP_PORT" "$LOG_PORT" "$BOOT_CONFIG_PORT" |
  as_root tee "$IFI_ETC/ifi.env" >/dev/null
render_vsock_proxy_yaml "$ROLE" | as_root tee /etc/nitro_enclaves/vsock-proxy.yaml >/dev/null

# Units may be newer than the ones host-setup installed.
as_root install -m 0644 "$INFRA_DIR"/systemd/ifi-*.service "$INFRA_DIR"/systemd/ifi-*.target /etc/systemd/system/
as_root systemctl daemon-reload

# --- Logs first, so the enclave's first lines are kept -------------------------------
as_root systemctl enable ifi-logs.service >/dev/null 2>&1
as_root systemctl restart ifi-logs.service

# --- Egress proxies ----------------------------------------------------------------
log "starting egress proxies"
for unit in $(systemctl list-units --all --plain --no-legend 'ifi-egress@*' | awk '{print $1}'); do
  as_root systemctl disable --now "$unit" >/dev/null 2>&1 || true
done
as_root find "$IFI_ETC/egress" -name '*.env' -delete
while read -r vport host rport _rest; do
  printf 'REMOTE_HOST=%s\nREMOTE_PORT=%s\n' "$host" "$rport" | as_root tee "$IFI_ETC/egress/$vport.env" >/dev/null
  as_root systemctl enable --now "ifi-egress@$vport.service" >/dev/null 2>&1
  log "  vsock $vport -> $host:$rport"
done < <(egress_entries "$ROLE")
as_root systemctl enable ifi-egress.target >/dev/null 2>&1 || true

# --- The enclave (production mode: there is no --debug-mode here, on purpose) --------
log "running enclave ifi-$ROLE: cpus=$ENCLAVE_CPUS memory=${ENCLAVE_MEMORY_MIB}MiB cid=$ENCLAVE_CID"
nitro_cli run-enclave \
  --eif-path "$EIF" \
  --cpu-count "$ENCLAVE_CPUS" \
  --memory "$ENCLAVE_MEMORY_MIB" \
  --enclave-cid "$ENCLAVE_CID" \
  --enclave-name "ifi-$ROLE" >/dev/null

desc="$(nitro_cli describe-enclaves | jq '.[0]')"
flags="$(jq -r '.Flags' <<<"$desc")"
if [[ "$flags" != "NONE" ]]; then
  nitro_cli terminate-enclave --all >/dev/null || true
  die "enclave flags are '$flags', expected NONE. Debug mode is not allowed. Terminated."
fi

# --- Ingress -------------------------------------------------------------------------
as_root systemctl enable ifi-ingress.service >/dev/null 2>&1
as_root systemctl restart ifi-ingress.service

# --- Boot config -----------------------------------------------------------------------
if as_root test -f "$BOOT_JSON"; then
  log "pushing $BOOT_JSON into the enclave (vsock $ENCLAVE_CID:$BOOT_CONFIG_PORT)"
  pushed=0
  for _ in $(seq 1 60); do
    reply="$(as_root socat -t 5 - "VSOCK-CONNECT:$ENCLAVE_CID:$BOOT_CONFIG_PORT" <"$BOOT_JSON" 2>/dev/null || true)"
    case "$reply" in
      ok) pushed=1; break ;;
      "already configured") warn "the enclave already has a boot config"; pushed=1; break ;;
      "bad json") die "the enclave rejected $BOOT_JSON as bad JSON" ;;
    esac
    sleep 2
  done
  [[ "$pushed" -eq 1 ]] || warn "boot config not accepted after 120 s. Does the app call waitForBootConfig()? Check: journalctl -u ifi-logs"
else
  log "no $BOOT_JSON, skipping boot config (copy infra/config/boot.example.json there if the app needs one)"
fi

# --- Health ----------------------------------------------------------------------------
log "waiting for https://127.0.0.1:$PUBLIC_PORT/healthz"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsk --max-time 3 "https://127.0.0.1:$PUBLIC_PORT/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done

pcr0_live="$(jq -r '.Measurements.PCR0 // empty' <<<"$desc")"
pcr0_pub="$(jq -r --arg r "$ROLE" '.enclaves[$r].pcr0 // empty' "$PCRS_FILE" 2>/dev/null || true)"
echo
echo "  enclave   ifi-$ROLE  cid=$ENCLAVE_CID  flags=$flags"
echo "  PCR0      ${pcr0_live:-(not shown by this nitro-cli)}"
if [[ -n "$pcr0_live" && -n "$pcr0_pub" ]]; then
  if [[ "$pcr0_live" == "$pcr0_pub" ]]; then echo "  pcrs.json match"; else echo "  pcrs.json MISMATCH ($pcr0_pub). Rebuild or commit the new pcrs.json."; fi
fi
if [[ "$healthy" -eq 1 ]]; then
  echo "  health    OK on port $PUBLIC_PORT"
else
  echo "  health    NOT RESPONDING. Check: journalctl -u ifi-logs -n 100"
  exit 1
fi
echo
log "INF-23: do not restart this enclave during the demo."
