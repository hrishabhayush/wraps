#!/usr/bin/env bash
# prepare-build.sh [--repin]   (INF-07, run ONCE, then commit the result)
#
# Fixes every input the enclave builds pull from the network, so both hosts
# and every rebuild produce the same PCR0:
#   1. Resolves each "FROM image:tag@sha256:PIN_ME" in infra/docker/*.Dockerfile
#      to the current digest and writes it into the Dockerfile.
#   2. Pins BUILDKIT_IMAGE in infra/config/build.env by digest.
#   3. Generates infra/enclave-common/nsm-helper/Cargo.lock if it is missing.
#
# Already-pinned images are left alone unless you pass --repin.
# Afterwards: git add infra/docker infra/config/build.env infra/enclave-common/nsm-helper/Cargo.lock
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need docker

REPIN=0
[[ "${1:-}" == "--repin" ]] && REPIN=1

resolve_digest() {
  local ref="$1" digest
  docker_cmd pull -q "$ref" >/dev/null
  # RepoDigests holds the multi-arch index digest when pulled by tag.
  digest="$(docker_cmd image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | head -n1 | sed 's/.*@//')"
  [[ "$digest" == sha256:* ]] || die "could not resolve a digest for $ref"
  echo "$digest"
}

# 1. Dockerfile base images.
for df in "$INFRA_DIR"/docker/*.Dockerfile; do
  while read -r ref; do
    tag="${ref%@*}"
    current="${ref#*@}"
    if [[ "$current" != "sha256:PIN_ME" && "$REPIN" -eq 0 ]]; then
      log "$(basename "$df"): $tag already pinned"
      continue
    fi
    digest="$(resolve_digest "$tag")"
    log "$(basename "$df"): $tag -> $digest"
    # Rewrite every FROM line that uses this tag, whatever digest it had.
    sed -i.bak -E "s#^(FROM ${tag//./\\.})@sha256:[A-Za-z0-9_]+#\\1@${digest}#" "$df"
    rm -f "$df.bak"
  done < <(grep -Eo '^FROM [^ ]+@sha256:[A-Za-z0-9_]+' "$df" | awk '{print $2}' | sort -u)
done

# 2. BuildKit image.
load_build_config
bk_tag="${BUILDKIT_IMAGE%@*}"
if [[ "$BUILDKIT_IMAGE" != *@sha256:* || "$REPIN" -eq 1 ]]; then
  digest="$(resolve_digest "$bk_tag")"
  log "build.env: $bk_tag -> $digest"
  sed -i.bak -E "s#^BUILDKIT_IMAGE=.*#BUILDKIT_IMAGE=${bk_tag}@${digest}#" "$INFRA_DIR/config/build.env"
  rm -f "$INFRA_DIR/config/build.env.bak"
  # A builder made with the old image would keep using it.
  docker_cmd buildx rm "$BUILDX_BUILDER" >/dev/null 2>&1 || true
else
  log "build.env: BuildKit already pinned"
fi

# 3. Cargo.lock for the NSM helper.
NSM_DIR="$INFRA_DIR/enclave-common/nsm-helper"
if [[ ! -f "$NSM_DIR/Cargo.lock" ]]; then
  rust_ref="$(grep -Eo '^FROM rust:[^ ]+' "$INFRA_DIR/docker/issuer.Dockerfile" | head -n1 | awk '{print $2}')"
  log "generating Cargo.lock with $rust_ref"
  docker_cmd run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/tmp/cargo \
    -v "$NSM_DIR:/src" -w /src "$rust_ref" cargo generate-lockfile
else
  log "Cargo.lock already present"
fi

log "done. Review with 'git diff infra', then commit."
