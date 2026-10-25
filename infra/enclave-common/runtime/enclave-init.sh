#!/bin/sh
# enclave-init: the image ENTRYPOINT. It runs inside the enclave before the app.
#
# Nitro mode (default, ENCLAVE_MODE=nitro):
#   1. Bring up loopback. An enclave has no other network device.
#   2. Logs: app stdout/stderr -> FIFO -> vsock 3:LOG_PORT -> parent journald.
#   3. Egress: for each line in /etc/ifi/egress.conf, map the host to a
#      loopback IP in /etc/hosts and forward <ip>:<port> -> vsock 3:<vsock_port>.
#      The parent runs vsock-proxy on that port, allowlisted to that host only.
#      The app still opens TLS to the real hostname, so TLS ends in the enclave.
#   4. Ingress: vsock APP_PORT -> TCP 127.0.0.1:APP_PORT (the app's HTTPS server).
#      Boot config: vsock BOOT_CONFIG_PORT -> TCP 127.0.0.1:BOOT_CONFIG_PORT.
#   5. exec the app.
#
# Docker fallback mode (ENCLAVE_MODE=docker): skip all of the above and exec
# the app directly. It listens on 0.0.0.0 and uses normal DNS.
#
# This is POSIX sh (Debian dash), so no "pipefail".
set -eu

MODE="${ENCLAVE_MODE:-nitro}"
APP_PORT="${APP_PORT:-8443}"
BOOT_CONFIG_PORT="${BOOT_CONFIG_PORT:-7000}"
LOG_PORT="${LOG_PORT:-9000}"
EGRESS_CONF="${EGRESS_CONF:-/etc/ifi/egress.conf}"
PARENT_CID=3
LOG_FIFO=/run/ifi-log.fifo

if [ "$#" -eq 0 ]; then
  echo "enclave-init: no app command given" >&2
  exit 64
fi

case "$MODE" in
  docker)
    export ENCLAVE_LISTEN_HOST=0.0.0.0
    echo "enclave-init: DOCKER FALLBACK MODE. Mock attestation. No vsock." >&2
    exec "$@"
    ;;
  nitro) ;;
  *)
    echo "enclave-init: unknown ENCLAVE_MODE=$MODE" >&2
    exit 64
    ;;
esac
export ENCLAVE_LISTEN_HOST=127.0.0.1

# 1. Loopback.
ip link set dev lo up
ip addr add 127.0.0.1/8 dev lo 2>/dev/null || true

# 2. Logs. Hold the FIFO open read-write on fd 3, so a writer never gets
# SIGPIPE while the parent listener is down. Writes block only after the
# 64 KiB pipe buffer fills, and resume when the parent comes back.
mkdir -p /run
rm -f "$LOG_FIFO"
mkfifo "$LOG_FIFO"
exec 3<>"$LOG_FIFO"
(
  while :; do
    socat -u "OPEN:$LOG_FIFO,rdonly" "VSOCK-CONNECT:$PARENT_CID:$LOG_PORT" 2>/dev/null || true
    sleep 1
  done
) &
exec >"$LOG_FIFO" 2>&1
echo "enclave-init: logs -> vsock $PARENT_CID:$LOG_PORT"

# 3. Egress. No DNS server exists in the enclave, so only hosts listed here resolve.
printf '127.0.0.1 localhost\n' >/etc/hosts
printf '# no resolver inside the enclave; see /etc/hosts\n' >/etc/resolv.conf
next=1
while read -r vport host rport _rest; do
  case "$vport" in '' | '#'*) continue ;; esac
  ip_addr=$(awk -v h="$host" '$2 == h { print $1; exit }' /etc/hosts)
  if [ -z "$ip_addr" ]; then
    next=$((next + 1))
    ip_addr="127.0.10.$next"
    printf '%s %s\n' "$ip_addr" "$host" >>/etc/hosts
  fi
  socat "TCP-LISTEN:$rport,bind=$ip_addr,fork,reuseaddr" "VSOCK-CONNECT:$PARENT_CID:$vport" &
  echo "enclave-init: egress $host:$rport -> $ip_addr -> vsock $PARENT_CID:$vport"
done <"$EGRESS_CONF"

# 4. Ingress and boot config.
socat "VSOCK-LISTEN:$APP_PORT,fork,reuseaddr" "TCP:127.0.0.1:$APP_PORT" &
socat "VSOCK-LISTEN:$BOOT_CONFIG_PORT,fork,reuseaddr" "TCP:127.0.0.1:$BOOT_CONFIG_PORT" &
echo "enclave-init: ingress vsock:$APP_PORT -> 127.0.0.1:$APP_PORT, boot config vsock:$BOOT_CONFIG_PORT"

# 5. The app. Its stdout and stderr already point at the FIFO.
echo "enclave-init: starting: $*"
exec "$@"
