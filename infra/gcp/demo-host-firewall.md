# INF-21: demo-host firewall blocker

## Finding

The current live rehearsal runs the agent, the mainnet spy, and the temporary merchant tunnel on one macOS host. A host-wide outbound rule that allows only the relay would break two required parts of that rehearsal:

- The spy sends XRPL JSON-RPC requests directly to `s1.ripple.com:51234`, `s2.ripple.com:51234`, and `xrplcluster.com:443` (`packages/spybot/src/rpc.ts`). It loads the XRPL AI Hub directory and merchant catalogs from `xrpl-ai.org` (`packages/spybot/src/directory.ts`, `packages/spybot/src/catalog.ts`). An optional Quicknode endpoint comes from `QUICKNODE_XRPL_URL`.
- Unless `DEMO_MERCHANT_URL` is configured, the live agent starts `cloudflared` on the same host to expose its local merchant (`apps/demo/src/live-agent-run.ts`). Cloudflare documents that Tunnel needs DNS discovery and outbound TCP or UDP port 7844 to its edge endpoints; those endpoints are not the attested relay (`https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/`).
- The live agent contacts the relay's attestation listener on port 8080 and relay HTTPS on port 443. Issuer requests are sent through the pinned relay. If issuer or relay addresses are absent from the environment and `.state` files, live configuration can also call `gcloud` to discover them (`scripts/live-config.ts`).

Allowing the current spy and tunnel exceptions would make this a host-wide allowlist for unrelated processes, not “outbound traffic only to the relay.” Allowing general DNS to keep these hostname-based clients working would also leave a direct DNS egress path. Resolving and pinning the current IPs is not a robust substitute: it can break a rehearsal when an endpoint answer changes, while allowing broad vendor ranges weakens the egress boundary.

## Safe status

No PF rules, anchors, enable references, or other host firewall settings were changed during this audit. The local `/etc/pf.conf` exposes Apple's `com.apple/*` anchor; reading `pfctl` status was denied without root, and no privileged firewall commands were run.

INF-21 stays open. This repository does not yet have a safe boundary that isolates the agent from the spy and `cloudflared` traffic on the same host. Before adding an apply/disable/timer workflow, move the agent and its DNS into an isolated VM or equivalent network boundary whose only egress is the relay, while keeping the spy and merchant tunnel outside that boundary. Then rehearsal-only firewall changes can be tested in that isolated environment with an automatic rollback and status/disable commands.

## Recheck before implementation

1. Confirm the isolated agent can reach the relay's HTTPS and attestation endpoints without direct DNS or issuer egress.
2. Confirm the spy and merchant tunnel continue to work outside the isolated boundary.
3. Test allow, deny, status, manual disable, and automatic rollback in the isolated rehearsal environment. Do not apply a trial policy to the operator's active macOS firewall.
