# Issuer enclave image (INF-07). Build context: the repo root.
#   Build: infra/scripts/build-eif.sh issuer   (do not run docker build by hand for the EIF)
#
# Reproducibility, because PCR0 must match on every build:
#   - Base images are pinned by digest. "@sha256:PIN_ME" is a placeholder.
#     Run infra/scripts/prepare-build.sh once on a machine with Docker, then commit.
#   - npm installs from package-lock.json (npm ci). Rust builds with Cargo.lock (--locked).
#   - Debian packages come from a fixed snapshot.debian.org date (DEBIAN_SNAPSHOT).
#   - build-eif.sh sets SOURCE_DATE_EPOCH and BuildKit rewrite-timestamp=true.
#   - issuer.Dockerfile.dockerignore keeps .git, node_modules and secrets out.
#
# Needs from other lanes:
#   - packages/issuer/src/cli.ts (the issuer entry point)
#   - "infra/enclave-common" in the root package.json "workspaces", then a fresh
#     package-lock.json, so @wraps/enclave-common installs like any workspace.

ARG SOURCE_DATE_EPOCH=0

# ---- Stage 1: the NSM helper binary (Rust) ---------------------------------
FROM rust:1.82.0-slim-bookworm@sha256:PIN_ME AS nsm
ARG SOURCE_DATE_EPOCH
WORKDIR /src
COPY infra/enclave-common/nsm-helper/ ./
ENV CARGO_HOME=/cargo \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/cargo=cargo"
RUN cargo build --release --locked && cp target/release/nsm-attest /nsm-attest

# ---- Stage 2: npm install from the lockfile ---------------------------------
FROM node:22.11.0-bookworm-slim@sha256:PIN_ME AS deps
ARG SOURCE_DATE_EPOCH
# Workspaces this app needs at runtime, besides itself and enclave-common.
ARG APP=issuer
ARG APP_PACKAGES="issuer tokens attestation"
WORKDIR /repo
COPY . .
# --ignore-scripts: no install scripts run, which is safer and more reproducible.
# Remove it if a dependency truly needs a postinstall step.
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --include-workspace-root -w "@wraps/${APP}" -w @wraps/enclave-common \
 && mkdir -p /out/packages /out/infra \
 && cp -a package.json package-lock.json node_modules /out/ \
 && for p in ${APP_PACKAGES}; do cp -a "packages/$p" /out/packages/; done \
 && cp -a infra/enclave-common /out/infra/ \
 && rm -rf /out/infra/enclave-common/nsm-helper

# ---- Stage 3: the enclave image ---------------------------------------------
FROM node:22.11.0-bookworm-slim@sha256:PIN_ME
ARG SOURCE_DATE_EPOCH
ARG DEBIAN_SNAPSHOT=20261020T000000Z
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" > /etc/apt/sources.list; \
    echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" >> /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends socat iproute2; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* \
           /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old /var/lib/dpkg/*-old

COPY --from=nsm /nsm-attest /usr/local/bin/nsm-attest
COPY --chmod=0755 infra/enclave-common/runtime/enclave-init.sh /usr/local/bin/enclave-init
COPY --chmod=0644 infra/config/egress.issuer.conf /etc/ifi/egress.conf
COPY --from=deps /out /app

WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC \
    ENCLAVE_ROLE=issuer \
    ENCLAVE_MODE=nitro \
    APP_PORT=8443 \
    BOOT_CONFIG_PORT=7000 \
    LOG_PORT=9000 \
    NSM_HELPER=/usr/local/bin/nsm-attest

ENTRYPOINT ["/usr/local/bin/enclave-init"]
CMD ["node", "--import", "tsx", "packages/issuer/src/cli.ts"]
