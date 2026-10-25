# Issuer workload for Google Cloud Confidential Space. Build context: the repo root.
#   Build:  infra/gcp/build.sh issuer   (Cloud Build; prints the image digest)
#
# The SDK trusts this image by its digest (infra/gcp/expected.json), which the
# attestation token reports as submods.container.image_digest. Anything that
# changes the image (code, ENV, LABEL, EXPOSE) changes the digest.

# ---- build: install from the lockfile, bundle the issuer into one file ----------
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
# --ignore-scripts: no install scripts run. None of the issuer's dependencies need one.
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN mkdir /out && npx esbuild packages/issuer/src/cli.ts \
      --bundle --platform=node --format=esm --target=node22 --legal-comments=none \
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/issuer.mjs

# ---- runtime: node and one bundled file ------------------------------------------
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da
COPY --from=build /out/issuer.mjs /app/issuer.mjs

# Fixed in the image, so the operator cannot change them: no allow_env_override label.
# Money: the issuer makes its own XRPL EVM wallet in memory at boot (ISSUER_WALLET=enclave) and names
# it in the attestation. Users top up by paying it RLUSD (or on the mock rail for the agent demo); every
# 2 minutes it pays merchants' earned tabs in RLUSD from it. The key dies with the VM, so before a
# planned restart call POST /sweep: it sends everything to ISSUER_SWEEP_TO and nowhere else.
ENV NODE_ENV=production \
    TZ=UTC \
    ATTESTATION=confidential-space \
    ISSUER_TLS=1 \
    ISSUER_HOST=0.0.0.0 \
    ISSUER_PORT=443 \
    ISSUER_RAIL=mock,xrpl-evm \
    ISSUER_WALLET=enclave \
    ISSUER_SWEEP_TO=0x34A7142038CDd6946ecc8a231e49c45E62A7F562 \
    RLUSD_ADDRESS=0x27b57a9D0b8d24EB97259c4E2279e45255e016f3 \
    XRPL_EVM_RPC=https://rpc.testnet.xrplevm.org/ \
    PAYOUT_RAIL=xrpl-evm \
    MERCHANT_PAYOUT_ADDRESSES=relay=0x7AAcF9A05880866ebEb3c7EF7E55C36e53D535df,merchant-research-data=0x7AAcF9A05880866ebEb3c7EF7E55C36e53D535df \
    PAYOUT_INTERVAL_MS=120000

# Confidential Space blocks inbound ports unless the image exposes them.
EXPOSE 443/tcp

# Launch policy. Logs leave the VM only on the debug image (this is also the default).
LABEL "tee.launch_policy.log_redirect"="debugonly"

# Root inside the container: binds 443 and reads the launcher socket
# (/run/container_launcher/teeserver.sock).
CMD ["node", "/app/issuer.mjs"]
