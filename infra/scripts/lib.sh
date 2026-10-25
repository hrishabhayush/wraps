#!/usr/bin/env bash
# Shared helpers for infra/scripts. Source it; do not run it.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
BUILD_DIR="$INFRA_DIR/build"
PCRS_FILE="$INFRA_DIR/pcrs.json"
IFI_ETC=/etc/ifi

log() { printf '[%s] %s\n' "$(basename "$0")" "$*" >&2; }
warn() { printf '[%s] WARNING: %s\n' "$(basename "$0")" "$*" >&2; }
die() {
  printf '[%s] ERROR: %s\n' "$(basename "$0")" "$*" >&2
  exit 1
}

require_role() {
  case "${1:-}" in
    issuer | relay) ;;
    *) die "usage: $(basename "$0") <issuer|relay> [options]" ;;
  esac
}

load_role_config() {
  local f="$INFRA_DIR/config/$1.env"
  [[ -f "$f" ]] || die "missing $f"
  # shellcheck disable=SC1090
  source "$f"
}

load_build_config() {
  # shellcheck disable=SC1091
  source "$INFRA_DIR/config/build.env"
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

# Use docker / nitro-cli directly when the user is in the docker / ne group,
# otherwise through sudo (right after host-setup, before a re-login).
docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}
nitro_cli() {
  if [[ -w /dev/nitro_enclaves ]]; then nitro-cli "$@"; else sudo nitro-cli "$@"; fi
}

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' not found. Run infra/scripts/host-setup.sh first."
  done
}

# Lines of the egress file without comments or blanks: "<vsock_port> <host> <remote_port>"
egress_entries() {
  grep -Ev '^[[:space:]]*(#|$)' "$INFRA_DIR/config/egress.$1.conf"
}

render_vsock_proxy_yaml() {
  local vport host rport rest
  echo "# Written by infra/scripts/deploy.sh from infra/config/egress.$1.conf. Do not edit."
  echo "allowlist:"
  while read -r vport host rport rest; do
    echo "- {address: $host, port: $rport}"
  done < <(egress_entries "$1")
}

# Fails if a file still contains a placeholder that must be replaced before building.
check_no_placeholders() {
  local f="$1" pattern="$2"
  if grep -nE "$pattern" "$f" | grep -v '^[0-9]*:[[:space:]]*#' >&2; then
    die "$f still has placeholders (see lines above). Replace them first."
  fi
}

# Number of running enclaves (0 if nitro-cli fails).
running_enclaves() {
  nitro_cli describe-enclaves 2>/dev/null | jq 'length' 2>/dev/null || echo 0
}

random_nonce_hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Build the Docker image ifi-<role>:latest reproducibly with a pinned BuildKit.
build_image() {
  local role="$1" no_cache="${2:-}"
  load_build_config
  local image="ifi-$role:latest"
  local dockerfile="$INFRA_DIR/docker/$role.Dockerfile"

  if ! docker_cmd buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
    log "creating buildx builder $BUILDX_BUILDER ($BUILDKIT_IMAGE)"
    docker_cmd buildx create --name "$BUILDX_BUILDER" --driver docker-container \
      --driver-opt "image=$BUILDKIT_IMAGE" >/dev/null
  fi

  local args=(
    buildx build --builder "$BUILDX_BUILDER"
    -f "$dockerfile"
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
    --build-arg "DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT"
    --provenance=false --sbom=false
    --output "type=docker,name=$image,rewrite-timestamp=true"
  )
  [[ "$no_cache" == "--no-cache" ]] && args+=(--no-cache)
  log "building $image (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
  docker_cmd "${args[@]}" "$REPO_ROOT"
}
