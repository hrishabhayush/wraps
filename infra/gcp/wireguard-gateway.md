# Test WireGuard gateway

`deploy-wireguard-gateway.sh` creates a temporary Debian 12 GCE VM for test traffic. The VM runs outside Confidential Space. It has no attached service account, no wallet or issuer keys, and no SDK attestation or token-metering role. Keep issuer signing and HTTPS relay workloads in Confidential Space.

The gateway gives a peer full-tunnel IPv4 egress through the project. It blocks private, reserved, and metadata IPv4 destinations, blocks IPv6 forwarding, and allows only UDP 51820 ingress. It is not a private route to project VMs. Use it with a public relay/RPC endpoint. Any RPC provider credentials and the wallet used to sign transactions remain the user's responsibility.

## Deploy

Install `gcloud` and authenticate to `wraps-hack`. Generate a dedicated client keypair locally, then pass only its public key as `WG_PEER_PUBLIC_KEY`:

```sh
umask 077
wg genkey > /tmp/wraps-wg-client.key
wg pubkey < /tmp/wraps-wg-client.key
WG_PEER_PUBLIC_KEY="$(wg pubkey < /tmp/wraps-wg-client.key)" infra/gcp/deploy-wireguard-gateway.sh
```

The deploy script uses an `n2d-standard-2` machine, labels it `project=wraps`, and configures it to stop after 12 hours. It creates firewall rules scoped to the gateway's dedicated network tag. Do not put the private client key in instance metadata, source control, or chat.

After startup, get the VM's external IP from `infra/gcp/.state/wireguard-gateway.ip`. The server public key appears in the VM's startup/serial output as `WRAPS_WG_SERVER_PUBLIC_KEY=...`. The server private key is generated in `/run` (RAM-backed) and rotates when the VM reboots.

Give the peer this client profile, substituting the private key, server public key, and external IP:

```ini
[Interface]
PrivateKey = <client private key>
Address = 10.77.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <server public key>
Endpoint = <gateway external IP>:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

Send the finished profile to the peer through a secure channel. The profile contains the peer's private key. Connect it with a WireGuard client, then configure the application to use its public relay and RPC URLs.

## Stop and teardown

Stop the VM when finished:

```sh
gcloud --project=wraps-hack compute instances stop wraps-wg-gateway --zone=us-central1-a
```

Stopping preserves the VM and its disk. To remove it and the gateway-only firewall rules when the task is over:

```sh
gcloud --project=wraps-hack compute instances delete wraps-wg-gateway --zone=us-central1-a
gcloud --project=wraps-hack compute firewall-rules delete wraps-allow-wg-gateway wraps-deny-wg-gateway-ingress
```
