#!/bin/sh
set -eu

RELAY_IP="${WRAPS_RELAY_IP:-}"
[ -n "${RELAY_IP}" ] || { echo 'worker firewall requires a numeric relay IP' >&2; exit 70; }
RELAY_IP="${RELAY_IP}" node -e 'if (require("node:net").isIP(process.env.RELAY_IP) !== 4) process.exit(1)' \
  || { echo 'worker firewall supports only an IPv4 relay address' >&2; exit 70; }

# Fail closed before starting Node. DNS is explicitly dropped before loopback
# so Docker's embedded resolver cannot forward queries outside the container.
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -F INPUT
iptables -F OUTPUT
iptables -F FORWARD
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j DROP
iptables -A OUTPUT -p tcp --dport 53 -j DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp -d "${RELAY_IP}" --dport 443 -j ACCEPT
iptables -A OUTPUT -p tcp -d "${RELAY_IP}" --dport 8080 -j ACCEPT

# If the container has IPv6 enabled, apply a separate default-drop policy.
# There is no IPv6 exception because GCP relay endpoints are IPv4 here.
if [ -e /proc/net/if_inet6 ]; then
  command -v ip6tables >/dev/null 2>&1 || { echo 'IPv6 is enabled but ip6tables is unavailable' >&2; exit 70; }
  ip6tables -P INPUT DROP
  ip6tables -P OUTPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -F INPUT
  ip6tables -F OUTPUT
  ip6tables -F FORWARD
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -p udp --dport 53 -j DROP
  ip6tables -A OUTPUT -p tcp --dport 53 -j DROP
  ip6tables -A OUTPUT -o lo -j ACCEPT
fi

# The Node worker does not keep NET_ADMIN after the rules are installed.
exec setpriv --reuid=node --regid=node --init-groups \
  --bounding-set=-net_admin,-setuid,-setgid \
  --inh-caps=-net_admin,-setuid,-setgid --ambient-caps=-net_admin,-setuid,-setgid "$@"
