# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# STS service image; build context must be the caracal/ workspace root.

FROM golang:1.26-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS builder
WORKDIR /build
COPY go.work go.work
COPY packages/shared/ packages/shared/
COPY packages/caracalai-mcp-go/ packages/caracalai-mcp-go/
COPY services/audit/ services/audit/
COPY services/gateway/ services/gateway/
COPY apps/agent-coordinator/relay/ apps/agent-coordinator/relay/
COPY services/sts/ services/sts/
COPY tests/go/ tests/go/
WORKDIR /build/services/sts
RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -o /sts ./cmd/sts

FROM alpine:3.22@sha256:310c62b5e7ca5b08167e4384c68db0fd2905dd9c7493756d356e893909057601
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /sts /sts
USER 65532:65532
ENTRYPOINT ["/sts"]
