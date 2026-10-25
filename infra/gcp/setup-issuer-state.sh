#!/usr/bin/env bash
# Provision the dedicated append-only encrypted issuer-state resources.
# Usage: infra/gcp/setup-issuer-state.sh prepare
source "$(dirname "$0")/lib.sh"

[ "${1:-}" = prepare ] && [ "$#" -eq 1 ] || die "usage: infra/gcp/setup-issuer-state.sh prepare"

POOL_ID="${GCP_WIF_POOL_ID:-wraps-attested}"
PROVIDER_ID="${GCP_WIF_PROVIDER_ID:-wraps-cs}"
KEYRING="${ISSUER_STATE_KMS_KEYRING:-wraps-issuer-state}"
KEY_ID="${ISSUER_STATE_KMS_KEY_ID:-issuer-state}"
PREFIX="${ISSUER_STATE_GCS_PREFIX:-issuer-state/v1}"

gc services enable storage.googleapis.com cloudkms.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com --quiet

PROJECT_NUMBER="$(gc projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
[[ "${PROJECT_NUMBER}" =~ ^[0-9]+$ ]] || die "could not read the GCP project number"
EXPECTED_BUCKET="${GCP_PROJECT}-issuer-state-${PROJECT_NUMBER}"
BUCKET="${ISSUER_STATE_GCS_BUCKET:-${EXPECTED_BUCKET}}"
[[ "${BUCKET}" = "${EXPECTED_BUCKET}" ]] \
  || die "issuer state must use its dedicated project bucket gs://${EXPECTED_BUCKET}; arbitrary bucket overrides are refused"
KMS_KEY="projects/${GCP_PROJECT}/locations/${GCP_REGION}/keyRings/${KEYRING}/cryptoKeys/${KEY_ID}"
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

