#!/usr/bin/env bash
# fallback-docker.sh <issuer|relay> [--stop] [--force]   (INF-24)
#
# Plan B if Nitro breaks: run the SAME image as a plain Docker container on
# this host, with ENCLAVE_MODE=docker. Then:
#   - attestation is MOCK (provider "mock", all-zero PCRs). The SDK must run
#     in mock mode to accept it. Say so on stage.
#   - the egress allowlist is NOT enforced (normal Docker networking and DNS).
#   - the host operator can read the container's memory. No isolation.
#
# One command per host:   infra/scripts/fallback-docker.sh issuer
# Undo:                   infra/scripts/fallback-docker.sh issuer --stop
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need docker

require_role "${1:-}"
ROLE="$1"
shift
STOP=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --stop) STOP=1 ;;
    --force) FORCE=1 ;;
    *) die "unknown option $a" ;;
  esac
done
load_role_config "$ROLE"

NAME="ifi-$ROLE-fallback"
IMAGE="ifi-$ROLE:latest"
BOOT_JSON="$IFI_ETC/$ROLE.boot.json"

if [[ "$STOP" -eq 1 ]]; then
  docker_cmd rm -f "$NAME" >/dev/null 2>&1 || true
  log "fallback container removed. To go back to Nitro: infra/scripts/deploy.sh $ROLE"
  exit 0
fi

if command -v nitro-cli >/dev/null && [[ "$(running_enclaves)" != "0" ]]; then
  [[ "$FORCE" -eq 1 ]] || die "an enclave is running. Use --force to terminate it (its keys are lost)."
  nitro_cli terminate-enclave --all >/dev/null
fi

# Free the public port held by the vsock ingress.
as_root systemctl stop ifi-ingress.service 2>/dev/null || true

if ! docker_cmd image inspect "$IMAGE" >/dev/null 2>&1; then
  log "image $IMAGE not found, building it"
  build_image "$ROLE"
fi

docker_cmd rm -f "$NAME" >/dev/null 2>&1 || true
args=(run -d --init --name "$NAME" --restart unless-stopped
  -e ENCLAVE_MODE=docker
  -p "$PUBLIC_PORT:$APP_PORT")
if as_root test -f "$BOOT_JSON"; then
  args+=(-v "$BOOT_JSON:/run/ifi/boot.json:ro")
else
  warn "no $BOOT_JSON; the app starts with an empty boot config"
fi
docker_cmd "${args[@]}" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsk --max-time 3 "https://127.0.0.1:$PUBLIC_PORT/healthz" >/dev/null 2>&1; then
    log "fallback $ROLE is up on port $PUBLIC_PORT (MOCK attestation, no enclave)"
    log "logs: docker logs -f $NAME"
    log "Say on stage that this run uses the Docker fallback."
    exit 0
  fi
  sleep 2
done
die "container started but /healthz does not answer. Check: docker logs $NAME"
