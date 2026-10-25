#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DEMO_AGENT_WORKER_IMAGE:-wraps-demo-agent-worker:local}"
BUILD_CONTEXT="$(mktemp -d)"
trap 'rm -rf "${BUILD_CONTEXT}"' EXIT

# Use an allowlisted context so local .env files, Keychain exports, .state and
# unrelated worktrees never enter Docker's build context.
cp "${REPO_ROOT}/package.json" "${REPO_ROOT}/package-lock.json" "${REPO_ROOT}/tsconfig.json" "${BUILD_CONTEXT}/"
mkdir -p "${BUILD_CONTEXT}/packages" "${BUILD_CONTEXT}/apps/demo/src" "${BUILD_CONTEXT}/scripts"
for manifest in "${REPO_ROOT}"/packages/*/package.json "${REPO_ROOT}"/apps/*/package.json; do
  [ -f "${manifest}" ] || continue
  relative="${manifest#"${REPO_ROOT}/"}"
  mkdir -p "${BUILD_CONTEXT}/$(dirname "${relative}")"
  cp "${manifest}" "${BUILD_CONTEXT}/${relative}"
done
for package in agent attestation issuer merchant sdk tokens; do
  mkdir -p "${BUILD_CONTEXT}/packages/${package}"
  cp -R "${REPO_ROOT}/packages/${package}/src" "${BUILD_CONTEXT}/packages/${package}/src"
done
cp "${REPO_ROOT}/apps/demo/src/agent-worker.ts" "${BUILD_CONTEXT}/apps/demo/src/agent-worker.ts"
cp "${REPO_ROOT}/apps/demo/worker-entrypoint.sh" "${BUILD_CONTEXT}/apps/demo/worker-entrypoint.sh"
cp "${REPO_ROOT}/scripts/live-config.ts" "${BUILD_CONTEXT}/scripts/live-config.ts"

docker build --file "${REPO_ROOT}/apps/demo/Dockerfile.agent-worker" --tag "${IMAGE}" "${BUILD_CONTEXT}"
echo "Built isolated demo agent image ${IMAGE}."
