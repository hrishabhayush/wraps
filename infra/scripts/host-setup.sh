#!/usr/bin/env bash
# host-setup.sh <issuer|relay>   (INF-06)
#
# Prepares an Amazon Linux 2023 EC2 host (enclave option on) to build and run
# one Nitro Enclave. Safe to run again.
#   - installs docker, aws-nitro-enclaves-cli (+devel), socat, jq, git
#   - adds the current user to the docker and ne groups
#   - writes /etc/nitro_enclaves/allocator.yaml from infra/config/<role>.env
#   - enables docker and the enclave allocator
#   - disables the stock KMS vsock-proxy unit (deploy.sh runs our own proxies)
#   - installs the ifi-* systemd units
#   - installs the docker buildx plugin if missing
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_role "${1:-}"
ROLE="$1"
load_role_config "$ROLE"

BUILDX_VERSION=v0.17.1
TARGET_USER="${SUDO_USER:-$(id -un)}"

if ! grep -q 'Amazon Linux' /etc/os-release 2>/dev/null; then
  warn "this script targets Amazon Linux 2023; continuing anyway"
fi
if [[ ! -e /dev/nitro_enclaves ]]; then
  warn "/dev/nitro_enclaves is missing. Was the instance launched with --enclave-options Enabled=true?"
fi

log "installing packages"
as_root dnf install -y docker aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel socat jq git

log "adding $TARGET_USER to groups docker and ne"
as_root usermod -aG docker,ne "$TARGET_USER"

log "writing /etc/nitro_enclaves/allocator.yaml (cpu_count=$ENCLAVE_CPUS memory_mib=$ENCLAVE_MEMORY_MIB)"
as_root install -d -m 0755 /etc/nitro_enclaves
printf -- '---\n# Written by infra/scripts/host-setup.sh for role %s.\n# Memory and CPUs reserved for enclaves. The parent loses them.\nmemory_mib: %s\ncpu_count: %s\n' \
  "$ROLE" "$ENCLAVE_MEMORY_MIB" "$ENCLAVE_CPUS" | as_root tee /etc/nitro_enclaves/allocator.yaml >/dev/null

log "enabling docker and the enclave allocator"
as_root systemctl enable --now docker
as_root systemctl enable nitro-enclaves-allocator.service
if ! as_root systemctl restart nitro-enclaves-allocator.service; then
  as_root journalctl -u nitro-enclaves-allocator.service -n 30 --no-pager >&2 || true
  die "allocator failed. Lower ENCLAVE_MEMORY_MIB in infra/config/$ROLE.env or use a bigger instance."
fi

# The stock unit proxies to KMS. Our allowlist does not include KMS, so it would only fail.
as_root systemctl disable --now nitro-enclaves-vsock-proxy.service >/dev/null 2>&1 || true

log "installing ifi systemd units"
as_root install -d -m 0755 "$IFI_ETC" "$IFI_ETC/egress"
as_root install -m 0644 "$INFRA_DIR"/systemd/ifi-*.service "$INFRA_DIR"/systemd/ifi-*.target /etc/systemd/system/
as_root systemctl daemon-reload

if ! docker_cmd buildx version >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  log "installing docker buildx $BUILDX_VERSION"
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-$arch"
  log "buildx sha256: $(sha256sum "$tmp" | cut -d' ' -f1)  (compare with the release page if you care)"
  as_root install -d /usr/local/lib/docker/cli-plugins
  as_root install -m 0755 "$tmp" /usr/local/lib/docker/cli-plugins/docker-buildx
  rm -f "$tmp"
fi

log "checks"
nitro-cli --version
docker_cmd buildx version
if socat -V 2>/dev/null | grep -q 'WITH_VSOCK 1'; then
  log "socat has VSOCK support"
else
  die "this socat has no VSOCK support (need socat >= 1.7.4)"
fi
command -v vsock-proxy >/dev/null || die "vsock-proxy not found (it ships with aws-nitro-enclaves-cli)"

log "done. Log out and back in (or run 'newgrp docker') so the group changes apply."
log "next: infra/scripts/smoke-hello.sh"
