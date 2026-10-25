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