[[ "${BUCKET}" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || die "invalid state bucket name"
PREFIX="${PREFIX}" node -e '
  const prefix = process.env.PREFIX;
  if (!prefix || prefix.startsWith("/") || prefix.endsWith("/") || prefix.length > 900 ||
      !/^[A-Za-z0-9!#$&\x27()+,._=@~-]+(?:\/[A-Za-z0-9!#$&\x27()+,._=@~-]+)*$/.test(prefix)) {
    console.error("invalid issuer state object prefix"); process.exit(1);
  }
'
[[ "${KEYRING}" =~ ^[A-Za-z0-9_-]{1,63}$ && "${KEY_ID}" =~ ^[A-Za-z0-9_-]{1,63}$ ]] || die "invalid Cloud KMS keyring or key ID"
[[ "${POOL_ID}" =~ ^[a-z][a-z0-9_-]{3,31}$ && "${PROVIDER_ID}" =~ ^[a-z][a-z0-9_-]{3,31}$ ]] || die "invalid Workload Identity Pool or provider ID"

if ! gc storage buckets describe "gs://${BUCKET}" --format='value(name)' >/dev/null 2>&1; then
  echo "Creating dedicated regional state bucket gs://${BUCKET}..."
  gc storage buckets create "gs://${BUCKET}" --project="${GCP_PROJECT}" \
    --location="${GCP_REGION}" --default-storage-class=STANDARD \
    --uniform-bucket-level-access --public-access-prevention --quiet
fi

PROJECT_BUCKETS="$(gc storage buckets list --format='value(name)')"
if ! printf '%s\n' "${PROJECT_BUCKETS}" | grep -Fxq "${BUCKET}"; then
  die "gs://${BUCKET} is not owned by configured project ${GCP_PROJECT}"
fi

# The workload gets bucket-wide objectViewer/objectCreator roles. Keep this
# canonical bucket dedicated to issuer snapshots before granting those roles.
OBJECT_NAMES="$(gc storage objects list "gs://${BUCKET}/**" --format='value(name)')"
while IFS= read -r object; do
  [ -n "${object}" ] || continue
  [[ "${object}" == "${PREFIX}/"* ]] \
    || die "issuer state bucket contains an object outside ${PREFIX}/; refusing a bucket-wide workload grant"
done <<< "${OBJECT_NAMES}"

gc storage buckets update "gs://${BUCKET}" \
  --update-labels=project=wraps,role=issuer-state --quiet

BUCKET_JSON="$(mktemp)"
trap 'rm -f "${BUCKET_JSON}"' EXIT
gc storage buckets describe "gs://${BUCKET}" --format=json > "${BUCKET_JSON}"
node - "${BUCKET_JSON}" "${GCP_REGION}" <<'NODE'
const fs = require('node:fs');
const bucket = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const region = process.argv[3].toLowerCase();
const errors = [];
if (String(bucket.location ?? '').toLowerCase() !== region) errors.push('bucket must be in the configured region');
if (String(bucket.storageClass ?? bucket.default_storage_class ?? '').toUpperCase() !== 'STANDARD') errors.push('bucket must use Standard storage');
const ubla = bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled ?? bucket.uniform_bucket_level_access;
if (ubla !== true) errors.push('uniform bucket-level access must be enabled');
const pap = bucket.iamConfiguration?.publicAccessPrevention ?? bucket.public_access_prevention;
if (pap !== 'enforced') errors.push('public access prevention must be enforced');
const lifecycle = bucket.lifecycle ?? bucket.lifecycle_config ?? bucket.lifecycle_rule;
const lifecycleRules = lifecycle?.rule ?? lifecycle?.rules ?? lifecycle;
if (Array.isArray(lifecycleRules) && lifecycleRules.length !== 0) errors.push('remove lifecycle rules that could delete issuer snapshots');
if (bucket.labels?.project !== 'wraps' || bucket.labels?.role !== 'issuer-state') errors.push('bucket must be labeled project=wraps,role=issuer-state');
if (errors.length) { console.error(`invalid issuer-state bucket: ${errors.join('; ')}`); process.exit(1); }
NODE

if ! gc kms keyrings describe "${KEYRING}" --location="${GCP_REGION}" --format='value(name)' >/dev/null 2>&1; then
  gc kms keyrings create "${KEYRING}" --location="${GCP_REGION}" --quiet
fi
if ! gc kms keys describe "${KEY_ID}" --location="${GCP_REGION}" --keyring="${KEYRING}" --format='value(name)' >/dev/null 2>&1; then
  gc kms keys create "${KEY_ID}" --location="${GCP_REGION}" --keyring="${KEYRING}" \
    --purpose=encryption --protection-level=software --quiet
fi
KEY_JSON="$(gc kms keys describe "${KEY_ID}" --location="${GCP_REGION}" --keyring="${KEYRING}" --format=json)"
KEY_JSON="${KEY_JSON}" GCP_REGION="${GCP_REGION}" node -e '
  const key = JSON.parse(process.env.KEY_JSON);
  if (key.purpose !== "ENCRYPT_DECRYPT" || key.name?.split("/")[3] !== process.env.GCP_REGION) {
    console.error("issuer state requires a symmetric ENCRYPT_DECRYPT key in the configured region");
    process.exit(1);
  }
'

mkdir -p "${STATE_DIR}"
umask 077
cat > "${STATE_DIR}/issuer-state.env" <<EOF
export GCP_WIF_PROVIDER=${WIF_PROVIDER}
export ISSUER_STATE_GCS_BUCKET=${BUCKET}
export ISSUER_STATE_GCS_PREFIX=${PREFIX}
export ISSUER_STATE_KMS_KEY=${KMS_KEY}
EOF

echo "Issuer state bucket: gs://${BUCKET} (${GCP_REGION}, Standard, UBLA, public access prevention)"
echo "Cloud KMS key: ${KMS_KEY} (symmetric ENCRYPT_DECRYPT)"
echo "WIF provider baked into images: ${WIF_PROVIDER}"
echo "Resource names saved to infra/gcp/.state/issuer-state.env (no credentials or key material)."
