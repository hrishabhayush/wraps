# Live split-screen demo

From the repository root:

```sh
npm install
npm run demo
```

Open `http://127.0.0.1:4174`, then select **Start live demo**. The left pane
can run a real x402 buyer on XRPL testnet and watch the resulting merchant
payment. The right pane starts a local mock issuer and merchant, verifies mock
attestation, and runs one research task with the blind-token SDK.

To enable the testnet buyer, configure a funded testnet wallet, an x402-protected
resource URL using t54's testnet facilitator, and that resource's XRPL pay-to
address in the environment before starting the demo:

```sh
export XRPL_TESTNET_BUYER_SEED='sEd...'
export XRPL_TESTNET_RESOURCE_URL='https://merchant.example/paid-resource'
export XRPL_TESTNET_MERCHANT_ADDRESS='r...'
npm run demo
```

The buyer uses `x402Fetch` with network `xrpl:1`; it calls the resource URL,
handles the 402 challenge, and signs the testnet payment. SpyBot watches only
that merchant account through XRPL testnet JSON-RPC, without mainnet fallbacks
or mainnet directory/catalog lookups. The seed is read only by the server
process and is never sent to the browser or included in events. Use a testnet
wallet only. Without all three variables, the left pane stays idle and lists
the missing configuration; it never falls back to mainnet.

Stop ends XRPL polling and the local demo services. Set `DEMO_HOST` or
`DEMO_PORT` to change the listener. It binds to loopback by default. Directory
and merchant catalog caches go to the system temporary directory.
