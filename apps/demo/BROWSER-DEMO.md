# Visible agent demo

Run `npm run demo:browser`, then open http://127.0.0.1:4176. It opens an isolated, visible Chromium window on **Run agent**. The dashboard mirrors that window on the left, displays action events below it, and embeds the Wraps IP page on the right. Screenshots stay in memory; no browser profile or HAR is saved. General research mode uses the OpenAI Responses API to choose browser actions and answer your task. A separately labeled scripted payment demo remains available without a model key.

The scripted preview browses the real XRPL transaction-cost reference, then visits a local sample resource that returns HTTP 402. It does **not** fabricate vouchers, transaction hashes, or completed payments. The IP page checks the viewing browser every 15 seconds while visible; the separate agent-IP label checks the Node process. Neither label alone proves a leak-free VPN tunnel.

## Three-service AP4M task

With your registered agent key already exported, an open AP4M channel, and Wraps connected:

```sh
npm run ap4m:task
```

Open http://127.0.0.1:4177 and click **Run payment demo**. The page preselects the scripted task and a **0.15 testnet RLUSD total budget**. No OpenAI key is needed for this mode. Startup does not sign a payment voucher or buy anything.

The task buys three services for **0.05 testnet RLUSD each**:

1. A saved XRPL EVM network snapshot (`xrp-research-1`, port 4180).
2. Gas utilization calculated from that snapshot (`gas-report-1`, port 4181).
3. A saved gas-price-based estimate for a 21,000-gas native XRP transfer (`fee-estimate-1`, port 4182).

These are three local service endpoints belonging to the same channel merchant. They use testnet data, not live market prices. Each new purchase follows the unchanged official AP4M toolkit:

1. Request the service with `X-AP4M-CHANNEL-ID`; receive HTTP 402 and `PAYMENT-REQUIRED`.
2. Validate the resource, asset, channel, payee, price, cap and validity window before signing.
3. Create the cumulative EIP-712 voucher and resource-binding signature; persist the exact signed intent privately before sending `PAYMENT-SIGNATURE`.
4. The merchant validates the voucher and submits `redeemVoucher` to the AP4M ledger. **Redemption is the service payment**, not a step before another transfer.
5. Receive the resource with HTTP 200 and `PAYMENT-RESPONSE`; verify the exact transaction, claim and finalized `VoucherRedeemed` event before reporting success.

Purchases are sequential: on a previously unused channel the cumulative amounts are 0.05, 0.10 and 0.15 RLUSD. Any pre-existing redeemed balance is added to those amounts. Redemption gas is separate: this local demo uses the agent wallet as the merchant submitter, with the existing 0.1 testnet XRP estimated gas ceiling **per redemption**.

Every service retains its own purchase intent and result. Each new run buys requested services again with fresh vouchers, even when those reports were bought in a previous run. Completed vouchers are archived by the official toolkit. An uncertain voucher blocks new purchases until recovered; rerun with the original state and enough budget to cover its retained authority. Do not delete payment files or change operation IDs to retry. When recovering an unresolved voucher, completed services are temporarily reused so the task can reach and resume that voucher without creating another payment first. All reports are saved across restarts, so subsequent runs do not buy refreshed data.

For model-directed purchases, select **General research agent** with an OpenAI key configured and use: “Buy all three configured XRPL EVM reports via x402, summarize network activity, gas utilization and estimated native transfer cost, and show the payment receipts. Spend at most 0.15 RLUSD.” The model chooses only server-configured service IDs; the payment code enforces the shared remaining budget. The scripted mode always buys the configured catalog, regardless of edits to the task text.

Use `npm run ap4m:demo` for the original single-report or sponsored demo. The three-service task is local only; the public gateway retains its 0.05 RLUSD ceiling.

## General research mode

In the same terminal where `AGENT_PRIVATE_KEY` is exported, load your OpenAI key without putting it in shell history (zsh):

```sh
read -s "OPENAI_API_KEY?Paste your OpenAI API key, then press Enter: "
export OPENAI_API_KEY
printf '\n'
npm run ap4m:demo
```

