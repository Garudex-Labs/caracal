#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Idempotent migration applier for /migrations/*.up.sql; records applied
# versions in schema_migrations and serializes concurrent runners.

set -eu

if [ -n "${PGPASSWORD_FILE:-}" ] && [ -r "${PGPASSWORD_FILE}" ]; then
    : "${PGHOST:?PGHOST required when PGPASSWORD_FILE is set}"
    : "${PGPORT:?PGPORT required when PGPASSWORD_FILE is set}"
    : "${PGUSER:?PGUSER required when PGPASSWORD_FILE is set}"
    : "${PGDATABASE:?PGDATABASE required when PGPASSWORD_FILE is set}"
    pgpass="$(mktemp "${TMPDIR:-/tmp}/caracal.pgpass.XXXXXX")"
    trap 'rm -f "${pgpass:-}"' EXIT
    chmod 0600 "${pgpass}"
    printf '%s:%s:%s:%s:%s\n' "${PGHOST}" "${PGPORT}" "${PGDATABASE}" "${PGUSER}" "$(cat "${PGPASSWORD_FILE}")" > "${pgpass}"
    export PGPASSFILE="${pgpass}"
    unset PGPASSWORD
elif [ -z "${PGPASSWORD:-}" ] && [ -z "${PGPASSFILE:-}" ]; then
    echo "migrate: PGPASSWORD_FILE, PGPASSWORD, or PGPASSFILE is required" >&2
    exit 1
fi

migrations_dir="${MIGRATIONS_DIR:-/migrations}"
lock_key="${MIGRATION_ADVISORY_LOCK_KEY:-4732518903281471}"

case "${lock_key}" in
    -*)
        lock_digits="${lock_key#-}"
        ;;
    *)
        lock_digits="${lock_key}"
        ;;
esac
case "${lock_digits}" in
    ''|*[!0-9]*)
        echo "migrate: MIGRATION_ADVISORY_LOCK_KEY must be a signed integer" >&2
        exit 1
        ;;
esac

psql_cmd() {
    psql -w -v ON_ERROR_STOP=1 \
        -h "${PGHOST:?PGHOST required}" \
        -p "${PGPORT:?PGPORT required}" \
        -U "${PGUSER:?PGUSER required}" \
        -d "${PGDATABASE:?PGDATABASE required}" \
        "$@"
}

tries=0
until psql_cmd -c "SELECT 1;" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "${tries}" -gt "${MIGRATION_CONNECT_RETRIES:-30}" ]; then
        echo "migrate: database did not become reachable" >&2
        exit 1
    fi
    sleep "${MIGRATION_CONNECT_SLEEP_SECONDS:-1}"
done

psql_cmd -c "
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
" >/dev/null

find "${migrations_dir}" -maxdepth 1 -type f -name '*.up.sql' | sort | while IFS= read -r path; do
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
    echo "applying ${version}"
    psql_cmd --single-transaction \
        -v ver="${version}" \
        -v lock_key="${lock_key}" \
        -v migration="${path}" \
        <<'SQL'
SELECT pg_advisory_xact_lock(:lock_key);
SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = :'ver') THEN 'true'
    ELSE 'false'
END AS migration_applied;
\gset
\if :migration_applied
SELECT :'ver' AS already_applied;
\else
\i :migration
RESET search_path;
INSERT INTO public.schema_migrations(version) VALUES (:'ver');
\endif
SQL
done

echo "migrations up to date"
