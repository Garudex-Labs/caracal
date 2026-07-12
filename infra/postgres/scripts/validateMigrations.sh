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
export PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}"
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
echo "=== Migration: unreleased schema stays in one baseline ==="
mapfile -t migration_files < <(find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)
expected_migrations=("0001_baseline.down.sql" "0001_baseline.up.sql")
if [ "${migration_files[*]}" != "${expected_migrations[*]}" ]; then
    echo "FAIL: before the first stable release, migrations must remain consolidated in the 0001 baseline pair" >&2
    printf '  found: %s\n' "${migration_files[*]:-none}" >&2
    exit 1
fi
echo "  baseline-only layout OK"

echo ""
echo "=== Migration: version prefixes are unique ==="
# migrate.sh applies files in lexicographic filename order and records the full
# filename as the version, so duplicate numeric prefixes make ordering depend on
# the suffix and confuse audits of what ran.
duplicate_prefixes="$(find "${MIGRATIONS_DIR}" -name '*.up.sql' -exec basename {} \; | cut -c1-4 | sort | uniq -d)"
if [ -n "${duplicate_prefixes}" ]; then
    echo "FAIL: duplicate migration prefixes: ${duplicate_prefixes}" >&2
    exit 1
fi
echo "  migration version prefixes are unique"

echo ""
echo "=== Migration: releases ship expand-only schema changes ==="
# caracal upgrade applies migrations while the previous version still serves, then
# rolls services. That is only safe when each release's migrations are backward
# compatible (expand phase). A migration that drops, renames, retypes, or tightens
# a column to NOT NULL breaks the running version mid-upgrade and forces a
# maintenance window. Such contract-phase changes must be split into a later
# release and tagged so the discipline stays explicit.
contract_violations=0
for up in "${MIGRATIONS_DIR}"/*.up.sql; do
    name="$(basename "${up}" .up.sql)"
    [ "${name}" = "0001_baseline" ] && continue
    # Flatten to one line so a contract statement split across lines (for example
    # ALTER COLUMN ... \n TYPE ...) cannot slip past a line-by-line match.
    statements="$(grep -vE '^[[:space:]]*--' "${up}" | tr '\n' ' ' | tr -s '[:space:]' ' ')"
    if printf '%s\n' "${statements}" | grep -iqE 'DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|TYPE)|[[:space:]]RENAME[[:space:]]|ALTER[[:space:]]+COLUMN[[:space:]]+[^;]*[[:space:]]TYPE[[:space:]]|SET[[:space:]]+NOT[[:space:]]+NULL'; then
        if ! grep -qE '^--[[:space:]]*caracal:phase[[:space:]]+contract' "${up}"; then
            echo "  FAIL: ${name} contains a contract-phase change but is not tagged '-- caracal:phase contract'" >&2
            contract_violations=$((contract_violations + 1))
        fi
    fi
done
if [ "${contract_violations}" -ne 0 ]; then
    echo "FAIL: ${contract_violations} migration(s) would break a no-window upgrade; split contract changes into a later release or tag them explicitly" >&2
    exit 1
fi
echo "  migrations are expand-only (or explicitly tagged contract)"

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
