# Status: issuer on Confidential Space

Checked live on Oct 24, 2026 (US time).

## What works

- The issuer image builds with Cloud Build and runs in Confidential Space on `n2d-standard-2` with AMD SEV.
- Image `us-central1-docker.pkg.dev/wraps-hack/wraps/issuer@sha256:892a2b1a22c5a911c221ce7f31aee477f33bf986083111c843935213dbc6fbea`, built from commit `1df3bee`.
- The issuer serves HTTPS on port 443. The certificate is self-signed, and its key is made in the VM at start-up.
- `GET /attestation?nonce=` returns a token that Google Cloud Attestation signed. The token has our audience and both nonces: the client nonce and the hash of the token, claim and TLS keys.
- The SDK verifier checks the RS256 signature against Google's JWKS, and the issuer, audience, expiry, hardware, OS, debug state, support attributes, image digest, nonce and key hash.
- The SDK and the merchant check that the TLS key on the connection is the attested key. Then they pin it. A different key closes the socket before the request goes out.
- `npm run demo:gcp` ran against the live issuer: the merchant and the agent on a laptop, a top-up, 8 purchases, 8 signed claims and a signed reserves statement, all verified.

## Live results

| Check | VM | Result |
|---|---|---|
| `npm run verify:gcp` | `wraps-issuer-debug` (debug image) | REFUSED (DEBUG_MODE): `dbgstat` is `enabled`. The token had no support attributes. |
| `npm run verify:gcp` | `wraps-issuer` (production image) | VERIFIED: `hwmodel GCP_AMD_SEV`, `swname CONFIDENTIAL_SPACE`, `swversion 261000`, `dbgstat disabled-since-boot`, `support [LATEST, STABLE, USABLE]`, image digest matches |
| `npm run demo:gcp` | `wraps-issuer` | Full flow passed. Claims and reserves verify against the attested claim key. |
| `demo:gcp` with a wrong digest in `expected.json` | `wraps-issuer` | REFUSED (IMAGE_MISMATCH) before any top-up or payment |
| `npm run merchant` and `npm run agent` | `wraps-issuer` | Both verified the token and pinned the TLS key |

Both VMs are **stopped**, not deleted. Their disks remain.

## What is still mocked

- The AP4M top-up rail (`MockTopUpRail`). No real voucher or RLUSD.
- Merchant payouts (`MockPayoutRail`).
- There is no relay. `packages/relay` does not exist, so there is no relay image.

## Trade-offs and limits

- **Trust in Google.** The claims rest on AMD SEV hardware and on Google Cloud Attestation. Google checks the hardware evidence and signs the token. We do not check AMD's report ourselves. Google, the cloud operator, is in the trusted base.
- **AMD SEV, not SEV-SNP.** The Confidential Space docs list SEV and TDX. They do not list SEV-SNP, so `deploy.sh` uses SEV. The project can launch SEV-SNP, but we did not test Confidential Space on it.
- **The image is not reproducible byte for byte.** The base image is pinned by digest and npm installs from the lockfile. But a Docker build stamps file times, so a rebuild can give a different digest. Anyone who wants to check the code must trust our build or rebuild it and compare. Reproducible builds are future work.
- **Keys die with the VM.** A stopped VM restarts with new keys and a new spent list, and gets a new IP. Do not restart during the demo.
- **The TLS name is not checked.** The SDK pins the key, not a DNS name. That is the point: no CA is involved.
- **The first connection is unpinned.** The SDK sends only the nonce on it, then compares the connection's key with the attested key. Nothing that matters (payments, tokens) goes out before that check.
- **The relay transport.** Over https, the SDK opens TLS connections to the issuer itself. A future relay tunnel (SDK-02) must carry these TLS connections. For now `transport` is used only for http issuers and for non-issuer URLs.
- **Logs.** The production image sends no container logs out (`log_redirect=debugonly`). The launcher still writes its own logs to the serial console.
- **Attestation rate.** Google Cloud Attestation allows 5 token requests per second per project per region. The issuer also limits `/attestation` to 60 per IP per minute.

## Costs incurred

- `wraps-issuer-debug` ran about 7 minutes. `wraps-issuer` ran about 5 minutes. Both are `n2d-standard-2` with AMD SEV. Together that is well under $0.05.
- One Cloud Build run, 32 seconds, inside the free tier.
- Two stopped 11 GB `pd-standard` disks: about $0.90 per month in total until someone deletes them.
- Artifact Registry: one image of about 80 MB, a few cents per month.

## Next steps

- Delete `wraps-issuer-debug` when nobody needs it (`gcloud compute instances delete wraps-issuer-debug --zone us-central1-a`).
- Before the demo, run `infra/gcp/deploy.sh issuer`, then `npm run verify:gcp`. The agent and merchant read the new IP from `infra/gcp/.state/issuer.ip`.
- Relay: add `infra/gcp/relay.Dockerfile` once `packages/relay` exists. The scripts already take `relay`.
