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

Each CONNECT request must carry a bounded batch of RFC 9578 blind tokens in its
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
nonce-bound receipt over HTTP by default. Start it on a dedicated port and set
the SDK's `attestationUrl` explicitly, for example
`http://relay.example:8080/attestation`; set the proxy URL to the HTTPS
listener, such as `https://relay.example:443`. The endpoint disables caching
and limits each client IP to 60 requests per minute by default. The Cloud
firewall must allow the selected attestation port from the demo agent.

```ts
import { startRelayAttestationServer } from '@wraps/relay/attestation';

const server = startRelayAttestationServer({
  host: '0.0.0.0',
  port: 8080,
  tlsCertificate: certificatePem,
  provider: confidentialSpaceAttestationProvider,
});
```

Do not expose the attestation URL as a substitute for the TLS-pinned proxy.
Its response is accepted only after the SDK verifies the request nonce and key
hash with the Google-signed workload attestation.
