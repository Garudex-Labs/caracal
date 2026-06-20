# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# PostgreSQL 18 base image for Caracal. Schema migrations are applied by the
# dbMigrate one-shot at boot. Runtime tuning is supplied via `command:` in
# compose to remain environment-aware.

# syntax=docker/dockerfile:1.7
FROM postgres:18-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa

ENV POSTGRES_DB=caracal \
    POSTGRES_INITDB_ARGS="--data-checksums --auth-host=scram-sha-256"

COPY migrations/ /migrations/
COPY --chmod=0755 scripts/migrate.sh /usr/local/bin/caracal-migrate

EXPOSE 5432
