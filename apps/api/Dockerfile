# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# API service image; build context must be the caracal/ workspace root.
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/ts/package.json packages/core/ts/package.json
RUN npm install -g pnpm@10.28.0 && pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/api...
COPY packages/core/ts/tsconfig.json packages/core/ts/tsconfig.json
COPY packages/core/ts/src packages/core/ts/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN pnpm --filter @caracalai/core build && \
    pnpm --filter @caracalai/api build && \
    pnpm --filter @caracalai/api deploy --prod --legacy /out

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app
COPY --from=builder /out ./
COPY infra/postgres/migrations /caracal/migrations
ENV CARACAL_MIGRATIONS_DIR=/caracal/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["node", "dist/main.js"]
