# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# API service image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-slim@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
ARG GO_IMAGE=golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1
ARG PNPM_VERSION=11.0.9

FROM ${GO_IMAGE} AS health-builder
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /healthcheck
COPY infra/healthcheck/ ./
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    GOWORK=off go build -trimpath -ldflags='-s -w' -o /healthcheck-bin ./

FROM ${NODE_IMAGE} AS builder
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/ts/package.json packages/core/ts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/api...
COPY packages/core/ts/tsconfig.json packages/core/ts/tsconfig.json
COPY packages/core/ts/src packages/core/ts/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN pnpm --filter @caracalai/core build && \
    pnpm --filter @caracalai/api build && \
    pnpm --filter @caracalai/api deploy --prod --legacy /out && \
    find /out/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + 2>/dev/null || true && \
    find /out/node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name 'CHANGELOG*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \) -delete 2>/dev/null || true

FROM ${RUNTIME_IMAGE}
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000 \
    HEALTH_PATH=/ready \
    CARACAL_MIGRATIONS_DIR=/caracal/migrations
WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /out ./
COPY --chown=nonroot:nonroot infra/postgres/migrations /caracal/migrations
COPY --from=health-builder /healthcheck-bin /healthcheck
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["/healthcheck"]
CMD ["dist/main.js"]
