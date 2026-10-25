#!/bin/bash
# Assemble what the one-click VPN bundles into Wraps.app (run before `tauri build`):
#   binaries/node-<triple>          official Node.js (runs the connect helper)
#   binaries/wg-<triple>            WireGuard userspace tools
#   binaries/wireguard-go-<triple>  WireGuard implementation (utun)
#   resources/wraps-connect.mjs     verify attestation or register the app's own blind token
# Requires: Homebrew `wireguard-tools wireguard-go`, and npm install at the repo root.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"; root="$(cd "$here/.." && pwd)"
triple="$(rustc -vV | awk '/^host:/{print $2}')"
node_version=v22.11.0
case "$triple" in aarch64-apple-darwin) node_arch=darwin-arm64 ;; x86_64-apple-darwin) node_arch=darwin-x64 ;; *) echo "macOS only for now" >&2; exit 1 ;; esac
bin="$here/src-tauri/binaries"; res="$here/src-tauri/resources"; mkdir -p "$bin" "$res"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tarball="node-$node_version-$node_arch.tar.gz"
curl -sSfL "https://nodejs.org/dist/$node_version/$tarball" -o "$tmp/$tarball"
(cd "$tmp" && curl -sSfL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" | grep " $tarball\$" | shasum -a 256 -c -)
tar -xzf "$tmp/$tarball" -C "$tmp" "node-$node_version-$node_arch/bin/node"
install -m 755 "$tmp/node-$node_version-$node_arch/bin/node" "$bin/node-$triple"
install -m 755 "$(brew --prefix)/bin/wg" "$bin/wg-$triple"
install -m 755 "$(brew --prefix)/bin/wireguard-go" "$bin/wireguard-go-$triple"

(cd "$root" && npx esbuild "$here/scripts/wireguard-register.ts" --bundle --platform=node --format=esm --target=node22 --legal-comments=none \
  "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$res/wraps-connect.mjs")
echo "VPN bundle ready for $triple"
