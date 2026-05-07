# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# API service image; build context must be the caracal/ workspace root.
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/ts-shared/package.json packages/ts-shared/package.json
RUN npm install -g pnpm@10.28.0 && pnpm install --frozen-lockfile --filter @caracalai/api...
COPY packages/ts-shared/tsconfig.json packages/ts-shared/tsconfig.json
COPY packages/ts-shared/src packages/ts-shared/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN pnpm --filter @caracalai/shared build && \
    pnpm --filter @caracalai/api build && \
    pnpm --filter @caracalai/api deploy --prod --legacy /out

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app
COPY --from=builder /out ./
COPY infra/postgres/migrations /caracal/migrations
ENV CARACAL_MIGRATIONS_DIR=/caracal/migrations
USER node
CMD ["node", "dist/main.js"]
