#!/usr/bin/env bash
# smoke-hello.sh   (INF-06 "done when")
#
# Builds and runs the AWS hello-world enclave, prints its console for a few
# seconds, then terminates it. It uses --debug-mode ONLY so the console is
# readable. Never use --debug-mode for the issuer or relay.
#
# It refuses to run while another enclave is up, so it cannot kill the demo.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need nitro-cli jq

HELLO_DIR=/usr/share/nitro_enclaves/examples/hello
EIF="$BUILD_DIR/hello.eif"

[[ -d "$HELLO_DIR" ]] || die "$HELLO_DIR missing. Install aws-nitro-enclaves-cli-devel."
[[ "$(running_enclaves)" == "0" ]] || die "an enclave is already running. Not touching it."

mkdir -p "$BUILD_DIR"
log "building hello.eif"
nitro_cli build-enclave --docker-dir "$HELLO_DIR" --docker-uri hello:latest --output-file "$EIF" >/dev/null

log "running hello enclave (debug mode, smoke test only)"
out="$(nitro_cli run-enclave --cpu-count 2 --memory 512 --eif-path "$EIF" --debug-mode)"
id="$(jq -r '.EnclaveID' <<<"$out")"
trap 'nitro_cli terminate-enclave --enclave-id "$id" >/dev/null 2>&1 || true' EXIT

log "console for 15 s (you should see 'Hello from the enclave side!')"
nitro_cli console --enclave-id "$id" --disconnect-timeout 15 || true

log "PASS if you saw the hello lines above. Terminating."
