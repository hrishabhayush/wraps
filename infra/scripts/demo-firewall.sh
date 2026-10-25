#!/usr/bin/env bash
# demo-firewall.sh   (INF-22)
#
# On the machine that runs the agent: allow outbound traffic only to the relay,
# so nothing leaks around the tunnel. macOS uses pf, Linux uses iptables.
#
#   sudo infra/scripts/demo-firewall.sh apply <relay-ip> [--port 443] [--allow <ip|cidr>]...
#   sudo infra/scripts/demo-firewall.sh status
#   sudo infra/scripts/demo-firewall.sh undo
#
# Loopback stays open (the local demo UI). DNS is blocked: give the relay as an IP.
# The agent sends merchant hostnames inside CONNECT, so it needs no local DNS.
# --allow opens one more destination, e.g. the LLM API the agent's model uses.
# Every --allow is a hole in the "only the tunnel" claim; keep the list short.
set -euo pipefail

ANCHOR="com.apple/250.ifi-demo"
PF_TOKEN_FILE=/var/tmp/ifi-demo-pf.token
CHAIN=IFI_DEMO_OUT

die() {
  echo "demo-firewall: ERROR: $*" >&2
  exit 1
}
log() { echo "demo-firewall: $*" >&2; }

[[ "$(id -u)" -eq 0 ]] || die "run with sudo"

cmd="${1:-}"
shift || true
RELAY=""
PORT=443
ALLOW=()
if [[ "$cmd" == "apply" ]]; then
  RELAY="${1:-}"
  shift || true
  [[ "$RELAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "apply needs the relay's IPv4 address (not a hostname)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="${2:?}"; shift 2 ;;
      --allow) ALLOW+=("${2:?}"); shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
fi

self_test() {
  local ok=1
  if curl -s --max-time 4 -o /dev/null https://1.1.1.1/ 2>/dev/null; then
    echo "  FAIL: https://1.1.1.1 is reachable (should be blocked)"
    ok=0
  else
    echo "  ok:   https://1.1.1.1 is blocked"
  fi
  if [[ -n "$RELAY" ]]; then
    if curl -sk --max-time 4 -o /dev/null "https://$RELAY:$PORT/healthz"; then
      echo "  ok:   relay $RELAY:$PORT is reachable"
    else
      echo "  WARN: relay $RELAY:$PORT did not answer (is it up?)"
    fi
  fi
  [[ "$ok" -eq 1 ]]
}

# ---------------- macOS (pf) ----------------
mac_apply() {
  local rules a
  rules="pass out quick on lo0 all
pass out quick inet proto tcp from any to $RELAY port $PORT keep state"
  for a in "${ALLOW[@]+"${ALLOW[@]}"}"; do
    rules+=$'\n'"pass out quick from any to $a keep state"
  done
  rules+=$'\n'"block drop out quick all"
  # Load the stock ruleset so the com.apple/* anchor point exists.
  pfctl -q -f /etc/pf.conf 2>/dev/null || true
  printf '%s\n' "$rules" | pfctl -q -a "$ANCHOR" -f -
  if [[ ! -s "$PF_TOKEN_FILE" ]]; then
    pfctl -E 2>&1 | awk '/Token/ {print $NF}' >"$PF_TOKEN_FILE"
  fi
  log "pf rules loaded into anchor $ANCHOR:"
  pfctl -a "$ANCHOR" -s rules 2>/dev/null | sed 's/^/  /'
}
mac_undo() {
  pfctl -q -a "$ANCHOR" -F all 2>/dev/null || true
  if [[ -s "$PF_TOKEN_FILE" ]]; then
    pfctl -q -X "$(cat "$PF_TOKEN_FILE")" 2>/dev/null || true
    rm -f "$PF_TOKEN_FILE"
  fi
  log "pf anchor flushed, pf enable token released"
}
mac_status() {
  pfctl -a "$ANCHOR" -s rules 2>/dev/null | sed 's/^/  /' || true
  pfctl -s info 2>/dev/null | head -n1 | sed 's/^/  /'
}

# ---------------- Linux (iptables + ip6tables) ----------------
linux_apply() {
  local a
  command -v iptables >/dev/null || die "iptables not found"
  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
  iptables -A "$CHAIN" -o lo -j ACCEPT
  iptables -A "$CHAIN" -p tcp -d "$RELAY" --dport "$PORT" -j ACCEPT
  for a in "${ALLOW[@]+"${ALLOW[@]}"}"; do iptables -A "$CHAIN" -d "$a" -j ACCEPT; done
  iptables -A "$CHAIN" -j REJECT
  iptables -C OUTPUT -j "$CHAIN" 2>/dev/null || iptables -I OUTPUT 1 -j "$CHAIN"
  if command -v ip6tables >/dev/null; then
    ip6tables -N "$CHAIN" 2>/dev/null || ip6tables -F "$CHAIN"
    ip6tables -A "$CHAIN" -o lo -j ACCEPT
    ip6tables -A "$CHAIN" -j REJECT
    ip6tables -C OUTPUT -j "$CHAIN" 2>/dev/null || ip6tables -I OUTPUT 1 -j "$CHAIN"
  fi
  log "iptables chain $CHAIN installed:"
  iptables -S "$CHAIN" | sed 's/^/  /'
  log "note: traffic from Docker containers uses FORWARD, not OUTPUT. Run the agent on the host."
}
linux_undo() {
  local t
  for t in iptables ip6tables; do
    command -v "$t" >/dev/null || continue
    while "$t" -D OUTPUT -j "$CHAIN" 2>/dev/null; do :; done
    "$t" -F "$CHAIN" 2>/dev/null || true
    "$t" -X "$CHAIN" 2>/dev/null || true
  done
  log "iptables chain $CHAIN removed"
}
linux_status() {
  iptables -S "$CHAIN" 2>/dev/null | sed 's/^/  /' || echo "  not installed"
}

case "$(uname -s)-$cmd" in
  Darwin-apply) mac_apply; self_test ;;
  Darwin-undo) mac_undo ;;
  Darwin-status) mac_status ;;
  Linux-apply) linux_apply; self_test ;;
  Linux-undo) linux_undo ;;
  Linux-status) linux_status ;;
  *) die "usage: demo-firewall.sh apply <relay-ip> [--port N] [--allow ip|cidr]... | status | undo" ;;
esac
