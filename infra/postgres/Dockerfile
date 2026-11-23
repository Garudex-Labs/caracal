# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# PostgreSQL 18 base image for Caracal. Schema migrations are applied by the
# dbMigrate one-shot at boot. Runtime tuning is supplied via `command:` in
# compose to remain environment-aware.

# syntax=docker/dockerfile:1.7
FROM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS gosu-builder
WORKDIR /build
# Rebuild the same upstream gosu 1.19 release on a patched Go toolchain rather
# than shipping the base image's Go 1.24.6 executable. The module and dependency
# checksums are committed; no unverified binary download is used.
COPY gosu/go.mod gosu/go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    CGO_ENABLED=0 GOWORK=off go build -mod=readonly -trimpath -ldflags="-s -w" \
      -o /out/gosu github.com/tianon/gosu

FROM postgres:19-alpine@sha256:8b0ff4cdf221f0c53d7fcda681d3b461be725c492cd881c5ec9c0ad25023f188

# The pinned base digest lags Alpine security releases between upstream
# rebuilds; upgrading at build time keeps apk packages at their current fixes.
RUN apk upgrade --no-cache
COPY --from=gosu-builder --chmod=0755 /out/gosu /usr/local/bin/gosu

ENV POSTGRES_DB=caracal \
    POSTGRES_INITDB_ARGS="--data-checksums --auth-host=scram-sha-256"

COPY migrations/ /migrations/
COPY --chmod=0755 scripts/migrate.sh /usr/local/bin/caracal-migrate

EXPOSE 5432
