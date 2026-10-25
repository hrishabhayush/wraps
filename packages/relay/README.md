# Relay

`@wraps/relay` provides an HTTP `CONNECT` proxy for HTTPS destinations on port
443. It opens a raw TCP connection and forwards bytes in both directions. TLS
continues between the client and destination; the relay does not terminate or
inspect TLS.

```ts
import { startRelayServer } from '@wraps/relay';

const server = startRelayServer({
  port: 8443,
  issuerUrl: 'https://issuer.example',
  merchantId: 'relay',
}); // listens on 127.0.0.1 by default
```

Each metered CONNECT request must carry a bounded batch of RFC 9578 blind tokens in its
`Proxy-Authorization` header. The relay verifies the batch with the issuer,
then settles one token for each 10,000,000 bytes sent or received. A partial
final block costs one token. If the batch runs out, the relay forwards only the
remaining quota and closes the tunnel. Tokens for later blocks are settled only
when that block is first used. There is no mid-tunnel top-up channel yet.

Issuer settlement is atomic and authoritative: the relay does not rely on a
prior `/verify` result to spend a token. Issuer errors and ambiguous timeouts
close the tunnel; settlement is never retried automatically. A valid tunnel is
refused with 503 until issuer metering is configured.

The proxy binds to loopback by default and rejects destinations that resolve to
private, loopback, link-local, or reserved IP ranges. If it is exposed on a
network, put it behind deployment-level access controls. It supports HTTPS
CONNECT only, on port 443. TLS remains end-to-end to the destination.

## Confidential Space attestation endpoint

`@wraps/relay/attestation` creates a nonce-bound receipt from the relay's
self-signed TLS certificate and an injected `AttestationProvider`. The provider
must be the Confidential Space implementation supplied by the attestation
lane. The TLS key and certificate must be generated inside the workload and
shared with the HTTPS proxy listener; the attestation endpoint hashes the
certificate's SPKI so the SDK can pin the same key.

The receipt listener is separate HTTP because the SDK-02 transport fetches its
nonce-bound receipt over HTTP by default. `startConfidentialRelay()` starts
both listeners; set the SDK's `attestationUrl` explicitly, for example
`http://relay.example:8080/attestation`, and set the proxy URL to the HTTPS
listener, such as `https://relay.example:443`. The endpoint disables caching
and limits each client IP to 60 requests per minute by default. The Cloud
firewall must allow the selected attestation port from the demo agent.

For SDK issuer bootstrap only, `startConfidentialRelay()` permits a tokenless
CONNECT when its authority matches the configured `issuerUrl` hostname on port
443. The destination still must resolve exclusively to publicly routable IPs.
Each client may open up to 10 such tunnels per minute, and each tunnel is capped
at 1 MiB in both directions combined. Other tokenless destinations receive 407;
CONNECT requests with tokens, including to the issuer, use the normal metered
flow.

```ts
import { startConfidentialRelay } from '@wraps/relay';

const servers = startConfidentialRelay({
  issuerUrl: process.env.ISSUER_URL,
  tlsCertificate: certificatePem,
  tlsPrivateKey: privateKeyPem,
  attestationProvider: confidentialSpaceAttestationProvider,
  proxyHost: '0.0.0.0',
  proxyPort: 443,
  attestationHost: '0.0.0.0',
  attestationPort: 8080,
});
```

Do not expose the attestation URL as a substitute for the TLS-pinned proxy.
Its response is accepted only after the SDK verifies the request nonce and key
hash with the Google-signed workload attestation.

## WireGuard gateway

`startWireGuardGateway()` starts an optional IPv4 full-tunnel gateway for
pre-authorized peers. It generates the server key at startup, installs only
validated peer public keys, NATs peer traffic to the configured egress
interface, and rejects private/reserved IPv4 destinations. IPv6 forwarding is
blocked; clients must use a kill switch or otherwise prevent direct IPv6
egress. The separate `/wireguard-attestation?nonce=<64 hex chars>` receipt
binds the WireGuard public key and a hash of the peer/routing policy together
with the existing TLS tunnel key.

Example relay setup (the entrypoint must await the async start function):

```ts
const relay = await startConfidentialWireGuardRelay({
  tlsCertificate,
  tlsPrivateKey,
  attestationProvider,
  issuerUrl,
  wireGuardGateway: {
    endpoint: process.env.RELAY_HOSTNAME!,
    listenPort: 51820,
    interfaceAddress: '10.77.0.1/24',
    egressInterface: 'ens4',
    peers: [{ publicKey: process.env.AGENT_WIREGUARD_PUBLIC_KEY!, allowedAddress: '10.77.0.2/32' }],
  },
});
```

The server requires `wg`, `wg-quick`, `ip`, `iptables`, `ip6tables`,
`sysctl`, a writable `/dev/net/tun`, `CAP_NET_ADMIN`, and IPv4 forwarding
already enabled by the VM runtime. Private config is held in tmpfs with mode
`0600` while the interface runs. **Do not enable this in the current
Confidential Space image until Infra has verified the required device and
capabilities and the SDK verifies the WireGuard attestation receipt.**

WireGuard packets do not carry the HTTP CONNECT token header. This gateway
does not yet meter WireGuard bytes; traffic over it must not be represented as
token-metered until peer admission and per-peer byte settlement are integrated.
