# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Audit service image; build context must be the caracal/ workspace root.

FROM golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS builder
WORKDIR /build
COPY go.work go.work
COPY packages/core/go/ packages/core/go/
COPY packages/identity/go/ packages/identity/go/
COPY packages/revocation/go/ packages/revocation/go/
COPY packages/transport/mcp/go/ packages/transport/mcp/go/
COPY packages/connectors/nethttp/go/ packages/connectors/nethttp/go/
COPY packages/sdk/go/ packages/sdk/go/
COPY services/sts/ services/sts/
COPY services/gateway/ services/gateway/
COPY apps/coordinator/relay/ apps/coordinator/relay/
COPY services/audit/ services/audit/
COPY tests/go/ tests/go/
WORKDIR /build/services/audit
RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -o /audit ./cmd/audit

FROM alpine:3.22@sha256:310c62b5e7ca5b08167e4384c68db0fd2905dd9c7493756d356e893909057601
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /audit /audit
USER 65532:65532
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-9090}/health" || exit 1
ENTRYPOINT ["/audit"]
