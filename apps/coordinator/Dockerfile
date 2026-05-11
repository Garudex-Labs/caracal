# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Coordinator image; build context must be the caracal/ workspace root.

FROM golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS go-builder
WORKDIR /build
COPY go.work go.work
COPY packages/core/go/ packages/core/go/
COPY packages/identity/go/ packages/identity/go/
COPY packages/revocation/go/ packages/revocation/go/
COPY packages/transport/mcp/go/ packages/transport/mcp/go/
COPY packages/connectors/nethttp/go/ packages/connectors/nethttp/go/
COPY packages/sdk/go/ packages/sdk/go/
COPY services/sts/ services/sts/
COPY services/audit/ services/audit/
COPY services/gateway/ services/gateway/
COPY apps/coordinator/relay/ apps/coordinator/relay/
COPY tests/go/ tests/go/
WORKDIR /build/apps/coordinator/relay
RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -o /relay ./cmd/relay

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS node-builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/coordinator/package.json apps/coordinator/package.json
COPY packages/core/ts/package.json packages/core/ts/package.json
COPY packages/identity/ts/package.json packages/identity/ts/package.json
RUN npm install -g pnpm@10.28.0 && pnpm install --frozen-lockfile --ignore-scripts --filter @caracalai/coordinator...
COPY packages/core/ts/tsconfig.json packages/core/ts/tsconfig.json
COPY packages/core/ts/src packages/core/ts/src
COPY packages/identity/ts/tsconfig.json packages/identity/ts/tsconfig.json
COPY packages/identity/ts/src packages/identity/ts/src
COPY apps/coordinator/tsconfig.json apps/coordinator/tsconfig.json
COPY apps/coordinator/src/ apps/coordinator/src/
RUN pnpm --filter @caracalai/core build && \
    pnpm --filter @caracalai/identity build && \
    pnpm --filter @caracalai/coordinator build && \
    pnpm --filter @caracalai/coordinator deploy --prod --legacy /out

FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app
COPY --from=go-builder /relay /relay
COPY --from=node-builder /out ./
COPY apps/coordinator/start.sh /start.sh
RUN chmod +x /start.sh && chown -R node:node /app /relay /start.sh
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/health" || exit 1
ENTRYPOINT ["/start.sh"]
