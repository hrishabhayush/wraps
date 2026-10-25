# Visible agent demo

Run `npm run demo:browser`, then open http://127.0.0.1:4176. It opens an isolated, visible Chromium window on **Run agent**. The dashboard mirrors that window on the left, displays action events below it, and embeds the Wraps IP page on the right. Screenshots stay in memory; no browser profile or HAR is saved. General research mode uses the OpenAI Responses API to choose browser actions and answer your task. A separately labeled scripted payment demo remains available without a model key.

The scripted preview browses the real XRPL transaction-cost reference, then visits a local sample resource that returns HTTP 402. It does **not** fabricate vouchers, transaction hashes, or completed payments. The IP page checks the viewing browser every 15 seconds while visible; the separate agent-IP label checks the Node process. Neither label alone proves a leak-free VPN tunnel.

## General research mode

In the same terminal where `AGENT_PRIVATE_KEY` is exported, load your OpenAI key without putting it in shell history (zsh):

```sh
read -s "OPENAI_API_KEY?Paste your OpenAI API key, then press Enter: "
export OPENAI_API_KEY
printf '\n'
npm run ap4m:demo
```

Open http://127.0.0.1:4177, keep Wraps connected, and enter a task. Choose **General research agent**, set a budget (0 is free research only, except an already purchased report can be retrieved), and click **Run agent**. Example: “Read https://xrpl.org/docs/concepts/transactions/transaction-cost and compare native XRPL fees with the saved XRPL EVM report. Retrieve that report if useful, cite sources, and distinguish both networks.” The bundled merchant quotes 0.05 RLUSD, which is also the server's purchase ceiling; a budget is a maximum, not an automatic charge.

The model defaults to `gpt-4.1-mini`; `OPENAI_MODEL` can override it. It can search, open public HTTPS pages, read visible text, follow observed links and request the one configured report. It cannot choose a payment address, change the channel or raise the budget. It has at most 12 model turns. **Stop** prevents subsequent actions; an already submitted voucher/transaction may still complete. Retry uncertain payments with their original budget and state.

Task and page text are sent to OpenAI with `store: false`; model usage is billed separately from RLUSD. This is not a no-logging guarantee from the model provider. Credentials stay on the server and are excluded from Chromium's environment. Browser actions are read-only requests; private IP destinations and non-HTTPS navigation are blocked by DNS preflight. That preflight is not connection-level isolation against DNS rebinding. Use a network-enforcing proxy before production use on hostile sites. Searches may encounter bot checks; provide source URLs if needed.

The right-hand IP panel refreshes automatically every 15 seconds, browser images every second, and live actions stream immediately. Agent egress is checked before model/tool actions when payments are configured. These checks are not a kill switch: a VPN disconnect between checks can leak traffic. Paid access currently supports the configured AP4M report only, not arbitrary x402 merchants or general online checkout.

## Real AP4M purchase

### Sponsored allowance preparation

`WRAPS_SPONSORED=1 npm run ap4m:demo` enables a persistent allowance of ten run attempts and requires a server payment ceiling no higher than 0.05 RLUSD. Each accepted attempt consumes one slot before model work starts, including attempts that later fail. Restarting does not reset the allowance. OpenAI usage is separately billed and bounded by the ten runs and twelve model turns per run; this is not an API-dollar budget. The same report and payment operation are retained, so subsequent retrievals do not buy it again.

This switch does **not** publish the dashboard or make it safe for multiple visitors: it still binds to loopback and shares its local activity feed. Public access requires isolated visitor sessions and a separate gateway. Do not expose this local server through a tunnel as-is.

For the bundled local merchant, run `npm run ap4m:demo` in the terminal holding the exported agent key. It discovers your single open channel, reads its merchant and payout from the chain, and starts `http://127.0.0.1:4180/resource` plus the live dashboard at `http://127.0.0.1:4177`. Startup makes no purchase. The endpoint quotes **0.05 testnet RLUSD** for a saved XRPL EVM block snapshot; the agent may buy the report when useful to your task and within the task budget. The local demo uses the agent wallet to submit the merchant's redemption transaction too (maximum estimated gas fee 0.1 testnet XRP). The payout still goes to the channel's registered merchant. Keep this terminal open. Stop it with Ctrl-C.

The local merchant request does not traverse the VPN. Public browsing, RPC and the observed external IP are separate network checks. The live purchase still requires the external agent IP to match `DEMO_EXIT_IP`. This is a demo of the AP4M voucher exchange, not proof of remote merchant routing or private on-chain payments. The server uses a stable local URL and retains the report and payment state across restarts so an uncertain purchase can resume.

In the terminal where the registered agent's replacement key is exported as `AGENT_PRIVATE_KEY`, run `npm run ap4m:check` to sign in and list channels. `npm run ap4m:channel` creates a channel capped at 1 RLUSD if no active request exists. It submits a vault binding request, uses testnet XRP gas (maximum estimated fee 0.1 XRP), and does not sign a payment voucher. The signed request is retained under `~/.local/state/wraps/ap4m/<agent>/channel-request.json` before broadcast; retries reuse it. Do not delete this file after an uncertain transaction. The channel command leaves the channel open for the x402 demo.

This path uses the official AP4M `buyResource` sample, not the mock Wraps rail. It requires an existing open channel and an AP4M-compatible merchant resource. Cross-team discovery may be disabled by the event organizers. Channel creation and allocation authorization still use the supplied AP4M starter/portal.

Configure these environment variables locally before starting the server:

- `AP4M_RESOURCE_URL`: the merchant's HTTPS URL ending in `/resource`.
- `AP4M_CHANNEL_ID`: the open channel ID for that merchant and agent wallet.
- `AGENT_PRIVATE_KEY`: the key exported in your terminal; or `AP4M_AGENT_KEY_FILE`, a private file (mode 600) containing it. Never paste keys into chat or put them in frontend variables.
- `AP4M_STATE_DIR`: an absolute private directory outside the repository. Retain it between restarts.
- `AP4M_MAX_RLUSD`: maximum purchase price, default 1, never above 1 in this demo.
- `AP4M_ENABLE_PAYMENTS=1`: enable only after authorizing that purchase and configuring the above.
- `DEMO_EXIT_IP`: expected VPN exit, default `136.80.57.82`.

The code checks observed agent egress before entering the payment path. This is a preflight, not a network kill switch: establish and verify the VPN separately. The toolkit validates the merchant challenge, asset, network, channel agent/payee/cap, signs the cumulative EIP-712 voucher, retries the resource with `PAYMENT-SIGNATURE`, and verifies the exact finalized redemption before showing a transaction as complete.

Every purchase reuses operation `xrp-research-1`. Completed reports are cached privately and reused without another RLUSD charge; this demo does not offer a new paid report on every run. An uncertain payment must resume with the same state, channel, URL and budget. Do not delete the retained state to retry. The toolkit may have sent a payment even if the UI reports a timeout. This demo does not automatically close channels or settle remaining allocations.

This purchase pays an AP4M merchant directly. It does **not** implement the separate AP4M-to-Wraps-issuer funding adapter, nor make on-chain voucher redemptions private. Wraps blind-token issuance and subsequent private merchant spending remain a separate flow.

No real transaction is executed during automated tests. Model and live-payment checks require their respective credentials.
