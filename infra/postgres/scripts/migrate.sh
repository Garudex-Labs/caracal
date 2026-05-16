#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Idempotent migration applier for /migrations/*.up.sql; honors the same
# schema_migrations table the API uses, so re-runs and concurrent API boots are safe.

set -eu

if [ -n "${PGPASSWORD_FILE:-}" ] && [ -r "${PGPASSWORD_FILE}" ]; then
    PGPASSWORD=$(cat "${PGPASSWORD_FILE}")
    export PGPASSWORD
fi

migrations_dir="${MIGRATIONS_DIR:-/migrations}"
lock_key="${MIGRATION_ADVISORY_LOCK_KEY:-4732518903281471}"

case "${lock_key}" in
    *[!0-9-]*|'')
        echo "migrate: MIGRATION_ADVISORY_LOCK_KEY must be a signed integer" >&2
        exit 1
        ;;
esac

psql -v ON_ERROR_STOP=1 -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
" >/dev/null

for path in $(ls "${migrations_dir}"/*.up.sql 2>/dev/null | sort); do
    version=$(basename "${path}" .up.sql)
    case "${version}" in
        [0-9][0-9][0-9][0-9]_*) : ;;
        *)
            echo "migrate: rejecting unexpected filename: ${version}" >&2
            exit 1
            ;;
    esac
    case "${version}" in
        *[!A-Za-z0-9_]*)
            echo "migrate: rejecting unsafe characters in version: ${version}" >&2
            exit 1
            ;;
    esac
    already=$(psql -tAXc "SELECT 1 FROM schema_migrations WHERE version = :'ver' LIMIT 1" -v ver="${version}")
    if [ "${already}" = "1" ]; then
        continue
    fi
    echo "applying ${version}"
    psql -v ON_ERROR_STOP=1 --single-transaction \
        -v ver="${version}" \
        -c "SELECT pg_advisory_xact_lock(${lock_key});" \
        -f "${path}" \
        -c "INSERT INTO schema_migrations(version) VALUES (:'ver') ON CONFLICT DO NOTHING;"
done

echo "migrations up to date"
