# Demo day: one-page cheat sheet

Detailed steps are in [REHEARSAL.md](REHEARSAL.md). This page is the short version to keep open on stage day.

---

## The night before (once)

1. Pull the latest main and install:
   ```sh
   git pull && npm install
   brew install cloudflared        # gives the local merchant a public HTTPS URL the relay can reach
   ```
2. Rehearse `npm run demo:live` three times. Fill in the table at the bottom of REHEARSAL.md.

---

## 45 minutes before

The issuer and relay VMs stop on their own after 12 hours, so check them early.

1. **Check what is running:**
   ```sh
   infra/gcp/status.sh
   ```
2. **Start anything that shows `TERMINATED`:**
   ```sh
   gcloud --project=wraps-hack compute instances start wraps-issuer --zone=us-central1-a
   gcloud --project=wraps-hack compute instances start wraps-relay  --zone=us-central1-a
   ```
   Confidential Space takes 2 to 4 minutes to boot and attest.
3. **Both IPs are reserved and stay the same across restarts**: issuer `34.123.78.11`, relay `136.80.57.82`. Export the issuer URL:
   ```sh
   export ISSUER_URL=https://34.123.78.11
   ```
4. **Run the preflight:**
   ```sh
   npm run demo:preflight
   ```
   **Every check must be green**: issuer and relay reachability and attestations, both image digests, TLS pins, issuer routing through the relay, XRPL mainnet node reachability, merchant HTTPS tunnel, and the live merchant signing key. If one is red, the line says what to fix.

---

## On stage (3 minutes)

```sh
npm run demo:live
```
Open **http://127.0.0.1:4174** (if the port is busy: `DEMO_PORT=4175 npm run demo:live`).

| Time | Show | Say |
|---|---|---|
| 0:00 | Title | "Agents now pay for data with x402 on XRPL. Every payment is public, forever." |
| 0:15 | **Left screen**: spy bot reading real mainnet payments | "This is live XRPL mainnet. Each line is a real agent paying a real service: wallet, merchant, price, exact time. That's its card statement, public." |
| 0:45 | Spy bot funder groups | "Agents rotate wallets to hide. We traced them: most were funded straight from an exchange, which can tie each wallet to an account." |
| 1:10 | **Right screen**: issuer and relay attestations | "Our issuer and relay run in Google Confidential Space. Before paying anything, the agent checks a Google-signed token: AMD SEV hardware, debug off, and the exact image digest we published. TLS keys are pinned." |
| 1:40 | Top-up and purchase through the relay | "The agent pays with blind tokens. The issuer signed them without seeing them, so it can't link a payment back to this agent. The merchant sees the relay's IP, not the agent's." |
| 2:10 | **Stop**, then **Tamper test** | "Now we point the agent at the issuer with the wrong expected image. It refuses: `IMAGE_MISMATCH`. No top-up, no payment." |
| 2:35 | Close | "We pass the published x402 facilitator security rules from USENIX Security 2026, where every one of 15 production facilitators failed at least one. Three layers, and no single party sees both who the agent is and what it buys." |

Stop with the **Stop** button or Ctrl-C. That closes the local merchant and the tunnel. It does not stop the VMs.

---

## Judge questions (short answers)

| Question | Answer |
|---|---|
| Do you hide which stock I research? | No. The merchant must read the request to answer it. We hide who is asking, from the merchant, the facilitator and the public chain. |
| Isn't this a mixer? | No. It's the GNU Taler model: payers private, merchant income transparent. Funders are known at top-up. Production would need a licensed partner. |
| Why trust your issuer? | Blind signatures stop it linking a token to its buyer even if it logs everything. And it runs in Confidential Space with a Google-signed attestation you just watched us verify. |
| Is the payment real? | Top-up in the demo uses a mock rail (AP4M is skipped). Real RLUSD payouts on XRPL EVM are built and tested on a local chain; no live testnet send yet. |
| How private is it really? | Simulation, PR #7: with hourly payouts a watcher still pins 69% of spending at 5 agents and 6% at 100. Privacy needs a crowd and slow payouts. |
| Is it faster? | Locally, a token payment takes about 1.8 ms (mock rails). Plain x402 on XRPL waits about 4 s for the ledger. Local number, not production. |
| SEV or SEV-SNP? | AMD SEV, verified by Google. Not SNP. |
| Is the WireGuard gateway attested? | The relay serves a nonce-bound attestation receipt for its WireGuard settings. Authorized peer packet forwarding has not yet been validated. The separate standalone gateway VM is not attested. |

---

## If something breaks

| Problem | Fix |
|---|---|
| Preflight: issuer unreachable | VM stopped. Start it (step 2 above) and wait 2 to 4 minutes. `ISSUER_URL` stays `https://34.123.78.11`. |
| Preflight: digest mismatch | The running image differs from `infra/gcp/expected.json`. Pull main; if still wrong, redeploy with `infra/gcp/deploy.sh issuer` (or follow `infra/gcp/relay-deploy.md`). |
| Preflight: cloudflared missing | `brew install cloudflared`, or set `DEMO_MERCHANT_URL` to a public HTTPS URL for the merchant. |
| Port 4174 busy | `DEMO_PORT=4175 npm run demo:live`. |
| Google Cloud down on stage | The page offers **Run local mock**. Say clearly that the right pane is now local and mock. The left spy feed still works. |

---

## After the demo (stop paying)

```sh
gcloud --project=wraps-hack compute instances stop wraps-issuer wraps-relay --zone=us-central1-a
gcloud --project=wraps-hack compute addresses delete wraps-relay-ip --region=us-central1   # reserved, unused
```
Keep `wraps-relay-live-ip` (`136.80.57.82`) and `wraps-issuer-ip` (`34.123.78.11`) only if you will demo again; delete them otherwise (reserved IPs cost a little while their VM is stopped). See FUP-03 in TODO.md.
