# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Audit service image; build context must be the caracal/ workspace root.

# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:188ddfb9e497f861177352057cb21913d840ecae6c843d39e00d44fa64daa51c

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
COPY services/gateway/ services/gateway/
COPY apps/coordinator/relay/ apps/coordinator/relay/
COPY services/audit/ services/audit/
COPY tests/go/ tests/go/
COPY infra/healthcheck/ /healthcheck/
WORKDIR /build/services/audit
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    go mod download && \
    go build -trimpath -ldflags='-s -w' -o /audit ./cmd/audit && \
    cd /healthcheck && GOWORK=off go build -trimpath -ldflags='-s -w' -o /healthcheck-bin ./

FROM ${RUNTIME_IMAGE}
COPY --from=builder /audit /audit
COPY --from=builder /healthcheck-bin /healthcheck
USER 65532:65532
ENV PORT=9090 HEALTH_PATH=/ready
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD ["/healthcheck"]
ENTRYPOINT ["/audit"]
