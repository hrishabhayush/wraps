#!/usr/bin/env bash
# build-eif.sh <issuer|relay> [--check]   (INF-08, INF-09)
#
#   1. Builds the Docker image ifi-<role>:latest reproducibly.
#   2. nitro-cli build-enclave -> infra/build/<role>.eif
#   3. Prints PCR0, PCR1, PCR2 and writes them to infra/pcrs.json.
#
# --check builds a second time with --no-cache and fails if PCR0 differs.
# That is the INF-09 "done when". Run it at least once before you publish PCRs.
#
# Commit infra/pcrs.json after a build you will deploy. The SDK reads it.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need docker nitro-cli jq

require_role "${1:-}"
ROLE="$1"
CHECK=0
[[ "${2:-}" == "--check" ]] && CHECK=1

DOCKERFILE="$INFRA_DIR/docker/$ROLE.Dockerfile"
EIF="$BUILD_DIR/$ROLE.eif"
IMAGE="ifi-$ROLE:latest"

# Preflight: refuse to build something that cannot be reproducible or cannot run.
check_no_placeholders "$DOCKERFILE" 'PIN_ME'
check_no_placeholders "$INFRA_DIR/config/egress.$ROLE.conf" 'PLACEHOLDER'
[[ -f "$INFRA_DIR/enclave-common/nsm-helper/Cargo.lock" ]] ||
  die "nsm-helper/Cargo.lock missing. Run infra/scripts/prepare-build.sh and commit."
[[ -f "$REPO_ROOT/package-lock.json" ]] || die "package-lock.json missing at the repo root"
grep -q '"infra/enclave-common"' "$REPO_ROOT/package-lock.json" ||
  die "package-lock.json has no infra/enclave-common workspace. Add it to root package.json workspaces, run npm install, commit."
[[ -f "$REPO_ROOT/packages/$ROLE/src/cli.ts" ]] ||
  die "packages/$ROLE/src/cli.ts missing (the app entry point the Dockerfile runs)"

mkdir -p "$BUILD_DIR"

# Prints the nitro-cli measurements JSON on stdout.
build_once() {
  build_image "$ROLE" "${1:-}" >&2
  log "nitro-cli build-enclave -> $EIF"
  local raw
  raw="$(nitro_cli build-enclave --docker-uri "$IMAGE" --output-file "$EIF")"
  # nitro-cli may print progress lines before the JSON. Keep the JSON part.
  awk '/^\{/{p=1} p' <<<"$raw" | jq -c '.Measurements'
}

M1="$(build_once)"
PCR0="$(jq -r '.PCR0' <<<"$M1")"
PCR1="$(jq -r '.PCR1' <<<"$M1")"
PCR2="$(jq -r '.PCR2' <<<"$M1")"

if [[ "$CHECK" -eq 1 ]]; then
  log "reproducibility check: second build without cache"
  M2="$(build_once --no-cache)"
  if [[ "$(jq -r '.PCR0' <<<"$M2")" != "$PCR0" ]]; then
    log "first  PCR0: $PCR0"
    log "second PCR0: $(jq -r '.PCR0' <<<"$M2")"
    die "PCR0 differs between builds. The build is not reproducible. pcrs.json NOT updated."
  fi
  log "PASS: PCR0 is the same in both builds"
fi

if [[ "$PCR0" =~ ^0+$ ]]; then die "PCR0 is all zeros. Something is wrong with the build."; fi

COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- . ":!infra/pcrs.json" 2>/dev/null || true)" ]]; then COMMIT="$COMMIT-dirty"; fi
IMAGE_ID="$(docker_cmd image inspect --format '{{.Id}}' "$IMAGE")"
NITRO_VER="$(nitro-cli --version 2>/dev/null | awk '{print $NF}')"

[[ -f "$PCRS_FILE" ]] || echo '{"schemaVersion":1,"hashAlgorithm":"SHA384","enclaves":{}}' >"$PCRS_FILE"
tmp="$(mktemp)"
jq --arg role "$ROLE" --arg pcr0 "$PCR0" --arg pcr1 "$PCR1" --arg pcr2 "$PCR2" \
  --arg imageId "$IMAGE_ID" --arg commit "$COMMIT" --arg nitro "$NITRO_VER" \
  --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson checked "$CHECK" \
  '.schemaVersion = 1 | .hashAlgorithm = "SHA384" |
   .enclaves[$role] = {
     pcr0: $pcr0, pcr1: $pcr1, pcr2: $pcr2,
     imageId: $imageId, gitCommit: $commit, nitroCliVersion: $nitro,
     builtAt: $builtAt, reproducibilityChecked: ($checked == 1)
   }' "$PCRS_FILE" >"$tmp"
mv "$tmp" "$PCRS_FILE"

cat <<EOF

  $ROLE enclave image: $EIF
  PCR0 $PCR0
  PCR1 $PCR1
  PCR2 $PCR2

  Written to infra/pcrs.json. Commit it so the SDK checks this build.
EOF
[[ "$COMMIT" == *-dirty ]] && warn "the git tree has uncommitted changes. Commit, then rebuild before you publish PCRs."
exit 0
