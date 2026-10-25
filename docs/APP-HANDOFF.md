# App handoff: what changed on main and what the app needs

Hey, a lot landed on main while you were building the menu bar app. This note lists what the app can now use, what will break soon if it doesn't change, and the order I'd do it in. Nothing in `app/` was changed. It's all yours.

---

## What the app does today (from the code on main)

- **`main.ts`** uses `MockBackend` (`backend.ts`): fake nodes (Zürich, Tokyo, …), fake attestation, fake connect.
- **`tokens.ts` `buy()`**: real blind tokens. Gets a quote, pays RLUSD on XRPL EVM testnet with the wallet, calls `/issue`. 👍
- **`tokens.ts` `issuerKey()`**: fetches `/attestation` but **doesn't verify it** (your own comment says so).
- **`tokens.ts` `spend()`**: the app calls the issuer's **`/settle` itself** as merchant `node:<id>`.
- `ISSUER_URL` defaults to `http://127.0.0.1:4001` (local issuer).

---

## What's on main now that the app can use

| Piece | Where | Notes |
|---|---|---|
| **Live issuer** in Google Confidential Space (AMD SEV) | `wraps-issuer` VM, HTTPS on 443 | **Its IP changes on every restart.** Get it with `infra/gcp/status.sh`. Serves a **self-signed TLS cert**; trust comes from the attestation, not a CA |
| **Live relay** in Confidential Space | `136.80.57.82` (static) | HTTPS proxy on **443**, attestation on **HTTP 8080** (`/attestation`, `/wireguard-attestation`), WireGuard on **UDP 51820**, peer registration at `/wireguard/register` |
| **Expected image digests** | `infra/gcp/expected.json` | What the verifier compares against |
| **Attestation verifier** | `packages/attestation` (`confidential-space.ts`) | Checks Google's signature, AMD SEV, production image, debug off, image digest, nonce, key hash |
| **SDK** | `packages/sdk` | `PrivatePayClient` (verify issuer, top-up, pay 402s, caps, token reservation and restore), `createPinnedRelayTransport` (tunnel through the attested relay), `fetchVerifiedWireGuardReceipt`, `createWireGuardClientProfile`, `registerWireGuardPeer` |
| **WireGuard through the attested relay** | PR #42 | **Verified live in production**: client handshake, HTTPS 200 through the tunnel |
| **Token key epochs** | issuer (SEC-01) | Token keys rotate and expire. Re-fetch keys or attestation if a key is retired |
| **Single-use merchant quotes** | `x-blindtoken-quote` header (SEC-01) | Merchants bind each payment to one resource and price |
| **Idempotent settle and `/settle/status`** | issuer (SEC-03) | For merchants and relays, not buyers |
| **RLUSD payouts to merchants** | issuer (ISS-06) | Mock rail by default |
| **Live demo and preflight** | `npm run demo:live`, `npm run demo:preflight` | `docs/DEMO-DAY.md`. A good reference for the full verified flow |

---

## ⚠️ What will break soon: `spend()` settling directly

PR #47 (open, not merged yet) adds **merchant authentication** on `/settle`. Once a deployment turns enforcement on, the app's `spend()` (settling as `node:<id>` with no credential) **gets refused**.

Until enforcement is on, the issuer runs in a **legacy-open** mode that still accepts it, with a loud warning. So nothing breaks today, but it's on the clock.

