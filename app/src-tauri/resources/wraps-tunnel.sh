#!/bin/bash
# Bring the wraps WireGuard tunnel up or down on macOS. Runs as root (the app asks
# for the admin password once). Uses the wg and wireguard-go binaries bundled in
# the app, so the user installs nothing.
#   wraps-tunnel.sh up   <bin-dir> <conf> <address/32> <endpoint-ip>
#   wraps-tunnel.sh down <bin-dir>
set -euo pipefail
cmd="$1"; bin="$2"
state=/var/run/wraps; mkdir -p "$state" /var/run/wireguard
service="$(networksetup -listnetworkserviceorder | awk -F'\\) ' '/^\([0-9]+\)/{print $2; exit}')"

down() {
  if [ -f "$state/iface" ]; then
    iface="$(cat "$state/iface")"
    rm -f "/var/run/wireguard/$iface.sock"            # stops wireguard-go and removes the utun
    [ -f "$state/endpoint" ] && route -q -n delete -inet "$(cat "$state/endpoint")" >/dev/null 2>&1 || true
    if [ -f "$state/dns" ] && [ -n "$service" ]; then
      prev="$(cat "$state/dns")"
      if [ "$prev" = none ]; then networksetup -setdnsservers "$service" empty; else networksetup -setdnsservers "$service" $prev; fi
    fi
  fi
  rm -f "$state/iface" "$state/endpoint" "$state/dns"
}

case "$cmd" in
  up)
    conf="$3"; address="$4"; endpoint="$5"
    down
    gw="$(route -n get default | awk '/gateway:/{print $2}')"
    WG_TUN_NAME_FILE="$state/iface" "$bin/wireguard-go" utun
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$state/iface" ] && break; sleep 0.2; done
    iface="$(cat "$state/iface")"
    "$bin/wg" setconf "$iface" "$conf"
    ip="${address%/*}"
    ifconfig "$iface" inet "$ip" "$ip" netmask 255.255.255.255 up
    route -q -n add -inet "$endpoint" "$gw" >/dev/null   # keep the encrypted UDP on the real network
    echo "$endpoint" > "$state/endpoint"
    route -q -n add -inet 0.0.0.0/1 -interface "$iface" >/dev/null
    route -q -n add -inet 128.0.0.0/1 -interface "$iface" >/dev/null
    if [ -n "$service" ]; then
      cur="$(networksetup -getdnsservers "$service" | tr '\n' ' ')"
      case "$cur" in *"aren't any"*) echo none > "$state/dns" ;; *) echo "$cur" > "$state/dns" ;; esac
      networksetup -setdnsservers "$service" 1.1.1.1
    fi
    echo "up $iface"
    ;;
  down) down; echo down ;;
  *) echo "usage: $0 up|down ..." >&2; exit 2 ;;
esac
