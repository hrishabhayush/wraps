#!/bin/sh
set -eu

if [ "${WG_ENABLED:-false}" = true ]; then
  if ! mount -o remount,rw /proc/sys >/dev/null 2>&1; then
    echo '[relay] guest forwarding setup failed (proc-remount-denied)' >&2
    exit 1
  fi
  if ! sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; then
    mount -o remount,ro /proc/sys >/dev/null 2>&1 || true
    echo '[relay] guest forwarding setup failed (sysctl-write-denied)' >&2
    exit 1
  fi
  if ! mount -o remount,ro /proc/sys >/dev/null 2>&1; then
    echo '[relay] guest forwarding setup failed (proc-remount-readonly-failed)' >&2
    exit 1
  fi

  # Keep the broader bootstrap capability out of the relay application.
  exec setpriv --bounding-set=-sys_admin --inh-caps=-sys_admin --ambient-caps=-sys_admin node /app/relay.mjs
fi

exec node /app/relay.mjs
