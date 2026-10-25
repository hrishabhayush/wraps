#!/usr/bin/env bash
# Create the digest-scoped WIF provider and relay-settlement secret binding for SEC-04.
# Build the final issuer and relay images first; their digests become the only accepted identities.
source "$(dirname "$0")/lib.sh"

POOL_ID="${GCP_WIF_POOL_ID:-wraps-attested}"
PROVIDER_ID="${GCP_WIF_PROVIDER_ID:-wraps-cs}"
SECRET_ID="${ISSUER_RELAY_SETTLE_KEY_SECRET_ID:-wraps-relay-settle-key}"

ISSUER_DIGEST="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.imageDigest ?? "")' "${EXPECTED_JSON}")"
RELAY_DIGEST="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.relay?.imageDigest ?? "")' "${EXPECTED_JSON}")"
KEY_FINGERPRINT="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.merchantAuthKeyFingerprint ?? "")' "${EXPECTED_JSON}")"
[[ "${ISSUER_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "expected.json has no valid issuer digest"
[[ "${RELAY_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "expected.json has no valid relay digest"
[[ "${KEY_FINGERPRINT}" =~ ^[0-9a-f]{64}$ ]] || die "issuer image was not built with a pinned merchant public-key map"

gc services enable iam.googleapis.com cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com --quiet

PROJECT_NUMBER="$(gc projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
[[ "${PROJECT_NUMBER}" =~ ^[0-9]+$ ]] || die "could not read the GCP project number"

MAPPING='google.subject="gcpcs::"+assertion.submods.container.image_digest+"::"+assertion.submods.gce.project_number+"::"+assertion.submods.gce.instance_id,attribute.image_digest=assertion.submods.container.image_digest'
CONDITION="assertion.swname == 'CONFIDENTIAL_SPACE' && assertion.secboot == true && assertion.dbgstat == 'disabled-since-boot' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.submods.container.image_digest in ['${ISSUER_DIGEST}', '${RELAY_DIGEST}'] && '${WORKLOAD_SA}' in assertion.google_service_accounts"

if ! gc iam workload-identity-pools describe "${POOL_ID}" --location=global --format='value(name)' >/dev/null 2>&1; then
  gc iam workload-identity-pools create "${POOL_ID}" --location=global \
    --display-name='Wraps attested workloads' --description='Digest-scoped identities for Wraps Confidential Space images.' --quiet
fi

if gc iam workload-identity-pools providers describe "${PROVIDER_ID}" --location=global \
  --workload-identity-pool="${POOL_ID}" --format='value(name)' >/dev/null 2>&1; then
  gc iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" --display-name='Wraps Confidential Space' \
    --issuer-uri='https://confidentialcomputing.googleapis.com/' --allowed-audiences='https://sts.googleapis.com' \
    --attribute-mapping="${MAPPING}" --attribute-condition="${CONDITION}" --quiet
else
  gc iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" --display-name='Wraps Confidential Space' \
    --description='Accept only the pinned production issuer and relay images.' \
    --issuer-uri='https://confidentialcomputing.googleapis.com/' --allowed-audiences='https://sts.googleapis.com' \
    --attribute-mapping="${MAPPING}" --attribute-condition="${CONDITION}" --quiet
fi

if ! gc secrets describe "${SECRET_ID}" --format='value(name)' >/dev/null 2>&1; then
  gc secrets create "${SECRET_ID}" --replication-policy=automatic --quiet
fi

ACTIVE_VERSIONS="$(gc secrets versions list "${SECRET_ID}" --filter='state=ENABLED' --format='value(name)')"
if [ -z "${ACTIVE_VERSIONS}" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' \
    | gc secrets versions add "${SECRET_ID}" --data-file=- --quiet >/dev/null
fi
SECRET_VERSION="$(gc secrets versions list "${SECRET_ID}" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
[[ "${SECRET_VERSION}" =~ ^[1-9][0-9]*$ ]] || die "could not read the enabled relay secret version"

ISSUER_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.image_digest/${ISSUER_DIGEST}"
RELAY_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.image_digest/${RELAY_DIGEST}"
for member in "${ISSUER_MEMBER}" "${RELAY_MEMBER}"; do
  gc secrets add-iam-policy-binding "${SECRET_ID}" --member="${member}" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done

mkdir -p "${STATE_DIR}"
umask 077
cat > "${STATE_DIR}/merchant-auth.env" <<EOF
export GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}
export ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION=projects/${GCP_PROJECT}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}
EOF

echo "WIF provider: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "Secret version: projects/${GCP_PROJECT}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}"
echo "Deployment references saved to infra/gcp/.state/merchant-auth.env."
echo "Access is limited to the issuer and relay image digests recorded in infra/gcp/expected.json."