The underlying issue is the role. **The buyer shouldn't settle.** The relay or merchant settles tokens it was handed. For the VPN that means:
1. The app registers a WireGuard peer with the relay, handing it tokens (`registerWireGuardPeer` in the SDK, which calls the relay's `/wireguard/register`).
2. The **relay** meters bandwidth and settles with the issuer (it already does this in `packages/relay`).
3. The app never calls `/settle`.

---

## Suggested order

1. **Verify the issuer attestation** (replace `issuerKey()`).
   - Use `ConfidentialSpaceVerifier` from `packages/attestation` with `infra/gcp/expected.json`, or just use `PrivatePayClient`.
   - **Tauri gotcha:** the webview's `fetch` will reject the issuer's self-signed cert. Make attested HTTPS calls from the Rust side (or `@tauri-apps/plugin-http` with custom cert handling), and pin the TLS key from the attestation. Don't just turn off cert checks.
2. **Replace `MockBackend` with a real backend** for one real node: the relay at `136.80.57.82` (us-central1).
   - `listNodes()`: return that relay from config.
   - `attest()`: `/attestation` plus `/wireguard-attestation` via the SDK. Show `hwmodel`, `swname`, `dbgstat`, image digest match and TLS pin in the UI. Keep the Tokyo-style "tampered" refusal as a real wrong-digest check.
   - `connect()`: `createWireGuardClientProfile` + `registerWireGuardPeer` (pays with tokens), then bring up the tunnel. On macOS, bringing up WireGuard from the app needs either a NetworkExtension, the official WireGuard app importing the generated profile, or `wg-quick` with admin rights. Pick one. Importing the profile into the WireGuard app is the fastest for a demo.
3. **Remove `spend()`'s direct `/settle`.** Bandwidth is paid through peer registration and quota, and the relay settles.
4. **Handle key rotation and quotes.** If `/issue` or a merchant refuses because a token key is retired or a quote expired, re-fetch attestation and retry. The SDK's reservation logic shows how not to lose tokens.
5. **Config:** issuer URL (changes on restart), relay host `136.80.57.82`, relay attestation port `8080`, expected digests. Read them from env or a config file, not hardcoded.

---

## Honest limits to keep in the UI copy

- AMD **SEV**, verified by Google. Not SEV-SNP.
- AP4M (Mastercard) top-up is **not** implemented. The demo uses a mock rail. Your XRPL EVM RLUSD top-up is real.
- The **standalone** WireGuard gateway VM (PR #43) is a plain GCE VM outside Confidential Space, with no attestation or token metering. Only the WireGuard path inside the Confidential Space relay is attested.
- Issuer state lives in memory: a restart loses keys, so old tokens become unknown.

---

## Where to look

- `docs/DEMO-DAY.md`, `docs/REHEARSAL.md`: the verified live flow, end to end
- `docs/SECURITY-CONFORMANCE.md`: what the issuer guarantees, with tests
- `scripts/live-preflight.ts`, `apps/demo/src/live-agent-run.ts`: working code that verifies the live issuer and relay and pays through the relay. The closest thing to what the app needs
- `packages/sdk/src/wireguard.ts`: WireGuard receipt verification, profile and registration
- `infra/gcp/README.md`, `infra/gcp/relay-deploy.md`: starting the VMs and getting IPs

Ping Adarsha if anything here is unclear.

---

## Update: the VPN is now one click, no other apps (Oct 25)

The WireGuard part is **automatic inside the app now**. The user never sees a key, a profile, a QR code or the WireGuard app. Rule from here on: **nobody should ever need a separate app or a terminal to connect.**

What happens when the user clicks **Connect** in the desktop app (`TauriBackend` in `app/src/backend.ts`, Rust in `app/src-tauri/src/vpn.rs`):
1. The app runs the bundled connect helper (`scripts/wg-join.ts`, run by a Node binary shipped inside the app). It generates a fresh WireGuard key on the device, verifies the relay's Confidential Space attestation and the issuer's, buys 10 blind tokens (mock top-up rail for now), pays the relay, and gets a tunnel address back. The relay accepts any key that pays (open registration, PR #51).
2. macOS asks for the admin password **once** (standard system prompt), and the bundled `wireguard-go` + `wg` bring the tunnel up, set routes, and set DNS to 1.1.1.1 (`app/src-tauri/resources/wraps-tunnel.sh`).
3. Disconnect removes the tunnel and restores DNS. The app re-checks the relay's attestation every 60 s.

Build: `app/scripts/prepare-vpn.sh` assembles the bundled binaries (official Node, checksum-verified; `wg` and `wireguard-go` from Homebrew; the helper bundled with esbuild), then `tauri build`. Binaries are not committed (too big for GitHub).

Still to do, in order:
- **Pay with the user's own tokens.** The helper currently buys tokens on the mock rail. Pass the wallet's real blind tokens (from `tokens.ts`) to the helper instead, and remove the app's direct `/settle` (`tk.spend`), which the desktop app no longer calls.
- **Top up automatically** when the 100 MB runs low (call the helper again with the same key).
- **Show real usage** instead of the simulated meter (read `wg show <iface> transfer`).
- **Ship it properly:** sign and notarize the app; for a fully native experience (no password prompt, VPN in System Settings) move the tunnel into a macOS Network Extension later. Intel Macs need an x86_64 build.
