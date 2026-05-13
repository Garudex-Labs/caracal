# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Gateway service image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1
ARG RUNTIME_IMAGE=alpine:3.22@sha256:310c62b5e7ca5b08167e4384c68db0fd2905dd9c7493756d356e893909057601

FROM ${GO_IMAGE} AS builder
ENV CGO_ENABLED=0 GOOS=linux GOFLAGS=-mod=readonly
WORKDIR /build
COPY go.work go.work
COPY packages/core/go/ packages/core/go/
COPY packages/identity/go/ packages/identity/go/
COPY packages/revocation/go/ packages/revocation/go/
COPY packages/transport/mcp/go/ packages/transport/mcp/go/
COPY packages/connectors/nethttp/go/ packages/connectors/nethttp/go/
COPY packages/connectors/redis/go/ packages/connectors/redis/go/
COPY packages/sdk/go/ packages/sdk/go/
COPY services/sts/ services/sts/
COPY services/audit/ services/audit/
COPY apps/coordinator/relay/ apps/coordinator/relay/
COPY services/gateway/ services/gateway/
COPY tests/go/ tests/go/
WORKDIR /build/services/gateway
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    go mod download && \
    go build -trimpath -ldflags='-s -w' -o /gateway ./cmd/gateway

FROM ${RUNTIME_IMAGE}
RUN apk add --no-cache ca-certificates wget tini
COPY --from=builder /gateway /gateway
USER 65532:65532
ENV PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8081}/ready" || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/gateway"]
