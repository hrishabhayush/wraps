#!/usr/bin/env bash
# Create the digest-scoped WIF provider and relay-settlement secret binding for SEC-04.
# Build the final issuer and relay images first; their digests become the only accepted identities.
source "$(dirname "$0")/lib.sh"

STATE_ENV="${STATE_DIR}/issuer-state.env"
[ -f "${STATE_ENV}" ] || die "issuer state configuration is missing; run infra/gcp/setup-issuer-state.sh prepare"
# shellcheck source=/dev/null
source "${STATE_ENV}"

POOL_ID="${GCP_WIF_POOL_ID:-wraps-attested}"
PROVIDER_ID="${GCP_WIF_PROVIDER_ID:-wraps-cs}"
SECRET_ID="${ISSUER_RELAY_SETTLE_KEY_SECRET_ID:-wraps-relay-settle-key}"
EXPECTED_WORKLOAD_SA="wraps-workload@${GCP_PROJECT}.iam.gserviceaccount.com"
[[ "${WORKLOAD_SA}" = "${EXPECTED_WORKLOAD_SA}" ]] \
  || die "WORKLOAD_SA must be ${EXPECTED_WORKLOAD_SA} for the digest-scoped WIF policy"
[[ "${SECRET_ID}" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "invalid relay settlement secret ID"

ISSUER_DIGEST="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.imageDigest ?? "")' "${EXPECTED_JSON}")"
RELAY_DIGEST="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.relay?.imageDigest ?? "")' "${EXPECTED_JSON}")"
KEY_FINGERPRINT="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.merchantAuthKeyFingerprint ?? "")' "${EXPECTED_JSON}")"
ISSUER_PROVIDER="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.config?.gcpWifProvider ?? "")' "${EXPECTED_JSON}")"
RELAY_PROVIDER="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.relay?.config?.gcpWifProvider ?? "")' "${EXPECTED_JSON}")"
ISSUER_BUCKET="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.config?.issuerStateGcsBucket ?? "")' "${EXPECTED_JSON}")"
ISSUER_PREFIX="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.config?.issuerStateGcsPrefix ?? "")' "${EXPECTED_JSON}")"
ISSUER_KMS_KEY="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.roles?.issuer?.config?.issuerStateKmsKey ?? "")' "${EXPECTED_JSON}")"
[[ "${ISSUER_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "expected.json has no valid issuer digest"
[[ "${RELAY_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "expected.json has no valid relay digest"
[[ "${KEY_FINGERPRINT}" =~ ^[0-9a-f]{64}$ ]] || die "issuer image was not built with a pinned merchant public-key map"
[[ "${ISSUER_PROVIDER}" = "${GCP_WIF_PROVIDER}" && "${RELAY_PROVIDER}" = "${GCP_WIF_PROVIDER}" ]] \
  || die "issuer and relay images must bake the provider in issuer-state.env; rebuild both"
[[ "${ISSUER_BUCKET}" = "${ISSUER_STATE_GCS_BUCKET}" && "${ISSUER_PREFIX}" = "${ISSUER_STATE_GCS_PREFIX}" && "${ISSUER_KMS_KEY}" = "${ISSUER_STATE_KMS_KEY}" ]] \
  || die "issuer image state resources do not match issuer-state.env; rebuild the issuer"
[[ "${ISSUER_STATE_KMS_KEY}" =~ ^projects/${GCP_PROJECT}/locations/${GCP_REGION}/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}$ ]] \
  || die "issuer state KMS key must belong to ${GCP_PROJECT} in ${GCP_REGION}"

gc services enable storage.googleapis.com cloudkms.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com --quiet

PROJECT_NUMBER="$(gc projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
[[ "${PROJECT_NUMBER}" =~ ^[0-9]+$ ]] || die "could not read the GCP project number"
WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
[ "${GCP_WIF_PROVIDER}" = "${WIF_PROVIDER_RESOURCE}" ] || die "issuer-state.env WIF provider does not match the configured pool and provider IDs"

MAPPING='google.subject="gcpcs::"+assertion.submods.container.image_digest+"::"+assertion.submods.gce.project_number+"::"+assertion.submods.gce.instance_id,attribute.image_digest=assertion.submods.container.image_digest'
CONDITION="assertion.submods.gce.project_number == '${PROJECT_NUMBER}' && assertion.swname == 'CONFIDENTIAL_SPACE' && assertion.secboot == true && assertion.dbgstat == 'disabled-since-boot' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.submods.container.image_digest in ['${ISSUER_DIGEST}', '${RELAY_DIGEST}'] && '${WORKLOAD_SA}' in assertion.google_service_accounts"

assert_existing_provider_matches() {
  PROVIDER_JSON="$1" EXPECTED_MAPPING="${MAPPING}" EXPECTED_CONDITION="${CONDITION}" node <<'NODE'
const provider = JSON.parse(process.env.PROVIDER_JSON);
const expectedMapping = Object.fromEntries(process.env.EXPECTED_MAPPING.split(',').map((entry) => {
  const separator = entry.indexOf('=');
  if (separator < 1) throw new Error('invalid expected WIF attribute mapping');
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}));
const canonical = (value) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const expectedAudiences = ['https://sts.googleapis.com'];
const actualAudiences = [...(provider.allowedAudiences ?? [])].sort();
const matches = provider.issuerUri === 'https://confidentialcomputing.googleapis.com/' &&
  canonical(provider.attributeMapping) === canonical(expectedMapping) &&
  provider.attributeCondition === process.env.EXPECTED_CONDITION &&
  JSON.stringify(actualAudiences) === JSON.stringify(expectedAudiences);
if (!matches) {
  console.error('error: existing WIF provider has different trust settings; refusing to reuse or update it; review it or choose a new provider ID');
  process.exit(1);
}
NODE
}

single_enabled_secret_version() {
  local versions_json
  versions_json="$(gc secrets versions list "${SECRET_ID}" --format=json)"
  printf '%s' "${versions_json}" | node -e '
    const versions = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(versions)) throw new Error("Secret Manager returned an invalid version list");
    if (versions.length === 0) { process.stdout.write("EMPTY"); process.exit(0); }
    const enabled = versions.filter((version) => version.state === "ENABLED");
    if (versions.length !== 1 || enabled.length !== 1) {
      console.error("error: relay secret must have exactly one total version and one enabled version; rotate by using a new secret ID");
      process.exit(1);
    }
    const match = /\/versions\/([1-9][0-9]*)$/.exec(enabled[0].name ?? "");
    if (!match) throw new Error("Secret Manager returned an invalid version resource name");
    process.stdout.write(match[1]);
  '
}

assert_secret_bindings_scoped() {
  local expected_expression="$1"
  local policy_json
  policy_json="$(gc secrets get-iam-policy "${SECRET_ID}" --format=json)"
  SECRET_POLICY_JSON="${policy_json}" ISSUER_MEMBER="${ISSUER_MEMBER}" RELAY_MEMBER="${RELAY_MEMBER}" \
    EXPECTED_SECRET_EXPRESSION="${expected_expression}" node <<'NODE'
const policy = JSON.parse(process.env.SECRET_POLICY_JSON);
const protectedMembers = new Set([process.env.ISSUER_MEMBER, process.env.RELAY_MEMBER]);
for (const binding of policy.bindings ?? []) {
  if (!(binding.members ?? []).some((member) => protectedMembers.has(member))) continue;
  if (binding.role !== 'roles/secretmanager.secretAccessor' ||
      binding.condition?.expression !== process.env.EXPECTED_SECRET_EXPRESSION) {
    console.error('error: an existing binding for a digest principal is not limited to the pinned secret version; remove or review that binding before setup');
    process.exit(1);
  }
}
NODE
}

ISSUER_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.image_digest/${ISSUER_DIGEST}"
RELAY_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.image_digest/${RELAY_DIGEST}"

PROVIDER_JSON=''
PROVIDER_EXISTS=0
if PROVIDER_JSON="$(gc iam workload-identity-pools providers describe "${PROVIDER_ID}" --location=global \
  --workload-identity-pool="${POOL_ID}" --format=json 2>/dev/null)"; then
  PROVIDER_EXISTS=1
  assert_existing_provider_matches "${PROVIDER_JSON}"
fi

SECRET_EXISTS=0
if gc secrets describe "${SECRET_ID}" --format='value(name)' >/dev/null 2>&1; then
  SECRET_EXISTS=1
  SECRET_VERSION="$(single_enabled_secret_version)"
  if [ "${SECRET_VERSION}" = EMPTY ]; then
    assert_secret_bindings_scoped ''
  else
    SECRET_VERSION_RESOURCE="projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}"
    SECRET_ACCESS_CONDITION="resource.name == '${SECRET_VERSION_RESOURCE}'"
    assert_secret_bindings_scoped "${SECRET_ACCESS_CONDITION}"
  fi
else
  SECRET_VERSION=EMPTY
fi

if ! gc iam workload-identity-pools describe "${POOL_ID}" --location=global --format='value(name)' >/dev/null 2>&1; then
  gc iam workload-identity-pools create "${POOL_ID}" --location=global \
    --display-name='Wraps attested workloads' --description='Digest-scoped identities for Wraps Confidential Space images.' --quiet
fi

if [ "${PROVIDER_EXISTS}" = 1 ]; then
  echo "Existing WIF provider matches the expected trust policy; leaving it unchanged."
else
  gc iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" --location=global \
    --workload-identity-pool="${POOL_ID}" --display-name='Wraps Confidential Space' \
    --description='Accept only the pinned production issuer and relay images.' \
    --issuer-uri='https://confidentialcomputing.googleapis.com/' --allowed-audiences='https://sts.googleapis.com' \
    --attribute-mapping="${MAPPING}" --attribute-condition="${CONDITION}" --quiet
fi

if [ "${SECRET_EXISTS}" = 0 ]; then
  gc secrets create "${SECRET_ID}" --replication-policy=automatic --quiet
fi

if [ "${SECRET_VERSION}" = EMPTY ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' \
    | gc secrets versions add "${SECRET_ID}" --data-file=- --quiet >/dev/null
  SECRET_VERSION="$(single_enabled_secret_version)"
fi
[[ "${SECRET_VERSION}" =~ ^[1-9][0-9]*$ ]] || die "could not read the enabled relay secret version"
SECRET_VERSION_RESOURCE="projects/${PROJECT_NUMBER}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}"
SECRET_ACCESS_CONDITION="resource.name == '${SECRET_VERSION_RESOURCE}'"
assert_secret_bindings_scoped "${SECRET_ACCESS_CONDITION}"

for member in "${ISSUER_MEMBER}" "${RELAY_MEMBER}"; do
  gc secrets add-iam-policy-binding "${SECRET_ID}" --member="${member}" \
    --role=roles/secretmanager.secretAccessor \
    --condition="expression=${SECRET_ACCESS_CONDITION},title=Access pinned relay credential version" --quiet >/dev/null
done

# The issuer alone receives the read/list, create-only, and encrypt/decrypt
# roles. The relay has no access to financial state or its wrapping key.
gc storage buckets add-iam-policy-binding "gs://${ISSUER_STATE_GCS_BUCKET}" \
  --member="${ISSUER_MEMBER}" --role=roles/storage.objectViewer --quiet >/dev/null
gc storage buckets add-iam-policy-binding "gs://${ISSUER_STATE_GCS_BUCKET}" \
  --member="${ISSUER_MEMBER}" --role=roles/storage.objectCreator --quiet >/dev/null
KMS_KEYRING="${ISSUER_STATE_KMS_KEY#*/keyRings/}"
KMS_KEYRING="${KMS_KEYRING%%/*}"
gc kms keys add-iam-policy-binding "${ISSUER_STATE_KMS_KEY##*/}" \
  --location="${GCP_REGION}" --keyring="${KMS_KEYRING}" \
  --member="${ISSUER_MEMBER}" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter --quiet >/dev/null

mkdir -p "${STATE_DIR}"
umask 077
cat > "${STATE_DIR}/merchant-auth.env" <<EOF
export GCP_WIF_PROVIDER=${WIF_PROVIDER_RESOURCE}
export ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION=projects/${GCP_PROJECT}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}
EOF

echo "WIF provider: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "Secret version: projects/${GCP_PROJECT}/secrets/${SECRET_ID}/versions/${SECRET_VERSION}"
echo "Deployment references saved to infra/gcp/.state/merchant-auth.env."
echo "Access is limited to the issuer and relay image digests recorded in infra/gcp/expected.json."
