# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# CLI container image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG PNPM_VERSION=11.1.1
ARG BUN_VERSION=1.2.21

FROM node:24-slim@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e AS builder
ARG PNPM_VERSION
ARG BUN_VERSION
ARG TARGETARCH
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/root/.bun/bin:$PATH \
    CI=1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip jq \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/ packages/
COPY apps/cli/ apps/cli/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/cli...
RUN pnpm run build:typescript
RUN case "${TARGETARCH}" in \
      amd64) bunTarget=bun-linux-x64; outName=caracal-cli-linux-x64 ;; \
      arm64) bunTarget=bun-linux-arm64; outName=caracal-cli-linux-arm64 ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac && \
    cd apps/cli && \
    node scripts/stampRelease.mjs && \
    bun build --compile --target=${bunTarget} src/cli.ts --outfile dist/caracal-cli && \
    chmod +x dist/caracal-cli

FROM debian:12-slim@sha256:1209d8fd77def86ceb6663deef7956481cc6c14a25e1e64daec12c0ceffcc19d
RUN useradd --system --uid 65532 --user-group --create-home --home-dir /home/caracal caracal
COPY --from=builder /workspace/apps/cli/dist/caracal-cli /usr/local/bin/caracal
USER caracal
WORKDIR /home/caracal
ENTRYPOINT ["/usr/local/bin/caracal"]
