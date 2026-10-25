#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DEMO_AGENT_WORKER_IMAGE:-wraps-demo-agent-worker:local}"
NETWORK="wraps-demo-egress-test-$$"
OCTET=$((100 + ($$ % 100)))
SUBNET="172.29.${OCTET}.0/28"
RELAY_IP="172.29.${OCTET}.2"
DENIED_IP="172.29.${OCTET}.3"
RELAY_NAME="wraps-egress-relay-$$"
DENIED_NAME="wraps-egress-denied-$$"

cleanup() {
  docker rm -f "${RELAY_NAME}" "${DENIED_NAME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${REPO_ROOT}/scripts/build-demo-agent-worker.sh"
docker network create --internal --driver bridge --subnet="${SUBNET}" "${NETWORK}" >/dev/null
docker run --detach --rm --name "${RELAY_NAME}" --network "${NETWORK}" --ip "${RELAY_IP}" --entrypoint node \
  --mount "type=bind,src=${REPO_ROOT}/apps/demo/test/egress/mock-endpoint.mjs,dst=/run/mock-endpoint.mjs,readonly" \
  "${IMAGE}" /run/mock-endpoint.mjs >/dev/null
docker run --detach --rm --name "${DENIED_NAME}" --network "${NETWORK}" --ip "${DENIED_IP}" --entrypoint node \
  --mount "type=bind,src=${REPO_ROOT}/apps/demo/test/egress/mock-endpoint.mjs,dst=/run/mock-endpoint.mjs,readonly" \
  "${IMAGE}" /run/mock-endpoint.mjs >/dev/null

for attempt in $(seq 1 20); do
  if docker logs "${RELAY_NAME}" 2>&1 | rg -q '^MOCK_READY$' && docker logs "${DENIED_NAME}" 2>&1 | rg -q '^MOCK_READY$'; then break; fi
  sleep 0.25
done
docker logs "${RELAY_NAME}" 2>&1 | rg -q '^MOCK_READY$'
docker logs "${DENIED_NAME}" 2>&1 | rg -q '^MOCK_READY$'

# Prove the mock non-relay destination and DNS endpoint are reachable before
# the filtered worker is started. This makes the deny checks meaningful.
docker run --rm --network "${NETWORK}" --entrypoint node \
  --mount "type=bind,src=${REPO_ROOT}/apps/demo/test/egress/control.mjs,dst=/run/control.mjs,readonly" \
  --env "WRAPS_EGRESS_TEST_DENIED_IP=${DENIED_IP}" "${IMAGE}" /run/control.mjs

docker run --rm --network "${NETWORK}" --cap-drop=ALL --cap-add=NET_ADMIN --cap-add=SETUID --cap-add=SETGID \
  --security-opt=no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --dns=127.0.0.1 --dns-search=. \
  --mount "type=bind,src=${REPO_ROOT}/apps/demo/test/egress/probe.mjs,dst=/run/probe.mjs,readonly" \
  --env "WRAPS_RELAY_IP=${RELAY_IP}" --env "WRAPS_EGRESS_TEST_DENIED_IP=${DENIED_IP}" \
  "${IMAGE}" node /run/probe.mjs

DNS_COUNT="$(docker logs "${DENIED_NAME}" 2>&1 | rg -c '^DNS_QUERY$' || true)"
[ "${DNS_COUNT}" = 1 ] || { echo "expected only the unfiltered control DNS query; observed ${DNS_COUNT}" >&2; exit 1; }
echo 'Container egress policy allowed only the mock relay IP on TCP 443/8080; other IP and DNS traffic were dropped.'
