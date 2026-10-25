# Official AP4M hackathon toolkit

`x402.mjs` was downloaded unchanged from https://hackathon.ap4m.build/sdk/ap4m-x402.mjs on 2026-10-25.

SHA-256: `ec4ed75def98673df75a736f6a2514b74ba1ddd26c16faad5c37160246435ce6`.

Hackathon-only code. It uses the matching official `@ap4m/sdk` package. The browser demo uses `buyResource`, including its durable signed intent, channel checks and confirmed redemption verification. Keep `purchase.json` private and retain it across retries; never delete it to retry an uncertain payment.
