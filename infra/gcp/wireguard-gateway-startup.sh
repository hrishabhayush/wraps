#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/wraps-wireguard-startup.log) 2>&1
trap 'status=$?; echo "WireGuard gateway startup failed (exit ${status})" >&2; exit "${status}"' ERR

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends curl iproute2 iptables wireguard-tools

PEER_PUBLIC_KEY="$(curl --fail --silent --show-error -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/wg-peer-public-key)"
if [[ ! "${PEER_PUBLIC_KEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo 'Invalid WireGuard peer public key metadata' >&2
  exit 1
fi
KEY_BYTES="$(printf '%s' "${PEER_PUBLIC_KEY}" | base64 --decode | wc -c | tr -d '[:space:]')"
CANONICAL_KEY="$(printf '%s' "${PEER_PUBLIC_KEY}" | base64 --decode | base64 | tr -d '\n')"
if [[ "${KEY_BYTES}" != 32 || "${CANONICAL_KEY}" != "${PEER_PUBLIC_KEY}" ]]; then
  echo 'WireGuard peer public key metadata is not canonical 32-byte base64' >&2
  exit 1
fi

EGRESS_INTERFACE="$(ip -4 route show default | awk 'NR == 1 { print $5 }')"
if [[ ! "${EGRESS_INTERFACE}" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then
  echo 'Could not identify the IPv4 egress interface' >&2
  exit 1
fi

cat > /etc/sysctl.d/99-wraps-wireguard.conf <<'SYSCTL'
net.ipv4.ip_forward=1
SYSCTL
sysctl -w net.ipv4.ip_forward=1

CHAIN=WRAPS_WG_FORWARD
iptables -N "${CHAIN}" 2>/dev/null || true
iptables -F "${CHAIN}"
for destination in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
  169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
  192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 \
  198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A "${CHAIN}" -i wg0 -d "${destination}" -j REJECT
done
iptables -A "${CHAIN}" -i wg0 ! -s 10.77.0.0/24 -j DROP
iptables -A "${CHAIN}" -i wg0 -o "${EGRESS_INTERFACE}" -s 10.77.0.0/24 -j ACCEPT
iptables -A "${CHAIN}" -i "${EGRESS_INTERFACE}" -o wg0 -d 10.77.0.0/24 \
  -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -A "${CHAIN}" -i wg0 -j DROP
while iptables -D FORWARD -i wg0 -j "${CHAIN}" 2>/dev/null; do :; done
while iptables -D FORWARD -o wg0 -j "${CHAIN}" 2>/dev/null; do :; done
iptables -I FORWARD 1 -o wg0 -j "${CHAIN}"
iptables -I FORWARD 1 -i wg0 -j "${CHAIN}"
iptables -t nat -C POSTROUTING -s 10.77.0.0/24 -o "${EGRESS_INTERFACE}" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s 10.77.0.0/24 -o "${EGRESS_INTERFACE}" -j MASQUERADE
ip6tables -C FORWARD -i wg0 -j REJECT 2>/dev/null || ip6tables -I FORWARD 1 -i wg0 -j REJECT
ip6tables -C FORWARD -o wg0 -j REJECT 2>/dev/null || ip6tables -I FORWARD 1 -o wg0 -j REJECT

umask 077
install -d -m 0700 /run/wireguard
wg genkey > /run/wireguard/server.key
wg pubkey < /run/wireguard/server.key > /run/wireguard/server.pub
{
  printf '[Interface]\nAddress = 10.77.0.1/24\nListenPort = 51820\nPrivateKey = '
  cat /run/wireguard/server.key
  printf 'Table = off\n\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.77.0.2/32\n' "${PEER_PUBLIC_KEY}"
} > /run/wireguard/wg0.conf
chmod 0600 /run/wireguard/wg0.conf
wg-quick up /run/wireguard/wg0.conf

SERVER_PUBLIC_KEY="$(cat /run/wireguard/server.pub)"
printf 'WRAPS_WG_SERVER_PUBLIC_KEY=%s\n' "${SERVER_PUBLIC_KEY}"
echo 'WireGuard gateway ready on UDP 51820'
