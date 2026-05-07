# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Agent coordinator image; build context must be the caracal/ workspace root.

FROM golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS go-builder
WORKDIR /build
COPY go.work go.work
COPY packages/shared/ packages/shared/
COPY packages/caracalai-mcp-go/ packages/caracalai-mcp-go/
COPY services/sts/ services/sts/
COPY services/audit/ services/audit/
COPY services/gateway/ services/gateway/
COPY apps/agent-coordinator/relay/ apps/agent-coordinator/relay/
COPY tests/go/ tests/go/
WORKDIR /build/apps/agent-coordinator/relay
RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -o /relay ./cmd/relay

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS node-builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-coordinator/package.json apps/agent-coordinator/package.json
COPY packages/ts-shared/package.json packages/ts-shared/package.json
RUN npm install -g pnpm@10.28.0 && pnpm install --frozen-lockfile --filter @caracalai/agent-coordinator...
COPY packages/ts-shared/tsconfig.json packages/ts-shared/tsconfig.json
COPY packages/ts-shared/src packages/ts-shared/src
COPY apps/agent-coordinator/tsconfig.json apps/agent-coordinator/tsconfig.json
COPY apps/agent-coordinator/src/ apps/agent-coordinator/src/
RUN pnpm --filter @caracalai/shared build && \
    pnpm --filter @caracalai/agent-coordinator build && \
    pnpm --filter @caracalai/agent-coordinator deploy --prod --legacy /out

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app
COPY --from=go-builder /relay /relay
COPY --from=node-builder /out ./
COPY apps/agent-coordinator/start.sh /start.sh
RUN chmod +x /start.sh && chown -R node:node /app /relay /start.sh
USER node
ENTRYPOINT ["/start.sh"]
