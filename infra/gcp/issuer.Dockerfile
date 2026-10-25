# Build context is the repository root. Node's amd64 manifest digest was read
# from the Docker Official Image page for node:22.23.4-bookworm-slim.
FROM --platform=linux/amd64 node:22.23.4-bookworm-slim@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09 AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.json ./
COPY packages/issuer/ ./packages/issuer/
COPY packages/attestation/ ./packages/attestation/
COPY packages/tokens/ ./packages/tokens/

# Install the selected workspaces from package-lock.json; no lifecycle scripts
# or install-time network fetches are required by the issuer's runtime deps.
RUN npm ci --no-audit --no-fund --ignore-scripts --include-workspace-root \
    --workspace @wraps/issuer \
    --workspace @wraps/attestation \
    --workspace @wraps/tokens
RUN mkdir -p /out && ./node_modules/.bin/esbuild packages/issuer/src/cli.ts \
    --bundle --platform=node --format=esm --target=node22 --legal-comments=none \
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
    --outfile=/out/issuer.mjs

# Runtime: only the pinned Node image and the bundled workload are shipped.
FROM --platform=linux/amd64 node:22.23.4-bookworm-slim@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09
WORKDIR /app
COPY --from=build /out/issuer.mjs ./issuer.mjs

# The production CLI selects Confidential Space attestation and makes its TLS
# identity inside the workload. The audience is supplied by the deployer.
ENV NODE_ENV=production \
    ATTESTATION=confidential-space \
    ISSUER_TLS=1 \
    ISSUER_HOST=0.0.0.0 \
    ISSUER_PORT=443 \
    TZ=UTC

EXPOSE 443/tcp
LABEL "tee.launch_policy.log_redirect"="debugonly"
LABEL "tee.launch_policy.allow_env_override"="ATTESTATION_AUDIENCE"

# The Confidential Space launcher socket is available to the workload process.
CMD ["node", "/app/issuer.mjs"]
