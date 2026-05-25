#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# CI validation for Caracal PostgreSQL migrations and forward-only upgrade safety.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-caracal}"
export PGDATABASE="${PGDATABASE:-caracal}"
export PGPASSWORD="${PGPASSWORD:-caracal}"
export MIGRATIONS_DIR="${MIGRATIONS_DIR:-${ROOT}/infra/postgres/migrations}"
DATABASE_URL="${DATABASE_URL:-postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}}"
AUDIT_DATABASE_URL="${AUDIT_DATABASE_URL:-postgresql://caracal_audit_ci:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}}"

psql_cmd() {
    psql -w -v ON_ERROR_STOP=1 \
        -h "${PGHOST}" \
        -p "${PGPORT}" \
        -U "${PGUSER}" \
        -d "${PGDATABASE}" \
        "$@"
}

echo "=== Migration: production tooling is forward-only ==="
if grep -R --include='*.sh' --include='*.yaml' --include='*.yml' -n '\.down\.sql' "${ROOT}/infra/docker" "${ROOT}/infra/helm" "${ROOT}/.github/workflows"; then
    echo "FAIL: production tooling references down migrations" >&2
    exit 1
fi
echo "  down migrations are not referenced by production tooling"

echo ""
echo "=== Migration: apply all migrations ==="
"${ROOT}/infra/postgres/scripts/migrate.sh"

echo ""
echo "=== Migration: idempotency ==="
"${ROOT}/infra/postgres/scripts/migrate.sh"

echo ""
echo "=== Migration: advisory lock concurrent runners ==="
logA="$(mktemp)"
logB="$(mktemp)"
"${ROOT}/infra/postgres/scripts/migrate.sh" >"${logA}" 2>&1 &
pidA=$!
"${ROOT}/infra/postgres/scripts/migrate.sh" >"${logB}" 2>&1 &
pidB=$!
wait "${pidA}" || { cat "${logA}" >&2; exit 1; }
wait "${pidB}" || { cat "${logB}" >&2; exit 1; }
rm -f "${logA}" "${logB}"
echo "  concurrent migrators completed"

echo ""
echo "=== Migration: schema verification ==="
psql_cmd -v password="${PGPASSWORD}" <<'SQL'
SELECT format('CREATE ROLE caracal_audit_ci LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caracal_audit_ci');
\gexec
GRANT caracalAudit TO caracal_audit_ci;
SQL
DATABASE_URL="${DATABASE_URL}" AUDIT_DATABASE_URL="${AUDIT_DATABASE_URL}" bash "${ROOT}/infra/postgres/scripts/verify.sh"
