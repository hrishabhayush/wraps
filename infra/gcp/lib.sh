# Shared settings for the infra/gcp scripts. Source it; do not run it.
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-wraps-hack}"
GCP_REGION="${GCP_REGION:-us-central1}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
REGISTRY="${REGISTRY:-${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/wraps}"
WORKLOAD_SA="${WORKLOAD_SA:-wraps-workload@${GCP_PROJECT}.iam.gserviceaccount.com}"
MACHINE_TYPE="${MACHINE_TYPE:-n2d-standard-2}"
MAX_RUN_DURATION="${MAX_RUN_DURATION:-12h}"

GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${GCP_DIR}/../.." && pwd)"
EXPECTED_JSON="${GCP_DIR}/expected.json"
STATE_DIR="${GCP_DIR}/.state"

die() { echo "error: $*" >&2; exit 1; }

check_role() {
  case "${1:-}" in
    issuer) ;;
    relay)
      [ -f "${GCP_DIR}/relay.Dockerfile" ] || die "packages/relay does not exist yet, so there is no relay image"
      ;;
    *) die "role must be issuer or relay" ;;
  esac
}

instance_name() { # role [debug]
  if [ "${2:-}" = "debug" ]; then echo "wraps-$1-debug"; else echo "wraps-$1"; fi
}

# Reads a value from expected.json with node (always present in this repo).
expected_get() { # js-expression-on-j
  node -e "const j=require(process.argv[1]); const v=($1); if(v==null) process.exit(1); console.log(v)" "${EXPECTED_JSON}"
}

gc() { gcloud --project "${GCP_PROJECT}" "$@"; }
