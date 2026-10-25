# Live split-screen demo

From the repository root:

```sh
npm install
npm run demo
```

Open `http://127.0.0.1:4174`, then select **Start live demo**. The left pane
reads public x402 activity for AskSurf on XRPL mainnet; it needs network access
and can use `QUICKNODE_XRPL_URL` when set. The right pane starts a local mock
issuer and merchant, verifies mock attestation, and runs one research task with
the blind-token SDK. Stop ends the XRPL polling and local demo services.

The SDK handles the merchant's single-use quotes (`x-blindtoken-quote`) and
checks the issuer's signed token key epochs, so the right pane runs the same
flow as `npm run demo:core`.

For the live flow, start Docker Desktop and run `npm run demo:live`. The UI,
XRPL spy, local merchant and Cloudflare Tunnel stay on the host. Only the
right-pane agent runs in a container. Its firewall drops outbound traffic by
default and allows only the numeric relay IP on TCP 443 and 8080; DNS is
blocked. The worker image is built from an allowlisted temporary context, and
the only host file mounted into it is the public `infra/gcp/expected.json`.
`npm run demo:preflight` checks that Docker Engine is available before a run.

## Tamper test

Select **Tamper test** to point the agent at a second mock issuer whose build
identity has a different PCR0. The SDK refuses it with `PCR_MISMATCH` before any
top-up or purchase, and the pane shows `tamper-refused`. The merchant keeps
trusting the original issuer. Any other failure, such as an issuer that does not
start, shows as `error`, never as `tamper-refused`.

## Control endpoints

`/api/start` and `/api/stop` start and stop the run. The server binds to
`127.0.0.1` by default. On a loopback host, the control endpoints accept only
loopback clients with a loopback `Host` header. On any host they refuse
cross-origin browser requests.

Set `DEMO_HOST` or `DEMO_PORT` to change the listener. If `DEMO_HOST` is not a
loopback address, the server makes a random token at start-up and prints a URL
like `http://0.0.0.0:4174/#token=...`. Open that URL: the page sends the token
in the `x-demo-token` header. Control calls without it get 403. The page,
`/api/status` and `/events` stay readable.

## Caches

The directory and catalog caches go to a new private directory
(`mkdtemp`, mode 0700) under the system temp directory. Files are created with
`O_EXCL | O_NOFOLLOW`, written to a temp file, then renamed into place. Reads
refuse symlinks. The directory is removed when the server stops. If the network
and the private cache both fail, the demo reads the spy bot's shipped caches
read-only.

## Tests

`npm test` runs `apps/demo/test` after the package tests. The local firewall
check is `scripts/test-demo-agent-egress.sh`; it uses an internal Docker bridge
and mock endpoints to verify allowed relay traffic and denied non-relay and DNS
traffic without changing host network settings.
