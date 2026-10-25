#!/usr/bin/env bash
# Builds a workload image with Cloud Build, pushes it to Artifact Registry, prints
# its digest, and writes the digest to expected.json (which the SDK reads).
#   infra/gcp/build.sh issuer
source "$(dirname "$0")/lib.sh"
ROLE="${1:-}"; check_role "${ROLE}"

TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)$(git -C "${REPO_ROOT}" diff --quiet HEAD -- packages package.json package-lock.json infra/gcp || echo -dirty)"
IMAGE="${REGISTRY}/${ROLE}"

echo "Building ${IMAGE}:${TAG} with Cloud Build (project ${GCP_PROJECT})..."
cd "${REPO_ROOT}"
gc builds submit . \
  --region="${GCP_REGION}" \
  --config=infra/gcp/cloudbuild.yaml \
  --ignore-file=infra/gcp/.gcloudignore \
  --substitutions="_ROLE=${ROLE},_IMAGE=${IMAGE},_TAG=${TAG}"

DIGEST="$(gc artifacts docker images describe "${IMAGE}:${TAG}" --format='value(image_summary.digest)')"
[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not read the image digest (got '${DIGEST}')"
REF="${IMAGE}@${DIGEST}"

node -e '
  const fs = require("fs");
  const [path, role, digest, ref, tag] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  j.roles = j.roles || {};
  j.roles[role] = { imageDigest: digest, imageReference: ref, tag, builtAt: new Date().toISOString() };
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
' "${EXPECTED_JSON}" "${ROLE}" "${DIGEST}" "${REF}" "${TAG}"

echo
echo "image digest: ${DIGEST}"
echo "reference:    ${REF}"
echo "written to:   infra/gcp/expected.json (roles.${ROLE})"
