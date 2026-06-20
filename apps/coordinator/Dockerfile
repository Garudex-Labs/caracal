# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Coordinator image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG PNPM_VERSION=11.1.1

FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS go-builder
ARG CGO_ENABLED=0
ARG CC
ARG CFLAGS
ARG CXX
ARG CXXFLAGS
ARG LDFLAGS
ARG GOFLAGS
ARG GO_BUILDFLAGS
ARG GO_LDFLAGS
ENV CGO_ENABLED=${CGO_ENABLED} GOOS=linux
WORKDIR /build
COPY go.work go.work
COPY packages/core/go/ packages/core/go/
COPY packages/identity/go/ packages/identity/go/
COPY packages/oauth/go/ packages/oauth/go/
COPY packages/revocation/go/ packages/revocation/go/
COPY packages/transport/mcp/go/ packages/transport/mcp/go/
COPY packages/connectors/nethttp/go/ packages/connectors/nethttp/go/
COPY packages/connectors/redis/go/ packages/connectors/redis/go/
COPY packages/sdk/go/ packages/sdk/go/
COPY services/sts/ services/sts/
COPY services/audit/ services/audit/
COPY services/gateway/ services/gateway/
COPY services/coordinator-relay/ services/coordinator-relay/
COPY tests/go/ tests/go/
WORKDIR /build/services/coordinator-relay
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    go mod download && \
    go build -mod=readonly -trimpath ${GO_BUILDFLAGS} -ldflags="${GO_LDFLAGS}" -o /relay ./cmd/relay

FROM node:26-alpine@sha256:a2dc166a387cc6ca1e62d0c8e265e49ca985d6e60abc9fe6e6c3d6ce8e63f606 AS node-builder
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/coordinator/package.json apps/coordinator/package.json
COPY packages/adminAudit/ts/package.json packages/adminAudit/ts/package.json
COPY packages/core/ts/package.json packages/core/ts/package.json
COPY packages/identity/ts/package.json packages/identity/ts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/coordinator...
COPY packages/adminAudit/ts/tsconfig.json packages/adminAudit/ts/tsconfig.json
COPY packages/adminAudit/ts/src packages/adminAudit/ts/src
COPY packages/core/ts/tsconfig.json packages/core/ts/tsconfig.json
COPY packages/core/ts/src packages/core/ts/src
COPY packages/identity/ts/tsconfig.json packages/identity/ts/tsconfig.json
COPY packages/identity/ts/src packages/identity/ts/src
COPY apps/coordinator/tsconfig.json apps/coordinator/tsconfig.json
COPY apps/coordinator/src/ apps/coordinator/src/
RUN set -e; \
    pnpm --filter @caracalai/admin-audit build; \
    pnpm --filter @caracalai/core build; \
    pnpm --filter @caracalai/identity build; \
    pnpm --filter @caracalai/coordinator build; \
    pnpm --config.inject-workspace-packages=true --filter @caracalai/coordinator deploy --prod /out; \
    find /out/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + 2>/dev/null || true; \
    find /out/node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name 'CHANGELOG*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \) -delete 2>/dev/null || true

FROM node:26-alpine@sha256:a2dc166a387cc6ca1e62d0c8e265e49ca985d6e60abc9fe6e6c3d6ce8e63f606
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=4000
WORKDIR /app
COPY --from=go-builder --chown=node:node /relay /relay
COPY --from=node-builder --chown=node:node /out ./
COPY --chown=node:node --chmod=0755 apps/coordinator/start.sh /start.sh
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/ready" || exit 1
ENTRYPOINT ["/start.sh"]
