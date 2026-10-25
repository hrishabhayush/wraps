# Issuer workload for Google Cloud Confidential Space. Build context: the repo root.
#   Build:  infra/gcp/build.sh issuer   (Cloud Build; prints the image digest)
#
# The SDK trusts this image by its digest (infra/gcp/expected.json), which the
# attestation token reports as submods.container.image_digest. Anything that
# changes the image (code, ENV, LABEL, EXPOSE) changes the digest.

# ---- build: install from the lockfile, bundle the issuer into one file ----------
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS build
WORKDIR /repo
ARG ISSUER_MERCHANT_AUTH_KEYS_B64=
ARG GCP_WIF_PROVIDER
ARG ISSUER_STATE_GCS_BUCKET
ARG ISSUER_STATE_GCS_PREFIX
ARG ISSUER_STATE_KMS_KEY
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
# --ignore-scripts: no install scripts run. None of the issuer's dependencies need one.
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN mkdir /out && npx esbuild packages/issuer/src/cli.ts \
      --bundle --platform=node --format=esm --target=node22 --legal-comments=none \
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/issuer.mjs
RUN printf '%s' "$ISSUER_MERCHANT_AUTH_KEYS_B64" | base64 -d > /out/issuer-merchant-auth.json

# ---- runtime: node and one bundled file ------------------------------------------
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da
ARG GCP_WIF_PROVIDER
ARG ISSUER_STATE_GCS_BUCKET
ARG ISSUER_STATE_GCS_PREFIX
ARG ISSUER_STATE_KMS_KEY
COPY --from=build /out/issuer.mjs /app/issuer.mjs
COPY --from=build /out/issuer-merchant-auth.json /app/issuer-merchant-auth.json
COPY infra/gcp/issuer-start.sh /app/issuer-start.sh

# Allow only Secret Manager references as deployment metadata. Merchant public keys are
# baked into the image and therefore covered by its attested digest.
ENV NODE_ENV=production \
    TZ=UTC \
    ATTESTATION=confidential-space \
    ISSUER_TLS=1 \
    ISSUER_HOST=0.0.0.0 \
    ISSUER_PORT=443 \
    GCP_WIF_PROVIDER=${GCP_WIF_PROVIDER} \
    ISSUER_STATE_GCS_BUCKET=${ISSUER_STATE_GCS_BUCKET} \
    ISSUER_STATE_GCS_PREFIX=${ISSUER_STATE_GCS_PREFIX} \
    ISSUER_STATE_KMS_KEY=${ISSUER_STATE_KMS_KEY}

# Confidential Space blocks inbound ports unless the image exposes them.
EXPOSE 443/tcp

# Launch policy. Logs leave the VM only on the debug image (this is also the default).
LABEL "tee.launch_policy.log_redirect"="debugonly"
LABEL "tee.launch_policy.allow_env_override"="ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION"

# Root inside the container: binds 443 and reads the launcher socket
# (/run/container_launcher/teeserver.sock).
CMD ["sh", "/app/issuer-start.sh"]
