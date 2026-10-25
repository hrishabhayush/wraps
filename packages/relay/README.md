# Relay

`@wraps/relay` provides an HTTP `CONNECT` proxy for HTTPS destinations on port
443. It opens a raw TCP connection and forwards bytes in both directions. TLS
continues between the client and destination; the relay does not terminate or
inspect TLS.

```ts
import { startRelayServer } from '@wraps/relay';

const server = startRelayServer({ port: 8443 }); // listens on 127.0.0.1 by default
```

The proxy has no user authentication. It binds to loopback by default and
rejects destinations that resolve to private, loopback, link-local, or reserved
IP ranges. If it is exposed on a network, put it behind deployment-level access
controls. It supports HTTPS CONNECT only, on port 443.
