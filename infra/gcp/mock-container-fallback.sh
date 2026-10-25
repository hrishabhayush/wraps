#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

RUNTIME=${CONTAINER_RUNTIME:-docker}
RUN_ID=$$
NETWORK=wraps-mock-fallback-$RUN_ID
ISSUER_CONTAINER=wraps-issuer-mock-$RUN_ID
RELAY_CONTAINER=wraps-relay-mock-$RUN_ID
ISSUER_PORT=${WRAPS_MOCK_ISSUER_PORT:-4401}
RELAY_PORT=${WRAPS_MOCK_RELAY_PORT:-4443}
ATTESTATION_PORT=${WRAPS_MOCK_ATTESTATION_PORT:-48080}

cleanup() {
  "$RUNTIME" rm -f "$RELAY_CONTAINER" "$ISSUER_CONTAINER" >/dev/null 2>&1 || true
  "$RUNTIME" network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$RUNTIME" build -f infra/gcp/issuer.Dockerfile -t wraps-issuer:mock-fallback .
"$RUNTIME" build -f infra/gcp/relay.Dockerfile -t wraps-relay:mock-fallback .
"$RUNTIME" network create "$NETWORK" >/dev/null

"$RUNTIME" run -d --name "$ISSUER_CONTAINER" --network "$NETWORK" --network-alias issuer \
  -p "$ISSUER_PORT:443" \
  -e ATTESTATION=mock -e ISSUER_TLS=1 -e ISSUER_HOST=0.0.0.0 -e ISSUER_PORT=443 \
  wraps-issuer:mock-fallback >/dev/null

"$RUNTIME" run -d --name "$RELAY_CONTAINER" --network "$NETWORK" \
  -p "$RELAY_PORT:443" -p "$ATTESTATION_PORT:8080" \
  -e ATTESTATION=mock -e ISSUER_URL=https://issuer:443 -e RELAY_HOSTNAME=relay.local \
  -e RELAY_PROXY_HOST=0.0.0.0 -e RELAY_PROXY_PORT=443 \
  -e RELAY_ATTESTATION_HOST=0.0.0.0 -e RELAY_ATTESTATION_PORT=8080 \
  wraps-relay:mock-fallback >/dev/null

ready=0
for _ in $(seq 1 30); do
  if curl --silent --show-error --insecure --fail "https://127.0.0.1:$ISSUER_PORT/health" >/dev/null 2>&1 && \
     curl --silent --show-error --fail "http://127.0.0.1:$ATTESTATION_PORT/attestation?nonce=0000000000000000000000000000000000000000000000000000000000000000" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "local issuer/relay containers did not become ready" >&2
  "$RUNTIME" logs "$ISSUER_CONTAINER" >&2 || true
  "$RUNTIME" logs "$RELAY_CONTAINER" >&2 || true
  exit 1
fi

WRAPS_MOCK_ISSUER_PORT="$ISSUER_PORT" \
WRAPS_MOCK_RELAY_PORT="$RELAY_PORT" \
WRAPS_MOCK_ATTESTATION_PORT="$ATTESTATION_PORT" \
  npx tsx infra/gcp/mock-container-probe.ts
