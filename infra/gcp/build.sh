#!/usr/bin/env bash
# Builds a workload image with Cloud Build, pushes it to Artifact Registry, prints
# its digest, and writes the digest to expected.json (which the SDK reads).
#   infra/gcp/build.sh issuer
source "$(dirname "$0")/lib.sh"
ROLE="${1:-}"; check_role "${ROLE}"

TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)$(git -C "${REPO_ROOT}" diff --quiet HEAD -- packages package.json package-lock.json infra/gcp || echo -dirty)"
IMAGE="${REGISTRY}/${ROLE}"
MERCHANT_AUTH_KEYS_B64=''
MERCHANT_AUTH_KEY_FINGERPRINT=''
if [ "${ROLE}" = issuer ]; then
  [ -n "${ISSUER_MERCHANT_AUTH_KEYS:-}" ] || die "ISSUER_MERCHANT_AUTH_KEYS is required to build an issuer image"
  MERCHANT_AUTH_KEY_FINGERPRINT="$(ISSUER_MERCHANT_AUTH_KEYS="${ISSUER_MERCHANT_AUTH_KEYS}" node -e '
    const { createPublicKey, createHash } = require("node:crypto");
    const raw = process.env.ISSUER_MERCHANT_AUTH_KEYS;
    let map;
    try { map = JSON.parse(raw); } catch { throw new Error("ISSUER_MERCHANT_AUTH_KEYS must be a JSON object"); }
    if (!map || Array.isArray(map) || typeof map !== "object" || Object.keys(map).length === 0) throw new Error("ISSUER_MERCHANT_AUTH_KEYS must contain at least one merchant public key");
    for (const [id, encoded] of Object.entries(map)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || typeof encoded !== "string") throw new Error("invalid merchant public key entry");
      const der = Buffer.from(encoded, "base64url");
      if (der.toString("base64url") !== encoded || createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") throw new Error("merchant public keys must be canonical base64url Ed25519 SPKI keys");
    }
    process.stdout.write(createHash("sha256").update(raw).digest("hex"));
  ' )" || die "invalid ISSUER_MERCHANT_AUTH_KEYS"
  MERCHANT_AUTH_KEYS_B64="$(printf '%s' "${ISSUER_MERCHANT_AUTH_KEYS}" | base64 | tr -d '\n')"
  TAG="${TAG}-auth${MERCHANT_AUTH_KEY_FINGERPRINT:0:12}"
fi

echo "Building ${IMAGE}:${TAG} with Cloud Build (project ${GCP_PROJECT})..."
cd "${REPO_ROOT}"
gc builds submit . \
  --region="${GCP_REGION}" \
  --config=infra/gcp/cloudbuild.yaml \
  --ignore-file=infra/gcp/.gcloudignore \
  --substitutions="_ROLE=${ROLE},_IMAGE=${IMAGE},_TAG=${TAG},_MERCHANT_AUTH_KEYS_B64=${MERCHANT_AUTH_KEYS_B64}"

DIGEST="$(gc artifacts docker images describe "${IMAGE}:${TAG}" --format='value(image_summary.digest)')"
[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not read the image digest (got '${DIGEST}')"
REF="${IMAGE}@${DIGEST}"

MERCHANT_AUTH_KEY_FINGERPRINT="${MERCHANT_AUTH_KEY_FINGERPRINT}" node -e '
  const fs = require("fs");
  const [path, role, digest, ref, tag] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  j.roles = j.roles || {};
  j.roles[role] = { imageDigest: digest, imageReference: ref, tag, builtAt: new Date().toISOString() };
  if (role === "issuer") j.roles[role].merchantAuthKeyFingerprint = process.env.MERCHANT_AUTH_KEY_FINGERPRINT;
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
' "${EXPECTED_JSON}" "${ROLE}" "${DIGEST}" "${REF}" "${TAG}"

echo
echo "image digest: ${DIGEST}"
echo "reference:    ${REF}"
echo "written to:   infra/gcp/expected.json (roles.${ROLE})"