Open http://127.0.0.1:4177, keep Wraps connected, and enter a task. Choose **General research agent**, set a budget (0 is free research only), and click **Run agent**. Example: “Read https://xrpl.org/docs/concepts/transactions/transaction-cost and compare native XRPL fees with the saved XRPL EVM report. Retrieve that report if useful, cite sources, and distinguish both networks.” The bundled merchant quotes 0.05 RLUSD, which is also the server's purchase ceiling; a budget is a maximum, not an automatic charge.

The model defaults to `gpt-4.1-mini`; `OPENAI_MODEL` can override it. It can search, open public HTTPS pages, read visible text, follow observed links and request configured reports by ID. It cannot choose a payment address, change the channel or raise the budget. It has at most 12 model turns. **Stop** prevents subsequent actions; an already submitted voucher/transaction may still complete. Retry uncertain payments with their original budget and state.

Task and page text are sent to OpenAI with `store: false`; model usage is billed separately from RLUSD. This is not a no-logging guarantee from the model provider. Credentials stay on the server and are excluded from Chromium's environment. Browser actions are read-only requests; private IP destinations and non-HTTPS navigation are blocked by DNS preflight. That preflight is not connection-level isolation against DNS rebinding. Use a network-enforcing proxy before production use on hostile sites. Searches may encounter bot checks; provide source URLs if needed.

The right-hand IP panel refreshes automatically every 15 seconds, browser images every second, and live actions refresh every second. Agent egress is checked before model/tool actions when payments are configured. These checks are not a kill switch: a VPN disconnect between checks can leak traffic. Paid access currently supports the configured AP4M report only, not arbitrary x402 merchants or general online checkout.

## Real AP4M purchase

### Temporary sponsored public link

1. Keep Wraps connected and run `npm run ap4m:demo` in the terminal holding both keys.
2. Install the tunnel client once with `brew install cloudflared`.
3. In another terminal, run `npm run ap4m:share`. That process does not need either key. Share the printed HTTPS `trycloudflare.com` URL.
4. Keep both terminals and this Mac awake. If you restart the private AP4M server, restart sharing too to obtain a new link; the gateway refuses new work after losing its original server connection. Ctrl-C in the share terminal ends public access; it also expires automatically after two hours.

The gateway has **ten run attempts total**, persisted under `~/.local/state/wraps/public-demo/runs`. Restarting does not reset the allowance. A failed accepted attempt still consumes a slot. There is one active run at a time, one run per visitor cookie, a three-minute stop request, and the existing twelve-model-turn bound. A cookie is not a verified human identity; the global allowance is the hard usage boundary. OpenAI billing is separate from AP4M; the run allowance is not a dollar-denominated API budget.

Each visitor gets their own activity and browser images. The gateway does not expose the private dashboard, event stream, payment configuration, or keys. Run IDs prevent screenshots and events from another run being returned. Do not start private dashboard tasks while people use the shared demo. The gateway retains at most ten visitor results in memory until sharing stops. Cookie expiry is one hour. Tasks and page text go to OpenAI; Cloudflare proxies the public page and requests. Neither provider is covered by a no-logging claim.

Shared runs use fresh browser contexts with page JavaScript disabled, only public HTTPS document/style/image/font requests, and DNS-validated socket addresses. This prevents a second DNS lookup or redirect from reaching the host's private network. JavaScript-only sites and some search pages may not work; provide direct public documentation URLs instead. Browser loads are capped at sixty requests and twenty MB per run. The three-minute limit requests a stop; an already submitted model request or payment can still finish.

The purchase ceiling remains 0.05 RLUSD. Each visitor run can make a new 0.05 RLUSD payment for the report, even when a previous run bought it. Repeated requests within one run reuse that run’s result. This AP4M path is separate from the desktop blind-token balance. The right panel shows the visitor's IP; the agent label shows the host VPN exit. The host must retain the expected exit to start runs and pass payment preflight. These checks are not an operating-system VPN kill switch.

The local-only `WRAPS_SPONSORED=1 npm run ap4m:demo` switch also supports a separate ten-attempt allowance under the AP4M state directory. It is unnecessary when using the public gateway. Never tunnel port 4177 directly: `ap4m:share` tunnels only the visitor gateway on port 4179.

