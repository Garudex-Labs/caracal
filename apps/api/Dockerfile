# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# API service image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG PNPM_VERSION=11.1.1

FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS health-builder
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
WORKDIR /healthcheck
COPY infra/healthcheck/ ./
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    GOWORK=off go build -mod=readonly -trimpath ${GO_BUILDFLAGS} -ldflags="${GO_LDFLAGS}" -o /healthcheck-bin ./

FROM node:26-slim@sha256:191ef878ecb351d68b78219593de18bd8942afd59af59f29960dc4b24805a3f1 AS builder
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/adminAudit/ts/package.json packages/adminAudit/ts/package.json
COPY packages/core/ts/package.json packages/core/ts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/api...
COPY packages/adminAudit/ts/tsconfig.json packages/adminAudit/ts/tsconfig.json
COPY packages/adminAudit/ts/src packages/adminAudit/ts/src
COPY packages/core/ts/tsconfig.json packages/core/ts/tsconfig.json
COPY packages/core/ts/src packages/core/ts/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN set -e; \
    pnpm --filter @caracalai/admin-audit build; \
    pnpm --filter @caracalai/core build; \
    pnpm --filter @caracalai/api build; \
    pnpm --config.inject-workspace-packages=true --filter @caracalai/api deploy --prod /out; \
    find /out/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + 2>/dev/null || true; \
    find /out/node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name 'CHANGELOG*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \) -delete 2>/dev/null || true

FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000 \
    HEALTH_PATH=/ready
WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /out ./
COPY --from=health-builder /healthcheck-bin /healthcheck
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["/healthcheck"]
CMD ["dist/main.js"]
