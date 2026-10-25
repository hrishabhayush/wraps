#!/usr/bin/env bash
# status.sh   (INF-20)
#
# Shows the enclave, its PCR0 against infra/pcrs.json, the ifi services, the
# fallback container, and live /healthz and /attestation answers. Read-only.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq curl

ROLE="unknown"
PUBLIC_PORT=443
if [[ -r "$IFI_ETC/ifi.env" ]]; then
  # shellcheck disable=SC1091
  source "$IFI_ETC/ifi.env"
fi

echo "== host: $(hostname)  role: $ROLE"

echo "== enclave"
if command -v nitro-cli >/dev/null; then
  desc="$(nitro_cli describe-enclaves 2>/dev/null || echo '[]')"
  if [[ "$(jq length <<<"$desc")" == "0" ]]; then
    echo "  none running"
  else
    jq -r '.[] | "  \(.EnclaveName // "-")  id=\(.EnclaveID)  state=\(.State)  flags=\(.Flags)  cid=\(.EnclaveCID)  cpus=\(.NumberOfCPUs)  mem=\(.MemoryMiB)MiB"' <<<"$desc"
    live="$(jq -r '.[0].Measurements.PCR0 // empty' <<<"$desc")"
    pub="$(jq -r --arg r "$ROLE" '.enclaves[$r].pcr0 // empty' "$PCRS_FILE" 2>/dev/null || true)"
    echo "  PCR0 live      ${live:-?}"
    echo "  PCR0 pcrs.json ${pub:-?}"
    if [[ -n "$live" && -n "$pub" ]]; then
      [[ "$live" == "$pub" ]] && echo "  -> match" || echo "  -> MISMATCH"
    fi
    [[ "$(jq -r '.[0].Flags' <<<"$desc")" == "NONE" ]] || echo "  -> WARNING: not production mode"
  fi
else
  echo "  nitro-cli not installed"
fi

echo "== services"
for unit in nitro-enclaves-allocator.service ifi-logs.service ifi-ingress.service \
  $(systemctl list-units --all --plain --no-legend 'ifi-egress@*' 2>/dev/null | awk '{print $1}'); do
  printf '  %-36s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
done

echo "== fallback container"
fb="$(as_root docker ps --filter 'name=ifi-.*-fallback' --format '{{.Names}} {{.Status}}' 2>/dev/null || true)"
echo "  ${fb:-none}"

echo "== endpoints (port $PUBLIC_PORT)"
if curl -fsk --max-time 3 "https://127.0.0.1:$PUBLIC_PORT/healthz" >/dev/null 2>&1; then
  echo "  /healthz      OK"
else
  echo "  /healthz      not responding"
fi
att="$(curl -fsk --max-time 5 "https://127.0.0.1:$PUBLIC_PORT/attestation?nonce=$(random_nonce_hex)" 2>/dev/null || true)"
if [[ -n "$att" ]]; then
  jq -r '"  /attestation  provider=\(.provider)  keys=\(.publicKeys | keys | join(","))  document=\(.document | length) b64 chars"' <<<"$att" 2>/dev/null ||
    echo "  /attestation  answered, but not with JSON"
else
  echo "  /attestation  not responding"
fi