For the bundled local merchant, run `npm run ap4m:demo` in the terminal holding the exported agent key. It discovers your single open channel, reads its merchant and payout from the chain, and starts `http://127.0.0.1:4180/resource` plus the live dashboard at `http://127.0.0.1:4177`. Startup makes no purchase. The endpoint quotes **0.05 testnet RLUSD** for a saved XRPL EVM block snapshot; the agent may buy the report when useful to your task and within the task budget. The local demo uses the agent wallet to submit the merchant's redemption transaction too (maximum estimated gas fee 0.1 testnet XRP). The payout still goes to the channel's registered merchant. Keep this terminal open. Stop it with Ctrl-C.

The local merchant request does not traverse the VPN. Public browsing, RPC and the observed external IP are separate network checks. The live purchase still requires the external agent IP to match `DEMO_EXIT_IP`. This is a demo of the AP4M voucher exchange, not proof of remote merchant routing or private on-chain payments. The server uses a stable local URL and retains the report and payment state across restarts so an uncertain purchase can resume.

In the terminal where the registered agent's replacement key is exported as `AGENT_PRIVATE_KEY`, run `npm run ap4m:check` to sign in and list channels. `npm run ap4m:channel` creates a channel capped at 1 RLUSD if no active request exists. It submits a vault binding request, uses testnet XRP gas (maximum estimated fee 0.1 XRP), and does not sign a payment voucher. The signed request is retained under `~/.local/state/wraps/ap4m/<agent>/channel-request.json` before broadcast; retries reuse it. Do not delete this file after an uncertain transaction. The channel command leaves the channel open for the x402 demo.

This path uses the official AP4M `buyResource` sample, not the mock Wraps rail. It requires an existing open channel and an AP4M-compatible merchant resource. Cross-team discovery may be disabled by the event organizers. Channel creation and allocation authorization still use the supplied AP4M starter/portal.

Configure these environment variables locally before starting the server:

- `AP4M_RESOURCE_URL`: the merchant's HTTPS URL ending in `/resource`, for a single report.
- `AP4M_RESOURCES`: optional JSON catalog of `{ "id", "description", "url" }` objects, replacing `AP4M_RESOURCE_URL`. IDs must be unique lowercase letters/digits/hyphens. All resources must accept the configured channel's merchant and payout. `ap4m:task` configures this automatically.
- `AP4M_CHANNEL_ID`: the open channel ID for that merchant and agent wallet.
- `AGENT_PRIVATE_KEY`: the key exported in your terminal; or `AP4M_AGENT_KEY_FILE`, a private file (mode 600) containing it. Never paste keys into chat or put them in frontend variables.
- `AP4M_STATE_DIR`: an absolute private directory outside the repository. Retain it between restarts.
- `AP4M_MAX_RLUSD`: total task payment ceiling, default 1, never above 1 in this demo.
- `AP4M_ENABLE_PAYMENTS=1`: enable only after authorizing that purchase and configuring the above.
- `DEMO_EXIT_IP`: expected VPN exit, default `136.80.57.82`.

The code checks observed agent egress before entering the payment path. This is a preflight, not a network kill switch: establish and verify the VPN separately. The toolkit validates the merchant challenge, asset, network, channel agent/payee/cap, signs the cumulative EIP-712 voucher, retries the resource with `PAYMENT-SIGNATURE`, and verifies the exact finalized redemption before showing a transaction as complete.

Resource IDs and state directories stay stable, but each fresh purchase receives a unique operation name. The original report keeps its existing state directory; additional resources keep separate subdirectories. Completed intents are archived, and new runs pay again. An unresolved intent always retains its exact operation name. Within a model run, repeated requests for the same service reuse that run’s result. An uncertain payment must resume with the same state, channel and URL; the toolkit receives its original retained maximum amount, which must fit the remaining task budget. Do not delete the retained state to retry. The toolkit may have sent a payment even if the UI reports a timeout. This demo does not automatically close channels or settle remaining allocations.

This purchase pays an AP4M merchant directly. It does **not** implement the separate AP4M-to-Wraps-issuer funding adapter, nor make on-chain voucher redemptions private. Wraps blind-token issuance and subsequent private merchant spending remain a separate flow.

No real transaction is executed during automated tests. `ap4m-flow.test.ts` exercises the official toolkit's signing, wire headers, retained intents and exact receipt checks against simulated chain and merchant responses. Model and live-payment checks require their respective credentials. The toolkit requires Node 22.13 or later for `node:sqlite`.
