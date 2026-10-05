# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Runtime container image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG PNPM_VERSION=11.1.1
ARG PNPM_INTEGRITY=sha512-0f319zxhe2T6GlaoHDyN/g6WbjOmAQqiVrUXrne+Idk+Ba/8DeGoOw5PKdVp9otEaujwaM1yR8C7PfD7TXvfmg==
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_INTEGRITY=sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==
ARG BUN_LINUX_AARCH64_INTEGRITY=sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==

FROM node:26-slim@sha256:4ebb5ace66f15a24c14c492e01a8beeed4fddf970a856109f5126e703e5fe503 AS builder
ARG PNPM_VERSION
ARG PNPM_INTEGRITY
ARG BUN_VERSION
ARG BUN_LINUX_X64_INTEGRITY
ARG BUN_LINUX_AARCH64_INTEGRITY
ARG TARGETARCH
ARG CARACAL_RELEASE_VERSION
ARG CARACAL_DEV_SHA
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/installVerifiedNpmTarball.mjs /tmp/installVerifiedNpmTarball.mjs
RUN node /tmp/installVerifiedNpmTarball.mjs pnpm "${PNPM_VERSION}" "${PNPM_INTEGRITY}" /opt/pnpm \
    && chmod 0755 /opt/pnpm/bin/pnpm.cjs \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && pnpm --version | grep -Fx "${PNPM_VERSION}" \
    && rm /tmp/installVerifiedNpmTarball.mjs
RUN <<'EOF'
set -eu
case "${TARGETARCH}" in
  amd64) bunPackage="bun-linux-x64"; bunIntegrity="${BUN_LINUX_X64_INTEGRITY}" ;;
  arm64) bunPackage="bun-linux-aarch64"; bunIntegrity="${BUN_LINUX_AARCH64_INTEGRITY}" ;;
  *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;;
esac
bunUrl="https://registry.npmjs.org/@oven/${bunPackage}/-/${bunPackage}-${BUN_VERSION}.tgz"
node - "${bunUrl}" "${bunIntegrity}" /tmp/bun.tgz <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");

const [url, integrity, target] = process.argv.slice(2);
https.get(url, (response) => {
  if (response.statusCode !== 200) {
    console.error(`download failed: ${response.statusCode}`);
    process.exit(1);
  }

  const hash = crypto.createHash("sha512");
  const file = fs.createWriteStream(target);
  response.on("data", (chunk) => hash.update(chunk));
  response.pipe(file);
  file.on("finish", () => {
    file.close(() => {
      const actual = `sha512-${hash.digest("base64")}`;
      if (actual !== integrity) {
        console.error(`integrity mismatch: ${actual}`);
        process.exit(1);
      }
    });
  });
}).on("error", (error) => {
  console.error(error);
  process.exit(1);
});
NODE
tar -xzf /tmp/bun.tgz -C /tmp
install -m 0755 /tmp/package/bin/bun /usr/local/bin/bun
rm -rf /tmp/package /tmp/bun.tgz
bun --version | grep -Fx "${BUN_VERSION}"
EOF
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/ packages/
COPY apps/runtime/ apps/runtime/
COPY infra/docker/runtime-compose.yml infra/docker/runtime-compose.yml
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/runtime...
RUN pnpm --filter "@caracalai/runtime^..." build
RUN case "${TARGETARCH}" in \
      amd64) bunTarget=bun-linux-x64 ;; \
      arm64) bunTarget=bun-linux-arm64 ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac && \
    cd apps/runtime && \
    CARACAL_RELEASE_VERSION="${CARACAL_RELEASE_VERSION}" CARACAL_DEV_SHA="${CARACAL_DEV_SHA}" node scripts/stampVersion.mjs && \
    bun build --compile --target=${bunTarget} src/shell.ts --outfile dist/caracal && \
    chmod +x dist/caracal

FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
# The pinned base digest lags Debian security releases between upstream rebuilds;
# upgrading at build time keeps apt packages (for example liblzma5) at their
# current fixes without waiting for a newer base image digest to be published.
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 65532 --user-group --create-home --home-dir /home/caracal caracal
COPY --from=builder /workspace/apps/runtime/dist/caracal /usr/local/bin/caracal
USER caracal
WORKDIR /home/caracal
ENTRYPOINT ["/usr/local/bin/caracal"]
