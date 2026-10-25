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

Set `DEMO_HOST` or `DEMO_PORT` to change the listener. It binds to loopback by
default. Directory and merchant catalog caches go to the system temporary
directory.
