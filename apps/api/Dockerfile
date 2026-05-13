# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# API service image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
ARG PNPM_VERSION=11.0.9

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
    find /out/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name doc -o -name examples -o -name example \) -prune -exec rm -rf {} + 2>/dev/null || true && \
    find /out/node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.ts' -o -name '*.map' -o -name '*.flow' -o -name 'LICENSE*' -o -name 'CHANGELOG*' -o -name 'AUTHORS*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \) -delete 2>/dev/null || true

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=builder --chown=node:node /out ./
COPY --chown=node:node infra/postgres/migrations /caracal/migrations
ENV CARACAL_MIGRATIONS_DIR=/caracal/migrations \
    PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/ready" || exit 1
CMD ["node", "dist/main.js"]
